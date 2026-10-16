import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  Button,
  Banner,
  ConfirmDialog,
  EmptyState,
  MotionTabs,
  ProgressBar,
  Section,
  StatusBadge,
  SwitchField,
  TextField,
  useToast,
} from '@sakura-ui/react'
import { humanBytes } from '../core/stats.js'
import type { DavSettingsView, DavStatusView, FileEntry, NasScopeCheck, NasScopeView, Transfer } from '../shared/ipc.js'

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function formatTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : ''
}

/** 只允许一段名字：不能带斜杠、不能是 . / ..（这些由 WebDAV 路径规范化拒绝，提前在界面挡住更友好）。 */
function validName(name: string): string | undefined {
  const n = name.trim()
  if (!n) return '名字不能为空'
  if (/[\\/]/.test(n)) return '名字里不能有 / 或 \\'
  if (n === '.' || n === '..') return '名字不能是 . 或 ..'
  return undefined
}

/** 面包屑：/volume1/照片 → [/] [volume1] [照片] */
function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean)
  return (
    <nav className="kura-crumbs" aria-label="当前位置">
      <button type="button" className="kura-crumbs__item" onClick={() => onNavigate('/')}>
        <HardDrive {...icon} /> NAS
      </button>
      {parts.map((part, i) => {
        const target = '/' + parts.slice(0, i + 1).join('/')
        return (
          <span key={target} className="kura-crumbs__seg">
            <ChevronRight size={14} aria-hidden />
            <button type="button" className="kura-crumbs__item" aria-current={i === parts.length - 1 ? 'page' : undefined} onClick={() => onNavigate(target)}>
              {part}
            </button>
          </span>
        )
      })}
    </nav>
  )
}

/** 就地输入一个名字（新建文件夹 / 改名）。 */
function NameForm({ initial, submitLabel, onSubmit, onCancel }: { initial: string; submitLabel: string; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const error = name === initial && initial ? undefined : validName(name)
  return (
    <form
      className="kura-files__name-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (error || busy) return
        setBusy(true)
        void onSubmit(name.trim()).finally(() => setBusy(false))
      }}
    >
      <TextField label="名称" value={name} onChange={(e) => setName(e.target.value)} autoFocus error={name ? error : undefined} />
      <Button type="submit" size="sm" disabled={Boolean(error) || busy}>
        {busy ? '处理中…' : submitLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
    </form>
  )
}

function TransferList({ transfers, onCancel }: { transfers: Transfer[]; onCancel: (id: string) => void }) {
  if (transfers.length === 0) return null
  return (
    <Section className="kura-transfers" aria-label="传输" title="传输">
      <ul>
        {transfers.slice(0, 8).map((t) => {
          const tone = t.state === 'error' ? 'danger' : t.state === 'done' ? 'success' : t.state === 'cancelled' ? 'warning' : 'accent'
          const label = { running: t.kind === 'upload' ? '上传中' : '下载中', done: '完成', error: '失败', cancelled: '已取消' }[t.state]
          return (
            <li key={t.id} data-testid="transfer" data-state={t.state}>
              <ProgressBar
                label={`${t.kind === 'upload' ? '↑' : '↓'} ${t.name}`}
                value={t.total ? t.done : t.state === 'done' ? 1 : undefined}
                max={t.total || 1}
                tone={tone}
                description={t.state === 'error' ? t.error : `${label} · ${humanBytes(t.done)}${t.total ? ` / ${humanBytes(t.total)}` : ''}`}
              />
              {t.state === 'running' && (
                <Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label={`取消 ${t.name}`} onClick={() => onCancel(t.id)} />
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function Browser() {
  const toast = useToast()
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<'idle' | 'mkdir' | { rename: FileEntry }>('idle')
  const [query, setQuery] = useState('')
  const [transfers, setTransfers] = useState<Transfer[]>([])

  // 只认最后一次 load：连点两个文件夹时，先发的那次晚回来不能把界面拉回去
  const loadSeq = useRef(0)
  const load = useCallback(async (target: string) => {
    if (!window.kura) return
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const listing = await window.kura.files.list(target)
      if (seq !== loadSeq.current) return
      setPath(listing.path)
      setEntries(listing.entries)
      setError('')
      setSelected([])
    } catch (caught) {
      if (seq === loadSeq.current) setError((caught as Error).message)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('/')
  }, [load])

  // 上一轮看到的传输里有没有在跑的：放 ref 里比较，不在 setState 的 updater 里做副作用
  // （updater 必须是纯函数，StrictMode 下会被调两次，副作用就跟着跑两次）
  const wasRunning = useRef(false)
  const transferSeq = useRef(0)

  // 传输进度：有在跑的就每 700ms 刷一次；全部结束后刷新当前目录（上传的文件该出现了）
  const running = transfers.some((t) => t.state === 'running')
  useEffect(() => {
    if (!window.kura) return
    let stopped = false
    const tick = async () => {
      const seq = ++transferSeq.current
      const next = await window.kura!.files.transfers()
      if (stopped || seq !== transferSeq.current) return
      const nowRunning = next.some((t) => t.state === 'running')
      if (wasRunning.current && !nowRunning && next.some((t) => t.kind === 'upload')) void load(path)
      wasRunning.current = nowRunning
      setTransfers(next)
    }
    void tick()
    const timer = setInterval(() => void tick(), running ? 700 : 3_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [running, path, load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q))
  }, [entries, query])

  const act = async (title: string, action: () => Promise<unknown>, reload = true) => {
    try {
      await action()
      if (reload) await load(path)
    } catch (caught) {
      toast.notify({ title, description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  const refreshTransfers = () => {
    const seq = ++transferSeq.current
    void window.kura?.files.transfers().then((next) => {
      if (seq !== transferSeq.current) return
      // 这里拿到「在跑」也要记下，否则刚开始的上传结束时 tick 看不到「跑 → 停」，不会刷新目录
      if (next.some((t) => t.state === 'running')) wasRunning.current = true
      setTransfers(next)
    })
  }

  const toggle = (p: string) => setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))
  const allChecked = visible.length > 0 && visible.every((e) => selected.includes(e.path))

  return (
    <div className="kura-files">
      <div className="kura-toolbar">
        <Button variant="ghost" icon={<ArrowUp {...icon} />} aria-label="上一级" disabled={path === '/'} onClick={() => void load(parentOf(path))} />
        <Breadcrumbs path={path} onNavigate={(p) => void load(p)} />
        <div className="kura-toolbar__search">
          <TextField label="筛选当前目录" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="文件名" />
        </div>
        <Button variant="ghost" icon={<RefreshCw {...icon} />} aria-label="刷新" disabled={loading} onClick={() => void load(path)} />
        <Button variant="secondary" icon={<FolderPlus {...icon} />} onClick={() => setMode('mkdir')}>
          新建文件夹
        </Button>
        <Button
          icon={<Upload {...icon} />}
          onClick={() =>
            void act(
              '上传失败',
              async () => {
                const n = await window.kura!.files.upload(path)
                if (n) toast.notify({ title: `开始上传 ${n} 个文件`, tone: 'success' })
                refreshTransfers()
              },
              false,
            )
          }
        >
          上传
        </Button>
      </div>

      {mode === 'mkdir' && (
        <NameForm
          initial=""
          submitLabel="新建"
          onCancel={() => setMode('idle')}
          onSubmit={(name) => act('新建文件夹失败', () => window.kura!.files.mkdir(joinPath(path, name))).then(() => setMode('idle'))}
        />
      )}
      {typeof mode === 'object' && (
        <NameForm
          initial={mode.rename.name}
          submitLabel="改名"
          onCancel={() => setMode('idle')}
          onSubmit={(name) =>
            act('改名失败', () => window.kura!.files.rename(mode.rename.path, joinPath(parentOf(mode.rename.path), name))).then(() => setMode('idle'))
          }
        />
      )}

      {selected.length > 0 && (
        <div className="kura-files__selection" role="region" aria-label="已选择的项目">
          <span>已选 {selected.length} 项</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<Download {...icon} />}
            onClick={() =>
              void act(
                '下载失败',
                async () => {
                  const n = await window.kura!.files.download(selected)
                  if (n) toast.notify({ title: `开始下载 ${n} 个文件`, tone: 'success' })
                  refreshTransfers()
                },
                false,
              )
            }
          >
            下载
          </Button>
          {selected.length === 1 && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil {...icon} />}
              onClick={() => {
                const entry = entries?.find((e) => e.path === selected[0])
                if (entry) setMode({ rename: entry })
              }}
            >
              改名
            </Button>
          )}
          <ConfirmDialog
            triggerLabel="删除"
            title={`删除 ${selected.length} 项？`}
            description={`将从 NAS 上永久删除：${selected.map((p) => p.slice(p.lastIndexOf('/') + 1)).join('、')}。文件夹会连同里面的内容一起删除，无法撤销。`}
            confirmLabel="删除"
            tone="danger"
            onConfirm={() => act('删除失败', () => window.kura!.files.remove(selected))}
          />
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            取消选择
          </Button>
        </div>
      )}

      {error ? (
        <div className="kura-placeholder">
          <EmptyState
            title="打不开这个目录"
            description={error}
            action={
              <Button variant="secondary" onClick={() => void load(path)}>
                重试
              </Button>
            }
          />
        </div>
      ) : entries === null ? (
        <div className="kura-placeholder">
          <EmptyState title="正在读取" description="经映射层连接 NAS 的 WebDAV" />
        </div>
      ) : visible.length === 0 ? (
        <div className="kura-placeholder">
          <EmptyState title={query ? '没有匹配的文件' : '空文件夹'} description={query ? '换个关键字' : '可以上传文件，或新建文件夹'} />
        </div>
      ) : (
        <table className="kura-files__table" data-testid="file-table">
          <thead>
            <tr>
              <th className="kura-files__check">
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allChecked}
                  onChange={() => setSelected(allChecked ? [] : visible.map((e) => e.path))}
                />
              </th>
              <th>名称</th>
              <th className="kura-files__num">大小</th>
              <th>修改时间</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr key={entry.path} data-selected={selected.includes(entry.path) || undefined} data-name={entry.name}>
                <td className="kura-files__check">
                  <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.includes(entry.path)} onChange={() => toggle(entry.path)} />
                </td>
                <td>
                  <button
                    type="button"
                    className="kura-files__name"
                    title={entry.isDir ? '打开文件夹' : '用默认程序打开（会先下载到临时目录）'}
                    onClick={() =>
                      entry.isDir
                        ? void load(entry.path)
                        : void act('打开失败', () => window.kura!.files.open(entry.path), false).then(refreshTransfers)
                    }
                  >
                    {entry.isDir ? <Folder {...icon} className="kura-files__dir-icon" /> : <FileIcon {...icon} />}
                    <span>{entry.name}</span>
                  </button>
                </td>
                <td className="kura-files__num">{entry.isDir ? '' : humanBytes(entry.size)}</td>
                <td className="kura-files__time">{formatTime(entry.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <TransferList transfers={transfers} onCancel={(id) => void window.kura?.files.cancel(id).then(refreshTransfers)} />
    </div>
  )
}

/** 一组路径规则的编辑器：每行一条，增删即时反映在草稿里。 */
function RuleList({ label, description, rules, onChange, testId }: { label: string; description: string; rules: string[]; onChange: (rules: string[]) => void; testId: string }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    const normalized = '/' + v.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
    if (!rules.includes(normalized)) onChange([...rules, normalized])
    setDraft('')
  }
  return (
    <div className="kura-rules" data-testid={testId}>
      <h3>{label}</h3>
      <p className="kura-form__note">{description}</p>
      <ul>
        {rules.map((rule) => (
          <li key={rule}>
            <code>{rule}</code>
            <Button size="sm" variant="ghost" icon={<Trash2 {...icon} />} aria-label={`移除 ${rule}`} onClick={() => onChange(rules.filter((r) => r !== rule))} />
          </li>
        ))}
        {rules.length === 0 && <li className="kura-rules__empty">（没有）</li>}
      </ul>
      <form
        className="kura-rules__add"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <TextField label={`添加${label}`} placeholder="/volume1/照片" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>
          添加
        </Button>
      </form>
    </div>
  )
}

function LocalDavPanel() {
  const toast = useToast()
  const [status, setStatus] = useState<DavStatusView | null>(null)
  const [draft, setDraft] = useState<DavSettingsView | null>(null)
  const [saving, setSaving] = useState(false)

  const davSeq = useRef(0)
  const refresh = useCallback(async () => {
    if (!window.kura) return
    const seq = ++davSeq.current
    const next = await window.kura.dav.get()
    if (seq !== davSeq.current) return
    setStatus(next)
    setDraft((prev) => prev ?? next.settings)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3_000)
    return () => clearInterval(timer)
  }, [refresh])

  if (!status || !draft) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings)
  const set = <K extends keyof DavSettingsView>(key: K, value: DavSettingsView[K]) => setDraft({ ...draft, [key]: value })

  const tone = !status.settings.enabled ? 'neutral' : !status.running ? 'danger' : status.upstreamError ? 'warning' : 'success'
  const label = !status.settings.enabled ? '已关闭' : !status.running ? '监听失败' : status.upstreamError ? 'NAS 侧不可用' : '运行中'

  return (
    <div className="kura-dav">
      <Section
        title="本机 WebDAV"
        actions={
          <StatusBadge tone={tone} dot size="sm">
            {label}
          </StatusBadge>
        }
        footer={<>请求 {status.requests} · 失败 {status.errors} · ↑ {humanBytes(status.bytesUp)} · ↓ {humanBytes(status.bytesDown)}</>}
      >
        <p className="kura-form__note">
          给本机其他程序用：资源管理器「映射网络驱动器」、播放器、同步工具都填这个地址，无需账号密码，只能从本机访问。
          看到的是「暴露范围」裁剪后的 NAS 目录 —— 范围和文件页、Z: 盘共用同一份，改在下面。
        </p>
        <div className="kura-card__addr">
          <code className="kura-card__local" data-testid="dav-url">
            {status.url}
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void window.kura
                ?.copyText(status.url)
                .then(() => toast.notify({ title: '已复制', description: status.url, tone: 'success' }))
                .catch((caught: Error) => toast.notify({ title: '复制失败', description: caught.message, tone: 'error' }))
            }
          >
            复制
          </Button>
        </div>
        {!status.available && <Banner tone="warning" description="服务端清单里还没有 webdav 服务：NAS 侧的 nas-webdav 没部署、或清单还没同步到。" />}
        {status.lastError && <p className="kura-card__error">{status.lastError}</p>}
        {status.upstreamError && <p className="kura-card__error">{status.upstreamError}</p>}
        </Section>

      <Section title="本机服务设置">
        <div className="kura-dav__basics">
          <SwitchField label="启用" description="关掉后本机端口释放，文件页的浏览不受影响" checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
          <TextField
            label="本机端口"
            inputMode="numeric"
            value={String(draft.port)}
            onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '').slice(0, 5)) || 0)}
          />
        </div>
        <p className="kura-form__note">范围与只读都在下面那两节，它们影响的不只是本机 WebDAV，所以没放在这里。</p>
        <div className="kura-form__actions">
          <Button
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true)
              // 保存期间回来的轮询结果是旧状态：作废它们
              davSeq.current++
              void window
                .kura!.dav.save(draft)
                .then((next) => {
                  davSeq.current++
                  setStatus(next)
                  setDraft(next.settings)
                  toast.notify({ title: '已保存', tone: 'success' })
                })
                .catch((caught: Error) => toast.notify({ title: '保存失败', description: caught.message, tone: 'error', duration: 0 }))
                .finally(() => setSaving(false))
            }}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(status.settings)}>
            撤销改动
          </Button>
        </div>
      </Section>

      <NasScopePanel />
    </div>
  )
}

/**
 * NAS 侧那份暴露范围。放在 NAS 的 kura-server 上，客户端走网关读写 ——
 * 它是**唯一**一份范围：文件页的浏览、本机 WebDAV、Z: 盘、外部程序都由它裁。
 *
 * 保存是整体替换（服务端契约如此）：删一条再保存必须真的删掉。
 */
function NasScopePanel() {
  const toast = useToast()
  const [scope, setScope] = useState<NasScopeView | null>(null)
  const [draft, setDraft] = useState<NasScopeView | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [probe, setProbe] = useState('/volume1')
  const [probeResult, setProbeResult] = useState<NasScopeCheck | null>(null)

  const refresh = useCallback(async () => {
    if (!window.kura) return
    try {
      const next = await window.kura.nasScope.get()
      setScope(next)
      setLoadError('')
      setDraft((prev) => prev ?? next)
    } catch (caught) {
      // 读不到就说清为什么（映射没起来 / 网关没有这个接口 —— 旧版 kura-server）
      setLoadError((caught as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loadError) {
    return (
      <Section title="暴露范围">
        <Banner
          tone="warning"
          description={
            <>
              读不到 NAS 上的暴露范围：{loadError}
              <br />
              范围存在 NAS 的 kura-server 上。确认映射已在运行，且 NAS 上的镜像够新（旧版还没有这个接口）。
            </>
          }
        />
      </Section>
    )
  }
  if (!scope || !draft) return null

  const dirty = JSON.stringify(draft) !== JSON.stringify(scope)
  const set = <K extends keyof NasScopeView>(key: K, value: NasScopeView[K]) => setDraft({ ...draft, [key]: value })

  return (
    <>
      <Section
        title="暴露范围"
        description="存在 NAS 上，与 NAS 管理页共用同一份"
      >
        <p className="kura-form__note">
          文件页的浏览、本机 WebDAV、Z: 盘、以及给其他程序用的 WebDAV，看到的都是这份范围裁剪后的结果。改完立即生效。
        </p>
        <div className="kura-dav__rules">
          <RuleList
            testId="scope-include"
            label="放行目录"
            description="这些目录及其下所有内容可见。上级目录会自动露出通往它的路径（只读）。"
            rules={draft.include}
            onChange={(v) => set('include', v)}
          />
          <RuleList
            testId="scope-exclude"
            label="排除目录"
            description="优先于放行：放行了 /volume1 又想挡住其中一个子目录，就加在这里。按路径前缀判断，写目录本身即可，支持 * 通配。"
            rules={draft.exclude}
            onChange={(v) => set('exclude', v)}
          />
        </div>
        <SwitchField
          label="只读"
          description="所有走 WebDAV 的读写都变成只读（文件页、本机 WebDAV、Z: 盘都受影响）"
          checked={draft.readOnly}
          onCheckedChange={(v) => set('readOnly', v)}
        />
        <div className="kura-form__actions">
          <Button
            data-testid="scope-save"
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true)
              void window
                .kura!.nasScope.save(draft)
                .then((next) => {
                  setScope(next)
                  setDraft(next)
                  toast.notify({ title: '已保存', description: '新的范围对下一个请求立即生效', tone: 'success' })
                })
                .catch((caught: Error) => toast.notify({ title: '保存失败', description: caught.message, tone: 'error', duration: 0 }))
                .finally(() => setSaving(false))
            }}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button variant="ghost" disabled={JSON.stringify(draft) === JSON.stringify(scope)} onClick={() => setDraft({ ...scope, ...scope.defaults })}>
            恢复默认
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(scope)}>
            撤销改动
          </Button>
        </div>
      </Section>

      <Section title="可见性自检">
        <p className="kura-form__note">输一个 NAS 路径，看它按当前已保存的规则能不能被看到、写入，以及是哪条规则决定的。</p>
        <form
          className="kura-rules__add"
          onSubmit={(event) => {
            event.preventDefault()
            void window
              .kura!.nasScope.check(probe)
              .then(setProbeResult)
              .catch((caught: Error) => toast.notify({ title: '自检失败', description: caught.message, tone: 'error' }))
          }}
        >
          <TextField label="NAS 路径" value={probe} onChange={(e) => setProbe(e.target.value)} spellCheck={false} />
          <Button type="submit" size="sm" variant="secondary">
            检查
          </Button>
        </form>
        {probeResult && (
          <p className="kura-dav__probe" data-testid="scope-probe" data-visibility={probeResult.visibility}>
            <StatusBadge tone={probeResult.visibility === 'full' ? 'success' : probeResult.visibility === 'ancestor' ? 'warning' : 'neutral'} size="sm">
              {probeResult.visibility === 'full' ? (probeResult.writable ? '可见 · 可写' : '可见 · 只读') : probeResult.visibility === 'ancestor' ? '仅路过' : '不可见'}
            </StatusBadge>
            <code>{probeResult.path}</code>
            <span>{probeResult.reason}</span>
          </p>
        )}
      </Section>
    </>
  )
}

export function FilesView() {
  // MotionTabs 切走会卸载内容：浏览位置放在 Browser 里随它重置是可以接受的，范围草稿在面板里同理
  const [tab, setTab] = useState('browse')
  return (
    <MotionTabs
      label="文件"
      value={tab}
      onValueChange={setTab}
      items={[
        { value: 'browse', label: '浏览', icon: <Folder {...icon} />, content: <Browser /> },
        { value: 'dav', label: '本机 WebDAV', icon: <HardDrive {...icon} />, content: <LocalDavPanel /> },
      ]}
    />
  )
}
