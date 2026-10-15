import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeImage, safeStorage, shell } from 'electron'
import {
  acquireSingleInstanceLock,
  createIpcRouter,
  createSettingsStore,
  createTrayManager,
  createUpdateManager,
  createWindowManager,
  createWindowStateStore,
  registerSettingsIpc,
  registerUpdaterIpc,
  registerWindowControls,
  trackWindowMaximizedChange,
  trackWindowState,
} from '@sakura-ui/electron/main'
import { autoUpdater } from 'electron-updater'
import { httpsProxyConfigured } from '../core/http.js'
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
  type TunnelStatus,
} from '../shared/ipc.js'
import type { DbEngine } from '../core/db-types.js'
import { kuraSettingsDefaults, type KuraSettings } from '../shared/settings.js'
import { ConnectionService } from './connection.js'
import { ContainerService, DatabaseService, FileService, LocalDavService, NasScopeService, TerminalService, safeLocalName } from './features.js'
import { DbTunnelService } from './db-tunnel.js'
import type { ProjectAction } from '../core/docker-client.js'
import { McpService } from './mcp.js'
import { ModuleManager, rcloneRelease, winfspDownloadPage } from './modules.js'
import { fileLogger } from './file-log.js'
import { decideWindowClose, isHiddenLaunch, loginItemSettings } from './lifecycle.js'
import { runRestartSmoke, runSmoke } from './smoke.js'
import { applySmokeRoute, smokeRequester } from './smoke-seams.js'
import { UpdateScheduler, friendlyBackend, updaterBackend, updateSource } from './updates.js'
import { CredentialVault } from './vault.js'

// 用户数据固定在 %APPDATA%\Kura，与 Go 版 nas-mirror 的 ~/.nas-mirror 互不干扰
app.setName('Kura')
app.setAppUserModelId('Kura')

const distDir = __dirname
const userData = app.getPath('userData')
const smoke = process.env.KURA_SMOKE === '1'
/** 开机自启拉起来的：只进托盘，窗口等用户点托盘再弹 */
const hiddenLaunch = isHiddenLaunch(process.argv)
const processStartedAt = Date.now()
if (smoke) {
  // 冒烟窗口常被别的窗口挡住：Windows 上 Chromium 会把被遮挡的页面判为 hidden，
  // 页面就按设计停掉轮询（用户看不见时不刷新）、xterm 停渲染 —— 无人值守时判据就会时好时坏（实测约 1/6）。
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

const log = fileLogger(join(userData, 'logs', 'kura.log'), process.env.KURA_VERBOSE === '1')
{
  // 只记有没有、记主机，不记整串：代理地址里可能带用户名密码
  const proxy = httpsProxyConfigured()
  if (proxy) log.info('外网链路走环境代理', { proxy: URL.canParse(proxy) ? new URL(proxy).host : '(无法解析)' })
}
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
const containers = new ContainerService(featureDeps, (event) => windows.broadcast(ch.dockerStreamEvent, event))
const databases = new DatabaseService(featureDeps)
/**
 * 数据库隧道：本机 127.0.0.1:<端口> 的裸 TCP ←→ 映射层的一条 WebSocket ←→ NAS 上的数据库。
 * 裸 TCP 过不了 HTTP 反代，也过不了绿联中继；WebSocket 能过（容器 shell 已验通）。
 */
const dbTunnels = new DbTunnelService({
  open: (name) => databases.openTunnel(name),
  dataDir: userData,
  log,
})
const modules = new ModuleManager({
  dir: join(userData, 'modules'),
  log,
  davUrl: () => {
    const view = localDav.view()
    if (!view.running) throw new Error('本机 WebDAV 没有在运行（文件页 → 本机 WebDAV 里打开它）')
    return view.url
  },
})
/**
 * MCP：给 AI 客户端（Claude Code 等）连的回环 HTTP 端点。与其它能力层共用同一批服务实例 ——
 * AI 的操作走的还是映射层、kura-server 白名单、NAS 那份范围，不另开一条路。
 */
const mcp = new McpService({
  mirror: () => connection.current(),
  dataDir: userData,
  log,
  version: () => app.getVersion(),
  files,
  containers,
  nasScope,
  localDav,
  modules,
  databases,
})

let quitting = false

/** 命令执行的 id 序号（一次 exec 一个，界面据此配对输出帧）。 */
let dbExecSeq = 0

/** 挑一个空闲的本机端口（给隧道用）：绑 0 让系统分配，记下端口立刻放掉。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/**
 * 自动更新：打包后走 GitHub Releases（electron-builder 打包时写进 resources/app-update.yml），
 * 开发模式设 KURA_UPDATE_URL 可以接本机的更新源演练；冒烟永远不接。
 */
const source = updateSource({ packaged: app.isPackaged, smoke, env: process.env })
const updates = (() => {
  if (source.kind === 'off') return undefined
  autoUpdater.logger = {
    info: (message?: unknown) => log.info('更新', { msg: String(message) }),
    warn: (message?: unknown) => log.warn('更新', { msg: String(message) }),
    // electron-updater 的 error 常带整段堆栈：只记第一行
    error: (message?: unknown) => log.error('更新', { msg: String(message).split('\n')[0] }),
  }
  // 下完了用户没点「重启安装」：退出时静默装上（electron-updater 默认就是 true，这里写明）
  autoUpdater.autoInstallOnAppQuit = true
  if (source.kind === 'generic') {
    // 演练用：没打包时 electron-updater 要读 dev-app-update.yml（下载阶段取缓存目录名），这里写一份到 userData
    const config = join(userData, 'dev-app-update.yml')
    writeFileSync(config, `provider: generic\nurl: ${JSON.stringify(source.url)}\nupdaterCacheDirName: kura-updater\n`)
    autoUpdater.updateConfigPath = config
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: source.url })
  }
  const manager = createUpdateManager({
    backend: friendlyBackend(updaterBackend(autoUpdater), log),
    broadcast: (channel, ...args) => windows.broadcast(channel, ...args),
  })
  return { manager, scheduler: new UpdateScheduler({ manager, enabled: () => settingsStore.get('autoCheckUpdates'), log }) }
})()

const windows = createWindowManager<BrowserWindow>({
  create: (name) => {
    const window = new BrowserWindow({
      ...windowState.readOr(name, { width: 1080, height: 720 }),
      // 冒烟（KURA_SMOKE_OFFSCREEN=1）：窗口放到屏幕外、不抢焦点、不进任务栏 ——
      // 对 Windows 来说它仍是「可见」的（关窗隐藏、托盘唤回这些判据照常成立），只是人看不见、不打断正在用电脑的人
      ...(smoke && process.env.KURA_SMOKE_OFFSCREEN === '1' ? { x: -32000, y: -32000, focusable: false, skipTaskbar: true } : {}),
      minWidth: 760,
      minHeight: 520,
      frame: false, // 标题栏由 @sakura-ui/electron-react 提供
      backgroundColor: '#1f2430',
      show: false,
      title: 'Kura',
      icon: join(distDir, 'icon.ico'),
      webPreferences: { preload: join(distDir, 'preload.cjs') },
    })

    trackWindowState({ window, name, store: windowState })
    trackWindowMaximizedChange(window)
    if (!smoke && !hiddenLaunch) window.once('ready-to-show', () => window.show())

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
  containers.closeAll()
  databases.closeAll()
  // 隧道不像映射那样常驻：Kura 退出就关掉（它是用户开的功能，不是核心）
  stopping = Promise.allSettled([modules.unmount(), localDav.close(), mcp.close(), dbTunnels.close()])
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
  router.handle(ch.appInfo, (): AppInfo => ({ version: app.getVersion(), userData, updatesEnabled: updates !== undefined }))
  router.handle(ch.changelog, () => readFileSync(join(distDir, 'CHANGELOG.md'), 'utf8'))
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
  // ---- 容器 ----
  const dockerId = (id: unknown) => String(id)
  router.handle(ch.dockerAvailable, () => containers.available())
  router.handle(ch.dockerOverview, () => containers.client.overview())
  router.handle(ch.dockerContainer, (_event, id: string) => containers.client.container(dockerId(id)))
  router.handle(ch.dockerStats, (_event, id: string) => containers.client.stats(dockerId(id)))
  router.handle(ch.dockerImages, () => containers.client.images())
  router.handle(ch.dockerActivity, () => containers.client.activity())
  router.handle(ch.dockerContainerAction, (_event, id: string, action: string) => {
    if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new Error(`不支持的操作：${action}`)
    return containers.client.containerAction(dockerId(id), action)
  })
  router.handle(ch.dockerRemoveContainer, (_event, id: string, force: boolean) => containers.client.removeContainer(dockerId(id), Boolean(force)))
  router.handle(ch.dockerRemoveImage, (_event, id: string) => containers.client.removeImage(dockerId(id)))
  router.handle(ch.dockerPruneImages, (_event, all: boolean) => containers.client.pruneImages(Boolean(all)))
  router.handle(ch.dockerSaveLogs, async (event, id: string, name: string) => {
    const window = ownerWindow(event)
    const options: Electron.SaveDialogOptions = {
      title: '保存日志',
      defaultPath: join(app.getPath('downloads'), safeLocalName(`${String(name) || 'container'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`)),
      filters: [{ name: '日志', extensions: ['log', 'txt'] }],
    }
    const saved = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (saved.canceled || !saved.filePath) return ''
    writeFileSync(saved.filePath, await containers.client.logsText(dockerId(id)))
    return saved.filePath
  })
  router.handle(ch.dockerStreamOpen, (_event, kind: string, target: string, action?: string, removeOptions?: { volumes?: unknown; files?: unknown }) => {
    if (kind !== 'logs' && kind !== 'project' && kind !== 'remove' && kind !== 'pull') throw new Error(`不支持的流：${kind}`)
    if (action !== undefined && action !== null && !['up', 'down', 'restart', 'pull'].includes(action)) throw new Error(`不支持的操作：${action}`)
    const remove = { volumes: removeOptions?.volumes === true, files: removeOptions?.files === true }
    return containers.open(kind, String(target), (action ?? undefined) as ProjectAction | undefined, remove)
  })
  router.handle(ch.dockerProjectFiles, (_event, name: string) => containers.client.projectFiles(String(name)))
  router.handle(ch.dockerVolumes, (_event, withSize: boolean) => containers.client.volumes(Boolean(withSize)))
  router.handle(ch.dockerNetworks, () => containers.client.networks())
  router.handle(ch.dockerCheckUpdates, (_event, images: unknown) => containers.client.checkUpdates(Array.isArray(images) ? images.map(String).slice(0, 100) : []))
  router.handle(ch.dockerShellOpen, (_event, container: string, cols: number, rows: number) => containers.openShell(String(container), Number(cols) || 80, Number(rows) || 24))
  router.handle(ch.dockerShellInput, (_event, id: string, data: string) => containers.shellInput(String(id), String(data)))
  router.handle(ch.dockerShellResize, (_event, id: string, cols: number, rows: number) => containers.shellResize(String(id), Number(cols), Number(rows)))
  router.handle(ch.dockerSaveProjectFiles, (_event, name: string, next: { compose?: unknown; env?: unknown }) => {
    const compose = Array.isArray(next?.compose)
      ? next.compose.map((c: { path?: unknown; content?: unknown }) => ({ path: String(c.path), content: String(c.content) }))
      : []
    return containers.client.saveProjectFiles(String(name), { compose, env: typeof next?.env === 'string' ? next.env : undefined })
  })
  router.handle(ch.dockerCreateProject, (_event, input: { name?: unknown; compose?: unknown; env?: unknown }) =>
    containers.client.createProject({ name: String(input?.name ?? ''), compose: String(input?.compose ?? ''), env: typeof input?.env === 'string' ? input.env : undefined }),
  )
  router.handle(ch.dockerStreamClose, (_event, id: string) => containers.close(String(id)))

  // ---- 数据库管理 ----
  // 隧道要跟着数据库列表走：Kura 装上/发现新的数据库就建好监听，消失的拆掉。
  // 这些 handler 都用惰性 list：不做定时轮询（数据库不常变），界面打开时拉一次即可。
  const syncTunnels = async (): Promise<TunnelStatus[]> => {
    const { databases: list } = await databases.list()
    dbTunnels.sync(list.map((d) => ({ name: d.name, engine: d.engine || '' })))
    return dbTunnels.status()
  }
  router.handle(ch.dbAvailable, () => databases.available())
  router.handle(ch.dbTemplates, () => databases.client.templates())
  router.handle(ch.dbList, async () => {
    const result = await databases.list()
    return { ...result, tunnels: await syncTunnels() }
  })
  router.handle(ch.dbInstall, async (_event, engine: string, name: string) => {
    const result = await databases.install(engine as DbEngine, String(name))
    // 装完立刻把隧道建好（默认不开，但要出现在界面上）
    await syncTunnels().catch(() => {})
    return result
  })
  router.handle(ch.dbDetail, (_event, name: string) => databases.detail(String(name)))
  router.handle(ch.dbInfo, (_event, name: string, includePassword?: boolean) => databases.info(String(name), includePassword === true))
  router.handle(ch.dbAction, async (_event, name: string, action: string) => {
    if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new Error(`不支持的操作：${action}`)
    return databases.action(String(name), action)
  })
  router.handle(ch.dbRemove, async (_event, name: string, options: { volumes?: unknown; files?: unknown }) => {
    await databases.remove(String(name), { volumes: options?.volumes === true, files: options?.files === true })
    await syncTunnels().catch(() => {})
  })
  router.handle(ch.dbExec, async (_event, name: string, cli: string, args: unknown, timeoutMs?: number) => {
    const id = `dbexec-${++dbExecSeq}`
    const argv = Array.isArray(args) ? args.map(String) : []
    // 边跑边把输出帧推给界面（命令台的实时输出）；返回的汇总结果同时给调用方
    const result = await databases.exec(
      String(name),
      String(cli),
      argv,
      (event) => windows.broadcast(ch.dbExecEvent, { id, type: 'out', stream: event.stream, text: event.text }),
      timeoutMs,
    )
    windows.broadcast(ch.dbExecEvent, { id, type: 'exit', code: result.exitCode, ...(result.error ? { error: result.error } : {}) })
    return result
  })
  router.handle(ch.dbTunnels, () => syncTunnels())
  router.handle(ch.dbTunnelSetEnabled, async (_event, name: string, enabled: boolean) => {
    await dbTunnels.setEnabled(String(name), enabled === true)
    return dbTunnels.status()
  })
  router.handle(ch.dbTunnelSetPort, async (_event, name: string, port: number) => {
    await dbTunnels.setPort(String(name), Number(port))
    return dbTunnels.status()
  })
  router.handle(ch.dbTunnelPort, () => pickFreePort())

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
    const target = modules.status().mount.target
    if (!target) throw new Error('还没有挂载')
    // 盘符要补反斜杠（"N:" → "N:\"），目录挂载点直接用
    const error = await shell.openPath(target.endsWith(':') ? `${target}\\` : target)
    if (error) throw new Error(error)
  })
  router.handle(ch.modulesPickFolder, async (event) => {
    const window = ownerWindow(event)
    // 选父目录：rclone 的挂载点目录必须不存在，由它自己建（见 MountMode 注释），所以让用户选上级文件夹，Kura 拼一个子目录
    const options: Electron.OpenDialogOptions = { title: '选择放在哪个文件夹下', properties: ['openDirectory', 'createDirectory'] }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return picked.canceled || !picked.filePaths[0] ? '' : picked.filePaths[0]
  })

  // ---- MCP ----
  router.handle(ch.mcpStatus, () => mcp.view())
  router.handle(ch.mcpSave, async (_event, enabled: boolean, port: number) => {
    const next = Number(port)
    if (!Number.isInteger(next) || next < 1 || next > 65535) throw new Error(`端口 ${port} 不合法`)
    // 运行时改动先做，成功了才落盘（与本机 WebDAV 同一个取舍）：端口绑不上时磁盘上留的仍是仍在生效的那份
    await mcp.apply(Boolean(enabled), next)
    settingsStore.set('mcpEnabled', Boolean(enabled))
    settingsStore.set('mcpPort', next)
    return mcp.view()
  })
  router.handle(ch.mcpRotateToken, () => {
    mcp.rotateToken()
    return mcp.view()
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
  if (updates) {
    registerUpdaterIpc({ router, manager: updates.manager })
    updates.scheduler.start()
    settingsStore.onChange((_settings, changed) => {
      if (changed.autoCheckUpdates !== undefined) updates.scheduler.setEnabled(changed.autoCheckUpdates)
    })
  }

  // 开机自启：以设置为准写进 HKCU\…\Run。冒烟不碰注册表。
  if (!smoke) {
    const applyLoginItem = (openAtLogin: boolean) =>
      app.setLoginItemSettings(loginItemSettings({ openAtLogin, packaged: app.isPackaged, appPath: app.getAppPath() }))
    applyLoginItem(settingsStore.get('openAtLogin'))
    settingsStore.onChange((_settings, changed) => {
      if (changed.openAtLogin !== undefined) applyLoginItem(changed.openAtLogin)
    })
  }

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

  // 数据库隧道：上次开着的不等界面打开就恢复，否则本机程序（psql、DBeaver）重启后会连不上，
  // 得先去「数据库」页点一下才有监听。拖不住启动 —— 失败留在状态里（与 localDav / MCP 同规矩）。
  // 还没配好连接时这里会失败，吞掉即可（那时本来也没有隧道要恢复）。
  void databases
    .list()
    .then(({ databases: list }) => dbTunnels.sync(list.map((d) => ({ name: d.name, engine: d.engine || '' }))))
    .catch((error: Error) => log.debug('启动时对齐数据库隧道失败', { err: error.message }))

  // MCP：按设置起（默认关）。起不来的原因留在状态里给界面显示，不拖住启动 ——
  // 与 localDav 一样，端口被占不该让整个程序起不来。
  if (settingsStore.get('mcpEnabled')) {
    try {
      await mcp.apply(true, settingsStore.get('mcpPort'))
    } catch (error) {
      log.warn('MCP 服务器启动失败', { err: (error as Error).message })
    }
  }

  if (smokeRestart) {
    void runRestartSmoke({ window, startedAt: processStartedAt }).then((passed) => {
      process.exitCode = passed ? 0 : 1
      quitApp()
    })
    return
  }

  if (smoke) {
    // MCP 平时默认关着；冒烟里起在端口 0（系统挑一个空闲口），免得跟日常在跑的那个 Kura 抢 18007。
    // 设置也一并写上：界面读的是设置里那份，不写的话会出现「开关关着、却显示正在运行」。
    settingsStore.set('mcpEnabled', true)
    settingsStore.set('mcpPort', 0)
    try {
      await mcp.apply(true, 0)
    } catch (error) {
      log.warn('冒烟：MCP 启动失败', { err: (error as Error).message })
    }
    const mcpView = mcp.view()
    void runSmoke({
      window,
      userData,
      isTrayCreated: () => tray.isCreated(),
      showMainWindow,
      davUrl: () => localDav.view().url,
      mcp: { url: mcpView.url, token: mcpView.token },
    }).then((passed) => {
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
