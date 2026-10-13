import http from 'node:http'
import https from 'node:https'

/**
 * 一次性 HTTP 请求（登录、申请令牌、网关自身接口、探测用）。
 *
 * 为什么不用 fetch：
 * 1. fetch 不允许自定义 Host 头，而局域网模式恰恰要「拨局域网 IP、发公网域名的 Host」
 *    —— Authelia 按 Host 校验会话域，用 IP 当 Host 会 401（Go 版实测踩过）。
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${options.url}`)))
    req.on('error', reject)
    req.end(options.body)
  })
}
