import http from 'node:http'
import type net from 'node:net'
import { errorMessage } from '../../src/core/errors.js'
import type { TokenStore } from './tokens.js'

/**
 * kura-server 侧对**客户端**暴露的终端接口，名字与现网 nas-console 保持一致，客户端不用改：
 *   WS   /api/tty            —— 开 PTY（可带 `?token=nsc_...`）
 *   GET  /api/me             —— 校验 API Token；没带 token 也回 200（终端不需要凭据）
 *   POST /api/exec           —— 用 API Token 调 exec（审计在这里记）
 *
 * **这里不再有认证**：kura-server 自己不做认证（见 server.ts 顶部）。API Token 仍然保留 ——
 * 它不是给终端用的门禁，是给脚本 / AI 调 exec 时的**归属标签**（审计里记下是谁在跑）。
 *
 * 请求靠**内部令牌**转给 kura-shell；kura-shell 不认用户，只认那个令牌。
 */
export interface ConsoleOptions {
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

/** 审计里没有 API Token 时的归属标签。 */
export const anonymousConsoleUser = 'kura'

export function createConsoleHandler(options: ConsoleOptions): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void
} {
  const log = options.log ?? (() => {})

  /** 谁在调：只用来给审计打标签，不是门禁。带了有效的 API Token 就记它的用途，否则记 kura。 */
  const identify = (req: http.IncomingMessage, url: URL): string => {
    const token = url.searchParams.get('token') ?? /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]?.trim()
    return options.tokens.verify(token ?? undefined)?.label ?? anonymousConsoleUser
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

    if (path === '/api/me') {
      const who = identify(req, url)
      res.writeHead(200, { 'content-type': 'application/json' })
      return void res.end(JSON.stringify({ user: who }))
    }

    if (path === '/api/exec' && req.method === 'POST') {
      const who = identify(req, url)
      // readBody 必须在 try 里：请求体超限时它 reject 且已经 destroy 了连接，
      // 异常从这里逃出去客户端什么都收不到，只剩一个被重置的连接
      let raw: string
      try {
        raw = await readBody(req)
      } catch (error) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: errorMessage(error) }))
        return
      }
      try {
        const result = await execShell({
          method: 'POST',
          path: '/api/exec',
          headers: { 'content-type': 'application/json', 'x-kura-token': options.internalToken, 'x-kura-user': encodeURIComponent(who) },
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
    // cols / rows 只可能是数字：`searchParams.get` 返回的是**已解码**的值，原样拼进请求行的话
    // `?cols=%0d%0a...` 解出来就是真的 CRLF，可以往发给 kura-shell 的请求里注入头 / 走私请求。
    // 非数字一律当没传（kura-shell 那边本来也有默认值 80×24）。
    const dim = (name: string): string => {
      const raw = url.searchParams.get(name) ?? ''
      return /^\d{1,4}$/.test(raw) ? raw : ''
    }
    const upstream = shellRequest(req, { method: 'GET', path: `/api/tty?cols=${dim('cols')}&rows=${dim('rows')}`, user: identify(req, url) })
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
