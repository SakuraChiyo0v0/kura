import http from 'node:http'
import { WebSocket } from 'ws'
import type { DbEngine } from './db-types.js'
import type {
  DbQueryResult,
  DbRowsPage,
  DbSchemaNode,
  DbTableDetail,
  DbTableNode,
  RedisKeyPage,
  RedisValue,
} from './db-browse.js'
import type { DockerActivity } from './docker-client.js'

/**
 * 客户端这一侧的数据库管理：连 kura-server 的 `/api/db/*`（挂在**已有的 docker 内置服务**下）。
 *
 * 地址来自 `Mirror.internalEndpoint('docker')` —— 和容器管理同一条路：链路切换、会话续期都在映射层，
 * 这里只认一个 http://127.0.0.1:<端口>。隧道也是从这条路上开 WebSocket（那条路已验通中继支持 WS）。
 */

const writeHeaders = { 'x-kura-docker': '1' }

export class DbApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 一个数据库（kura-server 的 DatabaseView 形状）。 */
export interface DatabaseView {
  name: string
  engine: DbEngine | ''
  container: string
  state: string
  status: string
  health: string
  port: number
  user: string
  database: string
  /** Kura 自己装的（能改能删）；false = 接管的已有容器 */
  managed: boolean
  dir: string
  tunnel?: { active: number; total: number; bytesUp: number; bytesDown: number }
}

export interface DatabaseTemplate {
  engine: DbEngine
  label: string
  /** 默认镜像（含 tag）；界面上可以换成别的版本 */
  image: string
  port: number
  database: string
  username: string
  /** 这个引擎能选的镜像变体（alpine / bookworm / '' 之类） */
  variants: string[]
  /** 默认变体；空串 = 镜像名后面不加变体 */
  defaultVariant: string
}

/** Docker Hub 上查到的一个可装版本。 */
export interface ImageVersion {
  /** 完整 tag，如 `17-alpine` */
  tag: string
  /** 版本号部分，如 `17`、`8.4` */
  version: string
  /** 变体部分（alpine / bookworm / ''） */
  variant: string
  updatedAt?: string
  size?: number
}

export interface VersionList {
  engine: DbEngine
  repository: string
  /** 可选的版本，新的在前 */
  versions: ImageVersion[]
  /** 模板的默认镜像 */
  defaultImage: string
  /** 这批版本哪来的：镜像站点 / Docker Hub / 内置兜底 */
  source: 'registry' | 'hub' | 'builtin'
  /** 查失败的原因（用内置兜底时一定有） */
  error?: string
}

export interface InstallResult {
  ok: boolean
  name: string
  engine: DbEngine
  /** 实际装的镜像 */
  image: string
  output: string
  connection: { container: string; port: number; database: string; user: string }
}

/** 一条命令的输出帧：stream 1 = stdout、2 = stderr。 */
export interface DbExecEvent {
  stream: 1 | 2
  text: string
}

export interface DbExecResult {
  exitCode: number
  error?: string
}

/** 一次 exec 连接：可以连续跑多条命令。 */
export interface DbExecSession {
  onOutput(listener: (event: DbExecEvent) => void): void
  /** 跑一条命令，返回它的结果（一条连接上一次只跑一个）。 */
  run(cli: string, args: string[], timeoutMs?: number): Promise<DbExecResult>
  close(): void
}

export interface DbActivity extends DockerActivity {}

export class DbClient {
  constructor(private readonly endpoint: () => Promise<string>) {}

  private async request(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; body: string }> {
    const base = new URL(await this.endpoint())
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: base.hostname,
          port: base.port,
          method,
          path,
          agent: false,
          headers: { ...(method === 'GET' ? {} : writeHeaders), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        },
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${method} ${path}）`)))
      req.on('error', reject)
      req.end(payload)
    })
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const { status, body: text } = await this.request(method, path, body, timeoutMs)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new DbApiError(status, status === 404 ? 'NAS 上的 kura-server 还没有数据库管理（镜像太旧，等 watchtower 换新）' : `kura-server 返回的不是 JSON（HTTP ${status}）`)
    }
    if (status >= 400) throw new DbApiError(status, (parsed as { error?: string }).error ?? `HTTP ${status}`)
    return parsed as T
  }

  /** 探测服务端有没有数据库接口（老镜像只有容器管理，没有 /api/db/*）。 */
  async available(): Promise<boolean> {
    try {
      const list = await this.templates()
      return list.length > 0
    } catch (error) {
      if (error instanceof DbApiError && error.status === 404) return false
      throw error
    }
  }

  templates(): Promise<DatabaseTemplate[]> {
    return this.json<DatabaseTemplate[]>('GET', '/api/db/templates')
  }

  /**
   * `installAvailable`：服务端的项目目录真的按原路径挂进来了，快捷安装才可用。
   * 老镜像没有这个字段 —— 那时按可用处理，让「安装」按钮照旧显示（点了会有明确的 409）。
   */
  async list(): Promise<{ databases: DatabaseView[]; tunnelAvailable: boolean; installAvailable?: boolean }> {
    return this.json<{ databases: DatabaseView[]; tunnelAvailable: boolean; installAvailable?: boolean }>('GET', '/api/db/list')
  }

  install(engine: DbEngine, name: string, image?: string): Promise<InstallResult> {
    return this.json<InstallResult>('POST', '/api/db/create', { engine, name, ...(image ? { image } : {}) }, 300_000)
  }

  /** 某个引擎有哪些版本可装。registry 是可选的镜像站点（国内网络通常只有这条路能通）。 */
  versions(engine: DbEngine, registry?: string): Promise<VersionList> {
    const query = new URLSearchParams({ engine })
    if (registry) query.set('registry', registry)
    return this.json<VersionList>('GET', `/api/db/versions?${query}`, undefined, 20_000)
  }

  detail(name: string): Promise<DatabaseView> {
    return this.json<DatabaseView>('GET', `/api/db/${encodeURIComponent(name)}`)
  }

  /** 连接信息；`includePassword` 默认 false（密码进了日志/界面就得当泄漏处理）。 */
  info(name: string, includePassword = false): Promise<DatabaseView & { password?: string }> {
    return this.json<DatabaseView & { password?: string }>('POST', `/api/db/${encodeURIComponent(name)}/info`, { includePassword })
  }

  action(name: string, action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>('POST', `/api/db/${encodeURIComponent(name)}/${action}`)
  }

  remove(name: string, options: { volumes: boolean; files: boolean }): Promise<{ ok: boolean }> {
    const query = `?volumes=${options.volumes ? 1 : 0}&files=${options.files ? 1 : 0}`
    return this.json<{ ok: boolean }>('DELETE', `/api/db/${encodeURIComponent(name)}${query}`, undefined, 120_000)
  }

  /**
   * 开一条隧道用的 WebSocket。**二进制帧**（数据库协议里没有文本/控制的分界）；
   * 用 `nodebuffer` 直接拿 Buffer，省一次拷贝。
   *
   * **要等握手完成再返回**：WS 的 `send()` 在 CONNECTING 状态是直接调用回调报错、**不发**，
   * 而隧道的泵按 `readyState === OPEN` 过滤 —— 早返回会让先到的那几个字节静默丢掉
   * （psql 前几条消息很短，正好落在这个窗口里）。`exec()` 本来就是这么等的。
   */
  async tunnel(name: string): Promise<WebSocket> {
    const base = await this.endpoint()
    const url = `${base.replace(/^http/, 'ws')}/api/db/${encodeURIComponent(name)}/tunnel`
    const ws = new WebSocket(url, { headers: writeHeaders, handshakeTimeout: 30_000 })
    ws.binaryType = 'nodebuffer'
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        reject(new DbApiError(res.statusCode ?? 0, res.statusCode === 404 ? '这个数据库没在 NAS 上登记，隧道不给开' : `隧道被拒绝：HTTP ${res.statusCode}`))
      })
      ws.once('error', reject)
    })
    return ws
  }

  // ---------------------------------------------------------------- 数据浏览
  // 这几个走 HTTP（不是 exec 那条 WS）：浏览是「一问一答」，不值得为每条请求开一条 WS，
  // 而且结构化结果本来就该用 JSON 传，不该塞进文本流再由客户端解析回来。

  /** Redis：扫一页 key。 */
  redisKeys(name: string, options: { cursor?: string; match?: string; count?: number; password?: string } = {}): Promise<RedisKeyPage> {
    const query = new URLSearchParams()
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.match) query.set('match', options.match)
    if (options.count) query.set('count', String(options.count))
    if (options.password) query.set('password', options.password)
    return this.json<RedisKeyPage>('GET', `/api/db/${encodeURIComponent(name)}/keys?${query}`)
  }

  /** Redis：读一个 key 的值。 */
  redisValue(name: string, key: string, options: { password?: string } = {}): Promise<RedisValue> {
    const query = new URLSearchParams({ key })
    if (options.password) query.set('password', options.password)
    return this.json<RedisValue>('GET', `/api/db/${encodeURIComponent(name)}/value?${query}`)
  }

  /** Redis：跑一条用户命令。 */
  redisCommand(name: string, args: string[], options: { password?: string; timeoutMs?: number } = {}): Promise<{ text: string; binary: boolean; ms: number }> {
    return this.json<{ text: string; binary: boolean; ms: number }>('POST', `/api/db/${encodeURIComponent(name)}/command`, {
      args,
      ...(options.password ? { password: options.password } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })
  }

  /** 服务端认不认浏览接口（老镜像只有 M1，会 404）。 */
  async browseAvailable(): Promise<boolean> {
    try {
      await this.json('GET', '/api/db/browse-capabilities')
      return true
    } catch (error) {
      if (error instanceof DbApiError && error.status === 404) return false
      throw error
    }
  }

  // 关系库（MySQL / MariaDB）：schema → tables → table → rows，加一条跑 SQL 的
  mySqlSchemas(name: string, options: { password?: string } = {}): Promise<DbSchemaNode[]> {
    const query = new URLSearchParams()
    if (options.password) query.set('password', options.password)
    return this.json<DbSchemaNode[]>('GET', `/api/db/${encodeURIComponent(name)}/schemas?${query}`)
  }

  mySqlTables(name: string, schema: string, options: { password?: string } = {}): Promise<DbTableNode[]> {
    const query = new URLSearchParams({ schema })
    if (options.password) query.set('password', options.password)
    return this.json<DbTableNode[]>('GET', `/api/db/${encodeURIComponent(name)}/tables?${query}`)
  }

  mySqlTable(name: string, schema: string, table: string, options: { password?: string } = {}): Promise<DbTableDetail> {
    const query = new URLSearchParams({ schema, table })
    if (options.password) query.set('password', options.password)
    return this.json<DbTableDetail>('GET', `/api/db/${encodeURIComponent(name)}/table?${query}`)
  }

  mySqlRows(
    name: string,
    options: { schema: string; table: string; offset?: number; limit?: number; orderBy?: string; password?: string },
  ): Promise<DbRowsPage> {
    const query = new URLSearchParams({ schema: options.schema, table: options.table })
    if (options.offset) query.set('offset', String(options.offset))
    if (options.limit) query.set('limit', String(options.limit))
    if (options.orderBy) query.set('orderBy', options.orderBy)
    if (options.password) query.set('password', options.password)
    return this.json<DbRowsPage>('GET', `/api/db/${encodeURIComponent(name)}/rows?${query}`)
  }

  /** 跑一条 SQL。写操作（INSERT / UPDATE / DDL）也走这条 —— 调用方自己负责确认。 */
  mySqlQuery(name: string, sql: string, options: { database?: string; password?: string; timeoutMs?: number } = {}): Promise<DbQueryResult> {
    return this.json<DbQueryResult>('POST', `/api/db/${encodeURIComponent(name)}/query`, {
      sql,
      ...(options.database ? { database: options.database } : {}),
      ...(options.password ? { password: options.password } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }, 120_000)
  }

  /** 开一条命令执行会话（一条 WS 上连续跑多条）。 */
  async exec(name: string): Promise<DbExecSession> {
    const base = await this.endpoint()
    const url = `${base.replace(/^http/, 'ws')}/api/db/${encodeURIComponent(name)}/exec`
    const ws = new WebSocket(url, undefined, { headers: writeHeaders, handshakeTimeout: 30_000 })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        reject(new DbApiError(res.statusCode ?? 0, res.statusCode === 404 ? 'NAS 上的 kura-server 镜像太旧，还没有数据库命令执行' : `连接被拒绝：HTTP ${res.statusCode}`))
      })
      ws.once('error', reject)
    })

    const outputListeners: Array<(event: DbExecEvent) => void> = []
    let pending: ((result: DbExecResult) => void) | undefined
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      let message: { type?: string; stream?: number; text?: string; code?: number; error?: string }
      try {
        message = JSON.parse(data.toString('utf8')) as typeof message
      } catch {
        return
      }
      if (message.type === 'out' && message.text !== undefined) {
        for (const listener of outputListeners) listener({ stream: message.stream === 2 ? 2 : 1, text: message.text })
      }
      if (message.type === 'exit') {
        const result: DbExecResult = { exitCode: message.code ?? 0, ...(message.error ? { error: message.error } : {}) }
        const resolve = pending
        pending = undefined
        resolve?.(result)
      }
    })
    ws.on('close', () => {
      const resolve = pending
      pending = undefined
      resolve?.({ exitCode: -1, error: '连接已关闭' })
    })

    return {
      onOutput: (listener) => outputListeners.push(listener),
      run: (cli, args, timeoutMs) =>
        new Promise<DbExecResult>((resolve) => {
          pending = resolve
          ws.send(JSON.stringify({ cli, args, ...(timeoutMs ? { timeoutMs } : {}) }))
        }),
      close: () => ws.close(),
    }
  }
}
