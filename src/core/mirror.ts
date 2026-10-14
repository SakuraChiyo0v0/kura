import { join } from 'node:path'
import { errorMessage } from './errors.js'
import { request as defaultRequest, type HttpRequester } from './http.js'
import { LinkRouter, type LinkMode, type LinkModeSetting } from './link.js'
import { ServiceListener, type ListenerStatus } from './listener.js'
import { silentLogger, type Logger } from './log.js'
import { createServiceProxy } from './proxy.js'
import { SessionManager, noGateway, type AuthStatus } from './session.js'
import { ServiceStats, type StatsSnapshot } from './stats.js'
import { ServiceOverrideStore, readJson, writeJsonAtomic } from './store.js'
import { UgreenClient, appBase } from './ugreen.js'
import { Watchdog, type ProbeResult } from './watchdog.js'

/** 连接配置：引导页收集、凭据加密保存，由主进程交给核心。 */
export interface ConnectionConfig {
  /** UGREENlink ID（用户填的那串，如 <设备ID>）；老配置可能没有 */
  uglinkId?: string
  /** 设备域 https://<设备>.cn30.ug.link（由 ID 解析得到，存下来以便离线可用） */
  base: string
  ugreenUser: string
  ugreenPassword: string
  /** NAS 局域网地址；空 = 只走外网 */
  lanHost: string
  mode: LinkModeSetting
  /** 统一网关宿主端口；0 = 不用网关 */
  gatewayPort: number
  gatewayUser: string
  gatewayPassword: string
}

/** 一个要映射到本机的服务。 */
export interface ServiceSpec {
  /** NAS 上的端口（已发布到宿主的端口；没发布的退用容器端口） */
  port: number
  /** 网关注册名；空 = 直连 app-<端口> 域名 */
  service?: string
  label: string
  group?: string
  note?: string
  /** 来源：本地配置 / 服务端清单发现 */
  source: 'local' | 'discovered'
  headers?: Record<string, string>
  localPort?: number
  enabled?: boolean
}

export interface ServiceView {
  key: string
  spec: ServiceSpec
  listener: ListenerStatus
  /** 本机地址 http://127.0.0.1:<端口> */
  localUrl: string
  /** 绿联外链（手机绿联 App 里那条）；只说明「登录后可达」，不代表已验证 */
  externalUrl: string
  stats: StatsSnapshot
  probe?: ProbeResult
}

export interface DiscoveryState {
  lastSync: number
  lastError: string
  entries: number
  added: number
  skipped: string[]
}

/**
 * 启动到哪一步了，给界面画进度用（而不是一片空白）：
 * - starting：刚起，还没挂任何东西
 * - syncing：上次缓存的服务已经挂上（fromCache），正在登录并拉最新清单
 * - ready：至少成功同步过一次清单
 * - failed：首次同步失败（仍按缓存运行，原因在 discovery.lastError）
 */
export type MirrorPhase = 'starting' | 'syncing' | 'ready' | 'failed'

export interface MirrorSnapshot {
  running: boolean
  phase: MirrorPhase
  /** 当前的服务是不是上次缓存的清单挂出来的（最新清单还没到） */
  fromCache: boolean
  mode: LinkMode
  modeSetting: LinkModeSetting
  lanHost: string
  lanReachable: boolean | undefined
  sessions: number
  auth: AuthStatus
  discovery: DiscoveryState
  services: ServiceView[]
}

export interface MirrorOptions {
  config: ConnectionConfig
  /** 用户数据目录：服务改动、清单缓存放在这里 */
  dataDir: string
  localServices?: ServiceSpec[]
  log?: Logger
  request?: HttpRequester
  sessionTtlMs?: number
  refreshIntervalMs?: number
  lanProbeIntervalMs?: number
  discoverIntervalMs?: number
  /** watchdog 间隔，0 关闭 */
  probeIntervalMs?: number
  discover?: boolean
}

/** /__services 的一条（字段见服务端 gen-services.sh；host_port 为 0 = 没发布到宿主）。 */
interface RegistryEntry {
  name: string
  container_port?: number
  host_port?: number
  published?: boolean
}

export const discoveryGroup = '服务端发现'

function toSpec(entry: RegistryEntry): ServiceSpec {
  const port = entry.host_port && entry.host_port > 0 ? entry.host_port : (entry.container_port ?? 0)
  return {
    port,
    service: entry.name,
    label: entry.name,
    group: discoveryGroup,
    note: '来自服务端清单（自动发现）',
    source: 'discovered',
  }
}

interface Mounted {
  key: string
  spec: ServiceSpec
  listener: ServiceListener
  stats: ServiceStats
  handlers: ReturnType<typeof createServiceProxy>
  /** Kura 自己用的内部通道（见 internalEndpoint），按需才建 */
  internal?: ServiceListener
}

/** 服务端清单里还没有这个服务（没部署、或清单还没拉到）。 */
export class ServiceMissingError extends Error {}

/**
 * 端口映射的总装：会话、链路、反代、监听、发现、探测都在这里接起来。
 *
 * 取舍沿用 Go 版：
 * - 服务端清单**只增不减**：清单里消失的服务不自动关（生成脚本没重跑、临时读不到，都不该停掉本机在用的镜像）
 * - **本地优先**：本地配置先挂，清单里同名 / 同端口的跳过
 * - 拉不到就用**上次的缓存**；已挂上的一律不动（用户手动关掉的不会被下一轮同步重新打开）
 */
export class Mirror {
  readonly sessions: SessionManager
  readonly router: LinkRouter
  private readonly config: ConnectionConfig
  private readonly log: Logger
  private readonly watchdog: Watchdog
  private readonly overrides: ServiceOverrideStore
  private readonly cacheFile: string
  private readonly options: MirrorOptions
  private readonly byKey = new Map<string, Mounted>()
  private readonly byPort = new Map<number, Mounted>()
  private stops: Array<() => void> = []
  private running = false
  private modeSetting: LinkModeSetting
  private discoveryState: DiscoveryState = { lastSync: 0, lastError: '', entries: 0, added: 0, skipped: [] }
  private phase: MirrorPhase = 'starting'
  private fromCache = false
  private readonly changeListeners = new Set<() => void>()

  /**
   * 状态有变化（挂上新服务、开关、改端口、同步结果、链路切换）时回调。
   * 主进程用它主动把快照推给界面，不让界面靠轮询干等。
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // 订阅方自己的错，不影响映射
      }
    }
  }

  constructor(options: MirrorOptions) {
    this.options = options
    this.config = options.config
    this.log = options.log ?? silentLogger
    this.modeSetting = options.config.mode
    const request = options.request ?? defaultRequest
    this.sessions = new SessionManager({
      ugreen: new UgreenClient(
        { base: this.config.base, username: this.config.ugreenUser, password: this.config.ugreenPassword },
        request,
      ),
      ttlMs: options.sessionTtlMs ?? 15 * 60_000,
      log: this.log,
      request,
    })
    this.router = new LinkRouter({
      base: this.config.base,
      gatewayPort: this.config.gatewayPort,
      lanHost: this.config.lanHost,
      mode: this.config.mode,
      sessions: this.sessions,
      log: this.log,
    })
    if (this.config.gatewayPort && this.config.gatewayUser && this.config.gatewayPassword) {
      this.sessions.gateway = {
        port: this.config.gatewayPort,
        ...this.router.gatewayAddresses(),
        user: this.config.gatewayUser,
        password: this.config.gatewayPassword,
      }
    } else {
      this.sessions.gateway = noGateway
      if (this.config.gatewayPort) this.log.warn('已启用统一网关但没有网关凭据：走网关的服务会登录失败')
    }
    this.watchdog = new Watchdog({ log: this.log })
    this.overrides = new ServiceOverrideStore(join(options.dataDir, 'services.json'))
    this.cacheFile = join(options.dataDir, 'discovered.json')
  }

  private keyOf(spec: ServiceSpec): string {
    return spec.service || `port-${spec.port}`
  }

  /**
   * 把一个服务挂上本机：建统计、反代、监听，登记续期端口。启动和运行期发现共用这一条路，
   * 免得「启动能起、自动发现起不来」。已挂过就直接复用（同步每轮都会把清单过一遍）。
   */
  private attach(spec: ServiceSpec): Mounted {
    const key = this.keyOf(spec)
    const exist = this.byKey.get(key)
    if (exist) return exist
    if (spec.port <= 0 || spec.port > 65535) throw new Error(`端口 ${spec.port} 不合法`)

    const override = this.overrides.get(spec.port)
    const localPort = override.localPort ?? spec.localPort ?? spec.port
    const taken = this.byPort.get(localPort)
    if (taken) throw new Error(`本机端口 ${localPort} 已被 ${taken.spec.label} 占用`)

    const stats = new ServiceStats()
    const proxy = createServiceProxy(
      { port: spec.port, service: spec.service, label: spec.label, headers: spec.headers },
      { sessions: this.sessions, router: this.router, log: this.log },
      stats,
    )
    const listener = new ServiceListener({
      port: localPort,
      enabled: override.enabled ?? spec.enabled ?? true,
      handlers: proxy,
    })
    const mounted: Mounted = { key, spec, listener, stats, handlers: proxy }
    this.byKey.set(key, mounted)
    this.byPort.set(localPort, mounted)
    this.sessions.addRefreshPort(this.router.route(spec).sessionPort)
    return mounted
  }

  /** 挂上并按开关意图启动；端口被占只记原因、不抛（界面上显示「开着但监听失败」）。 */
  private async mount(spec: ServiceSpec): Promise<Mounted> {
    const mounted = this.attach(spec)
    try {
      await mounted.listener.applyIntent()
    } catch (error) {
      this.log.warn('服务监听失败', { service: spec.label, err: errorMessage(error) })
    }
    return mounted
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    for (const spec of this.options.localServices ?? []) {
      try {
        await this.mount(spec)
      } catch (error) {
        this.log.warn('本地配置的服务挂载失败', { service: spec.label, err: errorMessage(error) })
      }
    }
    const discover = this.options.discover ?? true
    if (discover) {
      await this.applyCache()
      this.fromCache = this.byKey.size > 0
      this.phase = 'syncing'
    } else {
      this.phase = 'ready'
    }
    this.stops.push(this.router.onModeChange(() => this.changed()))
    this.changed()

    // 网关端口本身也要续期：零服务配置时续期集合是空的，凭据坏了也照样显示「就绪」
    if (this.config.gatewayPort) this.sessions.addRefreshPort(this.config.gatewayPort)

    this.stops.push(this.router.startProbeLoop(this.options.lanProbeIntervalMs ?? 10_000))
    this.stops.push(this.sessions.startRefreshLoop(this.options.refreshIntervalMs ?? 8 * 60_000))
    this.stops.push(
      this.watchdog.start(this.options.probeIntervalMs ?? 60_000, () =>
        [...this.byKey.values()]
          .filter((m) => m.listener.status().running)
          .map((m) => ({ key: m.key, address: m.listener.address() })),
      ),
    )

    // 预热会话与首次同步都放后台：网络慢不该卡住启动
    void this.sessions.primeAll()
    if (discover) {
      void this.syncNow().catch(() => {})
      const timer = setInterval(() => void this.syncNow().catch(() => {}), this.options.discoverIntervalMs ?? 5 * 60_000)
      timer.unref?.()
      this.stops.push(() => clearInterval(timer))
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const stop of this.stops) stop()
    this.stops = []
    await Promise.all([...this.byKey.values()].flatMap((m) => [m.listener.close(), m.internal?.close()]))
    for (const m of this.byKey.values()) m.internal = undefined
  }

  /**
   * Kura 自己的功能（文件管理器、本机 WebDAV、终端、rclone）连一个服务时用的地址。
   *
   * 和服务卡片上那个本机端口分开：那个是给外部程序的，用户可以关、可以改端口；
   * Kura 自己的功能不该因为用户关了卡片就坏掉。这里另起一个只在回环、端口由系统随机分配的监听，
   * 走的是同一套反代（会话、链路切换、认证全复用），流量也记在同一张卡片上。
   */
  async internalEndpoint(key: string): Promise<string> {
    if (!this.running) throw new Error('映射没有在运行')
    const mounted = this.byKey.get(key)
    if (!mounted) throw new ServiceMissingError(`服务端清单里没有「${key}」服务`)
    if (!mounted.internal) {
      const internal = new ServiceListener({ port: 0, enabled: true, handlers: mounted.handlers })
      await internal.applyIntent()
      mounted.internal = internal
    }
    return `http://${mounted.internal.address()}`
  }

  /** 服务端清单里有没有这个服务（界面用来决定「终端 / WebDAV 可不可用」）。 */
  hasService(key: string): boolean {
    return this.byKey.has(key)
  }

  // ---- 服务端清单 ----

  private async applyEntries(entries: RegistryEntry[]): Promise<{ added: number; skipped: string[] }> {
    let added = 0
    const skipped: string[] = []
    for (const entry of entries) {
      if (!entry.name || this.byKey.has(entry.name)) continue // 已挂上的不动，added 只算本轮真正新挂的
      // 挂不上（端口非法、本机端口与别的服务冲突）才算跳过。
      // 本机端口被**外部程序**占用不算跳过：服务已挂上、界面上显示「开着但监听失败」和原因，
      // 用户可以就地改端口 —— 与 Go 版不同，Go 版把这种也记进 skipped，页面上却又看得到它。
      let mounted: Mounted
      try {
        mounted = this.attach(toSpec(entry))
      } catch (error) {
        skipped.push(`${entry.name}：${errorMessage(error)}`)
        continue
      }
      added += 1
      try {
        // 必须自己启动：运行期发现的这批没人替它启动，漏了就是「挂上了但没在监听」
        await mounted.listener.applyIntent()
      } catch (error) {
        this.log.warn('服务监听失败', { service: entry.name, err: errorMessage(error) })
      }
    }
    return { added, skipped }
  }

  private async applyCache(): Promise<void> {
    const doc = readJson<{ services?: RegistryEntry[] }>(this.cacheFile)
    if (!doc?.services) return
    const { added, skipped } = await this.applyEntries(doc.services)
    this.log.info('已按上次的服务端清单挂载', { 清单服务数: doc.services.length, 新增: added, 跳过: skipped.length })
  }

  /** 拉一次清单并挂上缺的服务，返回本轮新增数。失败只记错误，不动任何正在跑的服务。 */
  async syncNow(): Promise<number> {
    let doc: { services?: RegistryEntry[] }
    try {
      const body = await this.sessions.gatewayGet('/__services')
      doc = JSON.parse(body.toString('utf8')) as typeof doc
      if (!Array.isArray(doc.services)) throw new Error('清单里没有 services 数组')
    } catch (error) {
      this.discoveryState = { ...this.discoveryState, lastError: errorMessage(error) }
      if (this.phase !== 'ready') this.phase = 'failed'
      this.log.warn('拉取服务端清单失败', { err: errorMessage(error) })
      this.changed()
      throw error
    }
    try {
      writeJsonAtomic(this.cacheFile, doc)
    } catch (error) {
      this.log.warn('缓存服务端清单失败', { err: errorMessage(error) })
    }
    const { added, skipped } = await this.applyEntries(doc.services!)
    this.discoveryState = { lastSync: Date.now(), lastError: '', entries: doc.services!.length, added, skipped }
    this.phase = 'ready'
    this.fromCache = false
    if (added > 0) this.log.info('服务端清单里有新服务，已自动挂上', { 新增: added })
    this.changed()
    return added
  }

  // ---- 界面操作 ----

  private find(key: string): Mounted {
    const mounted = this.byKey.get(key)
    if (!mounted) throw new Error(`没有这个服务：${key}`)
    return mounted
  }

  async setServiceEnabled(key: string, enabled: boolean): Promise<void> {
    const mounted = this.find(key)
    // 先落盘再动监听：意图要记下来，哪怕起不来
    this.overrides.set(mounted.spec.port, { enabled })
    if (!enabled) this.watchdog.forget(key)
    try {
      await mounted.listener.setEnabled(enabled)
    } finally {
      this.changed()
    }
  }

  async setServicePort(key: string, localPort: number): Promise<void> {
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error(`端口 ${localPort} 不合法`)
    const mounted = this.find(key)
    const old = mounted.listener.status().port
    if (localPort === old) return
    const taken = this.byPort.get(localPort)
    if (taken && taken !== mounted) throw new Error(`本机端口 ${localPort} 已被 ${taken.spec.label} 占用`)
    await mounted.listener.setPort(localPort)
    this.byPort.delete(old)
    this.byPort.set(localPort, mounted)
    this.overrides.set(mounted.spec.port, { localPort })
    this.changed()
  }

  async setMode(setting: LinkModeSetting): Promise<void> {
    await this.router.setModeSetting(setting)
    this.modeSetting = setting
    this.changed()
  }

  /** 用户修好凭据或要求重试时：清掉退避并立刻重建会话。 */
  async retryNow(): Promise<void> {
    this.sessions.clearAllAuthFailures()
    await this.sessions.primeAll()
  }

  snapshot(): MirrorSnapshot {
    const services = [...this.byKey.values()].map((m): ServiceView => {
      let externalUrl = ''
      try {
        externalUrl = appBase(this.config.base, m.spec.port)
      } catch {
        // 设备域不对时没有外链可给，不影响其它字段
      }
      const listener = m.listener.status()
      return {
        key: m.key,
        spec: m.spec,
        listener,
        localUrl: `http://${m.listener.address()}`,
        externalUrl,
        stats: m.stats.snapshot(),
        probe: this.watchdog.get(m.key),
      }
    })
    services.sort((a, b) => a.spec.label.localeCompare(b.spec.label))
    return {
      running: this.running,
      phase: this.phase,
      fromCache: this.fromCache,
      mode: this.router.mode,
      modeSetting: this.modeSetting,
      lanHost: this.router.lanHost,
      lanReachable: this.router.lanReachable,
      sessions: this.sessions.sessionCount(),
      auth: this.sessions.authStatus(),
      discovery: { ...this.discoveryState, skipped: [...this.discoveryState.skipped] },
      services,
    }
  }
}
