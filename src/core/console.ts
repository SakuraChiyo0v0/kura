import { WebSocket } from 'ws'
import { errorMessage } from './errors.js'
import { request as defaultRequest, type HttpRequester } from './http.js'
import { silentLogger, type Logger } from './log.js'

/**
 * NAS 终端：接 nas-console 那套接口（`WS /api/tty` 开 PTY）。
 *
 * 一切都走映射层的本机地址（Mirror.internalEndpoint('nas-console')），本模块不认识绿联：
 * 绿联会话、网关都在映射层里处理了。**终端这一层没有凭据** —— 内网的 kura-server 不做认证，
 * 映射层带上绿联的 ugreen-proxy-token 就够。只有脚本 / AI 调 exec 才用得上 API Token（nsc_）。
 *
 * 协议（沿用 nas-console 的 server/src/server.ts）：
 * - 下行：PTY 输出按文本帧发（stdout 与 stderr 混在一起）；
 * - 上行：键盘输入原样当文本帧发；窗口尺寸发 `{"type":"resize","cols":..,"rows":..}`；
 * - 失败在握手阶段回 401，并发上限 429。
 */
export interface ConsoleCredentials {
  /** API Token（nsc_ 开头）。给脚本用；界面开终端不需要它 */
  token?: string
}

export class ConsoleAuthError extends Error {}

/** 终端连接参数：只要地址，不要会话（kura-server 不做认证）。 */
export class ConsoleSession {
  constructor(
    private readonly endpoint: () => Promise<string>,
    private readonly credentials: () => ConsoleCredentials,
    private readonly request: HttpRequester = defaultRequest,
  ) {}

  invalidate(): void {}

  /** 返回握手要用的地址与请求头。 */
  async handshake(): Promise<{ url: string; headers: Record<string, string> }> {
    const base = await this.endpoint()
    const creds = this.credentials()
    const ws = base.replace(/^http/, 'ws') + '/api/tty'
    if (creds.token) return { url: `${ws}?token=${encodeURIComponent(creds.token)}`, headers: {} }
    return { url: ws, headers: {} }
  }

  /** 设置页「测试」用：看终端服务在不在（拿 /api/me），不开 PTY。 */
  async check(): Promise<string> {
    const base = await this.endpoint()
    const creds = this.credentials()
    const res = await this.request({ url: `${base}/api/me`, headers: creds.token ? { authorization: `Bearer ${creds.token}` } : {}, timeoutMs: 20_000 })
    if (res.status !== 200) throw new ConsoleAuthError('终端不可用：没连上 NAS 的终端服务（看服务映射页的 nas-console 卡片）')
    return creds.token ? 'API Token 有效' : '终端服务可达'
  }
}

export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'status'; status: 'connecting' | 'open' | 'closed'; message?: string }

/** 一个终端标签对应一条 WebSocket（一个 PTY）。 */
export class ConsoleTerminal {
  private ws: WebSocket | undefined
  private closed = false

  constructor(
    readonly id: string,
    private readonly session: ConsoleSession,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly log: Logger = silentLogger,
  ) {}

  async open(): Promise<void> {
    this.emit({ type: 'status', status: 'connecting' })
    let target: { url: string; headers: Record<string, string> }
    try {
      target = await this.session.handshake()
    } catch (error) {
      this.finish(errorMessage(error))
      return
    }
    // 握手是异步的，这期间用户可能已经关掉了这个标签（close() 把 closed 置真、ws 清空）。
    // 不检查就继续建连接的话，这个 ws 永远不会被关（close() 已经跑过了），白白泄漏一条 PTY。
    if (this.closed) return
    const ws = new WebSocket(target.url, { headers: target.headers, handshakeTimeout: 20_000 })
    this.ws = ws
    ws.on('open', () => this.emit({ type: 'status', status: 'open' }))
    ws.on('message', (data, isBinary) => {
      this.emit({ type: 'data', data: isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString() })
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      const status = res.statusCode ?? 0
      const reason =
        status === 401
          ? '终端服务拒绝了握手（API Token 不对，或这台 NAS 上还是需要凭据的旧 nas-console）'
          : status === 429
            ? 'nas-console 的交互终端数已达上限（默认 4 个），关掉一个再试'
            : status === 502 && res.headers['content-type']?.includes('text/plain')
              ? 'Kura 映射层连不上 nas-console（看服务映射页的 nas-console 卡片）'
              : `握手失败：HTTP ${status}`
      this.finish(reason)
    })
    ws.on('error', (error) => {
      this.log.warn('终端连接出错', { id: this.id, err: errorMessage(error) })
      // close 事件随后会到，在那里收尾
      if (ws.readyState === WebSocket.CONNECTING) this.finish(errorMessage(error))
    })
    ws.on('close', (code) => {
      if (this.ws !== ws) return // 401 重登时换了新的连接
      this.finish(code === 1000 || code === 1005 ? '会话已结束' : `连接断开（${code}）`)
    })
  }

  write(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  /** 改窗口尺寸。kura-shell（node-pty）支持真 resize；现网 nas-console 会把这条当输入打进终端。 */
  resize(cols: number, rows: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'resize', cols: Math.max(1, Math.round(cols)), rows: Math.max(1, Math.round(rows)) }))
  }

  close(): void {
    this.closed = true
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close()
    } catch {
      ws?.terminate()
    }
    this.emit({ type: 'status', status: 'closed', message: '已关闭' })
  }

  private finish(message: string): void {
    if (this.closed) return
    this.closed = true
    this.ws = undefined
    this.emit({ type: 'status', status: 'closed', message })
  }

  get isClosed(): boolean {
    return this.closed
  }
}
