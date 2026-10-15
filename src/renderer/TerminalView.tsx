import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Banner, Button, EmptyState, StatusBadge } from '@sakura-ui/react'
import type { TerminalEventView } from '../shared/ipc.js'

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
    // 键盘输入 → 主进程 → 映射层 → NAS
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

    // 尺寸变化要告诉服务端（kura-shell 是真 PTY，resize 生效；现网 nas-console 会把它当输入）
    const push = () => {
      try {
        f.fit()
      } catch {
        // 隐藏的标签尺寸为 0，fit 会抛，忽略
        return
      }
      if (t.cols > 0 && t.rows > 0) void window.kura?.terminal.resize(tab.id, t.cols, t.rows)
    }
    const resize = new ResizeObserver(push)
    resize.observe(holder.current!)
    // 首次 fit 后报一次尺寸：ResizeObserver 只在下一次变化时触发，不给服务端正确初值会导致换行错位
    requestAnimationFrame(push)
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

export function TerminalView() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    void window.kura?.terminal.available().then(setAvailable)
    const timer = setInterval(() => void window.kura?.terminal.available().then(setAvailable), 5_000)
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

  if (available === null) return null
  // 终端不需要凭据（kura-server 不做认证）。只有在服务端清单里根本没有终端服务时
  // 才给一句说明 —— 这是部署问题，不是让用户去填什么。
  if (!available) {
    return (
      <div className="kura-term" data-mode="blocked">
        <Banner
          tone="warning"
          description="服务端清单里还没有终端服务：NAS 上要部署 kura-server（或旧的 nas-console），并在网关登记，映射层同步到后终端才能连。"
        />
      </div>
    )
  }

  const current = tabs.find((t) => t.id === active)

  return (
    <div className="kura-term" data-mode="term">
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
        <Button size="sm" variant="ghost" icon={<Plus {...icon} />} onClick={() => void openTab()}>
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
      </div>
      {tabs.length === 0 ? (
        <div className="kura-placeholder">
          <EmptyState
            icon={<SquareTerminal size={22} aria-hidden />}
            title="没有打开的终端"
            description="经映射层连接 NAS 上的终端服务，拿到的是宿主 root shell，操作请谨慎。"
            action={
              <Button onClick={() => void openTab()}>
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
