import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import { join } from 'node:path'
import type { LogFields, Logger } from '../../src/core/log.js'
import type { BuiltinHandler } from './server.js'
import { createConsoleHandler } from './console.js'
import { Registry, dockerSocketLister } from './registry.js'
import { createKuraServer } from './server.js'
import { createShellServer, internalToken } from './shell/server.js'
import { AuditLog } from './shell/audit.js'
import { TokenStore } from './tokens.js'
import { WebdavFeature, webdavDefaults } from './webdav.js'
import { createAdminHandler } from './admin.js'
import { DockerEngine } from './docker/engine.js'
import { ProjectFileStore, composeValidator } from './docker/files.js'
import { createDockerHandler, type AuditSink } from './docker/handler.js'
import { DockerService, appstoreRoot } from './docker/service.js'
import { AutoUpdate } from './docker/autoupdate.js'
import { ProjectLocks } from './docker/locks.js'
import { createDbHandler } from './db/handler.js'
import { DatabaseRegistry } from './db/registry.js'
import { TunnelService } from './db/tunnel.js'

/**
 * kura-server 入口（同一个镜像两个入口，发布一次）：
 *   kura-server serve   起服务（默认）：反代 + 清单 + WebDAV + 终端转发
 *   kura-server shell   起 kura-shell：特权容器里的 PTY / exec，只认内部令牌
 *
 * **不做认证**：kura-server 要么只从绿联中继进来（中继已认证绿联账号），要么在局域网里直连
 * （由更外层的手段保护，见 AGENTS.md）。客户端因此只需要绿联那一组账号密码。
 *
 * 配置全部来自环境变量（compose 的 env_file 注入）：
 *   KURA_PORT            监听端口，默认 8080（compose 里映射到宿主 8898）
 *   KURA_STATE           状态目录，默认 /state（services.json、webdav.json、tokens.json）
 *   KURA_SHELL           可选，kura-shell 的地址，如 http://kura-shell:8890；不设就没有终端
 *   KURA_SHELL_TOKEN_FILE 可选，内部令牌经共享卷传递；默认 /run/kura-shell/token
 *   KURA_DOCKER_SOCKET   可选，查容器端口映射 + 容器管理（内置服务 docker）；不设或文件不存在就都没有
 *   KURA_PROJECT_ROOT    compose 项目目录（宿主原路径，容器里按原路径挂），默认 /volume1/docker
 *   KURA_TRUST_PROXY     1 = 信任 X-Forwarded-For（前面还有一层反代时才开）
 */

function emit(level: string, message: string, fields?: LogFields): void {
  const extra = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`).join(' ') : ''
  const line = `${new Date().toISOString()} ${level} ${message}${extra}`
  if (level === 'ERROR' || level === 'WARN') console.error(line)
  else console.log(line)
}

/** kura-server 自己的日志（简洁的一行）。 */
function log(message: string, fields?: LogFields): void {
  emit('INFO', message, fields)
}

/** 注入给 core 里那些要 Logger 接口的地方（WebDAV 转发失败之类）。 */
const logger: Logger = {
  debug: () => {},
  info: (message, fields) => emit('INFO', message, fields),
  warn: (message, fields) => emit('WARN', message, fields),
  error: (message, fields) => emit('ERROR', message, fields),
}

function fatal(message: string): never {
  console.error(`FATAL: ${message}`)
  process.exit(1)
}

/**
 * 读共享卷上的内部令牌；没有才生成并写下去。
 *
 * 持久化不是为了「少生成一次」，是为了自动更新不出事：watchtower 只重建镜像变了的那个容器，
 * 单独重建 kura-server 时若换了令牌，还在跑的 kura-shell 就拿旧令牌 —— 终端全线 401。
 */
function readOrCreateToken(file: string, log: (message: string, fields?: LogFields) => void): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // 首次启动：文件还不存在
  }
  const token = internalToken()
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
  } catch (error) {
    log('写内部令牌失败，终端会不可用', { 文件: file, err: (error as Error).message })
  }
  return token
}

/** 探 kura-shell 在不在（拿它的免认证 /api/health）。 */
async function probeShell(base: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(base)
      const req = http.request({ hostname: url.hostname, port: url.port, path: '/api/health', method: 'GET', timeout: 3_000 }, (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) === 200)
      })
      req.on('timeout', () => req.destroy(new Error('超时')))
      req.on('error', () => resolve(false))
      req.end()
    } catch {
      resolve(false)
    }
  })
}

async function serve(): Promise<void> {
  const state = process.env.KURA_STATE ?? '/state'
  mkdirSync(state, { recursive: true })
  const servicesFile = join(state, 'services.json')
  if (!existsSync(servicesFile)) writeFileSync(servicesFile, '{\n  "services": []\n}\n')

  const socket = process.env.KURA_DOCKER_SOCKET
  const hasDocker = Boolean(socket && existsSync(socket))
  // 内置服务固定出现在清单上；docker 只在挂了 sock 时出现（客户端据此决定「容器」页可不可用）。
  // 端口号只是清单里的标签：内置服务都由 kura-server 自己处理，不会真按端口去连。
  const registry = new Registry(
    servicesFile,
    { webdav: 18005, 'nas-console': 8890, ...(hasDocker ? { docker: 2375 } : {}) },
    hasDocker ? dockerSocketLister(socket!) : undefined,
  )
  if (registry.error()) fatal(`services.json 读不了：${registry.error()}`)

  // 内置 WebDAV：容器里跑 rclone，前面套客户端那份范围层。范围存 state/webdav.json，改了即时生效。
  const webdav = new WebdavFeature({
    settings: webdavDefaults,
    settingsFile: join(state, 'webdav.json'),
    log: logger,
  })
  const tokens = new TokenStore(join(state, 'tokens.json'))

  // 终端：kura-server 生成内部令牌、经共享卷给 kura-shell；对客户端暴露 nas-console 那套接口。
  //
  // **令牌要持久**：共享卷上已有就沿用，没有才生成。watchtower 只重建**变了镜像的那个**容器 ——
  // 如果 kura-server 每次启动都换新令牌，watchtower 单独重建它之后，还在跑的 kura-shell 拿的是
  // 上一个令牌，终端会全线 401（容器都在跑，但连不上，最难查的那种）。沿用旧令牌就没这个问题。
  const shellAddress = process.env.KURA_SHELL?.trim() ?? ''
  const tokenFile = process.env.KURA_SHELL_TOKEN_FILE?.trim() || '/run/kura-shell/token'
  let consoleHandler: ReturnType<typeof createConsoleHandler> | undefined
  if (shellAddress) {
    const shellToken = readOrCreateToken(tokenFile, log)
    consoleHandler = createConsoleHandler({ tokens, shell: () => shellAddress, internalToken: shellToken, log })
  } else {
    log('没有配 KURA_SHELL，终端不可用（这是正常的：没起 kura-shell 容器）')
  }

  const audit = new AuditLog(join(state, 'audit', 'audit.log'))

  // 容器管理：同一个 docker.sock，接口由 server/src/docker/engine.ts 白名单。项目目录要按宿主原路径挂进来。
  const docker = hasDocker
    ? (() => {
        const engine = new DockerEngine({ socketPath: socket! })
        const projectRoot = process.env.KURA_PROJECT_ROOT?.trim() ?? '/volume1/docker'
        // 项目目录没按原路径挂进来就不给编辑：写进去的文件宿主上看不到
        const files = existsSync(projectRoot) ? new ProjectFileStore(projectRoot, composeValidator()) : undefined
        let seq = 0
        const auditSink = (entry: Parameters<AuditSink>[0]) => audit.write({ ...entry, at: new Date().toISOString(), id: `d${Date.now().toString(36)}${++seq}`, user: 'kura' })
        const service = new DockerService({
          engine,
          projectRoot,
          // 绿联商店的项目要能启停，它的目录也得按原路径挂进来；没挂就只读
          appstoreMounted: existsSync(appstoreRoot),
        })
        // 项目级 compose 锁：界面操作与自动更新**共用同一把**，否则自动更新在 pull + up
        // 的时候用户点「重启」，两边会同时动同一个项目的容器（见 locks.ts）。
        const locks = new ProjectLocks()
        // 按项目的自动更新：跑在**这个已经常驻的进程**里，不多一个容器、不多一份配置
        // （见 autoupdate.ts 顶部）。它只管别人的项目，kura-server 自己仍然由 watchtower 更新。
        const autoupdate = new AutoUpdate({
          engine,
          service,
          file: join(state, 'autoupdate.json'),
          locks,
          onResult: (r) => auditSink({ action: 'docker-auto-update', detail: `${r.project}：${r.ok ? `更新了 ${r.images.join('、')}` : r.reason}`, exitCode: r.ok ? 0 : 1 }),
          log,
        })
        const handler = createDockerHandler({
          engine,
          service,
          files,
          autoupdate,
          locks,
          audit: auditSink,
          activity: (n) => audit.tail(n * 4),
          log,
        })

        // 数据库管理：挂在**同一个内置服务 docker** 下（路径 /api/db/*）。
        // 不新增内置服务名 —— Mirror.attach() 会给每个内置服务在本机回环绑一个监听，
        // 多一个 `db` 就是凭空多一个 127.0.0.1 端口、还可能撞端口。见 server/src/db/handler.ts 顶部。
        const dbRegistry = new DatabaseRegistry(join(state, 'databases.json'))
        const tunnel = new TunnelService({ registry: dbRegistry, engine, log })
        const dbHandler = createDbHandler({ registry: dbRegistry, engine, tunnel, audit: auditSink, projectRoot, files, log })

        // 调度随进程起；serve() 退出时跟着停（stop() 里调）
        const stopAuto = autoupdate.start()

        return {
          request: (req: http.IncomingMessage, res: http.ServerResponse, path: string) =>
            path.startsWith('/api/db/') ? void dbHandler.handle(req, res) : void handler.handle(req, res),
          upgrade: (req: http.IncomingMessage, sock: net.Socket, head: Buffer, path: string) =>
            path.startsWith('/api/db/') ? dbHandler.upgrade(req, sock, head) : handler.upgrade(req, sock, head),
          /** 退出时断掉所有隧道、停掉调度 */
          close: () => {
            stopAuto()
            tunnel.closeAll()
          },
        }
      })()
    : undefined

  const builtins: Record<string, BuiltinHandler> = {
    webdav: { request: (req, res) => webdav.handle(req, res) },
    ...(consoleHandler ? { 'nas-console': { request: (req, res) => consoleHandler!.handle(req, res), upgrade: (req, socket, head) => consoleHandler!.upgrade(req, socket, head) } } : {}),
    ...(docker ? { docker: { request: (req, res, path) => docker.request(req, res, path), upgrade: (req, sock, head, path) => docker.upgrade(req, sock, head, path) } } : {}),
  }

  // 管理页：范围、服务清单、API Token、状态与审计。没有登录，直接打开。
  const admin = createAdminHandler({
    registry,
    webdav,
    tokens,
    auditTail: (n) => audit.tail(n),
    shellAlive: shellAddress ? () => probeShell(shellAddress) : undefined,
    log,
  })

  const server = createKuraServer({ registry, builtins, admin, log, trustProxy: process.env.KURA_TRUST_PROXY === '1' })
  const port = Number(process.env.KURA_PORT ?? 8080)
  server.listen(port, () => {
    log('kura-server 已启动', { 端口: port, 服务数: registry.list().length })
    webdav.start()
  })

  // services.json 被手改：收到 SIGHUP 重新读（docker kill -s HUP kura-server）
  process.on('SIGHUP', () => {
    registry.reload()
    log(registry.error() ? '重新读取 services.json 失败，沿用上一份' : '已重新读取 services.json', { 服务数: registry.list().length, err: registry.error() })
  })
  const stop = () => {
    webdav.stop()
    // 隧道是长连接：先断掉，否则 server.close() 会一直等它们排空
    docker?.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

/**
 * kura-shell：特权容器里的执行器。**它不认用户**，只认 kura-server 经共享卷传来的内部令牌。
 *
 *   KURA_SHELL_PORT       监听端口，默认 8890
 *   KURA_SHELL_TOKEN_FILE 内部令牌文件，默认 /run/kura-shell/token
 *   KURA_AUDIT_FILE       审计文件，默认 /audit/audit.log（容器里挂 ./state/audit）
 *   KURA_SHELL_MAX        PTY 并发上限，默认 4
 *   KURA_SHELL_BIN        进宿主用的 shell，默认 /bin/bash
 */
async function shell(): Promise<void> {
  const tokenFile = process.env.KURA_SHELL_TOKEN_FILE?.trim() || '/run/kura-shell/token'
  // 令牌是 kura-server 写进共享卷的：起来晚了就轮询等一会儿，别急着重启容器。
  // 启动后也**每次请求现读**（下面给的是函数）：这样 kura-server 单独重建、换了令牌时，
  // 这个还在跑的容器不用重启就跟上，终端不会因为一次自动更新而断掉。
  let ready = false
  for (let i = 0; i < 60; i++) {
    try {
      if (readFileSync(tokenFile, 'utf8').trim()) {
        ready = true
        break
      }
    } catch {
      // 还没写
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  if (!ready) fatal(`等不到内部令牌（${tokenFile}）：先起 kura-server`)
  const readToken = (): string => {
    try {
      return readFileSync(tokenFile, 'utf8').trim()
    } catch {
      return ''
    }
  }
  const auditFile = process.env.KURA_AUDIT_FILE?.trim() || '/audit/audit.log'
  const port = Number(process.env.KURA_SHELL_PORT ?? 8890)
  const max = Number(process.env.KURA_SHELL_MAX ?? 4)
  const bin = process.env.KURA_SHELL_BIN?.trim() || '/bin/bash'
  const server = createShellServer({ token: readToken, audit: new AuditLog(auditFile), maxSessions: max, shell: bin, log })
  // 只监听内部网络（默认绑 0.0.0.0，但容器不发布端口、只在 kura-internal 上）
  server.listen(port, () => log('kura-shell 已启动', { 端口: port, 并发上限: max, 审计: auditFile }))
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

const command = process.argv[2] ?? 'serve'
if (command === 'serve') await serve()
else if (command === 'shell') await shell()
else fatal(`不认识的子命令：${command}（serve / shell）`)
