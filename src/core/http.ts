import http from 'node:http'
import https from 'node:https'

/**
 * 一次性 HTTP 请求（登录、申请令牌、网关自身接口、探测用）。
 *
 * 为什么不用 fetch：
 * 1. fetch 不允许自定义 Host 头，而局域网模式恰恰要「拨局域网 IP、发公网域名的 Host」
 *    —— 旧网关上按 Host 校验会话域，用 IP 当 Host 会 401（Go 版实测踩过）。
 *    kura-server 已经不校验域了，这条仍然保留：让容器应用在两种链路下看到的 Host 一致。
 * 2. node:http 天生不跟随重定向。这是安全红线：中继用 302 → 登录页伪装「未认证」，
 *    跟随了就会拿到一个 200 的登录页，永远发现不了失败。
 */
export interface HttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  /** 覆盖 Host 头；https 下同时作为 TLS SNI */
  host?: string
  body?: string | Buffer
  timeoutMs?: number
  /** 响应体最多读多少字节，超出部分丢弃（默认 1 MiB） */
  maxBody?: number
}

export interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export type HttpRequester = (request: HttpRequest) => Promise<HttpResponse>

/** 取单值响应头（node 对重复头可能给数组）。 */
export function headerValue(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/**
 * 出网代理：读 HTTPS_PROXY / NO_PROXY（与 Go 版 ProxyFromEnvironment 对齐），用 Node 24 自带的 Agent 代理能力。
 *
 * 只给 **https** 上游用 —— 也就是绿联中继那条外网链路。lan 链路是 http 拨局域网 IP，
 * 本来就不该走公司代理；而且 Node 的 http 代理模式要求 Host 头与目标一致，
 * lan 模式偏偏要「拨 IP、发公网域名的 Host」，走代理会直接抛错。
 * 不读 Windows 系统代理（IE 设置）：Go 版也不读，需要时设环境变量。
 */
export function proxiedHttpsAgent(options: https.AgentOptions = {}, env: NodeJS.ProcessEnv = process.env): https.Agent {
  return new https.Agent({ ...options, proxyEnv: env })
}

/** 环境里有没有配 https 代理（日志里提一句，排查时一眼看出走没走代理）。 */
export function httpsProxyConfigured(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HTTPS_PROXY || env.https_proxy || undefined
}

const oneShotHttpsAgent = proxiedHttpsAgent()

export const request: HttpRequester = (options) => {
  const url = new URL(options.url)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http
  const headers: Record<string, string | number> = { ...options.headers }
  if (options.host) headers.host = options.host
  if (options.body !== undefined) headers['content-length'] = Buffer.byteLength(options.body)
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBody = options.maxBody ?? 1 << 20

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        headers,
        ...(isHttps ? { agent: oneShotHttpsAgent } : {}),
        ...(isHttps && options.host ? { servername: options.host.replace(/:\d+$/, '') } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          if (size >= maxBody) return
          const room = maxBody - size
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
          size += Math.min(chunk.length, room)
        })
        res.on('end', () => {
          clearTimeout(timer)
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )
    // 用独立定时器做**整体**超时，不用 req.setTimeout —— 那个是 socket 空闲超时，
    // 只要服务器还在慢慢吐字节就会被不断重置，一直拖着不结束的响应能把 timeoutMs 拖成永远。
    // 这几个调用方（登录、网关请求、探测）的 timeoutMs 都是「整个请求最多多久」的意思。
    const timer = setTimeout(() => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${options.url}`)), timeoutMs)
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end(options.body)
  })
}
