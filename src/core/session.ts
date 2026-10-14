import { errorMessage } from './errors.js'
import { request as defaultRequest, type HttpRequester } from './http.js'
import { silentLogger, type Logger } from './log.js'
import type { UgreenClient } from './ugreen.js'

/** 链路类失败（超时、5xx、绿联会话过期）按台阶退避：5s → 10s → … → 2min。 */
export const transientBackoffBaseMs = 5_000
export const transientBackoffMaxMs = 2 * 60_000

/**
 * 统一网关。
 *
 * **kura-server 不做第二层认证**（Authelia 那套已经删了，见 AGENTS.md），所以这里只需要
 * 「地址在哪儿」——客户端把绿联的 ugreen-proxy-token 带上就够，不必再登录一次。
 * port 为 0 表示没有网关，走网关的服务也用不了（只直连 app-<端口> 域名）。
 */
export interface GatewayAuth {
  port: number
  /** 外网链路上的网关地址 https://app-<网关端口>-<设备>... */
  base: string
  /** 局域网链路上的网关地址 http://<NAS IP>:<网关端口>，可能为空 */
  lanBase: string
  /** 局域网链路上要发的 Host 头（公网网关域名），让容器应用看到的 Host 两种模式一致 */
  lanHostHeader: string
}

export const noGateway: GatewayAuth = { port: 0, base: '', lanBase: '', lanHostHeader: '' }

interface SessionEntry {
  cookie: string
  established: number
}

interface AuthState {
  fails: number
  until: number
  reason: string
}

export interface AuthStatus {
  blocked: boolean
  reason: string
  retryAt: number
  fails: number
}

export interface SessionManagerOptions {
  ugreen: UgreenClient
  ttlMs: number
  gateway?: GatewayAuth
  log?: Logger
  request?: HttpRequester
  /** 测试注入时钟，免得用 sleep 去赌 TTL 与退避边界 */
  now?: () => number
}

/**
 * 维护「每端口一份」的应用会话。
 *
 * 为什么每端口一份：M0 实测会话严格按端口隔离 —— 用 8899 的 cookie 去访问 5244，一律被踢回登录页。
 *
 * 并发模型：同一端口同时只有一个建立中的 Promise（后来者等它）；同一时刻只有一个绿联登录在飞。
 * 这对应 Go 版的「每端口一把锁 + loginMu」。
 */
export class SessionManager {
  gateway: GatewayAuth
  private readonly ugreen: UgreenClient
  private readonly ttlMs: number
  private readonly log: Logger
  private readonly request: HttpRequester
  private readonly now: () => number

  private token = ''
  private loginInFlight: Promise<string> | undefined
  private readonly sessions = new Map<number, SessionEntry>()
  private readonly inFlight = new Map<number, Promise<string>>()
  private readonly refreshPorts = new Set<number>()
  private readonly authStates = new Map<number, AuthState>()
  /** 模式代数：切换模式时 +1，建立到一半的旧会话不再写进缓存 */
  private generation = 0
  private lan = false

  constructor(options: SessionManagerOptions) {
    this.ugreen = options.ugreen
    this.ttlMs = options.ttlMs
    this.gateway = options.gateway ?? noGateway
    this.log = options.log ?? silentLogger
    this.request = options.request ?? defaultRequest
    this.now = options.now ?? Date.now
  }

  /** 由链路路由在模式切换时调用。 */
  setLan(value: boolean): void {
    this.lan = value
  }

  get isLan(): boolean {
    return this.lan
  }

  /**
   * 丢弃全部缓存会话。模式切换后必须调用：
   * 外网会话带着绿联 SSO cookie，局域网链路用不到；反之局域网会话也不含绿联 cookie。
   */
  reset(): void {
    this.generation += 1
    this.sessions.clear()
    this.inFlight.clear()
    this.token = ''
  }

  private usesGateway(port: number): boolean {
    return this.gateway.port !== 0 && port === this.gateway.port
  }

  /** 局域网模式下直连 NAS，什么都不用带（kura-server 不认证）；也没有会话可续期。 */
  private lanNeedsNoSession(_port: number): boolean {
    return this.lan
  }

  /** 返回某个端口的可用会话 cookie；缓存过期或 force 时重建。 */
  async cookie(port: number, force = false): Promise<string> {
    if (this.lanNeedsNoSession(port)) return ''
    const cached = this.cached(port, force)
    if (cached !== undefined) return cached

    // 同一端口已有建立中的会话：等它，不重复建（授权页是一次性的，重复访问拿不到令牌）
    const pending = this.inFlight.get(port)
    if (pending) return pending

    // 退避窗口内直接失败，一个包都不发
    const blocked = this.authBlocked(port)
    if (blocked) {
      throw new Error(`认证退避中（还需 ${Math.ceil(blocked.leftMs / 1000)} 秒）：${blocked.reason}`)
    }

    const generation = this.generation
    const job = this.establish(port).then(
      (cookie) => {
        if (generation === this.generation) this.sessions.set(port, { cookie, established: this.now() })
        return cookie
      },
    )
    this.inFlight.set(port, job)
    try {
      return await job
    } finally {
      if (this.inFlight.get(port) === job) this.inFlight.delete(port)
    }
  }

  private cached(port: number, force: boolean): string | undefined {
    if (force) return undefined
    const entry = this.sessions.get(port)
    if (!entry || this.now() - entry.established >= this.ttlMs) return undefined
    return entry.cookie
  }

  /** 丢弃某个端口的会话，下次请求会重建。上游返回「未认证」时调用。 */
  invalidate(port: number): void {
    if (this.sessions.delete(port)) {
      this.log.warn('会话被上游拒绝，已作废，下次请求将重建', { port })
    }
  }

  /** 建立一份会话，并把失败归类成退避窗口。 */
  private async establish(port: number): Promise<string> {
    try {
      const cookie = await this.establishOnce(port)
      this.clearAuthFailure(port)
      return cookie
    } catch (error) {
      this.recordAuthFailure(port, error)
      throw error
    }
  }

  private async establishOnce(port: number): Promise<string> {
    // 局域网直连：不经过绿联，也就没有 ugreen-proxy-token —— kura-server 不做认证，空 cookie 就够。
    if (this.lan) return ''

    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const apiToken = await this.apiToken(attempt > 0)
      let redirectUrl: string
      try {
        redirectUrl = await this.ugreen.dockerToken(port, apiToken)
      } catch (error) {
        lastError = error
        if (attempt === 0) {
          // 最可能的原因就是 api_token 过期：丢掉缓存再登录一次
          this.log.warn('申请代理令牌失败，丢弃 api_token 后重试', { port, err: errorMessage(error) })
          this.token = ''
          continue
        }
        throw error
      }
      return `ugreen-proxy-token=${await this.ugreen.fetchSsoCookie(redirectUrl)}`
    }
    throw new Error(`建立端口 ${port} 的会话失败：${errorMessage(lastError)}`)
  }

  private async apiToken(force: boolean): Promise<string> {
    if (!force && this.token) return this.token
    // 只允许一个登录在飞：多个端口同时冷启动时不该重复登录
    if (this.loginInFlight) return this.loginInFlight
    const generation = this.generation
    const job = this.ugreen.login().then((token) => {
      if (generation === this.generation) this.token = token
      this.log.info('绿联登录成功')
      return token
    })
    this.loginInFlight = job
    try {
      return await job
    } finally {
      if (this.loginInFlight === job) this.loginInFlight = undefined
    }
  }

  /**
   * 在统一网关上取一个路径，带上当前会话 cookie（网关**自身**的接口，如 /__services）。
   *
   * 链路与 Host 头的处理与 establish 一致：局域网拨局域网地址、Host 发公网域名。
   * 收到 302/401 视为会话失效：作废缓存再试一次；仍不行就把状态码报出去（不跟随重定向）。
   */
  async gatewayGet(path: string): Promise<Buffer> {
    if (this.gateway.port === 0) {
      throw new Error('未配置统一网关，取不到服务端清单')
    }
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let cookie: string
      try {
        cookie = await this.cookie(this.gateway.port, attempt > 0)
      } catch (error) {
        lastError = error
        continue
      }
      const base = this.lan ? this.gateway.lanBase : this.gateway.base
      const host = this.lan ? this.gateway.lanHostHeader : undefined
      let res
      try {
        res = await this.request({ url: base + path, host, headers: cookie ? { cookie } : {}, timeoutMs: 30_000 })
      } catch (error) {
        lastError = error
        continue
      }
      if (res.status === 200) return res.body
      lastError = new Error(`网关返回 HTTP ${res.status}（${path}）`)
      if (res.status === 302 || res.status === 401) {
        this.invalidate(this.gateway.port)
        continue
      }
      break
    }
    throw new Error(`取服务端清单失败：${errorMessage(lastError)}`)
  }

  // ---- 认证退避 ----

  private authBlocked(port: number): { reason: string; leftMs: number } | undefined {
    const state = this.authStates.get(port)
    if (!state || this.now() >= state.until) return undefined
    return { reason: state.reason, leftMs: state.until - this.now() }
  }

  /** 按台阶退避：链路类失败（超时、5xx、绿联会话过期）重试有意义，停一会儿再来。 */
  private recordAuthFailure(port: number, error: unknown): void {
    const state = this.authStates.get(port) ?? { fails: 0, until: 0, reason: '' }
    state.fails += 1
    state.reason = errorMessage(error)
    const backoff = Math.min(transientBackoffBaseMs * 2 ** (state.fails - 1), transientBackoffMaxMs)
    state.until = this.now() + backoff
    this.authStates.set(port, state)

    this.log.warn('建立会话失败，进入退避', {
      port,
      错误: state.reason,
      失败次数: state.fails,
      退避到: new Date(state.until).toLocaleTimeString('zh-CN', { hour12: false }),
    })
  }

  private clearAuthFailure(port: number): void {
    const state = this.authStates.get(port)
    if (!state) return
    this.authStates.delete(port)
    this.log.info('会话恢复，认证退避已清除', { port, 此前失败次数: state.fails })
  }

  /** 人工介入后（例如用户重新输入了凭据）清掉全部退避，允许立刻重试。 */
  clearAllAuthFailures(): void {
    this.authStates.clear()
  }

  /** 当前认证状态：有任一端口在退避中就报它。 */
  authStatus(): AuthStatus {
    for (const state of this.authStates.values()) {
      if (this.now() < state.until) {
        return { blocked: true, reason: state.reason, retryAt: state.until, fails: state.fails }
      }
    }
    return { blocked: false, reason: '', retryAt: 0, fails: 0 }
  }

  // ---- 后台续期 ----

  /**
   * 把会话端口登记进「后台主动续期」集合。集合放在这里而不是启动时算好的数组：
   * 服务可以在运行期被自动挂上来（服务端清单发现），数组看不到后来者。
   */
  addRefreshPort(port: number): void {
    if (port > 0) this.refreshPorts.add(port)
  }

  refreshPortList(): number[] {
    return [...this.refreshPorts].sort((a, b) => a - b)
  }

  /** 启动时把已登记端口的会话都建好，让第一个请求就是热的；返回每个端口的结果。 */
  async primeAll(): Promise<Map<number, Error | undefined>> {
    const ports = this.refreshPortList()
    const results = new Map<number, Error | undefined>()
    await Promise.all(
      ports.map(async (port) => {
        try {
          await this.cookie(port, true)
          results.set(port, undefined)
        } catch (error) {
          results.set(port, error instanceof Error ? error : new Error(String(error)))
          this.log.error('建立会话失败', { port, err: errorMessage(error) })
        }
      }),
    )
    return results
  }

  /** 续期一轮：每轮现读端口集合；退避中的端口跳过（cookie 内部也会拦，这里免得刷日志）。 */
  async refreshOnce(): Promise<void> {
    for (const port of this.refreshPortList()) {
      if (this.lanNeedsNoSession(port)) continue
      if (this.authBlocked(port)) {
        this.log.debug('端口处于认证退避中，本轮跳过续期', { port })
        continue
      }
      try {
        await this.cookie(port, true)
      } catch (error) {
        this.log.warn('后台续期失败', { port, err: errorMessage(error) })
      }
    }
  }

  /** 启动周期续期，返回停止函数。 */
  startRefreshLoop(intervalMs: number): () => void {
    let running = false
    const timer = setInterval(() => {
      if (running) return // 上一轮还没跑完（网络很慢），不叠加
      running = true
      void this.refreshOnce().finally(() => {
        running = false
      })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  sessionCount(): number {
    return this.sessions.size
  }
}
