import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ConsoleSession, ConsoleTerminal } from '../core/console.js'
import { DavClient, type DavEntry } from '../core/dav-client.js'
import { DbClient, type DatabaseView } from '../core/db-client.js'
import type { DbEngine } from '../core/db-types.js'
import { DockerClient, type DockerStream, type ProjectAction } from '../core/docker-client.js'
import { normalizeDavPath } from '../core/dav-scope.js'
import { DavServer, davServerDefaults, type DavServerSettings } from '../core/dav-server.js'
import { errorMessage } from '../core/errors.js'
import type { HttpRequester } from '../core/http.js'
import { silentLogger, type Logger } from '../core/log.js'
import type { Mirror } from '../core/mirror.js'
import { browseApiPath, checkScope, parseBrowse, parseScope, scopeApiPath } from '../core/nas-scope.js'
import { readJson, writeJsonAtomic } from '../core/store.js'
import type {
  DavCheckResult,
  NasDirListing,
  DavSettingsView,
  DavStatusView,
  DbExecView,
  DockerStreamEvent,
  DockerStreamKind,
  FileListing,
  NasScopeCheck,
  NasScopeView,
  TerminalEventView,
  Transfer,
} from '../shared/ipc.js'

/** 服务端清单里的服务名（nas-mirror 网关 map 里的键，见 server/nginx/conf.d/default.conf）。 */
export const webdavService = 'webdav'
export const consoleService = 'nas-console'
/** kura-server 挂了 docker.sock 时才出现在清单上 */
export const dockerService = 'docker'

/**
 * v0.2 的三样东西都建在映射层之上（AGENTS.md 架构原则 1）：
 *   文件管理器 → Mirror.internalEndpoint('webdav')
 *   本机 WebDAV → 同上，前面加一道范围
 *   终端       → Mirror.internalEndpoint('nas-console')
 * 映射重建（改了连接配置）时 mirror() 会返回新实例，这里每次现取，不缓存旧的。
 */
export interface FeatureDeps {
  mirror: () => Mirror | undefined
  dataDir: string
  log?: Logger
  request?: HttpRequester
}

function requireMirror(deps: FeatureDeps): Mirror {
  const mirror = deps.mirror()
  if (!mirror) throw new Error('还没有连接 NAS')
  return mirror
}

// ---------------------------------------------------------------- 文件

const maxTransfers = 50

export class FileService {
  readonly client: DavClient
  private readonly transfers = new Map<string, Transfer & { abort?: () => void }>()
  private seq = 0

  constructor(private readonly deps: FeatureDeps) {
    this.client = new DavClient({ endpoint: () => requireMirror(deps).internalEndpoint(webdavService) })
  }

  async list(path: string): Promise<FileListing> {
    const dir = normalizeDavPath(path)
    const entries = await this.client.list(dir)
    return { path: dir, entries: entries.map(({ path, name, isDir, size, modified }: DavEntry) => ({ path, name, isDir, size, modified })) }
  }

  mkdir(path: string): Promise<void> {
    return this.client.mkdir(path)
  }

  rename(from: string, to: string): Promise<void> {
    return this.client.move(from, to)
  }

  async remove(paths: string[]): Promise<void> {
    // 逐个删：一个失败不连累其他，但最后要把失败的报出来
    const failed: string[] = []
    for (const p of paths) {
      try {
        await this.client.remove(p)
      } catch (error) {
        failed.push(`${p}：${errorMessage(error)}`)
      }
    }
    if (failed.length) throw new Error(failed.join('\n'))
  }

  listTransfers(): Transfer[] {
    return [...this.transfers.values()].map(({ abort: _abort, ...t }) => ({ ...t })).sort((a, b) => b.startedAt - a.startedAt)
  }

  private track(kind: Transfer['kind'], remote: string, local: string, total: number): Transfer & { abort?: () => void } {
    const id = `t${++this.seq}`
    const transfer: Transfer & { abort?: () => void } = {
      id,
      kind,
      name: basename(kind === 'upload' ? local : remote),
      remote,
      local,
      done: 0,
      total,
      state: 'running',
      error: '',
      startedAt: Date.now(),
    }
    this.transfers.set(id, transfer)
    // 只留最近的若干条已结束记录
    const finished = [...this.transfers.values()].filter((t) => t.state !== 'running')
    for (const old of finished.slice(0, Math.max(0, this.transfers.size - maxTransfers))) this.transfers.delete(old.id)
    return transfer
  }

  cancel(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.state !== 'running') return
    t.state = 'cancelled'
    t.abort?.()
  }

  /** 上传本机文件（流式）；返回传输 id，进度靠 transfers() 轮询。 */
  upload(localFile: string, remoteDir: string): string {
    const size = statSync(localFile).size
    const remote = normalizeDavPath(`${remoteDir}/${basename(localFile)}`)
    const t = this.track('upload', remote, localFile, size)
    const stream = createReadStream(localFile)
    t.abort = () => stream.destroy(new Error('已取消'))
    stream.on('data', (chunk) => (t.done += chunk.length))
    this.client.upload(remote, stream, size).then(
      () => {
        if (t.state === 'running') t.state = 'done'
      },
      (error) => {
        if (t.state === 'running') Object.assign(t, { state: 'error', error: errorMessage(error) })
      },
    )
    return t.id
  }

  /** 下载到本机文件，返回传输 id（后台进行）。 */
  download(remote: string, localFile: string): string {
    const { id, finished } = this.startDownload(remote, localFile)
    finished.catch(() => {}) // 错误已记在传输记录里
    return id
  }

  /** 下载并等它完成（「打开」用）；失败抛出。 */
  async downloadNow(remote: string, localFile: string): Promise<void> {
    await this.startDownload(remote, localFile).finished
  }

  /** 先写 .part，完成后才改名：取消或失败不留半截文件。 */
  private startDownload(remote: string, localFile: string): { id: string; finished: Promise<void> } {
    const t = this.track('download', remote, localFile, 0)
    const part = `${localFile}.part`
    const sink = createWriteStream(part)
    t.abort = () => sink.destroy(new Error('已取消'))
    const finished = this.client
      .download(remote, sink, (done, total) => {
        t.done = done
        t.total = total
      })
      .then(
        () => {
          if (t.state === 'cancelled') throw new Error('已取消')
          rmSync(localFile, { force: true })
          renameSync(part, localFile)
          t.state = 'done'
        },
        (error: unknown) => {
          rmSync(part, { force: true })
          if (t.state === 'running') Object.assign(t, { state: 'error', error: errorMessage(error) })
          throw error
        },
      )
    return { id: t.id, finished }
  }

  /** 递归下载一个目录：先在本机建目录，再逐个文件排进传输。 */
  async downloadTree(remoteDir: string, localDir: string): Promise<number> {
    mkdirSync(localDir, { recursive: true })
    let count = 0
    for (const entry of await this.client.list(remoteDir)) {
      const target = join(localDir, safeLocalName(entry.name))
      if (entry.isDir) count += await this.downloadTree(entry.path, target)
      else {
        this.download(entry.path, target)
        count += 1
      }
    }
    return count
  }
}

/** NAS 上的文件名可能含 Windows 不允许的字符（: * ? " < > |），落到本机前换掉。 */
export function safeLocalName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned || '_'
}

// ---------------------------------------------------------------- 本机 WebDAV

export class LocalDavService {
  readonly server: DavServer
  private readonly file: string

  constructor(private readonly deps: FeatureDeps) {
    this.file = join(deps.dataDir, 'webdav.json')
    const saved = readJson<Partial<DavServerSettings>>(this.file)
    // 冒烟时换一个空闲端口：默认 18006 可能被日常在跑的 Kura 占着
    const smokePort = process.env.KURA_SMOKE === '1' ? Number(process.env.SMOKE_DAV_PORT) || undefined : undefined
    // 范围（include/exclude/readOnly）**不在这里配**：只有 NAS 侧那一份说了算（见 NasScopeService）。
    // 本机这层只做端口转发，范围由上游 kura-server 裁剪 —— 从磁盘读回来的旧 include/exclude 一律丢掉，
    // 免得老配置文件把 NAS 的范围又收窄一次（那种「文件页看得见、Z: 盘看不见」最难查）。
    this.server = new DavServer({
      settings: { ...davServerDefaults, ...saved, include: davServerDefaults.include, exclude: davServerDefaults.exclude, readOnly: false, ...(smokePort ? { port: smokePort } : {}) },
      upstream: () => requireMirror(deps).internalEndpoint(webdavService),
      log: deps.log,
    })
  }

  async start(): Promise<void> {
    try {
      await this.server.start()
    } catch (error) {
      ;(this.deps.log ?? silentLogger).warn('本机 WebDAV 启动失败', { err: errorMessage(error) })
    }
  }

  close(): Promise<void> {
    return this.server.close()
  }

  view(): DavStatusView {
    const status = this.server.status()
    const settings = this.server.current()
    return {
      settings: { enabled: settings.enabled, port: settings.port },
      url: status.url,
      running: status.listener.running,
      lastError: status.listener.lastError,
      upstreamError: status.upstreamError,
      requests: status.stats.requests,
      errors: status.stats.errors,
      bytesUp: status.stats.bytesUp,
      bytesDown: status.stats.bytesDown,
      available: this.deps.mirror()?.hasService(webdavService) ?? false,
    }
  }

  /** 只存传输层设置（启用 / 端口），范围不归这层管。 */
  async save(input: DavSettingsView): Promise<DavStatusView> {
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口 ${input.port} 不合法`)
    const next: DavServerSettings = {
      ...this.server.current(),
      enabled: Boolean(input.enabled),
      port,
    }
    // 运行时改动先做，成功了才落盘：失败时磁盘上留的是仍在生效的那份
    await this.server.apply(next)
    writeJsonAtomic(this.file, this.server.current())
    return this.view()
  }
}

// ---------------------------------------------------------------- NAS 侧暴露范围

/**
 * NAS 上那份 WebDAV 暴露范围（kura-server 的 `state/webdav.json`）。
 *
 * 这是**唯一**一份范围配置：文件页的浏览、本机 WebDAV、rclone 挂载、外部程序看到的都是它裁过的结果。
 * 读写走统一网关（`session.gatewayRequest`），与 NAS 管理页改的是同一处；本机不再自己存一份。
 */
export class NasScopeService {
  constructor(private readonly deps: FeatureDeps) {}

  async get(): Promise<NasScopeView> {
    return parseScope(await this.request('GET', scopeApiPath))
  }

  /** 整体替换：客户端这页是全量列表编辑器，删一条得真的删掉（合并会让删除静默失效）。 */
  async save(view: NasScopeView): Promise<NasScopeView> {
    const body = JSON.stringify({ include: view.include, exclude: view.exclude, readOnly: view.readOnly })
    return parseScope(await this.request('POST', scopeApiPath, body))
  }

  /**
   * 自检在客户端本地算：算法与本机那套是同一份 `dav-scope`，没必要多跑一趟网络。
   * 先读回服务端当前的范围 —— 可能是别人（NAS 管理页）刚改的，别用界面上的草稿。
   */
  async check(path: string): Promise<NasScopeCheck> {
    const scope = await this.get()
    return checkScope(scope, scope.readOnly, path)
  }

  /**
   * 目录选择器：列 NAS 上的子目录。
   *
   * 走 kura-server 的 `/_kura/api/browse`，**不经**范围层 —— 要挑的往往正是还没放行的目录
   * （放行过的在文件页里本来就看得到）。只列目录、不列文件名，越界由服务端拒绝。
   */
  async browse(path: string): Promise<NasDirListing> {
    const query = `?path=${encodeURIComponent(normalizeDavPath(path))}`
    return parseBrowse(await this.request('GET', browseApiPath + query))
  }

  private async request(method: string, path: string, body?: string): Promise<Buffer> {
    return requireMirror(this.deps).gatewayRequest(method, path, body)
  }
}

// ---------------------------------------------------------------- 容器

/**
 * 容器管理（docs/容器管理 设计.md）：连 kura-server 的内置服务 `docker`。
 * 流式操作（日志、compose、拉镜像）每个给一个 id，输出与结束按事件推给界面 —— 和终端同一个形状。
 */
export class ContainerService {
  readonly client: DockerClient
  private readonly streams = new Map<string, DockerStream>()
  private seq = 0

  constructor(
    private readonly deps: FeatureDeps,
    private readonly emit: (event: DockerStreamEvent) => void,
  ) {
    this.client = new DockerClient(() => requireMirror(deps).internalEndpoint(dockerService))
  }

  available(): boolean {
    return this.deps.mirror()?.hasService(dockerService) ?? false
  }

  /**
   * 开一个流，立刻返回 id；输出与结束按事件推（界面先显示「进行中」）。
   * `prune` 的 target 是范围（'all' / 其余当「只清悬空」），别的 kind 的 target 是操作对象。
   */
  async open(kind: DockerStreamKind, target: string, action?: ProjectAction, removeOptions?: { volumes: boolean; files: boolean }): Promise<string> {
    const id = `ds-${++this.seq}`
    const stream =
      kind === 'logs'
        ? await this.client.logs(target)
        : kind === 'project'
          ? await this.client.project(target, action ?? 'up')
          : kind === 'remove'
            ? await this.client.removeProject(target, removeOptions ?? { volumes: false, files: false })
            : kind === 'prune'
              ? await this.client.pruneImagesStream(target === 'all')
              : await this.client.pull(target)
    this.streams.set(id, stream)
    stream.onData((data) => this.emit({ id, type: 'data', data }))
    void stream.done.then((code) => {
      this.streams.delete(id)
      this.emit({ id, type: 'exit', code: code ?? null })
    })
    return id
  }

  close(id: string): void {
    this.streams.get(id)?.close()
    this.streams.delete(id)
    this.shells.get(id)?.close()
    this.shells.delete(id)
  }

  closeAll(): void {
    for (const s of this.streams.values()) s.close()
    this.streams.clear()
    for (const s of this.shells.values()) s.close()
    this.shells.clear()
  }

  // ---- 进容器 shell：事件走同一个 dockerStreamEvent（data / exit），输入与尺寸单独两个通道 ----

  private readonly shells = new Map<string, import('ws').WebSocket>()

  async openShell(container: string, cols: number, rows: number): Promise<string> {
    const id = `sh-${++this.seq}`
    const ws = await this.client.shell(container, cols, rows)
    this.shells.set(id, ws)
    ws.on('message', (data) => this.emit({ id, type: 'data', data: data.toString() }))
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      this.emit({ id, type: 'data', data: `\r\n连接被拒绝：HTTP ${res.statusCode}${res.statusCode === 404 ? '（NAS 上的 kura-server 镜像太旧）' : ''}\r\n` })
    })
    ws.on('error', (error) => this.emit({ id, type: 'data', data: `\r\n${error.message}\r\n` }))
    ws.on('close', () => {
      this.shells.delete(id)
      this.emit({ id, type: 'exit', code: 0 })
    })
    return id
  }

  shellInput(id: string, data: string): void {
    const ws = this.shells.get(id)
    if (ws?.readyState === ws?.OPEN) ws?.send(data)
  }

  shellResize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    const ws = this.shells.get(id)
    if (ws?.readyState === ws?.OPEN) ws?.send(JSON.stringify({ type: 'resize', cols: Math.round(cols), rows: Math.round(rows) }))
  }
}

// ---------------------------------------------------------------- 终端

export class TerminalService {
  private readonly session: ConsoleSession
  private readonly terminals = new Map<string, ConsoleTerminal>()
  private seq = 0

  constructor(
    private readonly deps: FeatureDeps,
    private readonly emit: (event: TerminalEventView) => void,
  ) {
    // 终端没有凭据：kura-server 不做认证，映射层带上绿联令牌即可。
    this.session = new ConsoleSession(() => requireMirror(deps).internalEndpoint(consoleService), () => ({}))
  }

  available(): boolean {
    return this.deps.mirror()?.hasService(consoleService) ?? false
  }

  async open(): Promise<string> {
    const id = `term-${++this.seq}`
    const terminal = new ConsoleTerminal(id, this.session, (event) => {
      this.emit({ id, ...event } as TerminalEventView)
      if (event.type === 'status' && event.status === 'closed') this.terminals.delete(id)
    }, this.deps.log)
    this.terminals.set(id, terminal)
    // 不等握手：id 先给界面，状态随事件推过去（界面先显示「连接中」）
    void terminal.open()
    return id
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.terminals.get(id)?.resize(cols, rows)
  }

  close(id: string): void {
    this.terminals.get(id)?.close()
    this.terminals.delete(id)
  }

  closeAll(): void {
    for (const t of this.terminals.values()) t.close()
    this.terminals.clear()
  }
}

// ---------------------------------------------------------------- 数据库

/**
 * 数据库管理：连 kura-server 的 `/api/db/*`（挂在 docker 内置服务下）。
 *
 * 隧道用的 WS 也从这里开：`openTunnel()` 拿到一条到某个数据库的 WebSocket，
 * 交给 `DbTunnelService` 去接本机回环的裸 TCP。应用知识（哪个库）留在这层，
 * 隧道那边只认「本地端口 → WS」—— 传输层不认识数据库（AGENTS.md §三.3）。
 *
 * 命令执行（M2）走 `docker exec` 进官方镜像跑官方 CLI：客户端零驱动依赖，
 * 版本与容器里的服务端天然对齐，且不经隧道（独立于隧道可用性）。
 */
export class DatabaseService {
  readonly client: DbClient

  constructor(private readonly deps: FeatureDeps) {
    this.client = new DbClient(() => requireMirror(deps).internalEndpoint(dockerService))
  }

  /** 服务端有没有数据库接口（老镜像只有容器管理，会 404）。 */
  async available(): Promise<boolean> {
    if (!this.deps.mirror()?.hasService(dockerService)) return false
    return this.client.available()
  }

  list(): Promise<{ databases: DatabaseView[]; tunnelAvailable: boolean; installAvailable?: boolean }> {
    return this.client.list()
  }

  install(engine: DbEngine, name: string, image?: string) {
    return this.client.install(engine, name, image)
  }

  /** 某个引擎有哪些版本可装。registry 是可选的镜像站点。 */
  versions(engine: DbEngine, registry?: string) {
    return this.client.versions(engine, registry)
  }

  detail(name: string) {
    return this.client.detail(name)
  }

  info(name: string, includePassword = false) {
    return this.client.info(name, includePassword)
  }

  action(name: string, action: 'start' | 'stop' | 'restart') {
    return this.client.action(name, action)
  }

  remove(name: string, options: { volumes: boolean; files: boolean }) {
    return this.client.remove(name, options)
  }

  /** 开一条到某个数据库的隧道用的 WS。 */
  openTunnel(name: string) {
    return this.client.tunnel(name)
  }

  // ---- 数据浏览 ----
  // 这几个只是透传：应用知识（哪个引擎、怎么分页）在服务端的 db 模块里，
  // 主进程这层不掺和 —— 否则同一套判断要在两侧各写一遍，必然漂移。

  browseAvailable(): Promise<boolean> {
    return this.client.browseAvailable()
  }

  redisKeys(name: string, options: { cursor?: string; match?: string; count?: number; password?: string }) {
    return this.client.redisKeys(name, options)
  }

  redisValue(name: string, key: string, options: { password?: string }) {
    return this.client.redisValue(name, key, options)
  }

  redisCommand(name: string, args: string[], options: { password?: string; timeoutMs?: number }) {
    return this.client.redisCommand(name, args, options)
  }

  // 关系库（MySQL / MariaDB / PostgreSQL）—— 同样是透传
  schemas(name: string, options: { password?: string }) {
    return this.client.mySqlSchemas(name, options)
  }

  tables(name: string, schema: string, options: { password?: string }) {
    return this.client.mySqlTables(name, schema, options)
  }

  table(name: string, schema: string, table: string, options: { password?: string }) {
    return this.client.mySqlTable(name, schema, table, options)
  }

  rows(name: string, options: { schema: string; table: string; offset?: number; limit?: number; orderBy?: string; password?: string }) {
    return this.client.mySqlRows(name, options)
  }

  query(name: string, sql: string, options: { database?: string; password?: string; timeoutMs?: number }) {
    return this.client.mySqlQuery(name, sql, options)
  }

  /**
   * 跑一条命令。每次调用开一条新连接（MCP 是请求/响应，没有会话可复用），跑完关掉。
   *
   * 输出同时走两条路：`onOutput` 按帧推给界面（实时看得到），返回值里带上汇总的
   * `stdout` / `stderr`（MCP 与直接调用要整段结果 —— 它们是请求/响应，没有事件可听）。
   */
  async exec(name: string, cli: string, args: string[], onOutput?: (event: { stream: 1 | 2; text: string }) => void, timeoutMs?: number): Promise<DbExecView> {
    const session = await this.client.exec(name)
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    try {
      session.onOutput((event) => {
        if (event.stream === 2) stderr += event.text
        else stdout += event.text
        onOutput?.(event)
      })
      const result = await session.run(cli, args, timeoutMs)
      return { exitCode: result.exitCode, ...(result.error ? { error: result.error } : {}), stdout, stderr, durationMs: Date.now() - startedAt }
    } finally {
      session.close()
    }
  }

  closeAll(): void {}
}
