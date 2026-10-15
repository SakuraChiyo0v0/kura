/** Kura 自己的 IPC 通道与 preload 暴露的 window.kura 形状。 */
import type { DockerActivity, ProjectAction, ProjectFilesView } from '../core/docker-client.js'
import type { ContainerDetail, ContainerStats, DockerOverview, ImageView, NetworkView, UpdateCheck, VolumeView } from '../core/docker-types.js'
import type { LinkModeSetting } from '../core/link.js'
import type { MirrorSnapshot } from '../core/mirror.js'

export type { DockerActivity, ProjectAction, ProjectFilesView }

/** 容器管理的流式操作：实时日志 / 项目 compose 动作 / 删除项目 / 拉镜像 */
export type DockerStreamKind = 'logs' | 'project' | 'remove' | 'pull'

export type DockerStreamEvent =
  | { id: string; type: 'data'; data: string }
  /** code = null：连接断了、没收到结束帧 */
  | { id: string; type: 'exit'; code: number | null }

export const kuraChannels = {
  appInfo: 'kura:app-info',
  quit: 'kura:quit',
  connectionGet: 'kura:connection:get',
  connectionTest: 'kura:connection:test',
  /** 测试连接时主进程每完成一步就推送一次（逐条点亮用） */
  connectionTestStep: 'kura:connection:test-step',
  connectionSave: 'kura:connection:save',
  connectionClear: 'kura:connection:clear',
  mirrorSnapshot: 'kura:mirror:snapshot',
  /** 主进程推送：映射状态有变化（新服务挂上、开关、同步结果、链路切换） */
  mirrorChanged: 'kura:mirror:changed',
  /** 同步通道：preload 在页面脚本跑之前拿到「配了没有」，第一帧就画对 */
  bootstrap: 'kura:bootstrap',
  mirrorSetMode: 'kura:mirror:set-mode',
  mirrorSetEnabled: 'kura:mirror:set-enabled',
  mirrorSetPort: 'kura:mirror:set-port',
  mirrorSync: 'kura:mirror:sync',
  mirrorRetry: 'kura:mirror:retry',
  openExternal: 'kura:open-external',
  copyText: 'kura:copy-text',
  // ---- v0.2 文件 ----
  filesList: 'kura:files:list',
  filesMkdir: 'kura:files:mkdir',
  filesRename: 'kura:files:rename',
  filesRemove: 'kura:files:remove',
  filesUpload: 'kura:files:upload',
  filesDownload: 'kura:files:download',
  filesOpen: 'kura:files:open',
  filesCancel: 'kura:files:cancel',
  filesTransfers: 'kura:files:transfers',
  // ---- v0.2 本机 WebDAV ----
  davGet: 'kura:dav:get',
  davSave: 'kura:dav:save',
  davCheck: 'kura:dav:check',
  // ---- v0.2 NAS 侧 WebDAV 暴露范围（放在 NAS 的 kura-server 上，走网关读写）----
  nasScopeGet: 'kura:nas-scope:get',
  nasScopeSave: 'kura:nas-scope:save',
  nasScopeCheck: 'kura:nas-scope:check',
  // ---- v0.2 终端 ----
  terminalOpen: 'kura:terminal:open',
  terminalWrite: 'kura:terminal:write',
  terminalResize: 'kura:terminal:resize',
  terminalClose: 'kura:terminal:close',
  /** 主进程推送：终端输出与状态 */
  terminalEvent: 'kura:terminal:event',
  terminalAvailable: 'kura:terminal:available',
  // ---- v0.3 模块 ----
  modulesStatus: 'kura:modules:status',
  modulesInstallRclone: 'kura:modules:install-rclone',
  modulesUninstallRclone: 'kura:modules:uninstall-rclone',
  modulesMountSettings: 'kura:modules:mount-settings',
  modulesSaveMount: 'kura:modules:save-mount',
  modulesMount: 'kura:modules:mount',
  modulesUnmount: 'kura:modules:unmount',
  modulesOpenDrive: 'kura:modules:open-drive',
  // ---- 容器管理 ----
  dockerAvailable: 'kura:docker:available',
  dockerOverview: 'kura:docker:overview',
  dockerContainer: 'kura:docker:container',
  dockerStats: 'kura:docker:stats',
  dockerImages: 'kura:docker:images',
  dockerActivity: 'kura:docker:activity',
  dockerContainerAction: 'kura:docker:container-action',
  dockerRemoveContainer: 'kura:docker:remove-container',
  dockerRemoveImage: 'kura:docker:remove-image',
  dockerPruneImages: 'kura:docker:prune-images',
  dockerSaveLogs: 'kura:docker:save-logs',
  dockerStreamOpen: 'kura:docker:stream-open',
  dockerProjectFiles: 'kura:docker:project-files',
  dockerVolumes: 'kura:docker:volumes',
  dockerNetworks: 'kura:docker:networks',
  dockerCheckUpdates: 'kura:docker:check-updates',
  dockerShellOpen: 'kura:docker:shell-open',
  dockerShellInput: 'kura:docker:shell-input',
  dockerShellResize: 'kura:docker:shell-resize',
  dockerSaveProjectFiles: 'kura:docker:save-project-files',
  dockerCreateProject: 'kura:docker:create-project',
  dockerStreamClose: 'kura:docker:stream-close',
  /** 主进程推送：流式操作的输出与结束 */
  dockerStreamEvent: 'kura:docker:stream-event',
} as const

// ---- v0.2 文件管理器 ----

export interface FileEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  modified: number
}

export interface FileListing {
  path: string
  entries: FileEntry[]
}

export interface Transfer {
  id: string
  kind: 'upload' | 'download'
  name: string
  /** NAS 上的路径 */
  remote: string
  /** 本机路径 */
  local: string
  done: number
  total: number
  state: 'running' | 'done' | 'error' | 'cancelled'
  error: string
  startedAt: number
}

// ---- v0.2 本机 WebDAV ----

/**
 * 本机 WebDAV 的设置：只有传输层这两项。范围（include/exclude/readOnly）由 NAS 那份统一管，
 * 见 NasScopeView —— 这里**不列**那几个字段，否则调用方以为能设、传进来却被 `davSave` 静默丢掉。
 */
export interface DavSettingsView {
  enabled: boolean
  port: number
}

export interface DavStatusView {
  settings: DavSettingsView
  url: string
  running: boolean
  lastError: string
  upstreamError: string
  requests: number
  errors: number
  bytesUp: number
  bytesDown: number
  /** 服务端清单里有没有 webdav 服务 */
  available: boolean
}

export interface DavCheckResult {
  path: string
  visibility: 'full' | 'ancestor' | 'hidden'
  reason: string
  writable: boolean
}

/** NAS 侧那份范围（放在 NAS 的 kura-server 上）。界面改的就是它，不再是本机那份。 */
export interface NasScopeView {
  include: string[]
  exclude: string[]
  readOnly: boolean
  /** 服务端代码里的默认范围，「恢复默认」用它。 */
  defaults: { include: string[]; exclude: string[]; readOnly: boolean }
}

export type NasScopeCheck = DavCheckResult

// ---- v0.2 终端 ----

export type TerminalEventView =
  | { id: string; type: 'data'; data: string }
  | { id: string; type: 'status'; status: 'connecting' | 'open' | 'closed'; message?: string }

// ---- v0.3 模块 ----

export interface ModulesStatusView {
  rclone: { state: 'missing' | 'installing' | 'ready' | 'error'; path: string; version: string; source: 'kura' | 'system' | ''; progress: number; error: string }
  winfsp: { installed: boolean; path: string }
  mount: { state: 'stopped' | 'starting' | 'mounted' | 'error'; drive: string; error: string; log: string[] }
  pinnedVersion: string
  winfspDownloadPage: string
  /** 本机 WebDAV 有没有在跑（挂载靠它） */
  davRunning: boolean
}

export interface MountSettingsView {
  drive: string
  volumeName: string
  readOnly: boolean
  autoMount: boolean
  cacheMode: 'off' | 'minimal' | 'writes' | 'full'
}

export interface AppInfo {
  version: string
  /** 用户数据目录（设置、凭据、日志都在这里） */
  userData: string
}

/**
 * 引导页填写的表单。密码字段在「已保存过」时可以留空，表示沿用已保存的值。
 *
 * 用户填的是 UGREENlink ID（绿联界面上那串，如 <设备ID>），不是设备域 ——
 * 设备域带节点（cn30），用户看不到也记不住，由主进程查出来。
 */
export interface ConnectionForm {
  uglinkId: string
  ugreenUser: string
  ugreenPassword: string
  /** 留空 = 用查询结果里的局域网地址 */
  lanHost: string
  mode: LinkModeSetting
  gatewayPort: number
}

/** 给渲染层看的连接配置：密码只告诉「有没有」，不回传明文。 */
export interface ConnectionSummary {
  configured: boolean
  uglinkId: string
  /** 由 ID 解析出的设备域，给界面回显（用户不用填，但要能核对） */
  base: string
  ugreenUser: string
  hasUgreenPassword: boolean
  lanHost: string
  mode: LinkModeSetting
  gatewayPort: number
}

export interface ConnectionTestStep {
  name: string
  ok: boolean
  detail: string
  /** 还在进行中（界面显示转圈，不算通过也不算失败） */
  pending?: boolean
}

/** 测试连接过程中推给界面的进度，见主进程 connection.ts 的 TestProgress。 */
export type ConnectionTestProgress =
  | { phase: 'plan'; names: string[] }
  | { phase: 'step'; step: ConnectionTestStep }
  | { phase: 'done' }

export interface ConnectionTestResult {
  ok: boolean
  steps: ConnectionTestStep[]
}

/** 窗口加载时同步取到的初始状态（见 kuraChannels.bootstrap）。 */
export interface KuraBootstrap {
  connection: ConnectionSummary
  /** 已经在跑的映射快照；没配置或还没起来是 null */
  snapshot: MirrorSnapshot | null
}

export interface KuraBridge {
  /** 页面加载前就已取好；第一帧直接用，不用等一次异步往返 */
  bootstrap: KuraBootstrap | null
  appInfo(): Promise<AppInfo>
  /** 真正退出程序（托盘常驻时关窗口不会退出） */
  quit(): Promise<void>
  connection: {
    get(): Promise<ConnectionSummary>
    /** 不保存，只按表单实际登录一遍，逐步报告结果 */
    test(form: ConnectionForm): Promise<ConnectionTestResult>
    /** 订阅测试进度（每条步骤完成时回调）；返回退订函数 */
    onTestProgress(listener: (progress: ConnectionTestProgress) => void): () => void
    /** 加密保存并（重新）启动映射 */
    save(form: ConnectionForm): Promise<ConnectionSummary>
    clear(): Promise<void>
  }
  mirror: {
    /** 未配置连接时为 null */
    snapshot(): Promise<MirrorSnapshot | null>
    /** 订阅主进程推送的快照；返回退订函数 */
    onChange(listener: (snapshot: MirrorSnapshot | null) => void): () => void
    setMode(mode: LinkModeSetting): Promise<void>
    setEnabled(key: string, enabled: boolean): Promise<void>
    setPort(key: string, port: number): Promise<void>
    sync(): Promise<number>
    retry(): Promise<void>
  }
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  files: {
    list(path: string): Promise<FileListing>
    mkdir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(paths: string[]): Promise<void>
    /** 弹出系统选择框选本机文件，上传进 dir；返回开始的传输数（取消选择 = 0） */
    upload(dir: string): Promise<number>
    /** 弹出系统保存框（多个文件时选文件夹）；返回开始的传输数 */
    download(paths: string[]): Promise<number>
    /** 下载到临时目录并用系统默认程序打开 */
    open(path: string): Promise<void>
    cancel(id: string): Promise<void>
    transfers(): Promise<Transfer[]>
  }
  dav: {
    get(): Promise<DavStatusView>
    save(settings: DavSettingsView): Promise<DavStatusView>
    check(path: string): Promise<DavCheckResult>
  }
  /** NAS 侧那份暴露范围（kura-server 上的 `state/webdav.json`）。**唯一**一份范围配置。 */
  nasScope: {
    get(): Promise<NasScopeView>
    save(view: NasScopeView): Promise<NasScopeView>
    check(path: string): Promise<NasScopeCheck>
  }
  terminal: {
    open(): Promise<string>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: TerminalEventView) => void): () => void
    available(): Promise<boolean>
  }
  docker: {
    /** 服务端清单里有没有 docker（kura-server 挂了 docker.sock 才有） */
    available(): Promise<boolean>
    overview(): Promise<DockerOverview>
    container(id: string): Promise<ContainerDetail>
    stats(id: string): Promise<ContainerStats>
    images(): Promise<ImageView[]>
    activity(): Promise<DockerActivity[]>
    containerAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<void>
    removeContainer(id: string, force: boolean): Promise<void>
    removeImage(id: string): Promise<void>
    /** 返回回收的字节数 */
    pruneImages(all: boolean): Promise<number>
    /** 弹保存框存完整日志；返回保存路径（取消 = 空串） */
    saveLogs(id: string, name: string): Promise<string>
    /** 开一个流（实时日志 / 项目操作 / 删除项目 / 拉镜像），返回流 id；输出按 onStream 推 */
    openStream(kind: DockerStreamKind, target: string, action?: ProjectAction, removeOptions?: { volumes: boolean; files: boolean }): Promise<string>
    volumes(withSize: boolean): Promise<VolumeView[]>
    networks(): Promise<NetworkView[]>
    /** 问仓库有没有新版（不拉镜像） */
    checkUpdates(images: string[]): Promise<UpdateCheck[]>
    /** 进容器 shell：返回会话 id；输出与结束走 onStream（和流同一个通道），输入 / 尺寸走下面两个 */
    openShell(container: string, cols: number, rows: number): Promise<string>
    shellInput(id: string, data: string): Promise<void>
    shellResize(id: string, cols: number, rows: number): Promise<void>
    projectFiles(name: string): Promise<ProjectFilesView>
    saveProjectFiles(name: string, next: { compose: Array<{ path: string; content: string }>; env?: string }): Promise<ProjectFilesView>
    createProject(input: { name: string; compose: string; env?: string }): Promise<{ dir: string; configFiles: string[] }>
    closeStream(id: string): Promise<void>
    onStream(listener: (event: DockerStreamEvent) => void): () => void
  }
  modules: {
    status(): Promise<ModulesStatusView>
    installRclone(): Promise<void>
    uninstallRclone(): Promise<void>
    mountSettings(): Promise<MountSettingsView>
    saveMount(settings: MountSettingsView): Promise<MountSettingsView>
    mount(): Promise<void>
    unmount(): Promise<void>
    openDrive(): Promise<void>
  }
}
