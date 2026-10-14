import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Download, ExternalLink, FolderOpen, HardDrive, RefreshCw } from 'lucide-react'
import { Button, ConfirmDialog, ProgressBar, SelectField, StatusBadge, SwitchField, TextField, useToast } from '@sakura-ui/react'
import type { ModulesStatusView, MountSettingsView } from '../shared/ipc.js'

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

const drives = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => ({ value: `${d}:`, label: `${d}:` }))
const cacheModes = [
  { value: 'writes', label: '写入缓存（推荐）', description: 'Office、图片编辑器这类「写临时文件再改名」的程序能正常保存' },
  { value: 'minimal', label: '最少', description: '只缓存正在打开写入的文件' },
  { value: 'full', label: '完整', description: '读也缓存到本机，反复打开同一文件最快，占本机磁盘' },
  { value: 'off', label: '关闭', description: '不占本机磁盘，但很多程序无法直接保存到盘里' },
] as const

function Requirement({ ok, title, detail, action }: { ok: boolean; title: string; detail: string; action?: React.ReactNode }) {
  return (
    <li className="kura-req" data-ok={ok}>
      {ok ? <CheckCircle2 {...icon} /> : <CircleAlert {...icon} />}
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {action}
    </li>
  )
}

export function ModulesView() {
  const toast = useToast()
  const [status, setStatus] = useState<ModulesStatusView | null>(null)
  const [settings, setSettings] = useState<MountSettingsView | null>(null)
  const [busy, setBusy] = useState('')

  const refresh = useCallback(async () => {
    if (!window.kura) return
    setStatus(await window.kura.modules.status())
  }, [])

  useEffect(() => {
    void refresh()
    void window.kura?.modules.mountSettings().then(setSettings)
  }, [refresh])

  // 安装、挂载过程中刷得勤一点
  const active = status?.rclone.state === 'installing' || status?.mount.state === 'starting'
  useEffect(() => {
    const timer = setInterval(() => void refresh(), active ? 600 : 3_000)
    return () => clearInterval(timer)
  }, [active, refresh])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await action()
    } catch (caught) {
      toast.notify({ title: `${label}失败`, description: (caught as Error).message, tone: 'error', duration: 0 })
    } finally {
      setBusy('')
      void refresh()
    }
  }

  if (!status || !settings) return null
  const rclone = status.rclone
  const mount = status.mount
  const ready = rclone.state === 'ready' && status.winfsp.installed && status.davRunning
  const mounted = mount.state === 'mounted' || mount.state === 'starting'
  const saveSettings = (next: MountSettingsView) => {
    setSettings(next)
    void window.kura!.modules.saveMount(next).then(setSettings).catch((caught: Error) => toast.notify({ title: '保存失败', description: caught.message, tone: 'error' }))
  }

  const mountTone = mount.state === 'mounted' ? 'success' : mount.state === 'starting' ? 'accent' : mount.state === 'error' ? 'danger' : 'neutral'
  const mountLabel = { mounted: `已挂载为 ${mount.drive}`, starting: '挂载中…', error: '挂载失败', stopped: '未挂载' }[mount.state]

  return (
    <div className="kura-modules">
      <article className="kura-module" data-testid="module-rclone">
        <header className="kura-module__head">
          <HardDrive size={22} strokeWidth={1.6} aria-hidden />
          <div>
            <h2>挂载为本机磁盘</h2>
            <p className="kura-form__note">
              用 rclone 把 NAS 挂成一个盘符，任何程序都能像本地磁盘一样读写。挂载走的是「本机 WebDAV」，暴露范围、只读设置一并生效。
            </p>
          </div>
          <StatusBadge tone={mountTone} dot>
            {mountLabel}
          </StatusBadge>
        </header>

        <ul className="kura-reqs">
          <Requirement
            ok={rclone.state === 'ready'}
            title={rclone.state === 'ready' ? `rclone ${rclone.version || ''}` : 'rclone'}
            detail={
              rclone.state === 'ready'
                ? rclone.source === 'system'
                  ? `使用系统里已有的：${rclone.path}`
                  : `Kura 安装的副本：${rclone.path}`
                : rclone.state === 'installing'
                  ? `正在下载 ${status.pinnedVersion}（约 25 MB），下载完会校验 SHA256`
                  : rclone.state === 'error'
                    ? rclone.error
                    : `未安装。Kura 会从 rclone 官方下载固定版本 ${status.pinnedVersion}，校验后放进 Kura 的数据目录，不改系统`
            }
            action={
              rclone.state === 'ready' ? (
                rclone.source === 'kura' && (
                  <ConfirmDialog
                    triggerLabel="卸载"
                    title="卸载 rclone？"
                    description="会先卸掉已挂载的盘，再删除 Kura 下载的 rclone。之后需要时可以再装。"
                    confirmLabel="卸载"
                    tone="danger"
                    onConfirm={() => run('卸载', () => window.kura!.modules.uninstallRclone())}
                  />
                )
              ) : (
                <Button icon={<Download {...icon} />} disabled={rclone.state === 'installing' || Boolean(busy)} onClick={() => void run('安装 rclone', () => window.kura!.modules.installRclone())}>
                  {rclone.state === 'installing' ? '安装中…' : rclone.state === 'error' ? '重试安装' : '安装'}
                </Button>
              )
            }
          />
          {rclone.state === 'installing' && <ProgressBar label="下载 rclone" value={Math.round(rclone.progress * 100)} max={100} showValue />}
          <Requirement
            ok={status.winfsp.installed}
            title="WinFsp"
            detail={
              status.winfsp.installed
                ? `已安装：${status.winfsp.path}`
                : 'Windows 挂载文件系统需要的驱动。要管理员权限，Kura 不替你装：从官网下载安装包装一次即可，装完点「重新检测」'
            }
            action={
              !status.winfsp.installed && (
                <Button variant="secondary" icon={<ExternalLink {...icon} />} onClick={() => void window.kura?.openExternal(status.winfspDownloadPage)}>
                  官网下载
                </Button>
              )
            }
          />
          <Requirement
            ok={status.davRunning}
            title="本机 WebDAV"
            detail={status.davRunning ? '正在运行，挂载会经它访问 NAS' : '没有运行：到「文件 → 本机 WebDAV」打开它'}
          />
        </ul>

        <div className="kura-module__settings">
          <SelectField label="盘符" value={settings.drive} options={drives} disabled={mounted} onValueChange={(v) => saveSettings({ ...settings, drive: v })} />
          <TextField
            label="卷名"
            value={settings.volumeName}
            disabled={mounted}
            maxLength={32}
            onChange={(e) => setSettings({ ...settings, volumeName: e.target.value })}
            onBlur={() => saveSettings(settings)}
          />
          <SelectField
            label="缓存"
            value={settings.cacheMode}
            options={cacheModes}
            disabled={mounted}
            onValueChange={(v) => saveSettings({ ...settings, cacheMode: v as MountSettingsView['cacheMode'] })}
          />
          <SwitchField label="只读挂载" checked={settings.readOnly} disabled={mounted} onCheckedChange={(v) => saveSettings({ ...settings, readOnly: v })} />
          <SwitchField label="Kura 启动时自动挂载" checked={settings.autoMount} onCheckedChange={(v) => saveSettings({ ...settings, autoMount: v })} />
        </div>

        {mount.error && <p className="kura-card__error">{mount.error}</p>}

        <div className="kura-form__actions">
          {mounted ? (
            <>
              <Button variant="secondary" icon={<FolderOpen {...icon} />} disabled={mount.state !== 'mounted'} onClick={() => void run('打开', () => window.kura!.modules.openDrive())}>
                在资源管理器中打开
              </Button>
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void run('卸载磁盘', () => window.kura!.modules.unmount())}>
                {busy === '卸载磁盘' ? '卸载中…' : '卸载磁盘'}
              </Button>
            </>
          ) : (
            <Button icon={<HardDrive {...icon} />} disabled={!ready || Boolean(busy)} onClick={() => void run('挂载', () => window.kura!.modules.mount())}>
              {busy === '挂载' ? '挂载中…' : `挂载为 ${settings.drive}`}
            </Button>
          )}
          <Button variant="ghost" icon={<RefreshCw {...icon} />} onClick={() => void refresh()}>
            重新检测
          </Button>
        </div>

        {mount.log.length > 0 && (
          <details className="kura-module__log">
            <summary>rclone 输出（最近 {mount.log.length} 行）</summary>
            <pre>{mount.log.join('\n')}</pre>
          </details>
        )}
      </article>
    </div>
  )
}
