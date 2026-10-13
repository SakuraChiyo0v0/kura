import http from 'node:http'
import net from 'node:net'

/** 关掉一个服务时等待在途请求的上限；页面上的「关闭」不该因为一个卡住的长连接永远转圈。 */
export const shutdownTimeoutMs = 3_000

export interface ListenerHandlers {
  request: http.RequestListener
  upgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void
}

export interface ListenerStatus {
  /** 开关意图 */
  enabled: boolean
  /** 真的在监听 */
  running: boolean
  port: number
  lastError: string
}

/**
 * 安全红线：只监听回环地址。绑到对外地址会让同网段其他机器连上本机代理 ——
 * 在公司电脑上运行的全部依据就是这一条，所以在代码里强制，不靠调用方自觉。
 */
export function assertLoopback(host: string): void {
  const ok = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  if (!ok) throw new Error(`监听地址必须是回环地址（当前 ${JSON.stringify(host)}）：只允许被本机访问`)
}

/**
 * 管住一个服务的本机监听：开关即时生效、改端口即时生效（失败退回原端口）。
 *
 * 操作串行化：连点两下开关、或开关和改端口交错，都按顺序一个个做完，不会出现
 * 「旧监听器还没关、新端口已经绑上」。enabled 与 running 会不一致（开关开着但端口被占），
 * 这是有意的：界面要能显示「开着，但监听失败」，否则开关会自己弹回去，看起来像没点上。
 */
export class ServiceListener {
  readonly host: string
  private enabled: boolean
  private port: number
  private server: http.Server | undefined
  private readonly sockets = new Set<net.Socket>()
  private lastError = ''
  private queue: Promise<unknown> = Promise.resolve()
  private readonly handlers: ListenerHandlers

  constructor(options: { host?: string; port: number; enabled: boolean; handlers: ListenerHandlers }) {
    this.host = options.host ?? '127.0.0.1'
    assertLoopback(this.host)
    this.port = options.port
    this.enabled = options.enabled
    this.handlers = options.handlers
  }

  status(): ListenerStatus {
    return { enabled: this.enabled, running: this.server !== undefined, port: this.port, lastError: this.lastError }
  }

  /** 本机地址（未运行时是「打算监听」的地址）。 */
  address(): string {
    return `${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => {})
    return run
  }

  /** 开 / 关，并记下意图 —— 哪怕起不来也要记。 */
  setEnabled(on: boolean): Promise<void> {
    return this.serial(async () => {
      this.enabled = on
      if (on) await this.start()
      else await this.stop()
    })
  }

  /** 按当前意图启动（启动时与挂载时用）。 */
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
    const server = http.createServer({ requestTimeout: 0 }, this.handlers.request)
    server.headersTimeout = 30_000
    server.on('upgrade', this.handlers.upgrade)
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    return new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        // 端口被占用是预期内的（本机应用先占了它），只记原因
        this.lastError = error.message
        reject(new Error(`本机端口 ${this.address()} 绑定失败：${error.message}`))
      }
      server.once('error', onError)
      server.listen(this.port, this.host, () => {
        server.off('error', onError)
        server.on('error', (error) => {
          this.lastError = error.message
        })
        this.server = server
        this.lastError = ''
        resolve()
      })
    })
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 等不完就强关：被接管的 WebSocket 连接 close() 不会等它，但也不会自己断，这里一并断掉
        for (const socket of this.sockets) socket.destroy()
      }, shutdownTimeoutMs)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
      server.closeIdleConnections()
    })
  }
}
