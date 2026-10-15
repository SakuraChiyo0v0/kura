import net from 'node:net'
import type { WebSocket } from 'ws'
import { pumpSocket } from '../../../src/core/tunnel-pump.js'
import { DockerError, type DockerEngine } from '../docker/engine.js'
import type { DatabaseEntry, DatabaseRegistry } from './registry.js'

/**
 * 数据库隧道（服务端一侧）。
 *
 * **这里是白名单的唯一入口。** 设计上刻意的三条：
 *
 * 1. **接口签名里没有 host / port。** 只接受一个登记名。一个"能转发任意 host:port"的接口就是开放代理，
 *    任何一处白名单代码写错都会立刻变成全网可达。所以从形状上就不给这个可能。
 * 2. **目标是容器名，不是 IP。** 容器名由 Docker 内置 DNS 在共享网络上解析，稳定；
 *    容器 IP 在重启后会变，缓存 IP 是必踩的坑。也**不做任何 DNS 解析**到任意主机（防 SSRF）。
 * 3. **登记表为空就一律拒绝**：没用过这功能的人，NAS 上零暴露面。
 *
 * 关于风险要说实话：能连到 kura-server 的人本来就已经等于拿到宿主 root（终端直通宿主 shell，
 * 见 docs/交接.md「kura-server 没有认证」），所以隧道**没有引入新的权限层级**，但**降低了门槛**。
 * 缓解的闸门放在「登记」这个动作上（要在 Kura 客户端里操作），不是在协议里加认证。
 */

export interface TunnelTarget {
  /** 容器名（Docker DNS 解析） */
  host: string
  port: number
  label: string
}

export interface TunnelStats {
  active: number
  total: number
  bytesUp: number
  bytesDown: number
}

export interface TunnelServiceOptions {
  registry: DatabaseRegistry
  engine: DockerEngine
  /** 单个目标最多几条并发隧道（数据库连接池一般几十条，32 够用） */
  maxPerTarget?: number
  /** 全局上限 */
  maxTotal?: number
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 测试注入：换掉真的 net.connect */
  connect?: (host: string, port: number) => net.Socket
}

interface LiveStats {
  active: number
  total: number
  bytesUp: number
  bytesDown: number
  sockets: Set<net.Socket>
}

export class TunnelService {
  private readonly perTarget: Record<string, LiveStats> = {}
  private total = 0

  constructor(private readonly options: TunnelServiceOptions) {}

  private statsFor(name: string): LiveStats {
    const existing = this.perTarget[name]
    if (existing) return existing
    const fresh: LiveStats = { active: 0, total: 0, bytesUp: 0, bytesDown: 0, sockets: new Set() }
    this.perTarget[name] = fresh
    return fresh
  }

  /**
   * 把登记名解析成一个可连的目标。**白名单的唯一入口** —— 未登记 / 容器不在跑 / 端口不合法，一律抛错。
   *
   * `assertRunning` 为真时要求容器在跑（开隧道时用）；列连接信息时可以不要求。
   */
  async resolve(name: string, options: { assertRunning?: boolean } = {}): Promise<TunnelTarget> {
    if (this.options.registry.list().length === 0) {
      throw new DockerError(403, 'Kura 里还没有登记任何数据库：先在 Kura 的「数据库」页添加一个')
    }
    const entry = this.options.registry.find(name)
    if (!entry) throw new DockerError(404, `没有登记叫「${name}」的数据库`)
    return this.targetOf(entry, options)
  }

  /** 接管来的容器不在登记表里，由 handler 先查出来再走这里。 */
  async targetOf(entry: DatabaseEntry, options: { assertRunning?: boolean } = {}): Promise<TunnelTarget> {
    if (!entry.container) throw new DockerError(400, '这条数据库没有容器名')
    // 校验层：容器必须真的存在；在跑（默认要求）
    const raw = await this.options.engine.inspectContainer(entry.container)
    if (options.assertRunning !== false && !raw.State.Running) {
      throw new DockerError(409, `${entry.container} 没有在运行：先启动它`)
    }
    const port = entry.port > 0 ? entry.port : 0
    if (!port) throw new DockerError(400, `${entry.container} 的端口读不到`)
    return { host: entry.container, port, label: entry.name }
  }

  /** 还有没有余量接一条新隧道。 */
  canAccept(name: string): { ok: true } | { ok: false; status: number; message: string } {
    const perTarget = this.options.maxPerTarget ?? 32
    const maxTotal = this.options.maxTotal ?? 64
    const live = this.perTarget[name]?.active ?? 0
    if (live >= perTarget) return { ok: false, status: 429, message: `「${name}」的隧道连接已达上限（${perTarget}）` }
    if (this.total >= maxTotal) return { ok: false, status: 429, message: `隧道连接总数已达上限（${maxTotal}）` }
    return { ok: true }
  }

  /**
   * 把一条 WebSocket 接到目标上。返回一个断开函数。
   * 调用方负责在握手前做完白名单校验（用 `resolve`）—— 这里假定已经过了。
   */
  async attach(name: string, target: TunnelTarget, ws: WebSocket): Promise<() => void> {
    const socket = (this.options.connect ?? ((host, port) => net.connect({ host, port })))(target.host, target.port)
    const stats = this.statsFor(name)
    stats.active += 1
    stats.total += 1
    this.total += 1
    stats.sockets.add(socket)

    socket.setKeepAlive(true, 60_000)
    socket.setNoDelay(true)

    const stop = pumpSocket(socket, ws as unknown as Parameters<typeof pumpSocket>[1], {
      onBytes: (direction, bytes) => {
        if (direction === 'up') stats.bytesUp += bytes
        else stats.bytesDown += bytes
      },
      onClose: (reason) => {
        stats.active = Math.max(0, stats.active - 1)
        this.total = Math.max(0, this.total - 1)
        stats.sockets.delete(socket)
        socket.destroy()
        if (ws.readyState === ws.OPEN) ws.close(1011, reason.slice(0, 120))
        this.options.log?.('数据库隧道关闭', { 目标: name, 原因: reason })
      },
      onError: (error) => this.options.log?.('数据库隧道出错', { 目标: name, err: error.message }),
    })

    // 连不上目标：在 101 之后只能靠 close code + 日志（握手前已经建立，来不及回 HTTP 状态码了）
    socket.once('error', () => {})

    return stop
  }

  stats(): Record<string, TunnelStats> {
    const out: Record<string, TunnelStats> = {}
    for (const [name, s] of Object.entries(this.perTarget)) {
      out[name] = { active: s.active, total: s.total, bytesUp: s.bytesUp, bytesDown: s.bytesDown }
    }
    return out
  }

  /** 退出时把所有还挂着的隧道断掉。 */
  closeAll(): void {
    for (const s of Object.values(this.perTarget)) {
      for (const socket of s.sockets) socket.destroy()
      s.sockets.clear()
      s.active = 0
    }
    this.total = 0
  }
}
