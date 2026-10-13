import net from 'node:net'
import { linkModeLabel, type LinkMode, type LinkModeSetting } from '../shared/labels.js'
import { silentLogger, type Logger } from './log.js'
import type { SessionManager } from './session.js'
import { appBase } from './ugreen.js'

export { linkModeLabel, type LinkMode, type LinkModeSetting }

/** 路由只关心服务的这两项：宿主端口、网关注册名（空 = 直连 app-<端口> 域名）。 */
export interface RoutableService {
  port: number
  service?: string
}

/** 一次请求的转发目标。 */
export interface Route {
  /** 上游地址（scheme + host[:port]） */
  upstream: string
  /** 非空时覆盖 Host 头（局域网模式：拨局域网 IP，Host 发公网域名） */
  host: string
  /** 非空时注入 X-Nas-Service（走统一网关的分流协议） */
  gatewayService: string
  /** 用哪个端口的会话（会话严格按端口隔离；走网关的服务共用网关端口那份） */
  sessionPort: number
}

export interface LinkRouterOptions {
  /** 设备域 https://<设备>.cn30.ug.link */
  base: string
  gatewayPort: number
  /** NAS 局域网地址；空 = 只能走外网 */
  lanHost: string
  mode: LinkModeSetting
  sessions: SessionManager
  log?: Logger
  /** 探测局域网可达性时连的端口，默认网关端口 */
  probePort?: number
  /** 测试注入：回答「局域网地址的某端口连得上吗」 */
  reachable?: (host: string, port: number) => Promise<boolean>
}

export class ModeError extends Error {}

/** 只做一次 TCP 连接：回答「我和 NAS 还在同一个局域网吗」，不是「服务健康吗」。 */
export function tcpReachable(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function hostOf(url: string): string {
  return new URL(url).host
}

/**
 * 决定每个请求走局域网还是外网，支持运行时热切换。
 *
 * 即使人在家、和 NAS 同处一个局域网，走中继的流量也是 NAS → 公网 → 中继 → NAS（实测 230–300ms，
 * 局域网 2ms）。有了它，在家自动直连、在外自动走中继。
 *
 * 与 Go 版的一处差异：Go 在启动时按服务列表预算好每个端口的地址，运行期才挂上来的服务
 * （服务端清单发现）查不到、落进兜底分支。这里改成按服务现算（只是字符串拼接），没有这个盲区。
 */
export class LinkRouter {
  readonly lanHost: string
  readonly gatewayPort: number
  private readonly base: string
  private readonly sessions: SessionManager
  private readonly log: Logger
  private readonly probePortValue: number
  private readonly reachableFn: (host: string, port: number) => Promise<boolean>
  private readonly wanGateway: string
  private readonly wanGatewayHost: string
  private readonly lanGateway: string

  private auto = false
  private current: LinkMode = 'wan'
  /** 最近一次探测结果（undefined = 还没探过） */
  lanReachable: boolean | undefined
  private listeners = new Set<(mode: LinkMode, reason: string) => void>()

  constructor(options: LinkRouterOptions) {
    this.base = options.base
    this.gatewayPort = options.gatewayPort
    this.lanHost = options.lanHost.trim()
    this.sessions = options.sessions
    this.log = options.log ?? silentLogger
    this.probePortValue = options.probePort ?? options.gatewayPort
    this.reachableFn = options.reachable ?? tcpReachable

    this.wanGateway = this.gatewayPort ? appBase(this.base, this.gatewayPort) : ''
    this.wanGatewayHost = this.wanGateway ? hostOf(this.wanGateway) : ''
    this.lanGateway = this.gatewayPort && this.lanHost ? `http://${this.joinHost(this.gatewayPort)}` : ''

    // 初始模式：auto 先按外网起步，第一次探测很快会纠正 —— 宁可慢一点，也不要一上来就假设在家
    if (options.mode === 'lan') {
      if (this.lanHost) {
        this.current = 'lan'
      } else {
        this.log.warn('配置要求局域网模式，但没有局域网地址：退回外网中继模式')
      }
    } else if (options.mode === 'auto') {
      this.auto = true
    }
    this.sessions.setLan(this.current === 'lan')
  }

  private joinHost(port: number): string {
    return this.lanHost.includes(':') ? `[${this.lanHost}]:${port}` : `${this.lanHost}:${port}`
  }

  get mode(): LinkMode {
    return this.current
  }

  get isAuto(): boolean {
    return this.auto
  }

  /** 外网与局域网的网关地址，供会话管理器的 GatewayAuth 使用。 */
  gatewayAddresses(): { base: string; lanBase: string; lanHostHeader: string } {
    return { base: this.wanGateway, lanBase: this.lanGateway, lanHostHeader: this.wanGatewayHost }
  }

  onModeChange(listener: (mode: LinkMode, reason: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 按当前模式算出某个服务的转发目标。
   *
   * 局域网模式的关键细节：**拨号地址是局域网 IP，Host 头仍是公网域名**。Authelia 校验请求域必须匹配
   * 它配置的 session cookie 域（只登记了公网域名），用 IP 当 Host 会 401（日志原话：
   * no configured session cookie domain matches the url）。顺带也让容器应用看到的 Host 两种模式一致。
   */
  route(svc: RoutableService): Route {
    const viaGateway = Boolean(svc.service) && this.gatewayPort !== 0
    if (this.current === 'lan' && this.lanHost) {
      if (viaGateway) {
        return { upstream: this.lanGateway, host: this.wanGatewayHost, gatewayService: svc.service!, sessionPort: this.gatewayPort }
      }
      return {
        upstream: `http://${this.joinHost(svc.port)}`,
        host: hostOf(appBase(this.base, svc.port)),
        gatewayService: '',
        sessionPort: svc.port,
      }
    }
    if (viaGateway) {
      return { upstream: this.wanGateway, host: '', gatewayService: svc.service!, sessionPort: this.gatewayPort }
    }
    return { upstream: appBase(this.base, svc.port), host: '', gatewayService: '', sessionPort: svc.port }
  }

  /** 切换模式；模式真的变了才作废会话缓存（两种模式下的会话内容根本不同）。 */
  private setMode(mode: LinkMode, reason: string): void {
    const old = this.current
    if (old === mode) return
    this.current = mode
    this.sessions.reset()
    this.sessions.setLan(mode === 'lan')
    this.log.info('链路模式已切换', { 从: linkModeLabel[old], 到: linkModeLabel[mode], 原因: reason })
    for (const listener of this.listeners) listener(mode, reason)
  }

  /** 供界面使用：auto 表示交回自动探测（并立刻探一次）。 */
  async setModeSetting(setting: LinkModeSetting): Promise<void> {
    if (setting !== 'wan' && !this.lanHost) {
      throw new ModeError('没有配置 NAS 局域网地址，无法使用局域网模式')
    }
    if (setting === 'auto') {
      this.auto = true
      await this.probeOnce('切回自动模式')
      return
    }
    this.auto = false
    this.setMode(setting, '手动切换')
  }

  async probeOnce(reason: string): Promise<void> {
    const ok = this.lanHost && this.probePortValue ? await this.reachableFn(this.lanHost, this.probePortValue) : false
    this.lanReachable = ok
    if (!this.auto) return
    this.setMode(ok ? 'lan' : 'wan', `${reason}：${ok ? '探测到局域网可达' : '探测不到局域网地址'}`)
  }

  /** auto 模式下周期探测，返回停止函数。没有局域网地址就什么都不做。 */
  startProbeLoop(intervalMs: number): () => void {
    if (!this.lanHost) return () => {}
    void this.probeOnce('启动探测')
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void this.probeOnce('周期探测').finally(() => {
        running = false
      })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
