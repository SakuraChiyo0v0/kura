import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Banner, Button, ContextMenu, StatusBadge } from '@sakura-ui/react'
import { ClipboardCopy, ClipboardPaste, Eraser, TextSelect } from 'lucide-react'
import type { DockerStreamEvent } from '../shared/ipc.js'
import { buildPastePayload, installTerminalClipboard, pastesMultipleCommands } from './xterm-clipboard.js'

/**
 * 进容器的 shell（docker exec -it），放在容器详情里。和终端页同一套 xterm：
 * 输出走 docker 流事件（data / exit），键盘输入与尺寸走 shellInput / shellResize。
 * 默认不连：点了「连接」才开 exec（开一个就进一条审计）。
 */
export function ContainerShell({ container, subscribe }: { container: string; subscribe: (id: string, listener: (e: DockerStreamEvent) => void) => () => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const [session, setSession] = useState<string>()
  const [state, setState] = useState<'idle' | 'open' | 'closed'>('idle')
  const [error, setError] = useState('')
  const [hasSelection, setHasSelection] = useState(false)
  /** 非 bracketed 时多行粘贴会逐条执行，先问一句 */
  const [confirming, setConfirming] = useState<{ lines: number; resolve: (ok: boolean) => void } | null>(null)

  useEffect(() => {
    if (!session || !holder.current) return
    const css = getComputedStyle(document.documentElement)
    const t = new Terminal({
      fontFamily: css.getPropertyValue('--kura-font-mono').trim() || 'Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: css.getPropertyValue('--sk-surface-sunken').trim() || '#111',
        foreground: css.getPropertyValue('--sk-ink').trim() || '#ddd',
        cursor: css.getPropertyValue('--sk-accent').trim() || '#e88',
      },
      // 右键留给复制/粘贴菜单
      rightClickSelectsWord: false,
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(holder.current)
    term.current = t
    ;(holder.current as HTMLDivElement & { kuraText?: () => string }).kuraText = () => {
      const b = t.buffer.active
      const lines: string[] = []
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n').trimEnd()
    }
    const input = t.onData((data) => void window.kura?.docker.shellInput(session, data))
    // 与终端页同一套复制粘贴：容器 shell 是 docker exec 的 PTY，剪贴板行为必须一致
    const selectionWatch = t.onSelectionChange(() => setHasSelection(t.hasSelection()))
    const dropClipboard = installTerminalClipboard(t, holder.current, {
      write: (data) => void window.kura?.docker.shellInput(session, data),
      copy: (text) => window.kura!.copyText(text),
      read: () => window.kura!.pasteText(),
      confirm: (lines) => new Promise<boolean>((resolve) => setConfirming({ lines, resolve })),
    })
    const off = subscribe(session, (event) => {
      if (event.type === 'data') {
        t.write(event.data)
        setState('open')
      } else {
        t.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n')
        setState('closed')
      }
    })
    const push = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (t.cols > 0 && t.rows > 0) void window.kura?.docker.shellResize(session, t.cols, t.rows)
    }
    const resize = new ResizeObserver(push)
    resize.observe(holder.current)
    requestAnimationFrame(() => {
      push()
      t.focus()
    })
    return () => {
      input.dispose()
      selectionWatch.dispose()
      dropClipboard()
      off()
      resize.disconnect()
      t.dispose()
      term.current = null
      void window.kura?.docker.closeStream(session)
    }
  }, [session, subscribe])

  const pasteFromClipboard = async () => {
    const t = term.current
    if (!t || !session) return
    const text = await window.kura!.pasteText()
    if (!text) return
    const bracketed = t.modes.bracketedPasteMode
    if (pastesMultipleCommands(text, bracketed)) {
      const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length
      const ok = await new Promise<boolean>((resolve) => setConfirming({ lines, resolve }))
      if (!ok) return
    }
    void window.kura?.docker.shellInput(session, buildPastePayload(text, bracketed))
  }

  const copySelection = () => {
    const text = term.current?.getSelection() ?? ''
    if (!text) return
    void window.kura?.copyText(text).then(() => term.current?.clearSelection(), () => {})
  }

  const settle = (ok: boolean) => {
    confirming?.resolve(ok)
    setConfirming(null)
    term.current?.focus()
  }

  if (!session) {
    return (
      <div className="kura-docker-shell__idle">
        <p className="kura-form__note">在容器里开一个交互 shell（依次尝试 bash、ash、sh）。打开和关闭都会记进审计。</p>
        {error && <Banner tone="warning" description={`进不去 shell：${error}`} />}
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void window.kura?.docker
              .openShell(container, 100, 28)
              .then((id) => {
                setState('idle')
                setSession(id)
              })
              // 进不去要吭声（容器没在跑、服务端拒绝都会走到这）；错误同时打进 xterm 那块区域看不见，所以弹 toast
              .catch((caught: Error) => setError(caught.message))
          }
        >
          连接 shell
        </Button>
      </div>
    )
  }
  return (
    <div className="kura-docker-shell">
      <div className="kura-docker-actions">
        <StatusBadge tone={state === 'open' ? 'success' : state === 'closed' ? 'neutral' : 'accent'} dot size="sm">
          {state === 'open' ? '已连接' : state === 'closed' ? '已断开' : '连接中'}
        </StatusBadge>
        <span className="kura-term__spacer" />
        {state === 'closed' ? (
          <Button size="sm" variant="ghost" onClick={() => setSession(undefined)}>
            重新连接
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void window.kura?.docker.closeStream(session).then(() => setSession(undefined))}>
            断开
          </Button>
        )}
      </div>
      {confirming && (
        <Banner
          tone="warning"
          description={`这段内容有 ${confirming.lines} 行。当前 shell 没开 bracketed paste，粘贴会逐行立即执行 —— 确认是要粘这么多命令吗？`}
          action={
            <>
              <Button size="sm" variant="ghost" onClick={() => settle(false)}>
                取消
              </Button>
              <Button size="sm" variant="secondary" onClick={() => settle(true)}>
                仍然粘贴
              </Button>
            </>
          }
        />
      )}
      <ContextMenu
        label="容器 shell 操作"
        items={[
          { id: 'copy', label: '复制', icon: <ClipboardCopy size={15} aria-hidden />, shortcut: 'Ctrl+C', disabled: !hasSelection },
          { id: 'paste', label: '粘贴', icon: <ClipboardPaste size={15} aria-hidden />, shortcut: 'Ctrl+V' },
          { id: 'selectAll', label: '全选', icon: <TextSelect size={15} aria-hidden />, separatorBefore: true },
          { id: 'clear', label: '清屏', icon: <Eraser size={15} aria-hidden /> },
        ]}
        onAction={(id) => {
          if (id === 'copy') copySelection()
          if (id === 'paste') void pasteFromClipboard()
          if (id === 'selectAll') term.current?.selectAll()
          if (id === 'clear') term.current?.clear()
        }}
      >
        <div className="kura-docker-shell__term" ref={holder} data-testid="container-shell" />
      </ContextMenu>
    </div>
  )
}
