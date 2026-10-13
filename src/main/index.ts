import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, ipcMain, nativeImage, safeStorage, shell } from 'electron'
import {
  acquireSingleInstanceLock,
  createIpcRouter,
  createSettingsStore,
  createTrayManager,
  createWindowManager,
  createWindowStateStore,
  registerSettingsIpc,
  registerWindowControls,
  trackWindowMaximizedChange,
  trackWindowState,
} from '@sakura-ui/electron/main'
import { linkModeLabel, type LinkModeSetting } from '../core/link.js'
import { kuraChannels as ch, type AppInfo, type ConnectionForm } from '../shared/ipc.js'
import { kuraSettingsDefaults, type KuraSettings } from '../shared/settings.js'
import { ConnectionService } from './connection.js'
import { fileLogger } from './file-log.js'
import { decideWindowClose } from './lifecycle.js'
import { runSmoke } from './smoke.js'
import { applySmokeRoute, smokeRequester } from './smoke-seams.js'
import { CredentialVault } from './vault.js'

// 用户数据固定在 %APPDATA%\Kura，与 Go 版 nas-mirror 的 ~/.nas-mirror 互不干扰
app.setName('Kura')
app.setAppUserModelId('Kura')

const distDir = __dirname
const userData = app.getPath('userData')
const smoke = process.env.KURA_SMOKE === '1'

const log = fileLogger(join(userData, 'logs', 'kura.log'), process.env.KURA_VERBOSE === '1')
const settingsStore = createSettingsStore<KuraSettings>({
  file: join(userData, 'settings.json'),
  defaults: kuraSettingsDefaults,
})
const windowState = createWindowStateStore(join(userData, 'window-state.json'))
const router = createIpcRouter(ipcMain)
const connection = new ConnectionService(
  new CredentialVault(join(userData, 'credentials.json'), safeStorage),
  { dataDir: join(userData, 'mirror'), log, request: smokeRequester() },
  log,
  applySmokeRoute,
)

let quitting = false

const windows = createWindowManager<BrowserWindow>({
  create: (name) => {
    const window = new BrowserWindow({
      ...windowState.readOr(name, { width: 1080, height: 720 }),
      minWidth: 760,
      minHeight: 520,
      frame: false, // 标题栏由 @sakura-ui/electron-react 提供
      backgroundColor: '#1f2430',
      show: false,
      title: 'Kura',
      webPreferences: { preload: join(distDir, 'preload.cjs') },
    })

    trackWindowState({ window, name, store: windowState })
    trackWindowMaximizedChange(window)
    if (!smoke) window.once('ready-to-show', () => window.show())

    // 托盘常驻：关窗口默认只隐藏，映射服务继续在主进程里跑
    window.on('close', (event) => {
      const decision = decideWindowClose({
        quitting,
        closeToTray: settingsStore.get('closeToTray'),
        trayAvailable: tray.isCreated(),
      })
      if (decision === 'hide') {
        event.preventDefault()
        window.hide()
      }
    })

    // 页面内的外链一律交给系统浏览器，不在应用窗口里打开
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    void window.loadFile(join(distDir, 'renderer', 'index.html'))
    return window
  },
})

function showMainWindow(): void {
  const window = windows.ensure('main')
  if (!window.isVisible()) window.show()
  windows.focus('main')
}

let stopping: Promise<void> | undefined
function quitApp(): void {
  quitting = true
  app.quit()
}

/** 托盘提示：一眼看出「映射在跑没、走的哪条链路、几个服务」。 */
function trayTooltip(): string {
  const snap = connection.current()?.snapshot()
  if (!snap) return connection.summary().configured ? 'Kura · 正在启动' : 'Kura · 尚未连接 NAS'
  const running = snap.services.filter((s) => s.listener.running).length
  const auth = snap.auth.blocked ? (snap.auth.credential ? ' · 凭据被拒' : ' · 认证退避中') : ''
  return `Kura · ${linkModeLabel[snap.mode]} · ${running}/${snap.services.length} 个服务${auth}`
}

const tray = createTrayManager<Tray>({
  create: () => new Tray(nativeImage.createFromPath(join(distDir, 'tray.png'))),
  tooltip: trayTooltip,
  onClick: () => showMainWindow(),
  buildMenu: () =>
    Menu.buildFromTemplate([
      { label: '打开 Kura', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
})

acquireSingleInstanceLock({
  app,
  onSecondInstance: () => showMainWindow(),
  onLockFailed: () => {
    // 已有实例在跑：它会收到 second-instance 并把窗口拉到前面，这里安静退出即可
    app.quit()
  },
})

// 退出前先把本机端口都放掉：下一次启动（或 Go 版）马上就能重新绑定
app.on('before-quit', (event) => {
  quitting = true
  if (stopping) return
  event.preventDefault()
  stopping = connection.stop().finally(() => app.quit())
})

// 托盘常驻：窗口全部关掉也不退出
app.on('window-all-closed', () => {
  if (!tray.isCreated()) quitApp()
})

function requireMirror() {
  const mirror = connection.current()
  if (!mirror) throw new Error('还没有连接 NAS：请先在引导页完成设置')
  return mirror
}

function registerKuraIpc(): void {
  router.handle(ch.appInfo, (): AppInfo => ({ version: app.getVersion(), userData }))
  router.handle(ch.quit, () => quitApp())

  router.handle(ch.connectionGet, () => connection.summary())
  router.handle(ch.connectionTest, (_event, form: ConnectionForm) => connection.test(form))
  router.handle(ch.connectionSave, async (_event, form: ConnectionForm) => {
    const summary = await connection.save(form)
    tray.refresh()
    return summary
  })
  router.handle(ch.connectionClear, async () => {
    await connection.clear()
    tray.refresh()
  })

  router.handle(ch.mirrorSnapshot, () => connection.current()?.snapshot() ?? null)
  router.handle(ch.mirrorSetMode, (_event, mode: LinkModeSetting) => requireMirror().setMode(mode))
  router.handle(ch.mirrorSetEnabled, (_event, key: string, enabled: boolean) => requireMirror().setServiceEnabled(key, enabled))
  router.handle(ch.mirrorSetPort, (_event, key: string, port: number) => requireMirror().setServicePort(key, port))
  router.handle(ch.mirrorSync, () => requireMirror().syncNow())
  router.handle(ch.mirrorRetry, () => requireMirror().retryNow())

  router.handle(ch.openExternal, (_event, url: string) => {
    // 只放行 http(s)：渲染层传什么都直接交给 shell 是危险的（file:、自定义协议）
    if (!/^https?:\/\//.test(url)) throw new Error('只能打开 http / https 链接')
    return shell.openExternal(url)
  })
  router.handle(ch.copyText, (_event, text: string) => clipboard.writeText(String(text)))
}

app.whenReady().then(async () => {
  registerWindowControls({
    router,
    getWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? undefined,
  })
  registerSettingsIpc({
    router,
    store: settingsStore,
    broadcast: (channel, ...args) => {
      windows.broadcast(channel, ...args)
    },
  })
  registerKuraIpc()

  tray.ensure()
  const window = windows.ensure('main')
  // 托盘提示随状态更新（悬停时看到的是最近 15 秒内的状态）
  const trayTimer = setInterval(() => tray.refresh(), 15_000)
  trayTimer.unref()

  if (smoke) {
    void runSmoke({ window, userData, isTrayCreated: () => tray.isCreated(), showMainWindow }).then((passed) => {
      process.exitCode = passed ? 0 : 1
      quitApp()
    })
    return
  }

  try {
    await connection.start()
  } catch (error) {
    log.error('启动映射失败', { err: (error as Error).message })
  }
  tray.refresh()
})
