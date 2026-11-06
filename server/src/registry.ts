import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../../src/core/store.js'

/**
 * 服务清单：kura-server 能反代到哪些应用。
 *
 * 有 Docker 时，名单是扫出来的（`scanServices`），不再以 `/state/services.json` 为准。
 * 文件只留同名服务的 `rewriteRedirect`（扫描看不出应用会不会发绝对路径跳转）。
 * 容器停了、删了，下一次扫描就不会再出现。没配 docker、或 socket 还不可用时，才退回这份文件，
 * 免得守护进程没起来的那几秒把所有应用一起拿掉。
 *
 * 内置服务（webdav、nas-console、docker）不在扫描结果里，固定出现在清单上。
 *
 * `/__services` 的输出向后兼容（客户端 src/core/mirror.ts 的 RegistryEntry）：
 *   {"services":[{"name":"openlist","container":"openlist","container_id":"...","ports":[...],
 *                 "container_port":5244,"host_port":5244,"published":true}]}
 *
 * 旧字段仍按每个入口生成，旧客户端照旧把入口当服务；新客户端用 container / container_id / ports
 * 把同一个容器的多个入口收成一张卡片。`ports[].name` 是这个入口在网关里的名字，不能合并掉它：
 * 一个容器有多个端口时，路径前缀和 X-Nas-Service 都按入口名分流。
 */
export interface ServiceEntry {
  name: string
  /** 后端地址，如 http://openlist:5244（Docker 内置 DNS 解析容器名） */
  backend: string
  /** 应用会发绝对路径的跳转（hermes 那种）：路径前缀模式下把 Location 重新加上前缀 */
  rewriteRedirect?: boolean
}

export interface RegistryEntry {
  name: string
  /** 容器名；内置服务没有，旧服务端也不会给。 */
  container?: string
  /** Docker 容器 ID，用来跨名字变化识别“还是那个容器”。 */
  container_id?: string
  /** 同一容器的全部可映射入口；旧客户端忽略。 */
  ports?: RegistryPort[]
  container_port: number
  host_port: number
  published: boolean
}

export interface RegistryPort {
  name: string
  container_port: number
  host_port: number
  published: boolean
}

/** 服务名的合法形状：和 nginx map 白名单一样，字母数字连字符。 */
const nameRe = /^[a-z0-9][a-z0-9-]{0,62}$/

export function parseServices(text: string): ServiceEntry[] {
  const doc = JSON.parse(text) as { services?: unknown }
  if (!Array.isArray(doc.services)) throw new Error('services.json 里没有 services 数组')
  const out: ServiceEntry[] = []
  const seen = new Set<string>()
  for (const raw of doc.services as Array<Record<string, unknown>>) {
    const name = String(raw.name ?? '')
    const backend = String(raw.backend ?? '')
    if (!nameRe.test(name)) throw new Error(`服务名不合法：${JSON.stringify(name)}`)
    if (seen.has(name)) throw new Error(`服务名重复：${name}`)
    let url: URL
    try {
      url = new URL(backend)
    } catch {
      throw new Error(`${name} 的 backend 不是合法地址：${JSON.stringify(backend)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} 的 backend 只能是 http / https`)
    seen.add(name)
    out.push({ name, backend: url.origin, rewriteRedirect: raw.rewriteRedirect === true })
  }
  return out
}

/**
 * `/containers/json` 用到的字段。网络是为了判断「kura-server 能不能用容器名解析到它」，
 * 以及不在同一网络时，发布端口该打到哪个网关地址。
 */
export interface DockerContainer {
  Id?: string
  Names?: string[]
  /** 缺省当运行中（测试夹具不填）。列表接口默认也只返回运行中的。 */
  State?: string
  Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string; IP?: string }>
  NetworkSettings?: { Networks?: Record<string, { Gateway?: string }> }
}

/**
 * `null` = docker 这会儿不可用（没 socket、或还没探到），调用方沿用上一份。
 * `[]` = 确实没有容器。两者不能混，否则 socket 一抖动就会把清单清空。
 */
export type DockerLister = () => Promise<DockerContainer[] | null>

/** 自己的容器不登记成网站：8898 是网关自己，kura-shell 只给终端用。 */
const selfNames = new Set(['kura-server', 'kura-shell'])

/** 只要能给出「现在用哪个 socket」就够了；`DockerSocketResolver` 和固定路径都满足。 */
export interface SocketPathSource {
  /** 只用**已知可用**的那个，不触发探测（清单会被频繁拉取，不能每次都 ping） */
  current(): { path: string } | undefined
}

export function dockerSocketLister(source: string | SocketPathSource = '/var/run/docker.sock'): DockerLister {
  return () => {
    const socketPath = typeof source === 'string' ? source : source.current()?.path
    // 还没有 socket：null，不把「暂时连不上」说成「一个容器都没有」
    if (!socketPath) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: '/containers/json', method: 'GET', timeout: 5_000 }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as DockerContainer[])
          } catch (error) {
            reject(error as Error)
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error('docker API 超时')))
      req.on('error', reject)
      req.end()
    })
  }
}

const containerName = (container: DockerContainer): string => (container.Names?.[0] ?? '').replace(/^\//, '')

const isLoopback = (ip: string | undefined): boolean => ip === '127.0.0.1' || ip === '::1'

/** 没填 IP 的旧数据当成 0.0.0.0。`::` 是全接口，不是回环。 */
const isPublicBind = (ip: string | undefined): boolean => !ip || ip === '0.0.0.0' || ip === '::' || !isLoopback(ip)

function sanitizeName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '')
  return nameRe.test(name) ? name : ''
}

function pickName(base: string, port: number, multiple: boolean, used: Set<string>): string {
  const primary = multiple ? '' : base
  const alt = `${base.slice(0, 50).replace(/-$/, '')}-${port}`
  for (const candidate of [primary, alt]) {
    if (candidate && nameRe.test(candidate) && !used.has(candidate)) return candidate
  }
  return ''
}

/**
 * 从正在运行的容器得出要反代的服务。
 *
 * - 和 kura-server 在同一个 Docker 网络上：后端用容器名 + 容器内端口（Docker DNS 解得开）。
 * - 不在同一个网络、但端口发布到了非回环地址：后端用该容器所在网络的网关 + 宿主端口。
 *   网关地址在宿主上，kura-server 经默认路由打得到（2026-11-04 实测 `172.17.0.1:8730`）。
 * - 只绑在 127.0.0.1 上、又不在同一网络：外链和网桥都到不了，不登记。
 * - `kura-server` / `kura-shell`、以及和内置服务撞名的，不登记。
 *
 * `annotations` 里同名的 `rewriteRedirect` 会抄过来。文件里多出来的名字（容器已经没了）不会出现。
 */
export function scanServices(containers: DockerContainer[], annotations: ServiceEntry[], reserved: Iterable<string>): ServiceEntry[] {
  const reservedNames = new Set(reserved)
  const self = containers.find((container) => containerName(container) === 'kura-server')
  const selfNets = new Set(Object.keys(self?.NetworkSettings?.Networks ?? {}))
  const used = new Set(reservedNames)
  const out: ServiceEntry[] = []

  const ordered = [...containers].sort((a, b) => containerName(a).localeCompare(containerName(b)))
  for (const container of ordered) {
    const name = containerName(container)
    if (!name || selfNames.has(name)) continue
    if (container.State && container.State !== 'running') continue
    const nets = container.NetworkSettings?.Networks ?? {}
    const shared = Object.keys(nets).some((netName) => selfNets.has(netName))
    const gateway = Object.values(nets)
      .map((endpoint) => endpoint.Gateway ?? '')
      .find((addr) => net.isIP(addr) === 4)

    const byPrivate = new Map<number, number>()
    for (const port of container.Ports ?? []) {
      if (port.Type && port.Type !== 'tcp') continue
      const privatePort = port.PrivatePort ?? 0
      if (privatePort <= 0) continue
      const publicPort = port.PublicPort ?? 0
      const published = publicPort > 0 && isPublicBind(port.IP)
      const prev = byPrivate.get(privatePort) ?? 0
      if (published && !prev) byPrivate.set(privatePort, publicPort)
      else if (!byPrivate.has(privatePort)) byPrivate.set(privatePort, 0)
    }

    const eligible = [...byPrivate.entries()]
      .filter(([, publicPort]) => publicPort > 0 || shared)
      .sort((a, b) => a[0] - b[0])
    const base = sanitizeName(name)
    if (!base) continue
    for (const [privatePort, publicPort] of eligible) {
      const serviceName = pickName(base, publicPort || privatePort, eligible.length > 1, used)
      if (!serviceName) continue
      const backend = shared ? `http://${name}:${privatePort}` : publicPort > 0 && gateway ? `http://${gateway}:${publicPort}` : ''
      if (!backend) continue
      used.add(serviceName)
      const note = annotations.find((entry) => entry.name === serviceName)
      out.push({ name: serviceName, backend, rewriteRedirect: note?.rewriteRedirect === true })
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 扫描结果里每个入口仍是一条 ServiceEntry；容器信息单独映射，供清单聚合用。 */
export function scanContainers(containers: DockerContainer[], annotations: ServiceEntry[], reserved: Iterable<string>): { services: ServiceEntry[]; owners: Map<string, DockerContainer> } {
  const services = scanServices(containers, annotations, reserved)
  const owners = new Map<string, DockerContainer>()
  for (const service of services) {
    const url = new URL(service.backend)
    const owner = containers.find((container) => {
      const name = containerName(container)
      if (!name || selfNames.has(name)) return false
      const publishedPort = Number(url.port) || 80
      if (net.isIP(url.hostname)) {
        return (container.Ports ?? []).some((port) => port.PublicPort === publishedPort && (!port.Type || port.Type === 'tcp') && isPublicBind(port.IP))
      }
      return name === url.hostname
    })
    if (owner?.Id) owners.set(service.name, owner)
  }
  return { services, owners }
}

export class Registry {
  /** services.json：没扫到容器时的名单，以及扫到之后的 rewriteRedirect 注解。 */
  private configured: ServiceEntry[] = []
  /** 最近一次扫成的名单。null = 还没扫成，路由退回 configured。 */
  private scanned: ServiceEntry[] | null = null
  private owners = new Map<string, DockerContainer>()
  private lastContainers: DockerContainer[] | null = null
  private loadError = ''
  private refreshedAt = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string | undefined,
    /** 内置服务：名字 → 容器内端口（用于清单上的 container_port） */
    private readonly builtin: Record<string, number>,
    private readonly docker?: DockerLister,
  ) {
    this.reload()
  }

  reload(): void {
    if (!this.file) return
    try {
      this.configured = parseServices(readFileSync(this.file, 'utf8'))
      this.loadError = ''
      this.reapplyScan()
    } catch (error) {
      // 文件坏了保留上一份：一次手误不该让所有应用一起 404
      this.loadError = (error as Error).message
    }
  }

  /** 测试与无 Docker 时直接设名单。已经扫过容器的话，这只更新注解并重算扫描结果。 */
  set(services: ServiceEntry[]): void {
    this.configured = services
    this.loadError = ''
    this.reapplyScan()
  }

  /** 管理页保存：写回 services.json（原子替换，写坏了不影响已加载的一份）。 */
  save(services: ServiceEntry[]): void {
    if (!this.file) throw new Error('没有配置 services.json 路径')
    // 先过一遍校验，坏数据不落盘
    parseServices(JSON.stringify({ services }))
    writeJsonAtomic(this.file, { services })
    this.set(services)
  }

  /** 给已扫到的服务记「改写跳转」。不增减名单。 */
  setRewrite(name: string, rewriteRedirect: boolean): void {
    const live = this.active().find((service) => service.name === name)
    if (!live) throw new Error(`没有这个服务：${name}`)
    if (!nameRe.test(name)) throw new Error(`服务名不合法：${JSON.stringify(name)}`)
    const next = this.configured.filter((service) => service.name !== name)
    next.push({ name, backend: live.backend, rewriteRedirect })
    this.save(next)
  }

  error(): string {
    return this.loadError
  }

  /** 最近一次扫描已经取代了文件名单。 */
  scans(): boolean {
    return this.scanned !== null
  }

  list(): ServiceEntry[] {
    return [...this.active()]
  }

  find(name: string): ServiceEntry | undefined {
    return this.active().find((service) => service.name === name)
  }

  isBuiltin(name: string): boolean {
    return name in this.builtin
  }

  /** 是不是已知服务名（内置或当前名单）—— 路径前缀分流的白名单。 */
  known(name: string): boolean {
    return this.isBuiltin(name) || this.find(name) !== undefined
  }

  /**
   * 拉一次容器列表并更新名单。`force` 用于 `/__services` 和管理页，不吃 10 秒缓存。
   * 普通反代请求走缓存，避免每个请求都打 docker.sock。
   */
  async refresh(force = false): Promise<void> {
    if (!this.docker) return
    const run = async (): Promise<void> => {
      if (!force && this.scanned && Date.now() - this.refreshedAt < 10_000) return
      await this.pull()
    }
    const job = this.queue.then(run, run)
    this.queue = job.then(
      () => undefined,
      () => undefined,
    )
    await job
  }

  async entries(): Promise<RegistryEntry[]> {
    await this.refresh(true)
    const containers = this.lastContainers ?? []
    const published = (host: string, port: number): number => {
      if (net.isIP(host)) return port
      const container = containers.find((item) => containerName(item) === host)
      return (
        container?.Ports?.find((portInfo) => portInfo.PrivatePort === port && (!portInfo.Type || portInfo.Type === 'tcp') && portInfo.PublicPort && isPublicBind(portInfo.IP))
          ?.PublicPort ?? 0
      )
    }
    const out: RegistryEntry[] = Object.entries(this.builtin).map(([name, port]) => ({
      name,
      container_port: port,
      host_port: 0,
      published: false,
    }))
    for (const service of this.active()) {
      const url = new URL(service.backend)
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      const host = published(url.hostname, port)
      // 只有拿到了容器 ID 才能做可靠聚合；测试夹具 / 旧扫描结果没有 ID 时保持原来的输出形状。
      const owner = this.owners.get(service.name)
      out.push({
        name: service.name,
        ...(owner?.Id
          ? { container: containerName(owner), ...(owner.Id ? { container_id: owner.Id } : {}) }
          : {}),
        container_port: port,
        host_port: host,
        published: host > 0,
      })
    }

    // 按入口所属的容器聚合。只对扫描出来的容器做；内置服务继续各占一条。
    const groups = new Map<string, RegistryEntry[]>()
    for (const entry of out) {
      if (!entry.container_id) continue
      const list = groups.get(entry.container_id) ?? []
      list.push(entry)
      groups.set(entry.container_id, list)
    }
    for (const group of groups.values()) {
      const ports: RegistryPort[] = group.map(({ name, container_port, host_port, published }) => ({
        name,
        container_port,
        host_port,
        published,
      }))
      for (const entry of group) {
        entry.container = group[0]!.container
        entry.ports = ports
      }
    }
    return out
  }

  private active(): ServiceEntry[] {
    return this.scanned ?? this.configured
  }

  private reapplyScan(): void {
    if (!this.lastContainers) return
    const scanned = scanContainers(this.lastContainers, this.configured, Object.keys(this.builtin))
    this.scanned = scanned.services
    this.owners = scanned.owners
  }

  private async pull(): Promise<void> {
    if (!this.docker) return
    let got: DockerContainer[] | null
    try {
      got = await this.docker()
    } catch {
      // 查询失败沿用上一份。还没扫成过就继续用文件。
      return
    }
    if (got == null) return
    this.lastContainers = got
    const scanned = scanContainers(got, this.configured, Object.keys(this.builtin))
    this.scanned = scanned.services
    this.owners = scanned.owners
    this.refreshedAt = Date.now()
  }
}
