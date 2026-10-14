import { WebSocket } from 'ws'
import { errorMessage } from './errors.js'
import { request as defaultRequest, type HttpRequester } from './http.js'
import { silentLogger, type Logger } from './log.js'

/**
 * NAS 终端：接 nas-console 那套接口（`POST /api/login` 拿 session cookie，`WS /api/tty` 开 PTY）。
 *
 * 一切都走映射层的本机地址（Mirror.internalEndpoint('nas-console')），本模块不认识绿联：
 * 绿联会话、网关、新版 kura-server 都在映射层里处理了。**kura-server 部署下这一层凭据也可以留空**：
 * 网关会带登录时拿到的会话，`/api/tty` 认它；只有现网的独立 nas-console 才需要它自己的第二层凭据。
 *
 * 协议（沿用 nas-console 的 server/src/server.ts）：
 * - 下行：PTY 输出按文本帧发（stdout 与 stderr 混在一起）；
 * - 上行：键盘输入原样当文本帧发；窗口尺寸发 `{"type":"resize","cols":..,"rows":..}`；
 * - 认证：cookie `session=...`、`?token=nsc_...`，或（kura-server）映射层带来的网关会话；
 *   失败在握手阶段回 401，并发上限 429。
 *
 * resize 现在真的会发：现网 nas-console 用 `script` 包一层 PTY、resize 会被当成输入（已读源码确认），
 * 所以早先关着；kura-server 的 kura-shell 用 node-pty，支持真 resize。现网那台会把 JSON 打进终端，
 * 属于已知的可接受退化（不再区分两种后端，服务端统一到 kura-server 后就没有这个问题）。
 */
export interface ConsoleCredentials {
  /** 二选一：账号密码（独立 nas-console 那套），或 API Token（nsc_ 开头）。kura-server 下可以都不填 */
  user?: string
  password?: string
  token?: string
}

export class ConsoleAuthError extends Error {}

/** nas-console 上一次登录拿到的 session，按 base 缓存；过期由 401 发现后重登。 */
export class ConsoleSession {
  private cookie = ''

  constructor(
    private readonly endpoint: () => Promise<string>,
    private readonly credentials: () => ConsoleCredentials,
    private readonly request: HttpRequester = defaultRequest,
  ) {}

  invalidate(): void {
    this.cookie = ''
  }

  /** 返回握手要用的地址与请求头。 */
  async handshake(): Promise<{ url: string; headers: Record<string, string> }> {
    const base = await this.endpoint()
    const creds = this.credentials()
    const ws = base.replace(/^http/, 'ws') + '/api/tty'
    if (creds.token) return { url: `${ws}?token=${encodeURIComponent(creds.token)}`, headers: {} }
    // 没填凭据也照连：kura-server 部署下映射层会带上网关会话，终端不需要第二层凭据。
    // 现网独立 nas-console 会在握手阶段回 401，那时界面再提示去设置。
    if (!creds.user || !creds.password) return { url: ws, headers: {} }
    if (!this.cookie) this.cookie = await this.login(base, creds.user, creds.password)
    return { url: ws, headers: { cookie: this.cookie } }
  }

  private async login(base: string, user: string, password: string): Promise<string> {
    const res = await this.request({
      url: `${base}/api/login`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
      timeoutMs: 20_000,
    })
    if (res.status === 401) throw new ConsoleAuthError('nas-console 账号或密码不对')
    if (res.status === 429) throw new Error('nas-console 登录尝试过于频繁，稍后再试')
    if (res.status !== 200) {
      throw new Error(`nas-console 登录失败：HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`)
    }
    const setCookie = res.headers['set-cookie'] ?? []
    const session = setCookie.map((line) => line.split(';')[0]!.trim()).find((pair) => pair.startsWith('session='))
    if (!session) throw new Error('nas-console 登录成功但没有下发 session cookie')
    return session
  }

  /** 设置页「测试」用：只验证能登录（或 token 有效），不开 PTY。 */
  async check(): Promise<string> {
    const base = await this.endpoint()
    const creds = this.credentials()
    if (creds.token) {
      const res = await this.request({ url: `${base}/api/me`, headers: { authorization: `Bearer ${creds.token}` }, timeoutMs: 20_000 })
      if (res.status !== 200) throw new ConsoleAuthError(`API Token 无效：HTTP ${res.status}`)
      return 'API Token 有效'
    }
    // 没填凭据：kura-server 认映射层带来的网关会话，能拿到 /api/me 就说明终端可用
    if (!creds.user || !creds.password) {
      const res = await this.request({ url: `${base}/api/me`, timeoutMs: 20_000 })
      if (res.status === 200) return '经网关会话可用，无需单独凭据'
      throw new ConsoleAuthError('终端不可用：这个 NAS 上还是独立的 nas-console，需要在设置里填它的账号密码')
    }
    this.invalidate()
    await this.handshake()
    return '登录成功'
  }
}

export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'status'; status: 'connecting' | 'open' | 'closed'; message?: string }

/** 一个终端标签对应一条 WebSocket（一个 PTY）。 */
export class ConsoleTerminal {
  private ws: WebSocket | undefined
  private closed = false
  /** 握手失败一次 401 时重登一次；连续 401 就是凭据真的不对 */
  private retriedAuth = false

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
    const ws = new WebSocket(target.url, { headers: target.headers, handshakeTimeout: 20_000 })
    this.ws = ws
    ws.on('open', () => this.emit({ type: 'status', status: 'open' }))
    ws.on('message', (data, isBinary) => {
      this.emit({ type: 'data', data: isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString() })
    })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      const status = res.statusCode ?? 0
      if (status === 401 && !this.retriedAuth && !this.closed) {
        this.retriedAuth = true
        this.session.invalidate()
        this.ws = undefined
        void this.open()
        return
      }
      const reason =
        status === 401
          ? 'nas-console 拒绝了登录（账号、密码或 Token 不对）'
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
