import { useEffect, useState } from 'react'
import { Button, SwitchField, TextField, useToast } from '@sakura-ui/react'
import { SettingsSection } from '@sakura-ui/electron-react'
import type { McpStatusView } from '../shared/ipc.js'
import type { KuraSettings } from '../shared/settings.js'

/**
 * 设置页的 MCP 一节：给 AI 客户端（Claude Code 等）连的服务器。
 *
 * 界面只做三件事：开关、端口、把接入命令交给用户复制。工具的权限边界不在这里配 ——
 * 它调的就是界面上那批能力，范围由 NAS 那份裁剪、容器走 kura-server 的白名单。
 */
export function McpSection({
  enabled,
  port,
  onSetting,
}: {
  enabled: boolean
  port: number
  /** 与设置页其它项同一个 setter：本地缓存跟着运行状态一起更新 */
  onSetting: <K extends 'mcpEnabled' | 'mcpPort'>(key: K, value: KuraSettings[K]) => void
}) {
  const toast = useToast()
  const [status, setStatus] = useState<McpStatusView>()
  const [portDraft, setPortDraft] = useState(String(port))
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    void window.kura?.mcp
      .status()
      .then((next) => {
        setStatus(next)
        setPortDraft(String(next.port))
      })
      .catch(() => {})
  }
  useEffect(load, [])

  const apply = (nextEnabled: boolean, nextPort: number) => {
    setBusy(true)
    setError('')
    void window.kura?.mcp
      .save(nextEnabled, nextPort)
      .then((next) => {
        setStatus(next)
        onSetting('mcpEnabled', next.enabled)
        onSetting('mcpPort', next.port)
      })
      .catch((reason: Error) => {
        // 端口被占这类失败用户是点了开关/改完端口才发生的：右下角弹一条，字段旁也留一句
        setError(reason.message)
        toast.notify({ title: 'MCP 设置没保存上', description: reason.message, tone: 'error', duration: 0 })
      })
      .finally(() => setBusy(false))
  }

  const command = status ? `claude mcp add --transport http kura ${status.url} --header "Authorization: Bearer ${status.token}"` : ''
  const running = status?.running === true

  return (
    <SettingsSection title="MCP（给 AI 客户端连接）">
      <div className="kura-settings-connection" data-testid="mcp-section">
        <SwitchField
          label="启用 MCP 服务器"
          description="只监听本机回环地址，并校验来源与令牌。开启后 AI 客户端（如 Claude Code）可以读写 NAS 上的文件、管理容器与映射"
          checked={enabled}
          onCheckedChange={(value) => apply(value, Number(portDraft) || port)}
        />
        <TextField
          label="端口"
          description="回环端口，改完立即生效；被占用会退回原端口"
          value={portDraft}
          inputMode="numeric"
          disabled={busy}
          onChange={(event) => setPortDraft(event.target.value.replace(/\D/g, '').slice(0, 5))}
          onBlur={() => {
            const next = Number(portDraft)
            if (Number.isInteger(next) && next >= 1 && next <= 65535) apply(enabled, next)
            else setPortDraft(String(status?.port ?? port))
          }}
        />
        <p className="kura-form__note">
          {running ? (
            <>
              正在运行 · 对外 {status?.toolCount} 个工具 · <span data-testid="mcp-url">{status?.url}</span>
            </>
          ) : enabled ? (
            <>没有在监听{status?.lastError ? `：${status.lastError}` : ''}</>
          ) : (
            '未启用'
          )}
        </p>
        {error && <p className="kura-form__note kura-form__note--warn">{error}</p>}

        {enabled && status && (
          <>
            <TextField
              label="接入令牌"
              description="客户端配置里要用到它。换令牌会让已连上的客户端立刻失效"
              readOnly
              value={showToken ? status.token : '•'.repeat(24)}
              suffix={
                <Button variant="ghost" onClick={() => setShowToken((value) => !value)}>
                  {showToken ? '隐藏' : '显示'}
                </Button>
              }
            />
            <div className="kura-form__actions">
              <Button
                variant="ghost"
                onClick={() => {
                  void window.kura
                    ?.copyText(command)
                    .then(() => toast.notify({ tone: 'success', title: '接入命令已复制' }))
                    .catch((reason: Error) => toast.notify({ tone: 'error', title: '复制失败', description: reason.message }))
                }}
              >
                复制接入命令
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (!window.confirm('换一把新令牌？已连上的 AI 客户端会立刻断开，需要用新令牌重新配置。')) return
                  void window.kura?.mcp
                    .rotateToken()
                    .then((next) => {
                      setStatus(next)
                      setShowToken(true)
                      toast.notify({ title: '已换新令牌', description: '已连上的客户端要拿新令牌重配', tone: 'success' })
                    })
                    .catch((reason: Error) => toast.notify({ title: '换令牌失败', description: reason.message, tone: 'error', duration: 0 }))
                }}
              >
                换一把新令牌
              </Button>
            </div>
            <pre className="kura-changelog__notes" data-testid="mcp-command">
              {command}
            </pre>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
