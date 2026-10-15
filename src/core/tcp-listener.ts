import net from 'node:net'
import { assertLoopback, shutdownTimeoutMs } from './listener.js'

/**
 * 管住一条**裸 TCP** 监听的开关、端口与状态。`ServiceListener` 的孪生兄弟。
 *
 * 为什么要另写一个：`ServiceListener` 用的是 `http.createServer`（只跑 HTTP 与 WebSocket 升级），
 * 而 PostgreSQL / MySQL / Redis 都是裸 TCP 协议，过不了 HTTP 反代。所以这里用 `net.createServer`。
 *
 * **语义与 `ServiceListener` 逐条对齐**（照抄，别发明第二套）：
 * - 构造时 `assertLoopback`（**从 listener.ts import，不复制那份正则**）—— 安全红线只写一遍；
 * - `enabled`（界面意图）与 `running`（真在监听）会不一致，界面要能显示「开着但绑定失败」；
 * - `serial()` 串行化：连点两下开关、开关与改端口交错，都一个个做完；
 * - `setPort` 失败**退回原端口**；
 * - 关机等待在途连接的上限用同一个 `shutdownTimeoutMs`。
 */

export interface TcpListenerStatus {
  /** 开关意图 */
  enabled: boolean
  /** 真的在监听 */
  running: boolean
  port: number
  lastError: string
  /** 当前活着的连接数 */
  connections: number
}

export interface TcpListenerHandlers {
  /** 来了一条本地连接。调用方负责接好对面的 WS 并搬运字节。 */
  connection: (socket: net.Socket) => void
}

export class TcpListener {
  readonly host: string
  private enabled: boolean
  private port: number
  private server: net.Server | undefined
  private readonly sockets = new Set<net.Socket>()
  private lastError = ''
  private queue: Promise<unknown> = Promise.resolve()
  private readonly handlers: TcpListenerHandlers

  constructor(options: { host?: string; port: number; enabled: boolean; handlers: TcpListenerHandlers }) {
    this.host = options.host ?? '127.0.0.1'
    assertLoopback(this.host)
    this.port = options.port
    this.enabled = options.enabled
    this.handlers = options.handlers
  }

  status(): TcpListenerStatus {
    return { enabled: this.enabled, running: this.server !== undefined, port: this.port, lastError: this.lastError, connections: this.sockets.size }
  }

  address(): string {
    return `${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => {})
    return run
  }

  setEnabled(on: boolean): Promise<void> {
    return this.serial(async () => {
      this.enabled = on
      if (on) await this.start()
      else await this.stop()
    })
  }

  applyIntent(): Promise<void> {
    return this.serial(async () => {
      if (this.enabled) await this.start()
    })
  }

  /** 改本机端口：运行中先释放旧端口再绑新端口；新端口绑不上就退回原端口。 */
  setPort(port: number): Promise<void> {
    return this.serial(async () => {
      const old = this.port
      if (port === old) return
      if (!this.server) {
        this.port = port
        this.lastError = ''
        if (this.enabled) {
          try {
            await this.start()
          } catch (error) {
            throw new Error(`本机端口 ${port} 绑定失败：${(error as Error).message}`)
          }
        }
        return
      }
      await this.stop()
      this.port = port
      try {
        await this.start()
      } catch (error) {
        this.port = old
        try {
          await this.start()
        } catch (restoreError) {
          this.lastError = `改端口失败（${(error as Error).message}），退回 ${old} 也失败（${(restoreError as Error).message}）`
          throw new Error(this.lastError)
        }
        throw new Error(`本机端口 ${port} 绑定失败，已退回 ${old}：${(error as Error).message}`)
      }
    })
  }

  /** 只关监听，不改开关意图（退出程序时用）。 */
  close(): Promise<void> {
    return this.serial(() => this.stop())
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve()
    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      // 不做应用层空闲超时（会误杀数据库连接池的闲置连接）；靠 TCP keepalive 判死活
      socket.setKeepAlive(true, 60_000)
      socket.setNoDelay(true)
      this.handlers.connection(socket)
    })
    return new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.lastError = error.message
        reject(new Error(`本机端口 ${this.address()} 绑定失败：${error.message}`))
      }
      server.once('error', onError)
      server.listen(this.port, this.host, () => {
        server.off('error', onError)
        if (this.port === 0) this.port = (server.address() as net.AddressInfo).port
        server.on('error', (error) => {
          this.lastError = error.message
        })
        this.server = server
        this.lastError = ''
        resolve()
      })
    })
  }

  private destroySockets(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.destroySockets(), shutdownTimeoutMs)
      server.close(() => {
        clearTimeout(timer)
        // close() 只等没被接管的连接排空；隧道连接会被一直占着，所以补一刀
        this.destroySockets()
        resolve()
      })
    })
  }
}
