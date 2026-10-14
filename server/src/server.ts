import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import { Auth, sessionCookie, sessionToken } from './auth.js'
import type { Registry } from './registry.js'

/**
 * kura-server 的 HTTP 入口：认证 + 反代 + 服务清单（设计文档 §二–§五）。
 *
 * 分流规则照搬现网 nginx（server/nginx/conf.d/default.conf）：
 * 1. `X-Nas-Service` 头优先；
 * 2. 没有头时看路径第一段，**只认清单里的名字**（白名单。现网踩过：写成通配后 /api/firstfactor
 *    被当成服务名 "api"，门户登录整个坏掉）；
 * 3. 都不是 = 门户请求：/api/firstfactor、/api/logout、/__services、/_kura/。
 *
 * 内置服务（webdav、nas-console）的处理器由调用方注入（S2、S3），S1 只认识名字。
 */

/** 转发给应用时要去掉的 cookie：kura 自己的会话、绿联中继的令牌 —— 应用不该看到网关凭据。 */
const strippedCookies = [sessionCookie, 'ugreen-proxy-token']

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
  request(req: http.IncomingMessage, res: http.ServerResponse, user: string, path: string): void
  upgrade?(req: http.IncomingMessage, socket: net.Socket, head: Buffer, user: string, path: string): void
}

export interface ServerOptions {
  auth: Auth
  registry: Registry
  builtins?: Record<string, BuiltinHandler>
  /** 测试注入：后端请求用的 agent */
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 信任这些来源的 X-Forwarded-For（默认不信任，用 socket 地址做防爆破的键） */
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

/** 未认证：浏览器（要 HTML）给 302 去登录页，程序给 401 —— 客户端两种都当「会话失效」处理。 */
function unauthorized(req: http.IncomingMessage, res: http.ServerResponse): void {
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
  if (wantsHtml) {
    res.writeHead(302, { location: `/_kura/login?rd=${encodeURIComponent(req.url ?? '/')}`, 'cache-control': 'no-store' })
    res.end()
    return
  }
  send(res, 401, { status: 'KO', message: 'Unauthorized' })
}

export function createKuraServer(options: ServerOptions): http.Server {
  const { auth, registry } = options
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
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/api/firstfactor' && req.method === 'POST') {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, { status: 'KO', message: 'Unable to parse body.' })
        return
      }
      const result = await auth.login(source(req), body)
      if (!result.ok) {
        if (result.status === 401) log('登录失败', { 来源: source(req) })
        send(res, result.status, { status: 'KO', message: result.message })
        return
      }
      // 不设 Domain：会话不绑域名（设计文档 §十三），局域网 IP 访问也认
      send(res, 200, { status: 'OK' }, {
        'set-cookie': `${sessionCookie}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${result.maxAgeSeconds}`,
      })
      return
    }
    if (path === '/api/logout' && req.method === 'POST') {
      auth.logout(sessionToken(req.headers.cookie))
      send(res, 200, { status: 'OK' }, { 'set-cookie': `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
      return
    }
    if (path === '/api/health') {
      send(res, 200, { status: 'OK', app: 'kura-server' })
      return
    }

    // 以下都要登录
    const user = auth.check(sessionToken(req.headers.cookie))
    if (!user) {
      unauthorized(req, res)
      return
    }
    if (path === '/__services' && req.method === 'GET') {
      send(res, 200, { services: await registry.entries() })
      return
    }
    if (path === '/api/user/info') {
      send(res, 200, { status: 'OK', data: { display_name: user } })
      return
    }
    send(res, 404, 'Not found')
  }

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, target: Target, user: string): void => {
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
    headers['remote-user'] = user
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
      const user = auth.check(sessionToken(req.headers.cookie))
      if (!user) return unauthorized(req, res)
      const builtin = builtins[target.name]
      if (builtin) {
        // 路径前缀模式（/webdav/foo）下 req.url 还带着前缀，内置处理器只认 WebDAV 自己的路径
        req.url = target.path
        return builtin.request(req, res, user, target.path)
      }
      if (!registry.find(target.name)) return send(res, 404, `kura-server：没有「${target.name}」这个服务`)
      forward(req, res, target, user)
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
    const user = auth.check(sessionToken(req.headers.cookie))
    if (!target || !user) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    const builtin = builtins[target.name]
    if (builtin?.upgrade) {
      req.url = target.path
      return builtin.upgrade(req, socket, head, user, target.path)
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
    headers['remote-user'] = user
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
