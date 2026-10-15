import { useEffect, useState } from 'react'
import {
  Button,
  EmptyState,
  PageTransition,
  SakuraProvider,
  SelectField,
  SidebarNav,
  SwitchField,
  ToastProvider,
} from '@sakura-ui/react'
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TitleBar,
  WindowControls,
  useSettings,
} from '@sakura-ui/electron-react'
// 样式需显式引入，顺序：地基 → 通用组件 → Electron 组件
import '@sakura-ui/tokens/tokens.css'
import '@sakura-ui/react/styles.css'
import '@sakura-ui/electron-react/styles.css'
import type { ConnectionSummary } from '../shared/ipc.js'
import { kuraSettingsDefaults, type KuraSettings, type ThemePreference } from '../shared/settings.js'
import { ConnectionForm } from './ConnectionForm.js'
import { ContainersView } from './ContainersView.js'
import { FilesView } from './FilesView.js'
import { McpSection } from './McpView.js'
import { MirrorView } from './MirrorView.js'
import { ModulesView } from './ModulesView.js'
import { OverviewView } from './OverviewView.js'
import { StartupProgress } from './StartupProgress.js'
import { TerminalView } from './TerminalView.js'
import { UpdateReadyToast, UpdatesSection, WhatsNew } from './UpdatesView.js'
import { findPage, pages, type PageDef, type PageId } from './pages.js'
import { useConnection, useMirrorSnapshot } from './use-mirror.js'

const darkQuery = '(prefers-color-scheme: dark)'

/** 「跟随系统 / 浅色 / 深色」解析成实际亮暗；跟随系统时监听系统切换。 */
function useResolvedTheme(theme: ThemePreference): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(darkQuery).matches)
  useEffect(() => {
    const query = window.matchMedia(darkQuery)
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  // <html> 也带上主题：滚动条与 SakuraProvider 外的底色同步
  useEffect(() => {
    document.documentElement.dataset.skTheme = resolved
  }, [resolved])
  return resolved
}

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const

function SettingsView({
  settings,
  set,
  connection,
  onConnectionSaved,
  onConnectionCleared,
}: {
  settings: KuraSettings
  set: <K extends keyof KuraSettings>(key: K, value: KuraSettings[K]) => void
  connection: ConnectionSummary | undefined
  onConnectionSaved: (summary: ConnectionSummary) => void
  onConnectionCleared: () => void
}) {
  return (
    <SettingsPage title="设置" description="改动立即生效并保存。">
      <SettingsSection title="外观">
        <SettingsRow
          label="主题"
          description="跟随系统时按 Windows 的亮暗偏好自动切换"
          control={
            <SelectField
              label="主题"
              value={settings.theme}
              options={themeOptions}
              onValueChange={(value) => set('theme', value as ThemePreference)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="运行">
        <SwitchField
          label="关闭窗口时退到托盘"
          description="服务映射在后台继续运行；从托盘菜单选「退出」才会真正关闭"
          checked={settings.closeToTray}
          onCheckedChange={(value) => set('closeToTray', value)}
        />
        <SwitchField
          label="登录 Windows 时自动启动"
          description="开机后直接在托盘里跑映射，不弹窗口"
          checked={settings.openAtLogin}
          onCheckedChange={(value) => set('openAtLogin', value)}
        />
      </SettingsSection>
      <SettingsSection title="NAS 连接">
        <div className="kura-settings-connection">
          {connection?.configured ? (
            <ConnectionForm summary={connection} onSaved={onConnectionSaved} submitLabel="保存并重新连接" />
          ) : (
            <p className="kura-form__note">还没有连接 NAS。</p>
          )}
          {connection?.configured && (
            <div className="kura-form__actions">
              <Button
                variant="ghost"
                onClick={() => {
                  if (!window.confirm('清除已保存的连接与凭据？映射会立即停止，需要重新走一遍引导。')) return
                  void window.kura?.connection.clear().then(onConnectionCleared)
                }}
              >
                清除连接与凭据
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>
      <UpdatesSection autoCheck={settings.autoCheckUpdates} onAutoCheckChange={(value) => set('autoCheckUpdates', value)} />
      <McpSection enabled={settings.mcpEnabled} port={settings.mcpPort} onSetting={set} />
    </SettingsPage>
  )
}

/** 尚未实现的页面：说清楚它将来做什么、哪个版本做，而不是一片空白。 */
function PlannedView({ page }: { page: PageDef }) {
  return (
    <div className="kura-placeholder">
      <EmptyState icon={page.icon} title={`${page.label} · ${page.plannedIn} 实现`} description={page.summary} />
    </div>
  )
}

/** 首次启动：没有连接配置时整窗只显示引导，不让人对着一排空页面猜该干什么。 */
function Onboarding({ onSaved }: { onSaved: (summary: ConnectionSummary) => void }) {
  return (
    <main className="kura-onboarding">
      <header className="kura-page-header">
        <p className="kura-eyebrow">欢迎使用 Kura 蔵</p>
        <h1 className="kura-page-title" data-testid="page-title">
          连接你的绿联 NAS
        </h1>
        <p className="kura-page-summary">
          填一次就好：之后 Kura 会在后台登录、续期，把 NAS 上的服务映射到本机 127.0.0.1，在家走局域网、在外走中继，自动切换。
        </p>
      </header>
      <ConnectionForm summary={undefined} onSaved={onSaved} />
    </main>
  )
}

function Shell() {
  const { settings, set, loading } = useSettings<KuraSettings>(kuraSettingsDefaults)
  const [activeId, setActiveId] = useState<PageId>('overview')
  const { summary, reload, setSummary } = useConnection()
  const configured = summary?.configured === true
  // 启动那一刻有没有连过 NAS：刚走完引导的新用户不弹「更新内容」（summary 第一帧就由 preload 同步取好）
  const [configuredAtStart] = useState(configured)
  const { snapshot, refresh } = useMirrorSnapshot(configured)
  const page = findPage(activeId)

  // 第一帧就有 summary（preload 同步取好），只有同步通道失败的退路下才会等这一下
  if (summary === undefined && window.kura) return null
  if (!configured) {
    return (
      <Onboarding
        onSaved={(next) => {
          setSummary(next)
          setActiveId('mirror')
        }}
      />
    )
  }

  const content = (() => {
    switch (page.id) {
      case 'settings':
        return (
          <SettingsView
            settings={settings}
            set={set}
            connection={summary}
            onConnectionSaved={(next) => {
              setSummary(next)
              void refresh()
            }}
            onConnectionCleared={() => void reload()}
          />
        )
      case 'overview':
      case 'mirror':
        // 还没有任何服务可显示（首次连接、或连缓存都没有）：给分步进度，而不是一句「正在启动」
        if (!snapshot || (snapshot.services.length === 0 && snapshot.phase !== 'ready')) {
          return <StartupProgress snapshot={snapshot} onRetry={() => void window.kura?.mirror.retry().then(() => window.kura?.mirror.sync())} />
        }
        return page.id === 'overview' ? (
          <OverviewView snapshot={snapshot} onOpenMirror={() => setActiveId('mirror')} />
        ) : (
          <MirrorView snapshot={snapshot} refresh={refresh} />
        )
      case 'files':
        return <FilesView />
      case 'terminal':
        // 终端页的正文常驻在下面的 .kura-term-host 里，这里只留页头（见那里的注释）
        return null
      case 'containers':
        return <ContainersView mapped={snapshot?.services ?? []} onOpenMirror={() => setActiveId('mirror')} />
      case 'modules':
        return <ModulesView />
      default:
        return <PlannedView page={page} />
    }
  })()

  return (
    <div className="kura-body">
      <WhatsNew
        lastSeen={settings.lastSeenVersion}
        existingUser={configuredAtStart}
        ready={!loading}
        onSeen={(version) => set('lastSeenVersion', version)}
      />
      <SidebarNav
        items={pages}
        activeId={activeId}
        onNavigate={(id) => setActiveId(id as PageId)}
        collapsed={settings.sidebarCollapsed}
        onCollapsedChange={(value) => set('sidebarCollapsed', value)}
        header={<span className="kura-brand">Kura 蔵</span>}
      />
      <main className="kura-main" data-terminal-active={page.id === 'terminal' || undefined}>
        <PageTransition routeKey={page.id}>
          <header className="kura-page-header">
            <h1 className="kura-page-title" data-testid="page-title">
              {page.label}
            </h1>
            {page.id !== 'settings' && <p className="kura-page-summary">{page.summary}</p>}
          </header>
          {content}
        </PageTransition>
        {/*
          终端页常驻在这里，**不能**放进上面那个 PageTransition：它按 routeKey 记住子树，
          切页时是卸载重建 —— 标签列表与 xterm 回滚缓冲会一起没掉，而主进程的 PTY 还活着，
          于是切回来看到「没有打开的终端」，其实会话还在。用 hidden 藏起来就都保住了。
          放在 main 末尾是为了让 DOM 与视觉顺序一致（主区在前、终端在后，终端被隐藏时不影响布局）。
        */}
        <div className="kura-term-host" hidden={page.id !== 'terminal'}>
          <TerminalView />
        </div>
      </main>
    </div>
  )
}

export function App() {
  const { settings } = useSettings<KuraSettings>(kuraSettingsDefaults)
  const theme = useResolvedTheme(settings.theme)
  return (
    <SakuraProvider theme={theme} motionPreset="soft">
      <ToastProvider>
        <div className="kura-app">
          <TitleBar title="Kura" actions={<WindowControls />} />
          {/* 放在 Shell 外：引导页上也要能收到「新版本已下载」 */}
          <UpdateReadyToast />
          <Shell />
        </div>
      </ToastProvider>
    </SakuraProvider>
  )
}
