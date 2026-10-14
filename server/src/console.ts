import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'
import { Auth, sessionToken as sessionFromCookie } from './auth.js'
import type { TokenStore } from './tokens.js'

/**
 * kura-server 侧对**客户端**暴露的终端接口，名字与现网 nas-console 保持一致，客户端不用改：
 *   POST /api/login          —— 账号密码换 session cookie（`session=...`）
 *   WS   /api/tty            —— 开 PTY（cookie 或 `?token=nsc_...` 认证）
 *   GET  /api/me             —— 校验 API Token
 *   POST /api/exec           —— 用 API Token 或会话调 exec（审计在这里记）
 *
 * kura-server 认证一次（Authelia 那套，或 nas-console 这套），然后凭**内部令牌**把请求转给
 * kura-shell。kura-shell 不认用户，只认那个令牌。
 *
 * 这里保留 `POST /api/login` 是为了兼容：客户端历史上要填一组 nas-console 账号密码。现在它和
 * 网关账号是同一个（S5 客户端会合并成一组），登录动作仍然照走 —— 服务端少改一处协议，
 * 就少一处客户端要跟着改的地方。
 */
export interface ConsoleOptions {
  /** 网关认证（复用同一个用户名与 argon2 哈希） */
  auth: Auth
  /** 调用 nas-console 的 API Token（`nsc_`） */
  tokens: TokenStore
  /** kura-shell 的 base，如 http://kura-shell:8890；没配就是没有终端 */
  shell: () => string
  /** 内部令牌，发给 kura-shell 用 */
  internalToken: string
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 测试注入：直接构造到 kura-shell 的请求（默认用 http.request） */
  requestShell?: (req: http.IncomingMessage) => http.ClientRequest
  /** exec 用的 HTTP 请求器（与 requestShell 分开，方便测试） */
  execShell?: (options: { method: string; path: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>
}

/** 独立的终端会话（与网关会话分开，因为客户端按 nas-console 那套来）。 */
export class ConsoleSessions {
  private readonly sessions = new Map<string, { user: string; at: number }>()
  private readonly ttlMs = 12 * 60 * 60_000

  constructor(private readonly now: () => number = Date.now) {}

  create(user: string): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { user, at: this.now() })
    return token
  }

  check(token: string | undefined): string | undefined {
    if (!token) return undefined
    const found = this.sessions.get(token)
    if (!found) return undefined
    if (this.now() - found.at > this.ttlMs) {
      this.sessions.delete(token)
      return undefined
    }
    return found.user
  }

  drop(token: string | undefined): void {
    if (token) this.sessions.delete(token)
  }

  size(): number {
    return this.sessions.size
  }
}

export function createConsoleHandler(options: ConsoleOptions): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void
} {
  const log = options.log ?? (() => {})
  const sessions = new ConsoleSessions()

  const sessionCookie = (header: string | undefined): string | undefined => {
    return /(?:^|;\s*)session=([^;]+)/.exec(header ?? '')?.[1]?.trim()
  }

  /** 谁在调：先看 nas-console 的 session cookie，再看 API Token，最后看网关会话。 */
  const identify = (req: http.IncomingMessage, url: URL): { user: string; via: string } | undefined => {
    const bySession = sessions.check(sessionCookie(req.headers.cookie))
    if (bySession) return { user: bySession, via: 'session' }
    const token = url.searchParams.get('token') ?? /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim()
    const record = options.tokens.verify(token ?? undefined)
    if (record) return { user: record.label, via: 'token' }
    // 网关会话：映射层会把 authelia_session 带进内部通道，客户端因此不需要单独的终端凭据
    const gateway = options.auth.check(sessionFromCookie(req.headers.cookie))
    if (gateway) return { user: gateway, via: 'gateway' }
    return undefined
  }

  const shellRequest = (
    req: http.IncomingMessage,
    options2: { method: string; path: string; user: string; body?: string; extraHeaders?: Record<string, string> },
  ): http.ClientRequest => {
    const base = new URL(options.shell())
    // WebSocket 握手靠这些头，必须原样带给 kura-shell；cookie / 客户端凭据不带（它只认内部令牌）
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'cookie' || lower === 'authorization' || lower === 'x-kura-token' || lower === 'x-kura-user') continue
      headers[name] = value
    }
    headers['x-kura-token'] = options.internalToken
    // 用户 / 令牌标签可能是中文，HTTP 头只能是 ASCII —— 编码后传，kura-shell 那边解回来（只用于审计）
    headers['x-kura-user'] = encodeURIComponent(options2.user)
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    for (const [name, value] of Object.entries(options2.extraHeaders ?? {})) headers[name] = value
    if (options2.body !== undefined) headers['content-type'] = 'application/json'
    return http.request({
      hostname: base.hostname,
      port: base.port,
      method: options2.method,
      path: options2.path,
      headers,
      agent: false,
    })
  }

  const execShell =
    options.execShell ??
    ((o: { method: string; path: string; headers: Record<string, string>; body: string }) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const base = new URL(options.shell())
        const req = http.request(
          { hostname: base.hostname, port: base.port, method: o.method, path: o.path, headers: o.headers },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
          },
        )
        req.on('error', reject)
        req.end(o.body)
      }))

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    const path = url.pathname

    if (path === '/api/login' && req.method === 'POST') {
      let body: { username?: unknown; password?: unknown }
      try {
        const raw = await readBody(req)
        body = JSON.parse(raw) as typeof body
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return void res.end('{"error":"bad body"}')
      }
      const result = await options.auth.login(req.socket.remoteAddress ?? 'unknown', body)
      if (!result.ok) {
        res.writeHead(result.status === 401 ? 401 : result.status, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ error: result.message }))
      }
      const token = sessions.create(String(body.username))
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax` })
      return void res.end('{"ok":true}')
    }

    if (path === '/api/me') {
      const who = identify(req, url)
      res.writeHead(who ? 200 : 401, { 'content-type': 'application/json' })
      return void res.end(JSON.stringify(who ? { user: who.user } : { error: 'unauthorized' }))
    }

    if (path === '/api/exec' && req.method === 'POST') {
      const who = identify(req, url)
      if (!who) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return void res.end('{"error":"unauthorized"}')
      }
      const raw = await readBody(req)
      try {
        const result = await execShell({
          method: 'POST',
          path: '/api/exec',
          headers: { 'content-type': 'application/json', 'x-kura-token': options.internalToken, 'x-kura-user': encodeURIComponent(who.user) },
          body: raw,
        })
        res.writeHead(result.status, { 'content-type': 'application/json' })
        res.end(result.body)
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `kura-shell 连不上：${(error as Error).message}` }))
      }
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  }

  const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    if (url.pathname !== '/api/tty') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    const who = identify(req, url)
    if (!who) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    const upstream = shellRequest(req, { method: 'GET', path: `/api/tty?cols=${url.searchParams.get('cols') ?? ''}&rows=${url.searchParams.get('rows') ?? ''}`, user: who.user })
    upstream.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.on('error', () => socket.destroy())
      socket.on('close', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    upstream.on('response', (up) => {
      socket.write(`HTTP/1.1 ${up.statusCode} ${up.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`)
      up.pipe(socket)
    })
    upstream.on('error', (error) => {
      log('kura-shell 连接失败', { err: error.message })
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
    })
    upstream.end()
  }

  return { handle, upgrade }
}

function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
