import type http from 'node:http'
import type net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { errorMessage } from '../../../src/core/errors.js'
import { engineCliCandidates, type DbEngine } from '../../../src/core/db-types.js'
import type { AuditEntry } from '../shell/audit.js'
import { checkUserRef, createStreamDemuxer, DockerError, type DockerEngine, type RawInspect } from '../docker/engine.js'
import { runCompose, type ComposeAction } from '../docker/compose.js'
import type { ProjectFileStore } from '../docker/files.js'
import { defaultNetwork, generatePassword, passwordEnvKey, readEnv, templates } from './templates.js'
import { discoverDatabases, readProjectEnv, type DatabaseEntry, type DatabaseRegistry } from './registry.js'
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
 * WebSocket：
 *   /api/db/:name/tunnel                     隧道（二进制帧双向搬运）
 *   /api/db/:name/exec                       跑一条命令（docker exec 官方 CLI）
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
    return { entry, raw }
  }

  /** 读一个数据库的密码：从项目 .env 里读回（唯一真相在 NAS 上，Kura 不另存一份）。 */
  const passwordOf = (entry: DatabaseEntry): string => {
    if (!entry.dir) return ''
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
          databases.push({ ...toView(entry, raw), ...(stats[entry.name] ? { tunnel: stats[entry.name] } : {}) })
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
        const password = body.includePassword === true ? passwordOf(entry) : ''
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
          execLoop(ws, entry, from).catch((error) => {
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

  /** 跑一条命令：docker exec 进数据库容器，用官方 CLI。参数是数组、不经 shell —— 注入面为零。 */
  const execLoop = async (ws: WebSocket, entry: DatabaseEntry, from: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    let running = false
    let capacity = 200_000
    const allowed = engineCliCandidates[entry.engine as DbEngine] ?? []

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
      const execId = await engine.createExec(entry.container, [cli, ...args], { tty: false })
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
