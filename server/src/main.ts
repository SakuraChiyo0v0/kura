import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { LogFields, Logger } from '../../src/core/log.js'
import type { BuiltinHandler } from './server.js'
import { Auth } from './auth.js'
import { createConsoleHandler } from './console.js'
import { fingerprint, hashPassword, parseHash } from './password.js'
import { Registry, dockerSocketLister } from './registry.js'
import { createKuraServer } from './server.js'
import { createShellServer, internalToken } from './shell/server.js'
import { AuditLog } from './shell/audit.js'
import { TokenStore } from './tokens.js'
import { WebdavFeature, webdavDefaults } from './webdav.js'
import { createAdminHandler, loginPage } from './admin.js'

/**
 * kura-server 入口（同一个镜像两个入口，发布一次）：
 *   kura-server serve   起服务（默认）：认证 + 反代 + 清单 + WebDAV + 终端转发
 *   kura-server shell   起 kura-shell：特权容器里的 PTY / exec，只认内部令牌
 *   kura-server hash    交互式输入密码，打印 argon2id 哈希（填进 .env 的 KURA_PASSWORD_HASH）
 *
 * 配置全部来自环境变量（compose 的 env_file 注入）：
 *   KURA_USER            必填
 *   KURA_PASSWORD_HASH   必填（argon2id PHC；现网 Authelia 的 ADMIN_PASSWORD_HASH 可直接用）
 *   KURA_PORT            监听端口，默认 8080（compose 里映射到宿主 8897）
 *   KURA_STATE           状态目录，默认 /state（会话、services.json、webdav.json、tokens.json）
 *   KURA_SHELL           可选，kura-shell 的地址，如 http://kura-shell:8890；不设就没有终端
 *   KURA_SHELL_TOKEN_FILE 可选，内部令牌经共享卷传递；默认 /run/kura-shell/token
 *   KURA_DOCKER_SOCKET   可选，查容器端口映射用；不设或文件不存在就不查
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
  const user = process.env.KURA_USER?.trim()
  const passwordHash = process.env.KURA_PASSWORD_HASH?.trim()
  if (!user) fatal('KURA_USER 未设置（检查 .env）')
  if (!passwordHash) fatal('KURA_PASSWORD_HASH 未设置。用 `kura-server hash` 生成，填进 .env')
  try {
    parseHash(passwordHash)
  } catch (error) {
    fatal((error as Error).message)
  }
  const state = process.env.KURA_STATE ?? '/state'
  mkdirSync(state, { recursive: true })
  const servicesFile = join(state, 'services.json')
  if (!existsSync(servicesFile)) writeFileSync(servicesFile, '{\n  "services": []\n}\n')

  const socket = process.env.KURA_DOCKER_SOCKET
  const registry = new Registry(
    servicesFile,
    { webdav: 18005, 'nas-console': 8890 },
    socket && existsSync(socket) ? dockerSocketLister(socket) : undefined,
  )
  if (registry.error()) fatal(`services.json 读不了：${registry.error()}`)

  // 内置 WebDAV：容器里跑 rclone，前面套客户端那份范围层。范围存 state/webdav.json，改了即时生效。
  const webdav = new WebdavFeature({
    settings: webdavDefaults,
    settingsFile: join(state, 'webdav.json'),
    log: logger,
  })
  const auth = new Auth({ user, passwordHash, sessionFile: join(state, 'sessions.json') })
  const tokens = new TokenStore(join(state, 'tokens.json'))

  // 终端：kura-server 生成内部令牌、经共享卷给 kura-shell；对客户端暴露 nas-console 那套接口。
  const shellAddress = process.env.KURA_SHELL?.trim() ?? ''
  const tokenFile = process.env.KURA_SHELL_TOKEN_FILE?.trim() || '/run/kura-shell/token'
  let consoleHandler: ReturnType<typeof createConsoleHandler> | undefined
  if (shellAddress) {
    const shellToken = internalToken()
    try {
      mkdirSync(join(tokenFile, '..'), { recursive: true })
      writeFileSync(tokenFile, shellToken, { mode: 0o600 })
    } catch (error) {
      log('写内部令牌失败，终端会不可用', { 文件: tokenFile, err: (error as Error).message })
    }
    consoleHandler = createConsoleHandler({ auth, tokens, shell: () => shellAddress, internalToken: shellToken, log })
  } else {
    log('没有配 KURA_SHELL，终端不可用（这是正常的：没起 kura-shell 容器）')
  }

  const builtins: Record<string, BuiltinHandler> = {
    webdav: { request: (req, res) => webdav.handle(req, res) },
    ...(consoleHandler ? { 'nas-console': { request: (req, res) => consoleHandler!.handle(req, res), upgrade: (req, socket, head) => consoleHandler!.upgrade(req, socket, head) } } : {}),
  }

  // 管理页：范围、服务清单、API Token、状态与审计。认证复用 kura-server 的会话（Authelia 协议）。
  const audit = new AuditLog(join(state, 'audit', 'audit.log'))
  const admin = createAdminHandler({
    auth,
    registry,
    webdav,
    tokens,
    auditTail: (n) => audit.tail(n),
    shellAlive: shellAddress ? () => probeShell(shellAddress) : undefined,
    log,
  })

  const server = createKuraServer({ auth, registry, builtins, admin, log, trustProxy: process.env.KURA_TRUST_PROXY === '1' })
  const port = Number(process.env.KURA_PORT ?? 8080)
  server.listen(port, () => {
    // 凭据指纹：客户端那边对一下就知道密码哈希有没有发错（Authelia entrypoint 留下的做法）
    log('kura-server 已启动', { 端口: port, 用户: user, 凭据指纹: fingerprint(passwordHash), 服务数: registry.list().length })
    webdav.start()
  })

  // services.json 被手改：收到 SIGHUP 重新读（docker kill -s HUP kura-server）
  process.on('SIGHUP', () => {
    registry.reload()
    log(registry.error() ? '重新读取 services.json 失败，沿用上一份' : '已重新读取 services.json', { 服务数: registry.list().length, err: registry.error() })
  })
  const stop = () => {
    webdav.stop()
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
  let token = ''
  // 令牌是 kura-server 启动时才写的：起来晚了就轮询等一会儿，别急着重启容器
  for (let i = 0; i < 60; i++) {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
      if (token) break
    } catch {
      // 还没写
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  if (!token) fatal(`等不到内部令牌（${tokenFile}）：先起 kura-server`)
  const auditFile = process.env.KURA_AUDIT_FILE?.trim() || '/audit/audit.log'
  const port = Number(process.env.KURA_SHELL_PORT ?? 8890)
  const max = Number(process.env.KURA_SHELL_MAX ?? 4)
  const bin = process.env.KURA_SHELL_BIN?.trim() || '/bin/bash'
  const server = createShellServer({ token, audit: new AuditLog(auditFile), maxSessions: max, shell: bin, log })
  // 只监听内部网络（默认绑 0.0.0.0，但容器不发布端口、只在 kura-internal 上）
  server.listen(port, () => log('kura-shell 已启动', { 端口: port, 并发上限: max, 审计: auditFile }))
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

async function hash(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  const password = await rl.question('密码：')
  rl.close()
  if (!password) fatal('密码不能为空')
  const phc = await hashPassword(password)
  console.log(phc)
  console.error(`指纹 ${fingerprint(phc)}；把上面一行填进 .env 的 KURA_PASSWORD_HASH（注意 .env 里的 $ 不用转义，compose 的 env_file 原样读取）`)
}

const command = process.argv[2] ?? 'serve'
if (command === 'serve') await serve()
else if (command === 'shell') await shell()
else if (command === 'hash') await hash()
else fatal(`不认识的子命令：${command}（serve / shell / hash）`)
