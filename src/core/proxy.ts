import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { errorPageMarker, isAuthRedirect, mergeCookie, rewriteLocation, rewriteSetCookie } from './cookies.js'
import { errorMessage } from './errors.js'
import type { LinkRouter, RoutableService, Route } from './link.js'
import { silentLogger, type Logger } from './log.js'
import type { SessionManager } from './session.js'
import type { ServiceStats } from './stats.js'

/** 同一服务「会话建立失败」日志的最小间隔：退避窗口里每个请求都会失败，不限频会把真告警淹掉。 */
export const sessionFailLogIntervalMs = 60_000

/** 逐跳头：反代不该原样转发（RFC 7230 §6.1）；Upgrade/Connection 在 WebSocket 路径单独处理。 */
const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface ProxyService extends RoutableService {
  label: string
  /** 转发时额外加的请求头（值已展开）；调用方自己带了同名头时以调用方为准 */
  headers?: Record<string, string>
}

export interface ProxyDeps {
  sessions: SessionManager
  /** 只用到 route()：测试可直接给一个指向本地上游的实现 */
  router: Pick<LinkRouter, 'route'>
  log?: Logger
  /** 共享的上游连接池；测试可注入 */
  agents?: { http: http.Agent; https: https.Agent }
}

export class SessionFailureLimiter {
  private readonly last = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}
  /** 返回这次要不要打日志：第一次立刻报，之后每分钟最多一条。 */
  shouldLog(service: string): boolean {
    const prev = this.last.get(service)
    if (prev !== undefined && this.now() - prev < sessionFailLogIntervalMs) return false
    this.last.set(service, this.now())
    return true
  }
}

/**
 * 调用方自己走了（关标签页、取消下载、探测超时）不是服务出错，计数与 WARN 都留给真故障。
 *
 * 判据看**连接**，不看 req.destroyed：Node 的 IncomingMessage 开着 autoDestroy，
 * 请求体一读完 destroyed 就变成 true（实测），拿它判会把每个正常请求都当成「调用方走了」。
 */
export function callerGone(req: http.IncomingMessage, error: unknown): boolean {
  if ((error as Error | undefined)?.name === 'AbortError') return true
  return req.socket.destroyed
}

function plainError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`Kura：${message}\n`)
}

/** 组装发往上游的请求头：逐跳头去掉、Host 指定、cookie 合并、附加头、网关分流头。 */
export function buildUpstreamHeaders(
  inbound: http.IncomingHttpHeaders,
  route: Route,
  upstreamHost: string,
  managedCookie: string,
  extra: Record<string, string> | undefined,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(inbound)) {
    if (value === undefined || hopByHop.has(name) || name === 'host' || name === 'cookie') continue
    out[name] = value
  }
  // Host 显式指定：局域网模式拨号地址是局域网 IP，但 Host 必须是公网域名（旧网关按它校验会话域；kura-server 不校验，保留是为了应用看到的 Host 一致）
  out.host = route.host || upstreamHost
  const cookie = mergeCookie(inbound.cookie ?? '', managedCookie)
  if (cookie) out.cookie = cookie
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (inbound[name.toLowerCase()] === undefined) out[name.toLowerCase()] = value
  }
  // 客户端内部的分流协议，不能被外部应用伪造或覆盖
  if (route.gatewayService) out['x-nas-service'] = route.gatewayService
  else delete out['x-nas-service']
  return out
}

function isUpgrade(req: http.IncomingMessage): boolean {
  return (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

/**
 * 为一个服务造出本机反代处理器（HTTP 请求 + WebSocket 升级）。
 *
 * 转发目标**每个请求现算**：链路模式可以运行时热切换，启动时烘死就没法切了。
 * 红线：不跟随重定向（node:http 本来就不跟随）；302→登录页要识别成「会话失效」而不是成功返回。
 */
export function createServiceProxy(svc: ProxyService, deps: ProxyDeps, stats?: ServiceStats) {
  const log = deps.log ?? silentLogger
  const limiter = new SessionFailureLimiter()
  const agents = deps.agents ?? defaultAgents

  async function prepare(_req: http.IncomingMessage) {
    const route = deps.router.route(svc)
    const cookie = await deps.sessions.cookie(route.sessionPort)
    const target = new URL(route.upstream)
    return { route, cookie, target }
  }

  function sessionFailed(error: unknown): string {
    stats?.noteError(error)
    if (limiter.shouldLog(svc.label)) log.error('无法建立到 NAS 的会话', { service: svc.label, err: errorMessage(error) })
    return `无法建立到 NAS 的会话：${errorMessage(error)}`
  }

  function proxyFailed(req: http.IncomingMessage, error: unknown): boolean {
    if (callerGone(req, error)) {
      log.debug('调用方已断开，请求取消', { service: svc.label, method: req.method, path: req.url })
      return false
    }
    stats?.noteError(error)
    log.warn('代理失败', { service: svc.label, method: req.method, path: req.url, err: errorMessage(error) })
    return true
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    stats?.noteRequest()
    let prepared
    try {
      prepared = await prepare(req)
    } catch (error) {
      plainError(res, 502, sessionFailed(error))
      return
    }
    const { route, cookie, target } = prepared
    const isHttps = target.protocol === 'https:'
    const headers = buildUpstreamHeaders(req.headers, route, target.host, cookie, svc.headers)

    // 上行计数：从调用方读走的请求体
    req.on('data', (chunk: Buffer) => {
      if (stats) stats.bytesUp += chunk.length
    })

    const upstream = (isHttps ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: req.url,
      headers,
      agent: isHttps ? agents.https : agents.http,
      ...(isHttps && route.host ? { servername: route.host.replace(/:\d+$/, '') } : {}),
    })

    // 调用方中途断开：中止上游，不计错误
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })

    upstream.on('response', (up) => {
      const status = up.statusCode ?? 502
      const location = String(up.headers.location ?? '')

      // 认证失败必须用**原始** Location 判断：改写会动 fragment，而中继登录页地址正好带 #
      if (isAuthRedirect(status, location)) {
        up.resume()
        deps.sessions.invalidate(route.sessionPort)
        const error = new Error(`绿联会话已失效（端口 ${route.sessionPort}），已作废，请重试`)
        if (proxyFailed(req, error)) plainError(res, 502, error.message)
        return
      }

      const outHeaders: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined || hopByHop.has(name)) continue
        outHeaders[name] = value
      }
      const setCookie = up.headers['set-cookie']
      if (setCookie) outHeaders['set-cookie'] = rewriteSetCookie(setCookie)
      if (location) outHeaders.location = rewriteLocation(location)

      // 嗅探 errorPage（中继的「假成功」：200 + 跳转 errorPage 的 HTML）。
      // 必须避开 SSE：对一个永不结束的流等前 4KB 会把连接一直卡住
      const sniff = !String(up.headers['content-type'] ?? '').toLowerCase().startsWith('text/event-stream')
      const head: Buffer[] = []
      let headSize = 0
      let decided = !sniff

      const startStreaming = () => {
        decided = true
        res.writeHead(status, outHeaders)
        for (const chunk of head) write(chunk)
        head.length = 0
      }
      const write = (chunk: Buffer) => {
        if (stats) stats.bytesDown += chunk.length
        res.write(chunk)
      }
      const rejectErrorPage = (): boolean => {
        if (!Buffer.concat(head).includes(errorPageMarker)) return false
        up.destroy()
        const error = new Error(`中继拒绝请求（errorPage），端口 ${route.sessionPort}`)
        if (proxyFailed(req, error)) plainError(res, 502, error.message)
        return true
      }

      if (decided) res.writeHead(status, outHeaders)
      up.on('data', (chunk: Buffer) => {
        if (decided) {
          write(chunk)
          return
        }
        head.push(chunk)
        headSize += chunk.length
        if (headSize >= 4096) {
          if (!rejectErrorPage()) startStreaming()
        }
      })
      up.on('end', () => {
        if (!decided) {
          if (rejectErrorPage()) return
          startStreaming()
        }
        res.end()
      })
      up.on('error', (error) => {
        if (proxyFailed(req, error)) plainError(res, 502, errorMessage(error))
      })
    })

    upstream.on('error', (error) => {
      if (proxyFailed(req, error)) plainError(res, 502, errorMessage(error))
    })

    req.pipe(upstream)
  }

  /** WebSocket：握手转发给上游，拿到 101 后双向搬运原始字节（不计入流量统计）。 */
  async function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    stats?.noteRequest()
    socket.on('error', () => {})
    let prepared
    try {
      prepared = await prepare(req)
    } catch (error) {
      const message = sessionFailed(error)
      socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\nKura：${message}\n`)
      return
    }
    const { route, cookie, target } = prepared
    const isHttps = target.protocol === 'https:'
    const headers = buildUpstreamHeaders(req.headers, route, target.host, cookie, svc.headers)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade

    const upstream = (isHttps ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: req.url,
      headers,
      agent: false, // 升级连接会被接管，不能进连接池
      ...(isHttps && route.host ? { servername: route.host.replace(/:\d+$/, '') } : {}),
    })

    upstream.on('upgrade', (up, upSocket: net.Socket | tls.TLSSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      socket.on('close', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })

    // 上游没升级（返回了普通响应）：照实转给调用方
    upstream.on('response', (up) => {
      const status = up.statusCode ?? 502
      if (isAuthRedirect(status, String(up.headers.location ?? ''))) deps.sessions.invalidate(route.sessionPort)
      socket.write(`HTTP/1.1 ${status} ${up.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`)
      up.pipe(socket)
    })

    upstream.on('error', (error) => {
      if (proxyFailed(req, error)) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    upstream.end()
  }

  return {
    request: (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (isUpgrade(req)) return // 由 upgrade 事件处理
      void handleRequest(req, res)
    },
    upgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      void handleUpgrade(req, socket, head)
    },
  }
}

/**
 * 默认上游连接池。保留环境代理不在这里做：Node 的 http.Agent 不读 HTTPS_PROXY，
 * 公司网络需要代理时再接（Go 版用 ProxyFromEnvironment；已记入遗留）。
 */
const defaultAgents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 32 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 32 }),
}
