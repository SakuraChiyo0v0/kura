import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import type { Registry } from './registry.js'

/**
 * kura-server 的 HTTP 入口：反代 + 服务清单 + 管理页（设计文档 §二–§五）。
 *
 * **kura-server 自己不做认证**：它要么只从绿联中继进来（中继已经认证过绿联账号），
 * 要么在局域网里直连（此时不加第二层认证，由更外层的手段保护 —— 见 AGENTS.md）。
 * 客户端因此只在设置里保留绿联那一组凭据，网关只填端口。
 *
 * 分流规则照搬现网 nginx（server/nginx/conf.d/default.conf）：
 * 1. `X-Nas-Service` 头优先；
 * 2. 没有头时看路径第一段，**只认清单里的名字**（白名单。现网踩过：写成通配后路径第一段
 *    被当成服务名，门户路径整个坏掉）；
 * 3. 都不是 = 门户请求：/api/health、/__services、/_kura/。
 *
 * 内置服务（webdav、nas-console）的处理器由调用方注入。
 */

/** 转发给应用时要去掉的 cookie：绿联中继的令牌、旧客户端残留的网关会话 —— 应用不该看到它们。 */
const strippedCookies = ['ugreen-proxy-token', 'authelia_session']

/** 没有用户可归属时转发头里的标识（应用按 remote-user 做 ACL 时至少有个稳定的值）。 */
export const anonymousUser = 'kura'

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function stripCookies(header: string | undefined): string {
  return (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => {
      if (!p) return false
      const name = p.slice(0, Math.max(0, p.indexOf('='))).trim()
      return !strippedCookies.some((s) => name === s || name.startsWith(`${s}_`))
    })
    .join('; ')
}

export interface BuiltinHandler {
  request(req: http.IncomingMessage, res: http.ServerResponse, path: string): void
  upgrade?(req: http.IncomingMessage, socket: net.Socket, head: Buffer, path: string): void
}

/** 管理页 `/_kura/`。由 main 注入，测试可以只给一个假的。 */
export interface AdminHandler {
  handle(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void>
}

export interface ServerOptions {
  registry: Registry
  builtins?: Record<string, BuiltinHandler>
  admin?: AdminHandler
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 信任 X-Forwarded-For（前面还有一层反代时才开），转发头里报真实来源 */
  trustProxy?: boolean
}

interface Target {
  name: string
  /** 转给后端的路径（路径前缀模式已剥掉 /<名>） */
  path: string
  /** 路径前缀模式下的前缀，用于改写跳转；头模式为空 */
  prefix: string
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

async function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 不跟随重定向、不区分认证失败：一条提示写清「请求没到应用」。 */
function unauthorized(_req: http.IncomingMessage, res: http.ServerResponse): void {
  send(res, 401, { status: 'KO', message: 'Unauthorized' })
}

export function createKuraServer(options: ServerOptions): http.Server {
  const { registry } = options
  const log = options.log ?? (() => {})
  const builtins = options.builtins ?? {}

  const source = (req: http.IncomingMessage): string => {
    if (options.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
      if (forwarded) return forwarded
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** 这个请求要去哪个服务；undefined = 门户请求。 */
  const resolve = (req: http.IncomingMessage): Target | undefined => {
    const url = req.url ?? '/'
    const header = String(req.headers['x-nas-service'] ?? '').trim()
    // 头里的名字也要过白名单：不认识的当门户请求（和现网 map 的 default "" 一样），不去猜后端
    if (header) return registry.known(header) ? { name: header, path: url, prefix: '' } : undefined
    const m = /^\/([a-z0-9][a-z0-9-]{0,62})(\/|$|\?)/.exec(url)
    if (m && registry.known(m[1]!)) {
      const rest = url.slice(m[1]!.length + 1)
      return { name: m[1]!, path: rest.startsWith('/') ? rest : `/${rest}`, prefix: `/${m[1]}` }
    }
    return undefined
  }

  const handlePortal = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path === '/api/health') {
      send(res, 200, { status: 'OK', app: 'kura-server' })
      return
    }

    // 旧客户端（v0.3 及以前）会先登录再访问。这一层已经删了，但直接 404 会让客户端
    // 报「未知错误」；回一个明确的「不需要登录」由客户端识别成「无需凭据，继续」。
    if (path === '/api/firstfactor' && req.method === 'POST') {
      send(res, 200, { status: 'OK', message: 'kura-server 不做认证，直接访问即可' })
      return
    }
    if (path === '/api/logout' && req.method === 'POST') {
      send(res, 200, { status: 'OK' })
      return
    }

    if (path === '/__services' && req.method === 'GET') {
      send(res, 200, { services: await registry.entries() })
      return
    }
    if (path === '/api/user/info') {
      send(res, 200, { status: 'OK', data: { display_name: anonymousUser } })
      return
    }
    if (options.admin && (path === '/_kura' || path.startsWith('/_kura/'))) {
      await options.admin.handle(req, res, path.slice('/_kura'.length) || '/')
      return
    }
    send(res, 404, 'Not found')
  }

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, target: Target): void => {
    const entry = registry.find(target.name)!
    const backend = new URL(entry.backend)
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || hopByHop.has(name) || name === 'cookie' || name === 'x-nas-service') continue
      headers[name] = value
    }
    const cookie = stripCookies(req.headers.cookie)
    if (cookie) headers.cookie = cookie
    // 与现网 protected-prefix.inc 一致的转发头
    headers['remote-user'] = anonymousUser
    headers['x-forwarded-proto'] = 'https'
    headers['x-forwarded-host'] = String(req.headers.host ?? '')
    headers['x-forwarded-for'] = source(req)

    const lib = backend.protocol === 'https:' ? https : http
    const upstream = lib.request({
      protocol: backend.protocol,
      hostname: backend.hostname,
      port: backend.port || undefined,
      method: req.method,
      path: target.path,
      headers,
    })
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    upstream.on('response', (up) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined || hopByHop.has(name)) continue
        out[name] = value
      }
      // 路径前缀模式：应用发的绝对路径跳转要重新加上前缀，否则浏览器跑到入口根上（现网 hermes 踩过）
      const location = up.headers.location
      if (location && target.prefix && entry.rewriteRedirect) {
        out.location = location.replace(/^(?:https?:\/\/[^/]+)?\//, `${target.prefix}/`)
      }
      res.writeHead(up.statusCode ?? 502, out)
      up.pipe(res)
    })
    upstream.on('error', (error) => {
      if (req.socket.destroyed) return
      log('后端连接失败', { 服务: target.name, err: error.message })
      if (res.headersSent) res.destroy()
      else send(res, 502, `kura-server：${target.name} 连不上（${error.message}）`)
    })
    req.pipe(upstream)
  }

  const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
    void (async () => {
      const target = resolve(req)
      if (!target) return handlePortal(req, res)
      const builtin = builtins[target.name]
      if (builtin) {
        // 路径前缀模式（/webdav/foo）下 req.url 还带着前缀，内置处理器只认 WebDAV 自己的路径
        req.url = target.path
        return builtin.request(req, res, target.path)
      }
      if (!registry.find(target.name)) return send(res, 404, `kura-server：没有「${target.name}」这个服务`)
      forward(req, res, target)
    })().catch((error: Error) => {
      log('处理请求出错', { err: error.message })
      if (!res.headersSent) send(res, 500, 'kura-server：内部错误')
      else res.destroy()
    })
  })
  server.headersTimeout = 30_000

  server.on('upgrade', (req, socket: net.Socket, head) => {
    socket.on('error', () => {})
    const target = resolve(req)
    if (!target) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    const builtin = builtins[target.name]
    if (builtin?.upgrade) {
      req.url = target.path
      return builtin.upgrade(req, socket, head, target.path)
    }
    const entry = registry.find(target.name)
    if (!entry) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    const backend = new URL(entry.backend)
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'cookie' || name === 'x-nas-service') continue
      headers[name] = value
    }
    const cookie = stripCookies(req.headers.cookie)
    if (cookie) headers.cookie = cookie
    headers['remote-user'] = anonymousUser
    const upstream = (backend.protocol === 'https:' ? https : http).request({
      hostname: backend.hostname,
      port: backend.port || undefined,
      path: target.path,
      method: req.method,
      headers,
      agent: false,
    })
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
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'))
    upstream.end()
  })

  return server
}
