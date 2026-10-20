import type net from 'node:net'
import type { DbEngine } from '../../../src/core/db-types.js'
import { DockerError, type DockerEngine } from '../docker/engine.js'
import { passwordEnvKey, readEnv } from './templates.js'
import { readProjectEnv, type DatabaseEntry, type DatabaseRegistry } from './registry.js'
import { TunnelService } from './tunnel.js'

/**
 * 「按数据库名拿到一条真的数据库连接」—— 浏览面板与 SQL 执行的唯一入口。
 *
 * 这里解决一个绕不开的问题：**接管的容器没有 .env**。
 *
 * Kura 自己装的数据库，口令在项目目录的 `.env` 里（唯一真相在 NAS 上，见 docs/数据库管理 设计.md §八）。
 * 但接管的（NAS 上原本就有的、绿联商店装的）根本没有那个 `.env`，口令只存在于容器自己的环境变量里
 * —— 而从 `Config.Env` 里读出来的口令是**明文**，那些变量本身就是服务端的配置。
 *
 * 处理方式：**先查容器自己的环境变量**（对 Kura 装的与接管的都成立 —— compose 的 ${VAR} 展开后
 * 最终也是这样进容器的），再退回项目 `.env`。这样接管来的库大多能自动连上，不用用户手输。
 * 两者都拿不到（比如口令是用户后来手动 ALTER USER 改的）才需要界面让用户输一次，
 * 那份口令**只存在客户端内存里**，不落盘。
 */

export interface DbCredentials {
  password: string
  /** 从哪拿到的；'container' / 'env' / 'client' / ''（不需要口令） */
  source: 'container' | 'env' | 'client' | ''
}

export interface DbConnectorOptions {
  registry: DatabaseRegistry
  engine: DockerEngine
  tunnel: TunnelService
  /**
   * 测试注入：换掉真的 `net.connect`。
   *
   * 真机上目标是**容器名**（由 Docker 内置 DNS 解析到容器 IP，见 tunnel.ts 的注释）；
   * 单测里没有 docker，容器名解析不了，只能把这一段换掉。**它必须一路传到驱动那一层**
   * —— 只在 `targetOf()` 里换是不够的，那只是校验，真正连的是驱动。
   */
  connect?: (host: string, port: number) => net.Socket
  log?: (message: string, fields?: Record<string, unknown>) => void
}

/** 一个已经定位好、可以连的数据库。 */
export interface ResolvedDatabase {
  entry: DatabaseEntry
  engine: DbEngine
  /** 容器名（Docker DNS） */
  host: string
  port: number
  user: string
  database: string
  password: string
  /** 口令从哪来（拿不到时为空，界面可以据此提示「需要输一次口令」） */
  passwordSource: DbCredentials['source']
  /** 只有测试注入时才有；驱动要把它透传给自己的 `connect` 选项 */
  connect?: (host: string, port: number) => net.Socket
}

/** 从容器的 `Config.Env` 里读一个变量。 */
function envOfContainer(env: string[] | undefined, key: string): string {
  for (const line of env ?? []) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    if (line.slice(0, at) === key) return line.slice(at + 1)
  }
  return ''
}

export class DbConnector {
  constructor(private readonly options: DbConnectorOptions) {}

  /**
   * 定位一个数据库并配好凭据。
   *
   * **白名单还是走 `tunnel.targetOf()`** —— 那是唯一入口（登记表为空一律拒绝、
   * 容器必须存在且在跑、端口从容器实际读）。这里只是多带一份口令出来，不另开一条路。
   */
  async resolve(
    name: string,
    options: { assertRunning?: boolean; clientPassword?: string; requirePassword?: boolean } = {},
  ): Promise<ResolvedDatabase> {
    const { registry, engine, tunnel } = this.options
    const entry = registry.find(name)
    const found = entry ?? (await this.discover(name))
    if (!found) throw new DockerError(404, `没有叫「${name}」的数据库`)
    if (!found.engine) throw new DockerError(400, `认不出「${name}」是什么引擎，看不了数据`)

    const target = await tunnel.targetOf(found, { assertRunning: options.assertRunning !== false })

    // 口令顺序：调用方给的（界面上用户手输、只在内存）→ 容器环境变量 → 项目 .env
    let password = options.clientPassword ?? ''
    let source: DbCredentials['source'] = password ? 'client' : ''
    if (!password) {
      const raw = await engine.inspectContainer(found.container)
      const key = passwordEnvKey(found.engine)
      password = envOfContainer(raw.Config?.Env, key)
      if (password) source = 'container'
    }
    if (!password && found.dir) {
      password = readEnv(readProjectEnv(found.dir), passwordEnvKey(found.engine))
      if (password) source = 'env'
    }

    // Redis 的 requirepass 一定要有；关系库没口令时容器内 socket 也可能能连（pg 的 trust / peer），
    // 所以不在这里一刀切，让驱动自己报认证失败，错误信息更能说明问题
    if (!password && found.engine === 'redis' && options.requirePassword) {
      throw new DockerError(401, '拿不到这个 Redis 的口令：在界面里输一次（只存在本机内存里）')
    }

    const user = found.user || ''
    return {
      entry: found,
      engine: found.engine,
      host: target.host,
      port: target.port,
      user,
      database: found.database || '',
      password,
      passwordSource: source,
      ...(this.options.connect ? { connect: this.options.connect } : {}),
    }
  }

  /** 登记表里没有的（接管的容器）现查一次，和 `discoverDatabases` 同一套认法。 */
  private async discover(name: string): Promise<DatabaseEntry | undefined> {
    const { discoverDatabases } = await import('./registry.js')
    const all = await discoverDatabases(this.options.engine, this.options.registry)
    return all.find((e) => e.name === name)
  }
}
