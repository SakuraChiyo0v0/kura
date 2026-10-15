import { useEffect, useRef, useState } from 'react'
import { Button, FocusDialog, SwitchField, useToast } from '@sakura-ui/react'
import { SettingsSection, UpdateBanner } from '@sakura-ui/electron-react'
import type { AppInfo } from '../shared/ipc.js'
import { useKuraUpdater } from './use-updater.js'
import { entriesBetween, parseChangelog, shouldShowWhatsNew, type ChangelogEntry } from '../shared/changelog.js'

/** 应用版本、是否接了更新源、打进包里的更新日志：只取一次 */
export function useAppMeta(): { info: AppInfo | undefined; changelog: ChangelogEntry[] } {
  const [info, setInfo] = useState<AppInfo>()
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([])
  useEffect(() => {
    let active = true
    void window.kura?.appInfo().then((value) => active && setInfo(value))
    void window.kura
      ?.changelog()
      .then((text) => active && setChangelog(parseChangelog(text)))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  return { info, changelog }
}

function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  return (
    <div className="kura-changelog">
      {entries.map((entry) => (
        <section key={entry.version} className="kura-changelog__entry">
          <h3 className="kura-changelog__version">
            {entry.version}
            {entry.date && <span className="kura-changelog__date">{entry.date}</span>}
          </h3>
          <ul>
            {entry.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** 设置页「关于与更新」 */
export function UpdatesSection({
  autoCheck,
  onAutoCheckChange,
}: {
  autoCheck: boolean
  onAutoCheckChange: (value: boolean) => void
}) {
  const { info, changelog } = useAppMeta()
  const { status, check, download, install } = useKuraUpdater(info?.updatesEnabled === true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const current = info ? changelog.find((entry) => entry.version === info.version) : undefined

  return (
    <SettingsSection title="关于与更新">
      <div className="kura-settings-connection" data-testid="updates-section">
        <p className="kura-form__note">
          当前版本 <strong data-testid="app-version">{info?.version ?? '…'}</strong>
          {info && !info.updatesEnabled && '（开发构建，不检查更新）'}
        </p>
        {info?.updatesEnabled && (
          <>
            <UpdateBanner status={status} onCheck={check} onDownload={download} onInstall={install} />
            {status.state === 'available' && status.releaseNotes && (
              <pre className="kura-changelog__notes">{status.releaseNotes}</pre>
            )}
          </>
        )}
        {current && (
          <div>
            <p className="kura-form__note">本版本更新内容</p>
            <ChangelogList entries={[current]} />
          </div>
        )}
        <div className="kura-form__actions">
          <FocusDialog
            triggerLabel="历次更新内容"
            title="更新日志"
            description="每个版本改了什么"
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            triggerClassName="sk-control-button sk-control-button--secondary sk-control-button--md"
          >
            <ChangelogList entries={changelog} />
          </FocusDialog>
        </div>
      </div>
      {info?.updatesEnabled && (
        <SwitchField
          label="自动检查更新"
          description="启动一分钟后检查，之后每 6 小时一次；有新版本在后台下载，退出时自动安装"
          checked={autoCheck}
          onCheckedChange={onAutoCheckChange}
        />
      )}
    </SettingsSection>
  )
}

/**
 * 升级后第一次打开：弹一次「本次更新内容」，关掉就记下当前版本，之后不再弹。
 * 只认打进包里的那份 CHANGELOG（跳过的版本也会一起列出来）。
 */
export function WhatsNew({
  lastSeen,
  existingUser,
  ready,
  onSeen,
}: {
  lastSeen: string
  existingUser: boolean
  /** 设置读到了才判断，否则拿默认值的空串会误判成「没看过」 */
  ready: boolean
  onSeen: (version: string) => void
}) {
  const { info, changelog } = useAppMeta()
  const [open, setOpen] = useState(false)
  const decided = useRef(false)

  useEffect(() => {
    if (decided.current || !ready || !info || changelog.length === 0) return
    decided.current = true
    if (shouldShowWhatsNew({ lastSeen, current: info.version, existingUser })) setOpen(true)
    // 全新安装：不弹，但也记下版本，下次升级才有比较的起点
    else if (lastSeen !== info.version) onSeen(info.version)
  }, [ready, info, changelog, lastSeen, existingUser, onSeen])

  if (!info) return null
  const entries = entriesBetween(changelog, lastSeen, info.version)
  return (
    <FocusDialog
      triggerLabel="本次更新内容"
      title={`Kura 已更新到 ${info.version}`}
      description="本次更新内容"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onSeen(info.version)
      }}
      triggerClassName="kura-whats-new-trigger"
      className="kura-whats-new"
    >
      <ChangelogList entries={entries.length > 0 ? entries : changelog.slice(0, 1)} />
      <div className="kura-form__actions">
        <Button
          onClick={() => {
            setOpen(false)
            onSeen(info.version)
          }}
        >
          知道了
        </Button>
      </div>
    </FocusDialog>
  )
}

/** 后台下完新版本：不打断，只在右下角提示一次，可以当场重启安装 */
export function UpdateReadyToast() {
  const { info } = useAppMeta()
  const { status, install } = useKuraUpdater(info?.updatesEnabled === true)
  const toast = useToast()
  const notified = useRef('')
  useEffect(() => {
    if (status.state !== 'downloaded' || notified.current === status.version) return
    notified.current = status.version
    toast.notify({
      title: `新版本 ${status.version} 已下载`,
      description: '现在重启即可安装；不重启的话，下次退出 Kura 时自动装上',
      tone: 'info',
      duration: 0,
      action: { label: '重启安装', onClick: install },
    })
  }, [status, toast, install])
  return null
}
