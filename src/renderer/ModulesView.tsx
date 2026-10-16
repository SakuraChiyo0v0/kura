import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Download, ExternalLink, FolderOpen, FolderTree, HardDrive, HardDriveDownload, Network, RefreshCw } from 'lucide-react'
import { Button, ConfirmDialog, EmptyState, FluidSegmented, ProgressBar, SelectField, StatusBadge, SwitchField, TextField, useToast } from '@sakura-ui/react'
import { folderLeaf, folderTarget } from '../shared/mount.js'
import type { ModulesStatusView, MountSettingsView } from '../shared/ipc.js'

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

const drives = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => ({ value: `${d}:`, label: `${d}:` }))

const mountModes: { value: MountSettingsView['mode']; label: string; icon: React.ReactNode; description: string }[] = [
  { value: 'disk', label: '模拟成硬盘', icon: <HardDrive {...icon} />, description: '出现在「此电脑」里，和 C:、D: 并列。程序看不出它是远程盘，兼容性最好。' },
  { value: 'network', label: '网络位置', icon: <Network {...icon} />, description: '出现在「网络位置」里，系统当成一个网络共享。更像远程盘的本来面目，但每次卸载会在资源管理器留下一条历史。' },
  { value: 'folder', label: '挂到文件夹', icon: <FolderTree {...icon} />, description: '不占盘符，只挂成某个目录（如 D:\\KuraNAS）。盘符紧张、或只想让特定程序按路径访问时用。' },
]

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

  // 只认最后一次发出的请求：轮询与按钮触发的刷新会并发，保存也会被连点。
  // 先发后到的旧响应要是也 set，界面就会跳回旧值（例如连点两次开关，最后停在第一次的结果）。
  const statusSeq = useRef(0)
  const saveSeq = useRef(0)
  /** 第一次拿到状态之前失败过：整页给提示，而不是留一片空白 */
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async () => {
    if (!window.kura) return
    const seq = ++statusSeq.current
    try {
      const next = await window.kura.modules.status()
      if (seq === statusSeq.current) setStatus(next)
    } catch (caught) {
      // 轮询挂在定时器上，抛出去就是未处理拒绝；没内容可显示时才把原因摆到页面上
      if (seq === statusSeq.current) setLoadError((prev) => prev || (caught as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.kura?.modules
      .mountSettings()
      .then(setSettings)
      .catch((caught: Error) => setLoadError((prev) => prev || caught.message))
  }, [refresh])

  // 两样都拿到了才算真的好了：只清 status 那次失败的话，mountSettings 的错会被下一轮轮询抹掉、页面又变空白
  useEffect(() => {
    if (status && settings) setLoadError('')
  }, [status, settings])

  // 安装、挂载过程中刷得勤一点
  const active = status?.rclone.state === 'installing' || status?.mount.state === 'starting'
  useEffect(() => {
    const timer = setInterval(() => void refresh(), active ? 600 : 3_000)
    return () => clearInterval(timer)
  }, [active, refresh])

  /**
   * 挂载是异步的：点了按钮那一刻没有结果，失败发生在几秒之后。
   * 卡片底部那行字太长被折叠、也不一定在视口里，所以状态落到 error 时补一条右下角提示。
   */
  const mountFailed = status?.mount.state === 'error' ? status.mount.error : ''
  const notifiedMountError = useRef('')
  useEffect(() => {
    if (!mountFailed || notifiedMountError.current === mountFailed) return
    notifiedMountError.current = mountFailed
    toast.notify({ title: '挂载失败', description: mountFailed, tone: 'error', duration: 0 })
  }, [mountFailed, toast])

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

  if (!status || !settings) {
    if (loadError) {
      return (
        <div className="kura-placeholder">
          <EmptyState
            title="读不到模块状态"
            description={`${loadError}（模块状态由主进程提供；重开 Kura 还这样就是程序自身的问题）`}
            action={
              <Button variant="secondary" icon={<RefreshCw {...icon} />} onClick={() => void refresh().catch((caught: Error) => setLoadError(caught.message))}>
                重试
              </Button>
            }
          />
        </div>
      )
    }
    return null
  }
  const rclone = status.rclone
  const mount = status.mount
  // 「文件夹」模式还没选父目录时不算就绪：挂载按钮灰着，并在字段下说清缺什么
  const folderMissing = settings.mode === 'folder' && !settings.folder.trim()
  const ready = rclone.state === 'ready' && status.winfsp.installed && status.davRunning && !folderMissing
  const mounted = mount.state === 'mounted' || mount.state === 'starting'
  const saveSettings = (next: MountSettingsView) => {
    setSettings(next)
    const seq = ++saveSeq.current
    void window.kura!.modules
      .saveMount(next)
      .then((saved) => {
        if (seq === saveSeq.current) setSettings(saved)
      })
      .catch((caught: Error) => {
        toast.notify({ title: '保存失败', description: caught.message, tone: 'error' })
        // 失败了界面别停在没存上的值：回读主进程那份（同样只认最新一次）
        if (seq === saveSeq.current) void window.kura!.modules.mountSettings().then((current) => seq === saveSeq.current && setSettings(current))
      })
  }

  const mountTone = mount.state === 'mounted' ? 'success' : mount.state === 'starting' ? 'accent' : mount.state === 'error' ? 'danger' : 'neutral'
  const mountLabel = { mounted: `已挂载到 ${mount.target}`, starting: '挂载中…', error: '挂载失败', stopped: '未挂载' }[mount.state]
  // 这次挂载会落在哪儿：folder 模式用「父目录\KuraNAS」，其它模式用盘符。挂载前的按钮与提示都读它
  const mountPoint = settings.folder.trim() ? folderTarget(settings.folder) : ''
  const plannedTarget = settings.mode === 'folder' ? mountPoint : settings.drive
  const pickFolder = async () => {
    const picked = await window.kura!.modules.pickFolder()
    if (picked) saveSettings({ ...settings, folder: picked })
  }

  return (
    <div className="kura-modules">
      <article className="kura-module" data-testid="module-rclone">
        <header className="kura-module__head">
          <HardDrive size={22} strokeWidth={1.6} aria-hidden />
          <div>
            <h2>挂载到本机</h2>
            <p className="kura-form__note">
              用 rclone 把 NAS 挂成本机的一块盘或一个目录，任何程序都能按路径读写。挂载走的是「本机 WebDAV」，暴露范围、只读设置一并生效。
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
          {/* fieldset 只借它的 disabled 语义：FluidSegmented 没有 disabled 属性，靠这个把里面的
              radio 一并禁掉。挂载中改形态会让界面换成另一种字段、真实挂的盘却不动，要换先卸载。 */}
          <fieldset className="kura-module__mode" disabled={mounted}>
            <FluidSegmented label="挂载形态" options={mountModes} value={settings.mode} onValueChange={(v) => saveSettings({ ...settings, mode: v as MountSettingsView['mode'] })} />
            <p className="kura-form__note">{mountModes.find((m) => m.value === settings.mode)?.description}</p>
          </fieldset>

          <div className="kura-module__fields">
            {settings.mode === 'folder' ? (
              <div className="kura-module__folder">
                <TextField
                  label="父目录"
                  value={settings.folder}
                  disabled={mounted}
                  placeholder="D:\\"
                  onChange={(e) => setSettings({ ...settings, folder: e.target.value })}
                  onBlur={() => saveSettings(settings)}
                />
                <Button variant="secondary" icon={<FolderOpen {...icon} />} disabled={mounted} onClick={() => void pickFolder()}>
                  选择…
                </Button>
                <p className="kura-form__note" data-testid="folder-note">
                  {mountPoint ? `会挂到 ${mountPoint}（这个目录由 rclone 创建，不能已存在）` : `选一个文件夹，Kura 会在它下面建 ${folderLeaf} 子目录作为挂载点`}
                </p>
                {folderMissing && (
                  <p className="kura-form__hint" data-testid="folder-missing">
                    <CircleAlert {...icon} />
                    还没选文件夹，选好才能挂载
                  </p>
                )}
              </div>
            ) : (
              <>
                <SelectField label="盘符" value={settings.drive} options={drives} disabled={mounted} onValueChange={(v) => saveSettings({ ...settings, drive: v })} />
                <TextField
                  label="卷名"
                  value={settings.volumeName}
                  disabled={mounted}
                  maxLength={32}
                  onChange={(e) => setSettings({ ...settings, volumeName: e.target.value })}
                  onBlur={() => saveSettings(settings)}
                />
              </>
            )}
            <SelectField
              label="缓存"
              value={settings.cacheMode}
              options={cacheModes}
              disabled={mounted}
              onValueChange={(v) => saveSettings({ ...settings, cacheMode: v as MountSettingsView['cacheMode'] })}
            />
          </div>

          <div className="kura-module__switches">
            <SwitchField label="只读挂载" checked={settings.readOnly} disabled={mounted} onCheckedChange={(v) => saveSettings({ ...settings, readOnly: v })} />
            <SwitchField label="Kura 启动时自动挂载" checked={settings.autoMount} onCheckedChange={(v) => saveSettings({ ...settings, autoMount: v })} />
          </div>
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
            <Button icon={<HardDriveDownload {...icon} />} disabled={!ready || Boolean(busy)} onClick={() => void run('挂载', () => window.kura!.modules.mount())}>
              {busy === '挂载' ? '挂载中…' : plannedTarget ? `挂载到 ${plannedTarget}` : '挂载'}
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
