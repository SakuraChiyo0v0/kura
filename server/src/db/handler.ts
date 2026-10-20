import type http from 'node:http'
import type net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { errorMessage } from '../../../src/core/errors.js'
import { engineCliCandidates, type DbEngine } from '../../../src/core/db-types.js'
import type { AuditEntry } from '../shell/audit.js'
import { checkUserRef, createStreamDemuxer, DockerError, type DockerEngine, type RawInspect } from '../docker/engine.js'
import { runCompose, type ComposeAction } from '../docker/compose.js'
import type { ProjectFileStore } from '../docker/files.js'
import { clientArgs, clientEnv, defaultNetwork, generatePassword, passwordEnvKey, readEnv, templates } from './templates.js'
import { deriveConnection, discoverDatabases, readProjectEnv, type DatabaseEntry, type DatabaseRegistry } from './registry.js'
import { DbConnector } from './connect.js'
import { assertNotStreamCommand, RedisClient } from './redis.js'
import { readValue, runUserCommand, scanKeys, typeSummary } from './redis-browse.js'
import { MySqlClient } from './mysql.js'
import { describeTable as myDescribeTable, listSchemas as myListSchemas, listTables as myListTables, readRows as myReadRows, runQuery as myRunQuery } from './mysql-browse.js'
import { PgClient } from './postgres.js'
import { describeTable as pgDescribeTable, listSchemas as pgListSchemas, listTables as pgListTables, readRows as pgReadRows, runQuery as pgRunQuery } from './postgres-browse.js'
import type { TunnelService } from './tunnel.js'

/**
 * kura-server 的数据库接口（挂在**已有的 docker 内置服务**下，路径 `/api/db/*`）。
 *
 * 为什么不新增一个内置服务名 `db`：`Mirror.attach()`（src/core/mirror.ts:233）会对每个内置服务
 * 在本机回环绑一个 `ServiceListener`，新增 `db` 就会让客户端凭空多一个 127.0.0.1:5432 的 HTTP 监听、
 * 还可能撞端口显示「开着但监听失败」。挂在 docker 下则映射层、清单、本机端口全部零改动
 * （server/src/server.ts:233 本来就按 path 分派）。
 *
 * HTTP（JSON）：
 *   GET    /api/db/templates                 可用模板
 *   GET    /api/db/list                      已登记 + 接管来的数据库
 *   POST   /api/db/create                    快捷安装 {engine, name}
 *   GET    /api/db/:name                     详情（状态，不含密码）
 *   POST   /api/db/:name/info                {includePassword} 取连接信息
 *   DELETE /api/db/:name?volumes=0&files=0   删除（只对 Kura 装的）
 *   POST   /api/db/:name/{start,stop,restart}
 *   GET    /api/db/:name/keys                浏览（Redis：扫描 key）
 *   GET    /api/db/:name/value               浏览（Redis：读一个 key 的值）
 *   POST   /api/db/:name/command             浏览（Redis：跑一条用户命令）
 * WebSocket：
 *   /api/db/:name/tunnel                     隧道（二进制帧双向搬运）
 *   /api/db/:name/exec                       跑一条命令（docker exec 官方 CLI）
 *
 * 浏览类接口（keys / value / command）与 exec **走的是两条完全不同的路**：
 * exec 是 `docker exec` 进容器跑官方 CLI（文本输出），浏览是服务端自己说数据库协议
 * （结构化结果）。前者给人应急、给 AI 跑任意 SQL；后者是界面里那个数据面板的地基。
 *
 * 所有非 GET 必须带 x-kura-docker: 1 头（沿用容器管理那套）。
 */

export type AuditSink = (entry: Omit<AuditEntry, 'at' | 'id' | 'user' | 'action'> & { action: `docker-${string}` }) => void

export interface DbHandlerOptions {
  registry: DatabaseRegistry
  engine: DockerEngine
  tunnel: TunnelService
  audit: AuditSink
  /** 项目目录（宿主原路径）；没有就不能快捷安装 */
  projectRoot: string
  /** compose 项目文件读写（复用容器管理那一份） */
  files?: ProjectFileStore
  /** 测试注入 */
  compose?: typeof runCompose
  /**
   * 测试注入：换掉驱动层的 `net.connect`。
   *
   * 真机上目标是容器名（Docker 内置 DNS 解析）；单测里没有 docker，必须能换掉这一段，
   * 否则「连接参数到底拼对没有」这件事没法测（踩过：只在隧道那层注入，驱动照样去解析容器名 → ENOTFOUND）。
   */
  connect?: (host: string, port: number) => net.Socket
  log?: (message: string, fields?: Record<string, unknown>) => void
}

const writeHeader = 'x-kura-docker'
const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const fail = (res: http.ServerResponse, error: unknown): void => {
  const status = error instanceof DockerError ? error.status : Number((error as { status?: unknown })?.status) || 500
  json(res, status >= 400 && status < 600 ? status : 500, { error: errorMessage(error) })
}
const ipOf = (req: http.IncomingMessage): string => req.socket.remoteAddress ?? ''

async function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new DockerError(413, '请求体过大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new DockerError(400, '请求体不是 JSON')
  }
}

/** 数据库页展示用的视图：登记/发现信息 + 容器实时状态。 */
interface DatabaseView {
  name: string
  engine: DbEngine | ''
  container: string
  state: string
  status: string
  health: string
  port: number
  user: string
  database: string
  managed: boolean
  dir: string
}

function toView(entry: DatabaseEntry, raw: RawInspect | undefined): DatabaseView {
  const health = raw?.State?.Health?.Status ?? ''
  return {
    name: entry.name,
    engine: entry.engine,
    container: entry.container,
    state: raw?.State?.Status ?? 'missing',
    status: raw?.State?.Status ?? 'missing',
    health: health === 'health: starting' ? 'starting' : health,
    port: entry.port,
    user: entry.user,
    database: entry.database,
    managed: entry.managed,
    dir: entry.dir,
  }
}

export function createDbHandler(options: DbHandlerOptions): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void
} {
  const { registry, engine, tunnel } = options
  const compose = options.compose ?? runCompose
  const log = options.log ?? (() => {})
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  const connector = new DbConnector({ registry, engine, tunnel, log, ...(options.connect ? { connect: options.connect } : {}) })

  /**
   * 开一条 Redis 连接，用完一定关。
   *
   * 每次请求开一条（浏览是「一问一答」，没有会话要复用）；用完就关，不搞连接池 ——
   * 池要处理闲置回收、坏连接剔除、进程退出清理，而这里每条请求本来就只有几十毫秒。
   */
  const withRedis = async <T>(name: string, clientPassword: string | undefined, fn: (client: RedisClient) => Promise<T>): Promise<T> => {
    const db = await connector.resolve(name, { clientPassword, requirePassword: true })
    if (db.engine !== 'redis') throw new DockerError(400, `「${name}」不是 Redis（是 ${db.engine}），这个接口只给 Redis 用`)
    const client = await RedisClient.connect({ host: db.host, port: db.port, password: db.password, ...(db.connect ? { connect: db.connect } : {}) })
    try {
      return await fn(client)
    } finally {
      client.close()
    }
  }

  /**
   * 开一条**关系库**连接（MySQL / MariaDB / PostgreSQL），用完一定关。
   *
   * 两种情况用同一个入口：界面只关心「这个库是关系型的，给我 schema/tables/rows」，
   * 具体是哪种引擎在这里分派 —— 否则界面要写一遍 if (engine === 'postgres')，
   * 而每加一个引擎就得改一遍界面（映射层的教训：应用知识不该往上渗）。
   */
  const withRelation = async <T>(
    name: string,
    options: { database?: string; clientPassword?: string },
    handlers: { mysql: (client: MySqlClient) => Promise<T>; postgres: (client: PgClient) => Promise<T> },
  ): Promise<T> => {
    const db = await connector.resolve(name, { clientPassword: options.clientPassword })

    if (db.engine === 'postgres') {
      // PG 的 database 是连接参数；schema 是库里的第一层
      const database = options.database || db.database || 'postgres'
      const client = await PgClient.connect({
        host: db.host,
        port: db.port,
        user: db.user || 'postgres',
        password: db.password,
        database,
        ...(db.connect ? { connect: db.connect } : {}),
      })
      try {
        return await handlers.postgres(client)
      } finally {
        client.close()
      }
    }

    if (db.engine === 'mysql' || db.engine === 'mariadb') {
      const database = options.database || db.database
      const client = await MySqlClient.connect({
        host: db.host,
        port: db.port,
        user: db.user || 'root',
        password: db.password,
        ...(database ? { database } : {}),
        ...(db.connect ? { connect: db.connect } : {}),
      })
      try {
        return await handlers.mysql(client)
      } finally {
        client.close()
      }
    }

    throw new DockerError(400, `「${name}」不是关系库（是 ${db.engine}），这个接口只给关系库用`)
  }

  /**
   * 补上用户 / 库名。**接管的容器在登记表里这两项是空串**（`discoverDatabases` 不写盘），
   * 但容器自己的 `Config.Env` 里有 —— `POSTGRES_USER`、`MYSQL_DATABASE` 这些。
   * 命令台与连接信息都要用它，否则 `psql` 不知道该用哪个角色登录。
   */
  const fillConnection = (entry: DatabaseEntry, raw: RawInspect | undefined): DatabaseEntry => {
    if (!entry.engine || !raw) return entry
    if (entry.user && entry.database) return entry
    const derived = deriveConnection(raw, entry.engine, entry.port)
    return { ...entry, user: entry.user || derived.user, database: entry.database || derived.database }
  }

  /** 找一条数据库：先查登记表，再查接管来的容器（都不写盘）。 */
  const lookup = async (name: string): Promise<{ entry: DatabaseEntry; raw: RawInspect }> => {
    const all = await discoverDatabases(engine, registry)
    const entry = all.find((e) => e.name === name)
    if (!entry) throw new DockerError(404, `没有叫「${name}」的数据库`)
    let raw: RawInspect
    try {
      raw = await engine.inspectContainer(entry.container)
    } catch {
      throw new DockerError(404, `容器 ${entry.container} 不在了`)
    }
    return { entry: fillConnection(entry, raw), raw }
  }

  /**
   * 读一个数据库的密码。两个来源，都**不额外存一份**：
   * 1. Kura 装的 → 项目目录的 `.env`（唯一真相在 NAS 上）；
   * 2. 接管的 → 容器自己的环境变量（它本来就没有 `.env`；那些变量就是它的配置）。
   */
  const passwordOf = (entry: DatabaseEntry, raw?: RawInspect): string => {
    if (!entry.dir) {
      const key = passwordEnvKey(entry.engine as DbEngine)
      for (const line of raw?.Config?.Env ?? []) {
        const at = line.indexOf('=')
        if (at > 0 && line.slice(0, at) === key) return line.slice(at + 1)
      }
      return ''
    }
    return readEnv(readProjectEnv(entry.dir), passwordEnvKey(entry.engine as DbEngine))
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    // 路径形如 /api/db/templates、/api/db/<名字>/info
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const method = req.method ?? 'GET'
    try {
      if (parts[0] !== 'api' || parts[1] !== 'db') return json(res, 404, { error: 'not found' })
      const head = parts[2]
      const verb = parts[3]

      if (method !== 'GET' && req.headers[writeHeader] !== '1') {
        return json(res, 403, { error: `写操作必须带 ${writeHeader}: 1 头` })
      }

      // 老客户端（只有 M1）探测新接口用：有这条就说明镜像带数据浏览
      if (method === 'GET' && head === 'browse-capabilities') {
        return json(res, 200, {
          version: 1,
          engines: ['redis', 'mysql', 'mariadb', 'postgres'],
          relation: ['mysql', 'mariadb', 'postgres'],
          redis: true,
        })
      }

      if (method === 'GET' && head === 'templates') {
        return json(
          res,
          200,
          Object.values(templates).map((t) => ({ engine: t.engine, label: t.label, image: t.image, port: t.port, database: t.database, username: t.username })),
        )
      }

      if (method === 'GET' && head === 'list') {
        const entries = await discoverDatabases(engine, registry)
        const stats = tunnel.stats()
        const databases: Array<DatabaseView & { tunnel?: (typeof stats)[string] }> = []
        for (const entry of entries) {
          let raw: RawInspect | undefined
          try {
            raw = await engine.inspectContainer(entry.container)
          } catch {
            raw = undefined
          }
          databases.push({ ...toView(fillConnection(entry, raw), raw), ...(stats[entry.name] ? { tunnel: stats[entry.name] } : {}) })
        }
        return json(res, 200, { databases, tunnelAvailable: registry.list().length > 0 })
      }

      if (method === 'POST' && head === 'create') {
        const body = parseJson<{ engine?: unknown; name?: unknown }>(await readBody(req))
        const engineKind = String(body.engine ?? '') as DbEngine
        const name = String(body.name ?? '').trim()
        const template = templates[engineKind]
        if (!template) throw new DockerError(400, `不认识的引擎：${JSON.stringify(body.engine)}`)
        const result = await install(name, template, ipOf(req))
        return json(res, 200, result)
      }

      if (!head) return json(res, 404, { error: 'not found' })
      const { entry, raw } = await lookup(head)

      if (method === 'GET' && !verb) return json(res, 200, toView(entry, raw))

      if (method === 'POST' && verb === 'info') {
        const text = await readBody(req).catch(() => '{}')
        const body = parseJson<{ includePassword?: unknown }>(text || '{}')
        const password = body.includePassword === true ? passwordOf(entry, raw) : ''
        return json(res, 200, { ...toView(entry, raw), ...(password ? { password } : {}) })
      }

      if (method === 'POST' && (verb === 'start' || verb === 'stop' || verb === 'restart')) {
        await engine[verb](entry.container)
        options.audit({ action: `docker-db-${verb}`, detail: entry.name, exitCode: 0, ip: ipOf(req) })
        return json(res, 200, { ok: true })
      }

      if (method === 'DELETE' && !verb) {
        if (!entry.managed) throw new DockerError(403, `「${entry.name}」不是 Kura 装的（接管的已有容器），不能在 Kura 里删`)
        const volumes = url.searchParams.get('volumes') === '1'
        const files = url.searchParams.get('files') === '1'
        await remove(entry, { volumes, files })
        options.audit({ action: 'docker-db-remove', detail: `${entry.name}${volumes ? ' · 删卷' : ''}${files ? ' · 删文件' : ''}`, exitCode: 0, ip: ipOf(req) })
        return json(res, 200, { ok: true })
      }

      // ---- 浏览（Redis）----
      // 口令可以由界面传一次（接管的容器拿不到 .env 时）；只在这次请求里用，不落盘、不记日志。

      if (method === 'GET' && verb === 'keys') {
        return json(res, 200, await withRedis(head, url.searchParams.get('password') ?? undefined, (client) => scanKeys(client, {
          cursor: url.searchParams.get('cursor') ?? '0',
          match: url.searchParams.get('match') ?? '',
          count: Number(url.searchParams.get('count') ?? 200) || 200,
        })))
      }

      if (method === 'GET' && verb === 'value') {
        const key = url.searchParams.get('key') ?? ''
        if (!key) throw new DockerError(400, '要带 ?key=')
        return json(res, 200, await withRedis(head, url.searchParams.get('password') ?? undefined, (client) => readValue(client, key)))
      }

      if (method === 'GET' && verb === 'summary') {
        return json(res, 200, await withRedis(head, url.searchParams.get('password') ?? undefined, async (client) => ({
          types: await typeSummary(client),
          /** 口令是从哪来的：container / env / client / ''（界面据此决定要不要弹输入框） */
          passwordSource: (await connector.resolve(head, { clientPassword: url.searchParams.get('password') ?? undefined })).passwordSource,
        })))
      }

      // ---- 浏览（MySQL / MariaDB）----
      // 形状和 Redis 那套平行：schema → tables → detail → rows，再加一条跑 SQL 的。
      // 路径里带上库名（`?database=`），因为一个 MySQL 实例下有多个库。

      if (method === 'GET' && verb === 'schemas') {
        const pw = url.searchParams.get('password') ?? undefined
        return json(
          res,
          200,
          await withRelation(head, { clientPassword: pw }, {
            mysql: (client) => myListSchemas(client),
            postgres: (client) => pgListSchemas(client),
          }),
        )
      }

      if (method === 'GET' && verb === 'tables') {
        const schema = url.searchParams.get('schema') ?? ''
        if (!schema) throw new DockerError(400, '要带 ?schema=')
        const pw = url.searchParams.get('password') ?? undefined
        return json(
          res,
          200,
          await withRelation(head, { clientPassword: pw }, {
            mysql: (client) => myListTables(client, schema),
            postgres: (client) => pgListTables(client, schema),
          }),
        )
      }

      if (method === 'GET' && verb === 'table') {
        const schema = url.searchParams.get('schema') ?? ''
        const table = url.searchParams.get('table') ?? ''
        if (!schema || !table) throw new DockerError(400, '要带 ?schema= 和 ?table=')
        const pw = url.searchParams.get('password') ?? undefined
        return json(
          res,
          200,
          await withRelation(head, { clientPassword: pw }, {
            mysql: (client) => myDescribeTable(client, schema, table),
            postgres: (client) => pgDescribeTable(client, schema, table),
          }),
        )
      }

      if (method === 'GET' && verb === 'rows') {
        const schema = url.searchParams.get('schema') ?? ''
        const table = url.searchParams.get('table') ?? ''
        if (!schema || !table) throw new DockerError(400, '要带 ?schema= 和 ?table=')
        const pw = url.searchParams.get('password') ?? undefined
        const readOptions = {
          schema,
          table,
          offset: Number(url.searchParams.get('offset') ?? 0) || 0,
          limit: Number(url.searchParams.get('limit') ?? 0) || undefined,
          orderBy: url.searchParams.get('orderBy') ?? undefined,
          timeoutMs: 30_000,
        }
        return json(
          res,
          200,
          await withRelation(head, { clientPassword: pw }, {
            mysql: (client) => myReadRows(client, readOptions),
            postgres: (client) => pgReadRows(client, readOptions),
          }),
        )
      }

      if (method === 'POST' && verb === 'query') {
        const body = parseJson<{ sql?: unknown; database?: unknown; password?: unknown; timeoutMs?: unknown }>(await readBody(req))
        const sql = String(body.sql ?? '').trim()
        if (!sql) throw new DockerError(400, '要带 {sql:"..."}')
        const startedAt = Date.now()
        const queryOptions = { timeoutMs: clampCommandTimeout(body.timeoutMs) }
        const result = await withRelation(
          head,
          { database: typeof body.database === 'string' ? body.database : undefined, clientPassword: typeof body.password === 'string' ? body.password : undefined },
          {
            mysql: (client) => myRunQuery(client, sql, queryOptions),
            postgres: (client) => pgRunQuery(client, sql, queryOptions),
          },
        )
        options.audit({ action: 'docker-db-query', detail: `${head}：${sql.slice(0, 120)}`, exitCode: 0, durationMs: Date.now() - startedAt, ip: ipOf(req) })
        return json(res, 200, result)
      }

      if (method === 'POST' && verb === 'command') {
        const body = parseJson<{ args?: unknown; password?: unknown; timeoutMs?: unknown }>(await readBody(req))
        const args = Array.isArray(body.args) ? body.args.map(String).filter((a) => a !== '') : []
        if (args.length === 0) throw new DockerError(400, '要带 {args:[...]}')
        assertNotStreamCommand(args)
        const startedAt = Date.now()
        const result = await withRedis(head, typeof body.password === 'string' ? body.password : undefined, (client) =>
          runUserCommand(client, args, clampCommandTimeout(body.timeoutMs)),
        )
        options.audit({ action: 'docker-db-command', detail: `${head}：${args[0]}`, exitCode: 0, durationMs: Date.now() - startedAt, ip: ipOf(req) })
        return json(res, 200, result)
      }

      json(res, 404, { error: 'not found' })
    } catch (error) {
      fail(res, error)
    }
  }

  /** 快捷安装：渲染模板 → ProjectFileStore.create（原子写 + compose 校验） → 起容器 → 登记。 */
  const install = async (name: string, template: (typeof templates)[DbEngine], from: string): Promise<unknown> => {
    if (!options.files || !options.projectRoot) throw new DockerError(409, 'NAS 上的 kura-server 没有挂项目目录，不能用快捷安装')
    const password = generatePassword()
    const created = await options.files.create(name, template.compose(name, defaultNetwork), template.env(template.database, template.username, password))
    options.audit({ action: 'docker-db-create', detail: `${name}（${template.engine}）`, exitCode: 0, ip: from })

    registry.add({
      name,
      engine: template.engine,
      container: name,
      port: template.port,
      user: template.username,
      database: template.database,
      dir: created.dir,
      managed: true,
      createdAt: new Date().toISOString(),
    })

    const run = compose({ name, dir: created.dir, configFiles: created.configFiles }, 'up' as ComposeAction)
    const output: string[] = []
    run.onOutput((text) => {
      if (output.length < 200) output.push(text)
    })
    const code = await run.done
    options.audit({ action: 'docker-db-up', detail: name, exitCode: code, ip: from })
    log('数据库安装结束', { 名字: name, 引擎: template.engine, 退出码: code })
    return { ok: code === 0, name, engine: template.engine, output: output.join(''), connection: { container: name, port: template.port, database: template.database, user: template.username } }
  }

  /** 删除：先 down，成功了才按勾选删文件。卷与文件默认都保留。 */
  const remove = async (entry: DatabaseEntry, want: { volumes: boolean; files: boolean }): Promise<void> => {
    if (entry.dir) {
      const configFiles = [`${entry.dir}/docker-compose.yaml`]
      const run = compose({ name: entry.name, dir: entry.dir, configFiles }, want.volumes ? 'down-volumes' : 'down')
      await run.done
      if (want.files && options.files) options.files.removeFiles(entry.dir, configFiles)
    }
    registry.remove(entry.name)
  }

  // ---- WebSocket：隧道 + 命令执行 ----

  const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    // /api/db/<名字>/<tunnel|exec>
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const kind = parts[0] === 'api' && parts[1] === 'db' ? parts[3] : undefined
    const name = parts[2]
    if ((kind !== 'tunnel' && kind !== 'exec') || !name) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    if (req.headers[writeHeader] !== '1') {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }

    // 白名单必须在 101 之前做完：升级之后只能靠 close code，说不清原因。
    // 登记表为空那道闸门在 tunnel.targetOf() 里（见那里的注释）—— 隧道与命令执行都要过它。
    void (async () => {
      try {
        const { entry, raw } = await lookup(name)
        if (kind === 'tunnel') {
          const room = tunnel.canAccept(name)
          if (!room.ok) {
            socket.end(`HTTP/1.1 ${room.status} Too Many Requests\r\nconnection: close\r\n\r\n`)
            return
          }
          const target = await tunnel.targetOf(entry, { assertRunning: true })
          wss.handleUpgrade(req, socket, head, (ws) => {
            options.audit({ action: 'docker-db-tunnel-open', detail: `${name} → ${target.host}:${target.port}`, ip: ipOf(req) })
            void tunnel.attach(name, target, ws).then((stop) => {
              ws.on('close', () => stop())
            })
          })
          return
        }
        // 命令执行：容器必须在跑
        if (!entry.engine) throw new DockerError(400, '认不出这个数据库的引擎，不能用命令执行')
        if (!raw.State.Running) throw new DockerError(409, '数据库没有在运行')
        const from = ipOf(req)
        wss.handleUpgrade(req, socket, head, (ws) => {
          execLoop(ws, entry, raw, from).catch((error) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code: 1, error: errorMessage(error) }))
            if (ws.readyState === ws.OPEN) ws.close()
          })
        })
      } catch (error) {
        const status = error instanceof DockerError ? error.status : 500
        socket.end(`HTTP/1.1 ${status} ${errorMessage(error).replace(/[\r\n]/g, ' ').slice(0, 80)}\r\nconnection: close\r\n\r\n`)
      }
    })()
  }

  /**
   * 跑一条命令：docker exec 进数据库容器，用官方 CLI。参数是数组、不经 shell —— 注入面为零。
   *
   * **连接参数由这里补齐，不交给调用方**：`-U <用户> -d <库>`（MySQL 的 `-u`）与口令都自动带上，
   * 所以命令台里只写 `-c "SELECT version()"` 就是「以这个数据库的身份连它自己」。
   * 理由见 templates.ts `clientEnv` 的长注释（psql 按 OS 用户 root 登录会报 role "root" does not exist）。
   *
   * `raw` 用来在调用方没给口令时从容器环境变量里取（接管的容器没有 .env）。
   */
  const execLoop = async (ws: WebSocket, entry: DatabaseEntry, raw: RawInspect | undefined, from: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    let running = false
    let capacity = 200_000
    const allowed = engineCliCandidates[entry.engine as DbEngine] ?? []
    // 口令只留在服务端：日志与审计都不带它
    const readonly = {
      user: entry.user,
      database: entry.database,
      password: passwordOf(entry, raw),
    }

    const finish = (code: number, error?: string): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
      running = false
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code, ...(error ? { error } : {}) }))
      if (ws.readyState === ws.OPEN) ws.close()
    }

    const run = async (cli: string, args: string[], timeoutMs: number): Promise<void> => {
      if (!allowed.includes(cli)) throw new DockerError(400, `只能用这些：${allowed.join('、')}`)
      for (const arg of args) checkUserRef(arg)
      const startedAt = Date.now()
      running = true
      const env = clientEnv(entry.engine as DbEngine, readonly)
      const argv = [...clientArgs(entry.engine as DbEngine, readonly), ...args]
      const execId = await engine.createExec(entry.container, [cli, ...argv], { tty: false, env })
      const socket = await engine.startExec(execId, { tty: false })
      const demux = createStreamDemuxer()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of demux(chunk)) {
          if (ws.readyState !== ws.OPEN || capacity <= 0) continue
          const text = frame.text.slice(0, capacity)
          capacity -= text.length
          ws.send(JSON.stringify({ type: 'out', stream: frame.stream, text }))
        }
      })
      socket.on('error', (error) => finish(1, error.message))
      socket.on('close', () => {
        void engine
          .inspectExec(execId)
          .then((info) => {
            options.audit({ action: 'docker-db-exec', detail: `${entry.name}：${cli}`, exitCode: info.ExitCode ?? 0, durationMs: Date.now() - startedAt, ip: from })
            finish(info.ExitCode ?? 0)
          })
          .catch(() => finish(0))
      })
      timer = setTimeout(() => {
        socket.destroy()
        options.audit({ action: 'docker-db-exec', detail: `${entry.name}：${cli}（超时）`, exitCode: 124, durationMs: Date.now() - startedAt, ip: from })
        finish(124, `超时（${timeoutMs} ms），已中断`)
      }, timeoutMs)
    }

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      let message: { cli?: unknown; args?: unknown; timeoutMs?: unknown }
      try {
        message = JSON.parse(data.toString('utf8')) as typeof message
      } catch {
        return
      }
      if (running) {
        finish(1, '这条连接上已经有一个命令在跑')
        return
      }
      const cli = String(message.cli ?? '')
      const args = Array.isArray(message.args) ? message.args.filter((a): a is string => typeof a === 'string') : []
      void run(cli, args, clampTimeout(message.timeoutMs)).catch((error) => finish(1, errorMessage(error)))
    })

    ws.on('close', () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    })
  }

  return { handle, upgrade }
}

function clampTimeout(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 30_000
  return Math.max(1_000, Math.min(n, 300_000))
}

/** 浏览命令的超时：默认 15 秒、上限 1 分钟（浏览是交互操作，不该有 `SELECT pg_sleep(600)` 那种）。 */
function clampCommandTimeout(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 15_000
  return Math.max(1_000, Math.min(n, 60_000))
}
