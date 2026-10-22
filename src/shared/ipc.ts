/** Kura 自己的 IPC 通道与 preload 暴露的 window.kura 形状。 */
import type { DockerActivity, ProjectAction, ProjectFilesView } from '../core/docker-client.js'
import type { AutoUpdateRunResult, AutoUpdateStatus, ContainerDetail, ContainerStats, DockerInfo, DockerOverview, ImageView, NetworkView, UpdateCheck, VolumeView } from '../core/docker-types.js'
import type { DatabaseView, DbExecResult, DatabaseTemplate, VersionList, ImageVersion } from '../core/db-client.js'
import type {
  DbQueryResult,
  DbRowsPage,
  DbSchemaNode,
  DbTableDetail,
  DbTableNode,
  RedisKeyPage,
  RedisValue,
} from '../core/db-browse.js'
import type { DbEngine } from '../core/db-types.js'
import type { LinkModeSetting } from '../core/link.js'
import type { MirrorSnapshot } from '../core/mirror.js'
import type { TunnelStatus } from '../main/db-tunnel.js'

export type { DockerActivity, ProjectAction, ProjectFilesView, DatabaseView, DatabaseTemplate, DbEngine, DbExecResult, TunnelStatus, VersionList, ImageVersion }

/** 命令执行的输出帧：stream 1 = stdout、2 = stderr。 */
export interface DbExecEventView {
  id: string
  type: 'out' | 'exit'
  stream?: 1 | 2
  text?: string
  code?: number
  error?: string
}

/** 命令执行的结果（主进程收完整理后回给界面）。 */
export interface DbExecView {
  exitCode: number
  error?: string
  stdout: string
  stderr: string
  durationMs: number
}

/** 容器管理的流式操作：实时日志 / 项目 compose 动作 / 删除项目 / 拉镜像 / 清理镜像 */
export type DockerStreamKind = 'logs' | 'project' | 'remove' | 'pull' | 'prune'

/**
 * 清理镜像的两档范围。用 `openStream('prune', scope)` 的 target 传下去，
 * `DatabaseService.open()` 里按 `target === 'all'` 决定要不要带 `all=1`。
 *
 * - `dangling`：只清没有标签的（`<none>`），Docker 的 `dangling=true`
 * - `all`：清所有没有任何容器在用的，**包含**悬空的（`dangling=false`，即 Docker 的 `prune -a`）
 */
export type PruneScope = 'dangling' | 'all'

export type DockerStreamEvent =
  | { id: string; type: 'data'; data: string }
  /** code = null：连接断了、没收到结束帧 */
  | { id: string; type: 'exit'; code: number | null }

export const kuraChannels = {
  appInfo: 'kura:app-info',
  /** 打进包里的 CHANGELOG.md 原文 */
  changelog: 'kura:changelog',
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
  /** 读系统剪贴板（终端粘贴用）。渲染层拿不到可靠的 navigator.clipboard：页面是 file:// 加载的 */
  pasteText: 'kura:paste-text',
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
  /** 目录选择器：列 NAS 上的子目录（只列目录，范围之外也能挑） */
  nasScopeBrowse: 'kura:nas-scope:browse',
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
  modulesPickFolder: 'kura:modules:pick-folder',
  // ---- 容器管理 ----
  dockerAvailable: 'kura:docker:available',
  dockerOverview: 'kura:docker:overview',
  dockerInfo: 'kura:docker:info',
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
  dockerAutoUpdate: 'kura:docker:auto-update',
  dockerSetAutoUpdate: 'kura:docker:set-auto-update',
  dockerRunAutoUpdate: 'kura:docker:run-auto-update',
  dockerShellOpen: 'kura:docker:shell-open',
  dockerShellInput: 'kura:docker:shell-input',
  dockerShellResize: 'kura:docker:shell-resize',
  dockerSaveProjectFiles: 'kura:docker:save-project-files',
  dockerCreateProject: 'kura:docker:create-project',
  dockerStreamClose: 'kura:docker:stream-close',
  /** 主进程推送：流式操作的输出与结束 */
  dockerStreamEvent: 'kura:docker:stream-event',
  // ---- 数据库管理 ----
  dbAvailable: 'kura:db:available',
  dbTemplates: 'kura:db:templates',
  dbList: 'kura:db:list',
  dbInstall: 'kura:db:install',
  dbDetail: 'kura:db:detail',
  dbInfo: 'kura:db:info',
  dbAction: 'kura:db:action',
  dbRemove: 'kura:db:remove',
  dbExec: 'kura:db:exec',
  /** 主进程推送：命令执行的输出帧（一条命令一个 id） */
  dbExecEvent: 'kura:db:exec-event',
  dbExecClose: 'kura:db:exec-close',
  /** 隧道（本机回环端口 → NAS 上的数据库） */
  dbTunnels: 'kura:db:tunnels',
  dbTunnelSetEnabled: 'kura:db:tunnel-set-enabled',
  dbTunnelSetPort: 'kura:db:tunnel-set-port',
  dbTunnelPort: 'kura:db:tunnel-port',
  /** Docker Hub 上可装的版本 */
  dbVersions: 'kura:db:versions',
  /** 数据浏览：服务端自己说数据库协议，拿结构化结果（与 exec 的文本输出是两条路） */
  dbBrowseAvailable: 'kura:db:browse-available',
  dbRedisKeys: 'kura:db:redis-keys',
  dbRedisValue: 'kura:db:redis-value',
  dbRedisCommand: 'kura:db:redis-command',
  /** 关系库（MySQL / MariaDB / PostgreSQL）：schema → tables → table → rows */
  dbSchemas: 'kura:db:schemas',
  dbTables: 'kura:db:tables',
  dbTable: 'kura:db:table',
  dbRows: 'kura:db:rows',
  dbQuery: 'kura:db:query',
  // ---- MCP（给 AI 客户端连的服务器）----
  mcpStatus: 'kura:mcp:status',
  mcpSave: 'kura:mcp:save',
  mcpRotateToken: 'kura:mcp:rotate-token',
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

/**
 * 目录选择器列出来的一项。只列目录 —— NAS 上的文件名不经过这个接口
 * （接口在暴露范围**之外**，否则挑不了范围外的目录；少给一样东西就少一分越界）。
 */
export interface NasDirEntry {
  name: string
  /** NAS 上的路径，可直接填进放行 / 排除规则 */
  path: string
}

export interface NasDirListing {
  path: string
  entries: NasDirEntry[]
  /** 超过上限被截断了，界面要说清「只显示前 N 个」 */
  truncated: boolean
}


// ---- v0.2 终端 ----

export type TerminalEventView =
  | { id: string; type: 'data'; data: string }
  | { id: string; type: 'status'; status: 'connecting' | 'open' | 'closed'; message?: string }

// ---- v0.3 模块 ----

export interface ModulesStatusView {
  rclone: { state: 'missing' | 'installing' | 'ready' | 'error'; path: string; version: string; source: 'kura' | 'system' | ''; progress: number; error: string }
  winfsp: { installed: boolean; path: string }
  mount: { state: 'stopped' | 'starting' | 'mounted' | 'error'; target: string; error: string; log: string[] }
  pinnedVersion: string
  winfspDownloadPage: string
  /** 本机 WebDAV 有没有在跑（挂载靠它） */
  davRunning: boolean
}

export type MountModeView = 'disk' | 'network' | 'folder'

export interface MountSettingsView {
  mode: MountModeView
  drive: string
  folder: string
  volumeName: string
  readOnly: boolean
  autoMount: boolean
  cacheMode: 'off' | 'minimal' | 'writes' | 'full'
  /** 缓存上限（GB）；0 = 不限制。超了由 rclone 淘汰最久没用的 */
  cacheMaxGb: number
}

export interface AppInfo {
  version: string
  /** 用户数据目录（设置、凭据、日志都在这里） */
  userData: string
  /** 这个构建接没接更新源（开发模式、冒烟不接）；没接时界面不显示「检查更新」 */
  updatesEnabled: boolean
}

// ---- MCP ----

/** 给 AI 客户端连的 MCP 服务器的状态。令牌回明文 —— 它就是给人复制到客户端配置里的。 */
export interface McpStatusView {
  enabled: boolean
  port: number
  running: boolean
  lastError: string
  /** 接入地址，如 http://127.0.0.1:18007/mcp */
  url: string
  token: string
  /** 暴露给 AI 的工具个数 */
  toolCount: number
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
  /** 打进包里的更新日志原文（解析见 shared/changelog.ts） */
  changelog(): Promise<string>
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
  /** 读系统剪贴板里的纯文本。终端粘贴用它 —— 页面是 file:// 加载的，navigator.clipboard 不可靠 */
  pasteText(): Promise<string>
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
    /** 目录选择器用：列 NAS 上的子目录。**不**受当前范围裁剪，否则挑不到范围外的目录。 */
    browse(path: string): Promise<NasDirListing>
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
    /** Docker 守护进程的系统信息（只读）：版本、根目录、镜像加速器 */
    info(): Promise<DockerInfo>
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
    /** 按项目的自动更新：开了开关的项目 + 上一轮结果 */
    autoUpdate(): Promise<AutoUpdateStatus>
    /** 开 / 关某个项目的自动更新；返回改完的状态 */
    setAutoUpdate(name: string, on: boolean): Promise<AutoUpdateStatus>
    /** 立刻跑一轮（所有开了开关的项目） */
    runAutoUpdate(): Promise<AutoUpdateRunResult[]>
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
  /** 数据库管理：NAS 上 Docker 里的 PostgreSQL / MySQL / MariaDB / Redis。 */
  databases: {
    /** 服务端有没有数据库接口（老镜像只有容器管理，会 404） */
    available(): Promise<boolean>
    templates(): Promise<DatabaseTemplate[]>
    /** 某个引擎在 Docker Hub 上有哪些版本可装（查不到时回 error 字段，界面回退默认镜像） */
    versions(engine: DbEngine, registry?: string): Promise<VersionList>
    list(): Promise<{ databases: DatabaseView[]; tunnelAvailable: boolean; installAvailable?: boolean }>
    /** 快捷安装：建项目、起容器、登记。可能几十秒 */
    /** 快捷安装。image 不填用模板默认的；填了必须是这个引擎的官方镜像。可能几十秒 */
    install(engine: DbEngine, name: string, image?: string): Promise<{ ok: boolean; name: string; engine: DbEngine; image: string; output: string; connection: { container: string; port: number; database: string; user: string } }>
    detail(name: string): Promise<DatabaseView>
    /** 连接信息；includePassword 默认 false */
    info(name: string, includePassword?: boolean): Promise<DatabaseView & { password?: string }>
    action(name: string, action: 'start' | 'stop' | 'restart'): Promise<void>
    remove(name: string, options: { volumes: boolean; files: boolean }): Promise<void>
    /** 跑一条命令（docker exec 进官方镜像跑官方 CLI）；输出按 onExec 推，返回汇总结果 */
    exec(name: string, cli: string, args: string[], timeoutMs?: number): Promise<DbExecView>
    onExec(listener: (event: DbExecEventView) => void): () => void
    /** 服务端带不带数据浏览接口（老镜像只有 M1） */
    browseAvailable(): Promise<boolean>
    /** Redis：扫一页 key */
    redisKeys(name: string, options?: { cursor?: string; match?: string; count?: number; password?: string }): Promise<RedisKeyPage>
    /** Redis：读一个 key 的值 */
    redisValue(name: string, key: string, options?: { password?: string }): Promise<RedisValue>
    /** Redis：跑一条用户命令 */
    redisCommand(name: string, args: string[], options?: { password?: string; timeoutMs?: number }): Promise<{ text: string; binary: boolean; ms: number }>
    /** 关系库：列出库（schema） */
    schemas(name: string, options?: { password?: string }): Promise<DbSchemaNode[]>
    /** 关系库：列一个库里的表 */
    tables(name: string, schema: string, options?: { password?: string }): Promise<DbTableNode[]>
    /** 关系库：一张表的结构 */
    table(name: string, schema: string, table: string, options?: { password?: string }): Promise<DbTableDetail>
    /** 关系库：读一页表数据 */
    rows(name: string, options: { schema: string; table: string; offset?: number; limit?: number; orderBy?: string; password?: string }): Promise<DbRowsPage>
    /** 关系库：跑一条 SQL */
    query(name: string, sql: string, options?: { database?: string; password?: string; timeoutMs?: number }): Promise<DbQueryResult>
    /** 本机隧道的状态（哪个数据库开在哪台端口） */
    tunnels(): Promise<TunnelStatus[]>
    tunnelSetEnabled(name: string, enabled: boolean): Promise<TunnelStatus[]>
    tunnelSetPort(name: string, port: number): Promise<TunnelStatus[]>
    /** 给一个数据库挑一个空闲的本机端口（界面「自动」按钮用） */
    tunnelPickPort(): Promise<number>
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
    /** 选一个目录作为 folder 模式的挂载点父目录；取消返回 '' */
    pickFolder(): Promise<string>
  }
  /** 给 AI 客户端连的 MCP 服务器。开关与端口同时存在设置里（mcpEnabled / mcpPort），这里是运行状态与令牌。 */
  mcp: {
    status(): Promise<McpStatusView>
    /** 开 / 关并应用端口 */
    save(enabled: boolean, port: number): Promise<McpStatusView>
    /** 换一把新令牌；旧客户端会立刻连不上 */
    rotateToken(): Promise<McpStatusView>
  }
}
