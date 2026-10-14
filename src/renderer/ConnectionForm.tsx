import { useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, CircleAlert, CircleDashed, Loader2 } from 'lucide-react'
import { Button, FluidSegmented, TextField, useToast } from '@sakura-ui/react'
import type { LinkModeSetting } from '../shared/labels.js'
import type { ConnectionForm as Form, ConnectionSummary, ConnectionTestResult, ConnectionTestStep } from '../shared/ipc.js'

const modeOptions = [
  { value: 'auto', label: '自动' },
  { value: 'lan', label: '局域网' },
  { value: 'wan', label: '外网' },
] as const

function initialForm(summary: ConnectionSummary | undefined): Form {
  return {
    uglinkId: summary?.uglinkId ?? '',
    ugreenUser: summary?.ugreenUser ?? '',
    ugreenPassword: '',
    lanHost: summary?.lanHost ?? '',
    mode: summary?.mode ?? 'auto',
    gatewayPort: summary?.gatewayPort ?? 8897,
    gatewayUser: summary?.gatewayUser ?? '',
    gatewayPassword: '',
  }
}

/**
 * 连接 NAS 的表单：首次启动的引导页与设置页共用。
 *
 * 「测试连接」按表单实际登录一遍、逐步报告；保存时同样要求测试通过，
 * 免得把一份连不上的配置存进去、再在映射页上看一堆红色。
 */
export function ConnectionForm({
  summary,
  onSaved,
  submitLabel = '测试并连接',
}: {
  summary: ConnectionSummary | undefined
  onSaved: (summary: ConnectionSummary) => void
  submitLabel?: string
}) {
  const toast = useToast()
  const [form, setForm] = useState<Form>(() => initialForm(summary))
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<ConnectionTestResult | undefined>(undefined)
  /** 逐条点亮的步骤；主进程每完成一步推一条进来 */
  const [steps, setSteps] = useState<ConnectionTestStep[]>([])
  const resultRef = useRef<HTMLUListElement>(null)
  const saved = summary?.configured === true

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setResult(undefined) // 改了任何一项，上次的测试结果就不再代表当前填写
    setSteps([])
  }

  const runTest = async (): Promise<ConnectionTestResult | undefined> => {
    if (!window.kura) return undefined
    setTesting(true)
    setSteps([])
    // 底部那列结果一开始就在视口外的话，转圈看不见，先滚过去
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))

    /** 同名步骤就地更新，新步骤追加 —— 保证「先转圈、后落定」不会重排 */
    const upsert = (step: ConnectionTestStep) =>
      setSteps((prev) => {
        const next = [...prev]
        const at = next.findIndex((s) => s.name === step.name)
        if (at >= 0) next[at] = step
        else next.push(step)
        return next
      })

    // 先订阅再开测：否则前面几步的结果可能已经推完、界面没接住
    const off = window.kura.connection.onTestProgress((progress) => {
      if (progress.phase === 'plan') {
        // 还没跑到的步骤先以「转圈」占位，让整列立刻出现、再逐条落定
        for (const name of progress.names) upsert({ name, ok: false, detail: '', pending: true })
        return
      }
      if (progress.phase === 'step') upsert(progress.step)
    })

    try {
      const next = await window.kura.connection.test(form)
      setResult(next)
      return next
    } finally {
      off()
      setTesting(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.kura || testing || saving) return
    // 刚测过且通过就不再测一遍；没测过、或测失败后改过表单（result 已清空）就先测
    const tested = result?.ok ? result : await runTest()
    if (!tested?.ok) return
    setSaving(true)
    try {
      const next = await window.kura.connection.save(form)
      toast.notify({ title: '已连接 NAS', description: '凭据已加密保存，映射已启动', tone: 'success' })
      onSaved(next)
    } catch (error) {
      toast.notify({ title: '保存失败', description: (error as Error).message, tone: 'error', duration: 0 })
    } finally {
      setSaving(false)
    }
  }

  const keepHint = saved ? '留空则沿用已保存的密码' : undefined

  return (
    <form className="kura-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="kura-form__group">
        <legend>绿联账号</legend>
        <TextField
          label="UGREENlink ID"
          description="绿联 App / UGOS「远程访问」里的那串 ID；也可直接粘贴 https://ug.link/<ID>"
          placeholder="abcd1234-1a2b"
          value={form.uglinkId}
          onChange={(e) => set('uglinkId', e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />
        {summary?.base && (
          <p className="kura-form__note">
            当前设备地址：<code>{summary.base}</code>
            {summary.lanHost ? ` · 局域网 ${summary.lanHost}` : ' · 未记录局域网地址'}
          </p>
        )}
        <div className="kura-form__row">
          <TextField label="账号" value={form.ugreenUser} onChange={(e) => set('ugreenUser', e.target.value)} required autoComplete="username" />
          <TextField
            label="密码"
            type="password"
            value={form.ugreenPassword}
            onChange={(e) => set('ugreenPassword', e.target.value)}
            required={!summary?.hasUgreenPassword}
            description={summary?.hasUgreenPassword ? keepHint : undefined}
            autoComplete="current-password"
          />
        </div>
      </fieldset>

      <fieldset className="kura-form__group">
        <legend>链路</legend>
        <FluidSegmented
          label="链路模式"
          options={modeOptions}
          value={form.mode}
          onValueChange={(value) => set('mode', value as LinkModeSetting)}
        />
        <p className="kura-form__note">
          自动：在家直连局域网（约 20 ms），在外走绿联中继（约 400 ms），定时探测、自动切换。
        </p>
        <TextField
          label="NAS 局域网地址"
          description={
            form.mode === 'lan'
              ? '局域网模式必填，例如 192.168.x.x'
              : '可以不填：留空就用绿联记录的地址，查不到就一直走外网中继。填上能在家直连（快很多）'
          }
          placeholder="192.168.1.10"
          value={form.lanHost}
          onChange={(e) => set('lanHost', e.target.value)}
          required={form.mode === 'lan'}
          autoComplete="off"
          spellCheck={false}
        />
      </fieldset>

      <fieldset className="kura-form__group">
        <legend>统一网关（Authelia）</legend>
        <p className="kura-form__note">服务端清单与走网关的服务都需要它；端口写 0 表示不用网关。</p>
        <div className="kura-form__row">
          <TextField
            label="网关端口"
            inputMode="numeric"
            value={String(form.gatewayPort)}
            onChange={(e) => set('gatewayPort', Number(e.target.value.replace(/\D/g, '')) || 0)}
          />
          <TextField
            label="网关账号"
            value={form.gatewayUser}
            onChange={(e) => set('gatewayUser', e.target.value)}
            disabled={!form.gatewayPort}
            autoComplete="off"
          />
          <TextField
            label="网关密码"
            type="password"
            value={form.gatewayPassword}
            onChange={(e) => set('gatewayPassword', e.target.value)}
            disabled={!form.gatewayPort}
            description={summary?.hasGatewayPassword ? keepHint : undefined}
            autoComplete="off"
          />
        </div>
      </fieldset>

      {steps.length > 0 && (
        <ul className="kura-test" aria-live="polite" data-testid="connection-test" ref={resultRef}>
          {steps.map((step) => (
            <li
              key={step.name}
              className="kura-test__step"
              data-ok={step.pending ? undefined : step.ok}
              data-pending={step.pending ? 'true' : undefined}
            >
              {step.pending ? (
                <Loader2 className="kura-test__spinner" size={16} aria-hidden />
              ) : step.ok ? (
                <CheckCircle2 size={16} aria-hidden />
              ) : step.name === '局域网可达' ? (
                <CircleDashed size={16} aria-hidden />
              ) : (
                <CircleAlert size={16} aria-hidden />
              )}
              <span className="kura-test__name">{step.name}</span>
              <span className="kura-test__detail">{step.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="kura-form__actions">
        {/* 一步完成：点一下就测试，全部通过才保存并进入主界面；不通过停在这里看哪一步错了 */}
        <Button type="submit" disabled={testing || saving}>
          {testing ? '正在测试…' : saving ? '正在保存…' : submitLabel}
        </Button>
        {saved && (
          <Button type="button" variant="ghost" disabled={testing || saving} onClick={() => void runTest()}>
            仅测试
          </Button>
        )}
      </div>
      <p className="kura-form__note">凭据用 Windows 当前用户的系统加密（DPAPI）保存在本机，不会上传，也不会写进日志。</p>
    </form>
  )
}
