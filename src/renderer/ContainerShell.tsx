import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button, StatusBadge } from '@sakura-ui/react'
import type { DockerStreamEvent } from '../shared/ipc.js'

/**
 * 进容器的 shell（docker exec -it），放在容器详情里。和终端页同一套 xterm：
 * 输出走 docker 流事件（data / exit），键盘输入与尺寸走 shellInput / shellResize。
 * 默认不连：点了「连接」才开 exec（开一个就进一条审计）。
 */
export function ContainerShell({ container, subscribe }: { container: string; subscribe: (id: string, listener: (e: DockerStreamEvent) => void) => () => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const [session, setSession] = useState<string>()
  const [state, setState] = useState<'idle' | 'open' | 'closed'>('idle')

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
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(holder.current)
    ;(holder.current as HTMLDivElement & { kuraText?: () => string }).kuraText = () => {
      const b = t.buffer.active
      const lines: string[] = []
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
      return lines.join('\n').trimEnd()
    }
    const input = t.onData((data) => void window.kura?.docker.shellInput(session, data))
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
      off()
      resize.disconnect()
      t.dispose()
      void window.kura?.docker.closeStream(session)
    }
  }, [session, subscribe])

  if (!session) {
    return (
      <div className="kura-docker-shell__idle">
        <p className="kura-form__note">在容器里开一个交互 shell（依次尝试 bash、ash、sh）。打开和关闭都会记进审计。</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void window.kura?.docker.openShell(container, 100, 28).then((id) => {
              setState('idle')
              setSession(id)
            })
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
      <div className="kura-docker-shell__term" ref={holder} data-testid="container-shell" />
    </div>
  )
}
