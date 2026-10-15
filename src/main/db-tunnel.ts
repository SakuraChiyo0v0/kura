import type net from 'node:net'
import type { WebSocket } from 'ws'
import { pumpSocket } from '../core/tunnel-pump.js'
import { TcpListener } from '../core/tcp-listener.js'
import { readJson, writeJsonAtomic } from '../core/store.js'
import { silentLogger, type Logger } from '../core/log.js'
import { errorMessage } from '../core/errors.js'

/**
 * 本机隧道：把 127.0.0.1:<本机端口> 的裸 TCP 连接，经映射层的一条 WebSocket 转到 NAS 上的数据库。
 *
 * 为什么需要它：PostgreSQL / MySQL / Redis 是裸 TCP 协议，过不了 HTTP 反代（映射层的 `proxy.ts`
 * 只跑 HTTP 与 WebSocket 升级），也过不了绿联中继（AGENTS.md §四.8）。但 **WebSocket 能过中继**
 * —— 容器 shell 已经真机验通。所以这里把 TCP 装进 WS 里运。
 *
 * 应用知识（连哪个数据库）不在这里：它只管「本地端口 → 一条 WS 地址」，
 * 由 `DatabaseService` 把数据库名翻译好再交给它 —— 传输层不认识数据库（AGENTS.md §三.3）。
 */

export interface TunnelStatus {
  name: string
  /** 开关意图 */
  enabled: boolean
  /** 真的在监听 */
  running: boolean
  port: number
  lastError: string
  /** 当前活着的本地连接数 */
  connections: number
  bytesUp: number
  bytesDown: number
}

/** 本机端口的偏好（每台客户端自己选，不上 NAS）。 */
interface TunnelPrefs {
  tunnels: Record<string, { enabled?: boolean; localPort?: number }>
}

export interface DbTunnelDeps {
  /** 开一条到 NAS 上某个数据库的 WS（由 DatabaseService 提供，它认识数据库名）。 */
  open: (name: string) => Promise<WebSocket>
  dataDir: string
  log?: Logger
}

/** 默认本机端口：各引擎的常见「高位」端口，避开本机真的在跑的 5432/3306/6379。 */
const defaultPorts: Record<string, number> = { postgres: 15432, mysql: 13306, mariadb: 13307, redis: 16379 }

export class DbTunnelService {
  private readonly listeners = new Map<string, TcpListener>()
  private readonly bytes = new Map<string, { up: number; down: number }>()
  private readonly engineOf = new Map<string, string>()
  private readonly file: string
  private readonly log: Logger
  private prefs: TunnelPrefs

  constructor(private readonly deps: DbTunnelDeps) {
    this.file = `${deps.dataDir}/tunnels.json`
    this.log = deps.log ?? silentLogger
    this.prefs = readJson<TunnelPrefs>(this.file) ?? { tunnels: {} }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, this.prefs)
    } catch (error) {
      // 落盘失败不改内存：否则界面显示「已保存」、重启后回到旧值（store.ts 里同样的取舍）
      this.log.warn('保存隧道偏好失败', { err: errorMessage(error) })
    }
  }

  /**
   * 按当前数据库列表对齐隧道：新出现的建好（按偏好决定开不开），消失的拆掉。
   * 引擎种类只用来挑默认端口，不影响连接（连接由 `open` 决定）。
   */
  sync(databases: Array<{ name: string; engine: string }>): void {
    const seen = new Set<string>()
    for (const db of databases) {
      seen.add(db.name)
      this.engineOf.set(db.name, db.engine)
      if (this.listeners.has(db.name)) continue
      const pref = this.prefs.tunnels[db.name] ?? {}
      const port = pref.localPort ?? defaultPorts[db.engine] ?? 0
      const listener = new TcpListener({
        port,
        enabled: pref.enabled === true,
        handlers: { connection: (socket) => this.bridge(db.name, socket) },
      })
      this.listeners.set(db.name, listener)
      this.bytes.set(db.name, { up: 0, down: 0 })
      // 「开着但绑不上」要能被界面看到，所以这里吞掉异常、状态里留着 lastError
      void listener.applyIntent().catch(() => {})
    }
    for (const [name, listener] of this.listeners) {
      if (seen.has(name)) continue
      void listener.close()
      this.listeners.delete(name)
      this.bytes.delete(name)
      this.engineOf.delete(name)
    }
  }

  /** 本地来了一条连接：开一条 WS 到 NAS，接起来。 */
  private bridge(name: string, socket: net.Socket): void {
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      socket.destroy()
    }
    void this.deps
      .open(name)
      .then((ws) => {
        if (stopped) {
          ws.close()
          return
        }
        const counter = this.bytes.get(name)
        pumpSocket(socket, ws as unknown as Parameters<typeof pumpSocket>[1], {
          onBytes: (direction, bytes) => {
            if (!counter) return
            if (direction === 'up') counter.up += bytes
            else counter.down += bytes
          },
          onClose: (reason) => {
            stop()
            // 正常关连接（客户端断开）不当错误记，只有异常才值得看
            this.log.debug('数据库隧道连接关闭', { 数据库: name, 原因: reason })
          },
          onError: (error) => this.log.debug('数据库隧道连接出错', { 数据库: name, err: error.message }),
        })
      })
      .catch((error) => {
        this.log.warn('开数据库隧道失败', { 数据库: name, err: errorMessage(error) })
        stop()
      })
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const listener = this.listeners.get(name)
    if (!listener) throw new Error(`没有「${name}」这条隧道`)
    await listener.setEnabled(enabled)
    this.prefs.tunnels[name] = { ...this.prefs.tunnels[name], enabled }
    this.persist()
  }

  async setPort(name: string, port: number): Promise<void> {
    const listener = this.listeners.get(name)
    if (!listener) throw new Error(`没有「${name}」这条隧道`)
    await listener.setPort(port)
    this.prefs.tunnels[name] = { ...this.prefs.tunnels[name], localPort: listener.status().port }
    this.persist()
  }

  status(): TunnelStatus[] {
    const out: TunnelStatus[] = []
    for (const [name, listener] of this.listeners) {
      const s = listener.status()
      const counter = this.bytes.get(name) ?? { up: 0, down: 0 }
      out.push({ name, enabled: s.enabled, running: s.running, port: s.port, lastError: s.lastError, connections: s.connections, bytesUp: counter.up, bytesDown: counter.down })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  find(name: string): TunnelStatus | undefined {
    return this.status().find((s) => s.name === name)
  }

  /** 退出时把所有隧道关掉。隧道不像映射那样常驻 —— 它是功能，用户开才有，Kura 退出就没了。 */
  async close(): Promise<void> {
    for (const listener of this.listeners.values()) await listener.close().catch(() => {})
    this.listeners.clear()
  }
}
