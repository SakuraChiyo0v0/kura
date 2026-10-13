import { useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, CircleAlert, CircleDashed } from 'lucide-react'
import { Button, FluidSegmented, TextField, useToast } from '@sakura-ui/react'
import type { LinkModeSetting } from '../shared/labels.js'
import type { ConnectionForm as Form, ConnectionSummary, ConnectionTestResult } from '../shared/ipc.js'

const modeOptions = [
  { value: 'auto', label: '自动' },
  { value: 'lan', label: '局域网' },
  { value: 'wan', label: '外网' },
] as const

function initialForm(summary: ConnectionSummary | undefined): Form {
  return {
    base: summary?.base ?? '',
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
  submitLabel = '保存并连接',
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
  const resultRef = useRef<HTMLUListElement>(null)
  const saved = summary?.configured === true

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setResult(undefined) // 改了任何一项，上次的测试结果就不再代表当前填写
  }

  const runTest = async (): Promise<ConnectionTestResult | undefined> => {
    if (!window.kura) return undefined
    setTesting(true)
    try {
      const next = await window.kura.connection.test(form)
      setResult(next)
      // 结果在表单底部，按钮也在底部，但长表单里结果可能落在视口外：滚过去，让人看见每一步
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
      return next
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.kura) return
    const tested = result ?? (await runTest())
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
  const needsLan = form.mode !== 'wan'

  return (
    <form className="kura-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="kura-form__group">
        <legend>绿联账号</legend>
        <TextField
          label="设备地址"
          description="绿联 App「远程访问」里的地址，形如 https://<设备>.cn30.ug.link"
          placeholder="https://xxxx.cn30.ug.link"
          value={form.base}
          onChange={(e) => set('base', e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />
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
          description={needsLan ? '用于在家直连，例如 192.168.x.x' : '外网模式下可以不填'}
          value={form.lanHost}
          onChange={(e) => set('lanHost', e.target.value)}
          required={needsLan}
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

      {result && (
        <ul className="kura-test" aria-live="polite" data-testid="connection-test" ref={resultRef}>
          {result.steps.map((step) => (
            <li key={step.name} className="kura-test__step" data-ok={step.ok}>
              {step.ok ? <CheckCircle2 size={16} aria-hidden /> : step.name === '局域网可达' ? <CircleDashed size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
              <span className="kura-test__name">{step.name}</span>
              <span className="kura-test__detail">{step.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="kura-form__actions">
        <Button type="button" variant="secondary" disabled={testing || saving} onClick={() => void runTest()}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button type="submit" disabled={testing || saving || result?.ok === false}>
          {saving ? '保存中…' : submitLabel}
        </Button>
      </div>
      <p className="kura-form__note">凭据用 Windows 当前用户的系统加密（DPAPI）保存在本机，不会上传，也不会写进日志。</p>
    </form>
  )
}
