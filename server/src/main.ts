import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Auth } from './auth.js'
import { fingerprint, hashPassword, parseHash } from './password.js'
import { Registry, dockerSocketLister } from './registry.js'
import { createKuraServer } from './server.js'

/**
 * kura-server 入口：
 *   kura-server serve   起服务（默认）
 *   kura-server hash    交互式输入密码，打印 argon2id 哈希（填进 .env 的 KURA_PASSWORD_HASH）
 *
 * 配置全部来自环境变量（compose 的 env_file 注入）：
 *   KURA_USER            必填
 *   KURA_PASSWORD_HASH   必填（argon2id PHC；现网 Authelia 的 ADMIN_PASSWORD_HASH 可直接用）
 *   KURA_PORT            监听端口，默认 8080（compose 里映射到宿主 8897）
 *   KURA_STATE           状态目录，默认 /state（会话、services.json、审计）
 *   KURA_DOCKER_SOCKET   可选，查容器端口映射用；不设或文件不存在就不查
 *   KURA_TRUST_PROXY     1 = 信任 X-Forwarded-For（前面还有一层反代时才开）
 */

function log(message: string, fields?: Record<string, unknown>): void {
  const extra = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`).join(' ') : ''
  console.log(`${new Date().toISOString()} ${message}${extra}`)
}

function fatal(message: string): never {
  console.error(`FATAL: ${message}`)
  process.exit(1)
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

  const auth = new Auth({ user, passwordHash, sessionFile: join(state, 'sessions.json') })
  const server = createKuraServer({ auth, registry, log, trustProxy: process.env.KURA_TRUST_PROXY === '1' })
  const port = Number(process.env.KURA_PORT ?? 8080)
  server.listen(port, () => {
    // 凭据指纹：客户端那边对一下就知道密码哈希有没有发错（Authelia entrypoint 留下的做法）
    log('kura-server 已启动', { 端口: port, 用户: user, 凭据指纹: fingerprint(passwordHash), 服务数: registry.list().length })
  })

  // services.json 被手改：收到 SIGHUP 重新读（docker kill -s HUP kura-server）
  process.on('SIGHUP', () => {
    registry.reload()
    log(registry.error() ? '重新读取 services.json 失败，沿用上一份' : '已重新读取 services.json', { 服务数: registry.list().length, err: registry.error() })
  })
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
else if (command === 'hash') await hash()
else fatal(`不认识的子命令：${command}（serve / hash）`)
