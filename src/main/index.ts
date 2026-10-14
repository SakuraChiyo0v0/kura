import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell } from 'electron'
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
import {
  kuraChannels as ch,
  type AppInfo,
  type ConnectionForm,
  type DavSettingsView,
  type KuraBootstrap,
  type ModulesStatusView,
  type MountSettingsView,
  type NasScopeView,
} from '../shared/ipc.js'
import { kuraSettingsDefaults, type KuraSettings } from '../shared/settings.js'
import { ConnectionService } from './connection.js'
import { FileService, LocalDavService, NasScopeService, TerminalService, safeLocalName } from './features.js'
import { ModuleManager, rcloneRelease, winfspDownloadPage } from './modules.js'
import { fileLogger } from './file-log.js'
import { decideWindowClose } from './lifecycle.js'
import { runRestartSmoke, runSmoke } from './smoke.js'
import { applySmokeRoute, smokeRequester } from './smoke-seams.js'
import { CredentialVault } from './vault.js'

// 用户数据固定在 %APPDATA%\Kura，与 Go 版 nas-mirror 的 ~/.nas-mirror 互不干扰
app.setName('Kura')
app.setAppUserModelId('Kura')

const distDir = __dirname
const userData = app.getPath('userData')
const smoke = process.env.KURA_SMOKE === '1'
const processStartedAt = Date.now()
if (smoke) {
  // 冒烟窗口常被别的窗口挡住：Windows 上 Chromium 会把被遮挡的页面判为 hidden，
  // 页面就按设计停掉轮询（用户看不见时不刷新）、xterm 停渲染 —— 无人值守时判据就会时好时坏（实测约 1/6）。
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

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

const featureDeps = { mirror: () => connection.current(), dataDir: userData, log, request: smokeRequester() }
const files = new FileService(featureDeps)
const localDav = new LocalDavService(featureDeps)
const nasScope = new NasScopeService(featureDeps)
const terminals = new TerminalService(
  featureDeps,
  (event) => windows.broadcast(ch.terminalEvent, event),
)
const modules = new ModuleManager({
  dir: join(userData, 'modules'),
  log,
  davUrl: () => {
    const view = localDav.view()
    if (!view.running) throw new Error('本机 WebDAV 没有在运行（文件页 → 本机 WebDAV 里打开它）')
    return view.url
  },
})

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
/** 清理跑完了没有。与 stopping（进行中）分开：两者共用一个值会让「进行中」被当成「已完成」。 */
let stopped = false
function quitApp(): void {
  quitting = true
  app.quit()
}

/** 托盘提示：一眼看出「映射在跑没、走的哪条链路、几个服务」。 */
function trayTooltip(): string {
  const snap = connection.current()?.snapshot()
  if (!snap) return connection.summary().configured ? 'Kura · 正在启动' : 'Kura · 尚未连接 NAS'
  const running = snap.services.filter((s) => s.listener.running).length
  const auth = snap.auth.blocked ? ' · 连接退避中' : ''
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
  // 清理已完成：放行这次退出（finally 里的 app.quit() 走到这里）
  if (stopped) return
  // 清理进行中又被点了一次退出：这次也必须拦下来。以前这里是直接 return，
  // 没 preventDefault，Electron 会走默认退出流程，在 unmount / close / stop 跑完前就把进程干掉。
  event.preventDefault()
  if (stopping) return
  terminals.closeAll()
  stopping = Promise.allSettled([modules.unmount(), localDav.close()])
    .then(() => connection.stop())
    .finally(() => {
      stopped = true
      stopping = undefined
      app.quit()
    })
})

// 托盘常驻：窗口全部关掉也不退出
app.on('window-all-closed', () => {
  if (!tray.isCreated()) quitApp()
})

/**
 * 映射状态一变就推给所有窗口（合并 150ms 内的连续变化，同步一轮挂上十几个服务只推一次）。
 * 界面不再靠 3 秒轮询干等：服务挂上的同一刻卡片就出现。轮询仍保留，只用来刷新流量数字。
 */
let pushTimer: NodeJS.Timeout | undefined
function pushSnapshot(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    windows.broadcast(ch.mirrorChanged, connection.current()?.snapshot() ?? null)
    tray.refresh()
  }, 150)
}
let unsubscribeMirror: (() => void) | undefined
connection.onMirrorChange((mirror) => {
  unsubscribeMirror?.()
  unsubscribeMirror = mirror?.onChange(pushSnapshot)
  pushSnapshot()
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
  router.handle(ch.connectionTest, (_event, form: ConnectionForm) =>
    connection.test(form, (progress) => windows.broadcast(ch.connectionTestStep, progress)),
  )
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

  // 同步通道只给 preload 用（ipcRenderer.sendSync）：返回的是现成的内存状态，不做任何 IO，
  // 所以不会把渲染进程卡住。sendSync 不走 router（router 只处理 invoke）。
  ipcMain.on(ch.bootstrap, (event) => {
    event.returnValue = { connection: connection.summary(), snapshot: connection.current()?.snapshot() ?? null } satisfies KuraBootstrap
  })
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

  // ---- 文件 ----
  const ownerWindow = (event: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender) ?? undefined
  router.handle(ch.filesList, (_event, path: string) => files.list(String(path)))
  router.handle(ch.filesMkdir, (_event, path: string) => files.mkdir(String(path)))
  router.handle(ch.filesRename, (_event, from: string, to: string) => files.rename(String(from), String(to)))
  router.handle(ch.filesRemove, (_event, paths: string[]) => files.remove(paths.map(String)))
  router.handle(ch.filesTransfers, () => files.listTransfers())
  router.handle(ch.filesCancel, (_event, id: string) => files.cancel(String(id)))
  router.handle(ch.filesUpload, async (event, dir: string) => {
    const window = ownerWindow(event)
    const options: Electron.OpenDialogOptions = { title: '选择要上传的文件', properties: ['openFile', 'multiSelections'] }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (picked.canceled) return 0
    for (const file of picked.filePaths) files.upload(file, String(dir))
    return picked.filePaths.length
  })
  router.handle(ch.filesDownload, async (event, paths: string[]) => {
    const window = ownerWindow(event)
    const list = paths.map(String)
    const entries = await Promise.all(list.map((p) => files.client.stat(p)))
    // 只有一个文件：另存为；多个、或含文件夹：选一个目标文件夹
    const single = entries[0]
    if (list.length === 1 && single && !single.isDir) {
      const options: Electron.SaveDialogOptions = { title: '保存到', defaultPath: join(app.getPath('downloads'), safeLocalName(single.name)) }
      const saved = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
      if (saved.canceled || !saved.filePath) return 0
      files.download(single.path, saved.filePath)
      return 1
    }
    const options: Electron.OpenDialogOptions = {
      title: '下载到哪个文件夹',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const targetDir = picked.filePaths[0]
    if (picked.canceled || !targetDir) return 0
    let count = 0
    for (const entry of entries) {
      if (!entry) continue
      const target = join(targetDir, safeLocalName(entry.name))
      if (entry.isDir) count += await files.downloadTree(entry.path, target)
      else {
        files.download(entry.path, target)
        count += 1
      }
    }
    return count
  })
  router.handle(ch.filesOpen, async (_event, path: string) => {
    const entry = await files.client.stat(String(path))
    if (!entry || entry.isDir) throw new Error('只能打开文件')
    // 每次打开放进独立子目录：同名文件不互相覆盖，被别的程序占着的旧副本也不影响
    const dir = join(app.getPath('temp'), 'Kura', `open-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, safeLocalName(entry.name))
    await files.downloadNow(entry.path, target)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  // ---- 本机 WebDAV ----
  router.handle(ch.davGet, () => localDav.view())
  router.handle(ch.davSave, (_event, settings: DavSettingsView) => localDav.save(settings))
  router.handle(ch.davCheck, (_event, path: string) => nasScope.check(String(path)))

  // ---- NAS 侧暴露范围（走网关读写 kura-server 上的那一份）----
  router.handle(ch.nasScopeGet, () => nasScope.get())
  router.handle(ch.nasScopeSave, (_event, view: NasScopeView) => nasScope.save(view))
  router.handle(ch.nasScopeCheck, (_event, path: string) => nasScope.check(String(path)))

  // ---- 终端 ----
  router.handle(ch.terminalOpen, () => terminals.open())
  router.handle(ch.terminalWrite, (_event, id: string, data: string) => terminals.write(String(id), String(data)))
  router.handle(ch.terminalResize, (_event, id: string, cols: number, rows: number) => terminals.resize(String(id), Number(cols), Number(rows)))
  router.handle(ch.terminalClose, (_event, id: string) => terminals.close(String(id)))
  router.handle(ch.terminalAvailable, () => terminals.available())

  // ---- 模块 ----
  router.handle(ch.modulesStatus, (): ModulesStatusView => ({
    ...modules.status(),
    pinnedVersion: rcloneRelease.version,
    winfspDownloadPage,
    davRunning: localDav.view().running,
  }))
  router.handle(ch.modulesInstallRclone, () => modules.installRclone())
  router.handle(ch.modulesUninstallRclone, () => modules.uninstallRclone())
  router.handle(ch.modulesMountSettings, () => modules.mountSettings())
  router.handle(ch.modulesSaveMount, (_event, settings: MountSettingsView) => modules.saveMountSettings(settings))
  router.handle(ch.modulesMount, () => modules.mount())
  router.handle(ch.modulesUnmount, () => modules.unmount())
  router.handle(ch.modulesOpenDrive, async () => {
    const drive = modules.status().mount.drive
    if (!drive) throw new Error('还没有挂载')
    const error = await shell.openPath(`${drive}\\`)
    if (error) throw new Error(error)
  })
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
  // 先把映射起起来再开窗口：Mirror.start() 只挂上次缓存的清单、不等网络（登录与拉清单在后台），
  // 通常几十毫秒。这样窗口第一帧（preload 同步取 bootstrap）就已经有服务卡片，而不是先空白、再跳出来。
  const smokeRestart = smoke && process.env.KURA_SMOKE_PHASE === 'restart'
  if (!smoke || smokeRestart) {
    try {
      await connection.start()
    } catch (error) {
      log.error('启动映射失败', { err: (error as Error).message })
    }
  }
  const window = windows.ensure('main')
  // 托盘提示随状态更新（悬停时看到的是最近 15 秒内的状态）
  const trayTimer = setInterval(() => tray.refresh(), 15_000)
  trayTimer.unref()

  await localDav.start()

  if (smokeRestart) {
    void runRestartSmoke({ window, startedAt: processStartedAt }).then((passed) => {
      process.exitCode = passed ? 0 : 1
      quitApp()
    })
    return
  }

  if (smoke) {
    void runSmoke({ window, userData, isTrayCreated: () => tray.isCreated(), showMainWindow, davUrl: () => localDav.view().url }).then((passed) => {
      process.exitCode = passed ? 0 : 1
      quitApp()
    })
    return
  }

  await modules.detect()
  if (modules.mountSettings().autoMount && connection.current()) {
    void modules.mount().catch((error: Error) => log.warn('自动挂载失败', { err: error.message }))
  }
  tray.refresh()
})
