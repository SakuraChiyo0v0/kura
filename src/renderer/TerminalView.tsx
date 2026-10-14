import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button, EmptyState, FluidSegmented, StatusBadge, TextField, useToast } from '@sakura-ui/react'
import type { TerminalConfigForm, TerminalConfigView, TerminalEventView } from '../shared/ipc.js'

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

type TabStatus = 'connecting' | 'open' | 'closed'

interface Tab {
  id: string
  title: string
  status: TabStatus
  message: string
}

/**
 * 主进程推来的终端事件统一在这里分发：每个标签挂一个 xterm 实例，按 id 找到它写进去。
 * 事件在标签挂好 xterm 之前就可能到（握手很快），先缓存，挂好后补写。
 */
const sinks = new Map<string, (data: string) => void>()
const pending = new Map<string, string[]>()

function routeData(id: string, data: string) {
  const sink = sinks.get(id)
  if (sink) sink(data)
  else pending.set(id, [...(pending.get(id) ?? []), data])
}

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 终端配色跟随 Sakura 的地基变量（亮暗主题切换时 xterm 不会自己读 CSS，要重新给）。 */
function terminalTheme() {
  return {
    background: readCssVar('--sk-surface-sunken') || '#111',
    foreground: readCssVar('--sk-ink') || '#ddd',
    cursor: readCssVar('--sk-accent') || '#e88',
    selectionBackground: readCssVar('--sk-line') || '#555',
  }
}

function XtermPane({ tab, active }: { tab: Tab; active: boolean }) {
  const holder = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--kura-font-mono').trim() || 'Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
      allowProposedApi: false,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(holder.current!)
    term.current = t
    fit.current = f
    // 键盘输入 → 主进程 → nas-console
    const input = t.onData((data) => void window.kura?.terminal.write(tab.id, data))
    sinks.set(tab.id, (data) => t.write(data))
    // 冒烟读的是缓冲区内容，不是画出来的 DOM：窗口被遮挡时渲染帧会被节流，DOM 不一定及时更新
    ;(holder.current as HTMLDivElement & { kuraText?: () => string }).kuraText = () => {
      const buffer = t.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n').trimEnd()
    }
    for (const chunk of pending.get(tab.id) ?? []) t.write(chunk)
    pending.delete(tab.id)

    const resize = new ResizeObserver(() => {
      try {
        f.fit()
      } catch {
        // 隐藏的标签尺寸为 0，fit 会抛，忽略
      }
    })
    resize.observe(holder.current!)
    // 亮暗切换：<html data-sk-theme> 变化时重设配色
    const themeWatch = new MutationObserver(() => (t.options.theme = terminalTheme()))
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sk-theme'] })
    return () => {
      input.dispose()
      resize.disconnect()
      themeWatch.disconnect()
      sinks.delete(tab.id)
      t.dispose()
    }
  }, [tab.id])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        // 同上
      }
      term.current?.focus()
    })
  }, [active])

  return <div className="kura-term__pane" ref={holder} hidden={!active} data-testid="terminal-pane" data-terminal={tab.id} />
}

function ConfigForm({ config, onSaved }: { config: TerminalConfigView; onSaved: (next: TerminalConfigView) => void }) {
  const toast = useToast()
  const [form, setForm] = useState<TerminalConfigForm>({ method: config.method, user: config.user, password: '', token: '' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const set = <K extends keyof TerminalConfigForm>(k: K, v: TerminalConfigForm[K]) => {
    setForm((prev) => ({ ...prev, [k]: v }))
    setResult('')
  }
  const kept = (has: boolean) => (has ? '留空则沿用已保存的' : undefined)

  return (
    <form
      className="kura-form kura-term__config"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        void window
          .kura!.terminal.test(form)
          .then(async (message) => {
            setResult(message)
            onSaved(await window.kura!.terminal.saveConfig(form))
            toast.notify({ title: '已保存', description: message, tone: 'success' })
          })
          .catch((caught: Error) => setResult(`失败：${caught.message}`))
          .finally(() => setBusy(false))
      }}
    >
      <fieldset className="kura-form__group">
        <legend>nas-console 登录</legend>
        <p className="kura-form__note">
          绿联账号与网关由映射层处理；这里是 nas-console 自己的账号（网页终端那套），或在它的 Token 页生成的 API Token。加密保存在本机。
        </p>
        <FluidSegmented
          label="登录方式"
          options={[
            { value: 'password', label: '账号密码' },
            { value: 'token', label: 'API Token' },
          ]}
          value={form.method}
          onValueChange={(v) => set('method', v as TerminalConfigForm['method'])}
        />
        {form.method === 'password' ? (
          <div className="kura-form__row">
            <TextField label="nas-console 账号" value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
            <TextField
              label="nas-console 密码"
              type="password"
              value={form.password}
              description={kept(config.hasPassword)}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
            />
          </div>
        ) : (
          <TextField
            label="API Token"
            type="password"
            placeholder="nsc_…"
            value={form.token}
            description={kept(config.hasToken)}
            onChange={(e) => set('token', e.target.value)}
            autoComplete="off"
          />
        )}
      </fieldset>
      {result && (
        <p className="kura-form__note" data-testid="terminal-config-result">
          {result}
        </p>
      )}
      <div className="kura-form__actions">
        <Button type="submit" disabled={busy}>
          {busy ? '测试中…' : '测试并保存'}
        </Button>
      </div>
    </form>
  )
}

export function TerminalView() {
  const [config, setConfig] = useState<TerminalConfigView | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [showConfig, setShowConfig] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    void window.kura?.terminal.getConfig().then(setConfig)
    const timer = setInterval(() => void window.kura?.terminal.getConfig().then(setConfig), 5_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!window.kura) return
    return window.kura.terminal.onEvent((event: TerminalEventView) => {
      if (event.type === 'data') {
        routeData(event.id, event.data)
        return
      }
      setTabs((prev) => prev.map((t) => (t.id === event.id ? { ...t, status: event.status, message: event.message ?? '' } : t)))
      if (event.status === 'closed' && event.message) routeData(event.id, `\r\n\x1b[33m[${event.message}]\x1b[0m\r\n`)
    })
  }, [])

  const openTab = useCallback(async () => {
    if (!window.kura) return
    const id = await window.kura.terminal.open()
    seq.current += 1
    setTabs((prev) => [...prev, { id, title: `终端 ${seq.current}`, status: 'connecting', message: '' }])
    setActive(id)
  }, [])

  const closeTab = (id: string) => {
    void window.kura?.terminal.close(id)
    sinks.delete(id)
    pending.delete(id)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (active === id) setActive(next.at(-1)?.id ?? '')
      return next
    })
  }

  /** 已断开的标签就地重连：关掉旧会话、在同一个位置开新会话 */
  const reconnect = async (tab: Tab) => {
    if (!window.kura) return
    const id = await window.kura.terminal.open()
    sinks.delete(tab.id)
    setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, id, status: 'connecting', message: '' } : t)))
    setActive(id)
  }

  if (!config) return null
  const configured = config.method === 'token' ? config.hasToken : Boolean(config.user && config.hasPassword)

  if (!configured || showConfig) {
    return (
      <div className="kura-term">
        {!config.available && (
          <p className="kura-banner" data-tone="warning">
            服务端清单里还没有 nas-console 服务：先在 NAS 上部署 nas-console 并登记到网关，映射层同步到后终端才能连。
          </p>
        )}
        <ConfigForm
          config={config}
          onSaved={(next) => {
            setConfig(next)
            setShowConfig(false)
          }}
        />
        {configured && (
          <Button variant="ghost" onClick={() => setShowConfig(false)}>
            返回终端
          </Button>
        )}
      </div>
    )
  }

  const current = tabs.find((t) => t.id === active)

  return (
    <div className="kura-term">
      <div className="kura-term__bar" role="tablist" aria-label="终端标签">
        {tabs.map((tab) => (
          <div key={tab.id} className="kura-term__tab" data-active={tab.id === active || undefined} data-status={tab.status}>
            <button type="button" role="tab" aria-selected={tab.id === active} onClick={() => setActive(tab.id)}>
              <SquareTerminal {...icon} />
              {tab.title}
            </button>
            <button type="button" className="kura-term__close" aria-label={`关闭 ${tab.title}`} onClick={() => closeTab(tab.id)}>
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus {...icon} />} onClick={() => void openTab()} disabled={!config.available}>
          新标签
        </Button>
        <span className="kura-term__spacer" />
        {current && (
          <StatusBadge tone={current.status === 'open' ? 'success' : current.status === 'connecting' ? 'accent' : 'neutral'} dot size="sm">
            {current.status === 'open' ? '已连接' : current.status === 'connecting' ? '连接中' : current.message || '已断开'}
          </StatusBadge>
        )}
        {current?.status === 'closed' && (
          <Button size="sm" variant="secondary" icon={<RotateCcw {...icon} />} onClick={() => void reconnect(current)}>
            重新连接
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowConfig(true)}>
          登录设置
        </Button>
      </div>
      {!config.available && (
        <p className="kura-banner" data-tone="warning">
          服务端清单里没有 nas-console 服务，暂时连不上。
        </p>
      )}
      {tabs.length === 0 ? (
        <div className="kura-placeholder">
          <EmptyState
            icon={<SquareTerminal size={22} aria-hidden />}
            title="没有打开的终端"
            description="经映射层连接 NAS 上的 nas-console，拿到的是宿主 root shell，操作请谨慎。"
            action={
              <Button onClick={() => void openTab()} disabled={!config.available}>
                打开终端
              </Button>
            }
          />
        </div>
      ) : (
        <div className="kura-term__panes">
          {tabs.map((tab) => (
            <XtermPane key={tab.id} tab={tab} active={tab.id === active} />
          ))}
        </div>
      )}
    </div>
  )
}
