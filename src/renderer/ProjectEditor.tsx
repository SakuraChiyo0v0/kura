import { useEffect, useMemo, useState } from 'react'
import { Save, Undo2, X } from 'lucide-react'
import { Banner, Button, Section, StatusBadge, SwitchField, TextField, useToast } from '@sakura-ui/react'
import { lineDiff } from '../core/line-diff.js'
import type { ProjectFilesView } from '../shared/ipc.js'

/**
 * compose 与 `.env` 并排编辑（借 Arcane）：保存前先看改了哪几行，服务端先校验、坏的存不进去，
 * 旧版本留在项目目录的 .kura-bak/ 里。保存只改文件，**不自动重建** —— 「保存并应用」才会接着跑一次启动。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

/** compose 的报错是多行的；toast 只放得下一句，完整内容留在编辑器下方 */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 200) ?? text.slice(0, 200)
}

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = lineDiff(before, after)
  // 只显示改动附近 2 行，长文件不至于一屏都是没变的
  const near = new Set<number>()
  rows.forEach((r, i) => {
    if (r.kind !== 'same') for (let k = i - 2; k <= i + 2; k++) near.add(k)
  })
  return (
    <pre className="kura-docker-diff">
      {rows.map((r, i) =>
        near.has(i) ? (
          <span key={i} data-kind={r.kind}>
            {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '}
            {r.text}
            {'\n'}
          </span>
        ) : near.has(i - 1) ? (
          <span key={i} data-kind="gap">
            {'  …\n'}
          </span>
        ) : null,
      )}
    </pre>
  )
}

export function ProjectEditor({ name, onClose, onApply }: { name: string; onClose: () => void; onApply: () => void }) {
  const toast = useToast()
  const [files, setFiles] = useState<ProjectFilesView | null>(null)
  const [compose, setCompose] = useState<string[]>([])
  const [env, setEnv] = useState('')
  const [active, setActive] = useState(0)
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [apply, setApply] = useState(true)

  useEffect(() => {
    void window.kura?.docker
      .projectFiles(name)
      .then((f) => {
        setFiles(f)
        setCompose(f.compose.map((c) => c.content))
        setEnv(f.env.content)
      })
      .catch((e: Error) => setError(e.message))
  }, [name])

  const changed = useMemo(() => {
    if (!files) return { compose: [] as number[], env: false }
    return { compose: files.compose.map((c, i) => (c.content !== compose[i] ? i : -1)).filter((i) => i >= 0), env: env !== files.env.content }
  }, [files, compose, env])
  const dirty = changed.compose.length > 0 || changed.env

  if (error && !files) {
    return (
      <Section
        className="kura-docker-editor"
        title={`编辑 ${name}`}
        actions={<Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label="关闭编辑" onClick={onClose} />}
      >
        <Banner tone="warning" description={error} />
      </Section>
    )
  }
  if (!files) return null

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const next = await window.kura!.docker.saveProjectFiles(name, {
        compose: changed.compose.map((i) => ({ path: files.compose[i]!.path, content: compose[i]! })),
        ...(changed.env ? { env } : {}),
      })
      setFiles(next)
      setCompose(next.compose.map((c) => c.content))
      setEnv(next.env.content)
      setReview(false)
      toast.notify({ title: '已保存', description: '旧版本留在项目目录的 .kura-bak/ 里', tone: 'success' })
      if (apply) onApply()
    } catch (e) {
      // 校验失败的信息是多行的（compose 的报错）：完整内容原样留在编辑器下方，toast 只报一声 + 首行
      setError((e as Error).message)
      toast.notify({
        title: '没有保存',
        description: firstLine((e as Error).message),
        tone: 'error',
        duration: 0,
      })
      setReview(false)
    } finally {
      setSaving(false)
    }
  }

  const fileName = (p: string) => p.split('/').pop() ?? p

  return (
    <Section
      className="kura-docker-editor"
      data-testid="project-editor"
      title={`编辑 ${name}`}
      actions={
        <>
          {dirty && (
            <StatusBadge tone="warning" size="sm">
              有未保存的改动
            </StatusBadge>
          )}
          <Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label="关闭编辑" onClick={onClose} />
        </>
      }
    >
      <p className="kura-form__note">
        改的是 NAS 上的文件（<code>{files.compose[0]?.path.replace(/\/[^/]+$/, '')}</code>）。保存前会先用 <code>docker compose config</code> 校验，坏的存不进去。
        {files.backups.length > 0 && ` 已有 ${files.backups.length} 份旧版本备份。`}
      </p>

      <div className="kura-docker-editor__panes">
        <div className="kura-docker-editor__pane">
          {files.compose.length > 1 && (
            <div className="kura-docker-actions" role="tablist" aria-label="compose 文件">
              {files.compose.map((c, i) => (
                <Button key={c.path} size="sm" variant={i === active ? 'secondary' : 'ghost'} role="tab" aria-selected={i === active} onClick={() => setActive(i)}>
                  {fileName(c.path)}
                  {changed.compose.includes(i) ? ' •' : ''}
                </Button>
              ))}
            </div>
          )}
          <label className="kura-docker-editor__label">
            {fileName(files.compose[active]!.path)}
            <textarea
              className="kura-docker-editor__text"
              spellCheck={false}
              value={compose[active] ?? ''}
              onChange={(e) => setCompose((prev) => prev.map((v, i) => (i === active ? e.target.value : v)))}
              onKeyDown={(e) => {
                // Tab 插两个空格（YAML 不认制表符），而不是把焦点移走
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault()
                  const el = e.currentTarget
                  const { selectionStart: s, selectionEnd: t, value } = el
                  const next = value.slice(0, s) + '  ' + value.slice(t)
                  setCompose((prev) => prev.map((v, i) => (i === active ? next : v)))
                  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault()
                  if (dirty) setReview(true)
                }
              }}
            />
          </label>
        </div>
        <div className="kura-docker-editor__pane">
          <label className="kura-docker-editor__label">
            .env{!files.env.exists && '（还没有，保存时新建）'}
            <textarea
              className="kura-docker-editor__text"
              spellCheck={false}
              value={env}
              placeholder="KEY=value，每行一个"
              onChange={(e) => setEnv(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault()
                  if (dirty) setReview(true)
                }
              }}
            />
          </label>
        </div>
      </div>

      {error && <pre className="kura-card__error kura-docker-editor__error" data-testid="editor-error">{error}</pre>}

      {review ? (
        <div className="kura-docker-review" data-testid="editor-review">
          <h3>将要保存的改动</h3>
          {changed.compose.map((i) => (
            <div key={i}>
              <p className="kura-form__note">{fileName(files.compose[i]!.path)}</p>
              <DiffView before={files.compose[i]!.content} after={compose[i]!} />
            </div>
          ))}
          {changed.env && (
            <div>
              <p className="kura-form__note">.env</p>
              <DiffView before={files.env.content} after={env} />
            </div>
          )}
          <SwitchField label="保存后应用（按新配置启动 / 重建）" description="关掉就只改文件，等你自己点「启动」" checked={apply} onCheckedChange={setApply} />
          <div className="kura-form__actions">
            <Button data-testid="editor-save" icon={<Save {...icon} />} disabled={saving} onClick={() => void save()}>
              {saving ? '校验并保存中…' : apply ? '保存并应用' : '保存'}
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => setReview(false)}>
              接着改
            </Button>
          </div>
        </div>
      ) : (
        <div className="kura-form__actions">
          <Button icon={<Save {...icon} />} disabled={!dirty} onClick={() => setReview(true)}>
            查看改动并保存
          </Button>
          <Button
            variant="ghost"
            icon={<Undo2 {...icon} />}
            disabled={!dirty}
            onClick={() => {
              setCompose(files.compose.map((c) => c.content))
              setEnv(files.env.content)
              setError('')
            }}
          >
            撤销改动
          </Button>
        </div>
      )}
    </Section>
  )
}

const starter = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./data:/usr/share/nginx/html
`

export function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, start: boolean) => void }) {
  const [name, setName] = useState('')
  const [compose, setCompose] = useState(starter)
  const [env, setEnv] = useState('')
  const [start, setStart] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  const nameError = name && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) ? '小写字母、数字、- 和 _，字母或数字开头' : ''
  return (
    <Section
      className="kura-docker-editor"
      data-testid="new-project"
      title="新建项目"
      actions={<Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label="关闭" onClick={onClose} />}
    >
      <p className="kura-form__note">在项目目录下建一个同名文件夹，写入 docker-compose.yaml。compose 里的相对路径（./data）就落在这个文件夹里。</p>
      <TextField label="项目名" value={name} onChange={(e) => setName(e.target.value.trim())} error={nameError || undefined} spellCheck={false} />
      <div className="kura-docker-editor__panes">
        <label className="kura-docker-editor__label">
          docker-compose.yaml
          <textarea className="kura-docker-editor__text" spellCheck={false} value={compose} onChange={(e) => setCompose(e.target.value)} />
        </label>
        <label className="kura-docker-editor__label">
          .env（可选）
          <textarea className="kura-docker-editor__text" spellCheck={false} value={env} placeholder="KEY=value，每行一个" onChange={(e) => setEnv(e.target.value)} />
        </label>
      </div>
      {error && <pre className="kura-card__error kura-docker-editor__error">{error}</pre>}
      <SwitchField label="建好后立即启动" checked={start} onCheckedChange={setStart} />
      <div className="kura-form__actions">
        <Button
          disabled={!name || Boolean(nameError) || busy}
          onClick={() => {
            setBusy(true)
            setError('')
            void window
              .kura!.docker.createProject({ name, compose, env: env || undefined })
              .then(() => onCreated(name, start))
              .catch((e: Error) => {
                setError(e.message)
                toast.notify({ title: '没有创建成功', description: firstLine(e.message), tone: 'error', duration: 0 })
              })
              .finally(() => setBusy(false))
          }}
        >
          {busy ? '校验并创建中…' : '创建'}
        </Button>
      </div>
    </Section>
  )
}
