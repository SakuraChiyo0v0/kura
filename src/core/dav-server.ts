import http from 'node:http'
import { encodeDavPath, hrefPath, responseBlockRe } from './dav-client.js'
import { normalizeDavPath, visibilityOf, writeDenial, type DavScope } from './dav-scope.js'
import { errorMessage } from './errors.js'
import { ServiceListener, type ListenerStatus } from './listener.js'
import { silentLogger, type Logger } from './log.js'
import { ServiceStats, type StatsSnapshot } from './stats.js'

/**
 * 给本机其他程序（资源管理器映射、播放器、同步工具、rclone 模块）用的 WebDAV 服务。
 *
 * 它不自己存文件，只是在映射层的 WebDAV 前面加一道「范围」：
 *   外部程序 → 127.0.0.1:<端口>（这里）→ 范围检查 / 过滤 → 映射层内部通道 → NAS 上的 rclone webdav
 *
 * 和服务映射页里那张 webdav 卡片的区别：那张是原样转发、NAS 暴露什么就看得到什么；这里按用户设的
 * 放行 / 排除 / 只读裁剪。两者都只监听回环。
 */
export interface DavServerSettings extends DavScope {
  enabled: boolean
  port: number
  readOnly: boolean
}

export const davServerDefaults: DavServerSettings = {
  enabled: true,
  port: 18006,
  readOnly: false,
  include: ['/'],
  exclude: [],
}

export interface DavServerStatus {
  listener: ListenerStatus
  url: string
  stats: StatsSnapshot
  /** 上游（映射层的 webdav 服务）现在能不能用；不能用时说明原因 */
  upstreamError: string
}

const readMethods = new Set(['GET', 'HEAD', 'PROPFIND', 'OPTIONS'])
const writeMethods = new Set(['PUT', 'MKCOL', 'DELETE', 'PROPPATCH', 'LOCK', 'UNLOCK', 'MOVE', 'COPY'])

/** 逐跳头，不转发。 */
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Host 头是不是回环地址（带不带端口都认；没有 Host 的 HTTP/1.0 客户端也放行）。 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return true
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/** 把 Destination（可能是 http://127.0.0.1:18006/a/b 这样的绝对 URL）收成规范化路径。 */
export function destinationPath(header: string): string {
  let pathname = header
  try {
    pathname = new URL(header, 'http://dav.invalid').pathname
  } catch {
    // 当成路径
  }
  return normalizeDavPath(decodeURIComponent(pathname))
}

/**
 * 只保留范围内可见的 <response>。
 * 被过滤掉的是整个块：外部程序根本不知道那些目录存在（而不是看得见、点进去 404）。
 */
export function filterMultistatus(xml: string, scope: DavScope): string {
  return xml.replace(responseBlockRe, (block) => {
    const path = hrefPath(block)
    if (!path) return ''
    return visibilityOf(path, scope).visibility === 'hidden' ? '' : block
  })
}

function reply(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`Kura WebDAV：${message}\n`)
}

export interface DavServerOptions {
  settings: DavServerSettings
  /** 映射层内部通道地址；映射没在跑、或服务端没有 webdav 服务时抛出 */
  upstream: () => Promise<string>
  log?: Logger
}

export class DavServer {
  private settings: DavServerSettings
  private readonly listener: ServiceListener
  private readonly stats = new ServiceStats()
  private readonly log: Logger
  private upstreamError = ''

  constructor(private readonly options: DavServerOptions) {
    this.settings = options.settings
    this.log = options.log ?? silentLogger
    this.listener = new ServiceListener({
      port: this.settings.port,
      enabled: this.settings.enabled,
      handlers: {
        request: (req, res) => void this.handle(req, res),
        upgrade: (_req, socket) => socket.destroy(),
      },
    })
  }

  start(): Promise<void> {
    return this.listener.applyIntent()
  }

  close(): Promise<void> {
    return this.listener.close()
  }

  status(): DavServerStatus {
    return {
      listener: this.listener.status(),
      url: `http://${this.listener.address()}/`,
      stats: this.stats.snapshot(),
      upstreamError: this.upstreamError,
    }
  }

  current(): DavServerSettings {
    return { ...this.settings, include: [...this.settings.include], exclude: [...this.settings.exclude] }
  }

  /** 应用新设置：范围、只读即时生效（下一个请求就按新的算）；开关与端口要动监听。 */
  async apply(next: DavServerSettings): Promise<void> {
    const prev = this.settings
    this.settings = next
    try {
      if (next.port !== prev.port) await this.listener.setPort(next.port)
      if (next.enabled !== prev.enabled) await this.listener.setEnabled(next.enabled)
    } catch (error) {
      // 端口绑不上：ServiceListener 已退回原端口，设置也退回，界面拿到错误
      this.settings = { ...next, port: this.listener.status().port }
      throw error
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.stats.noteRequest()
    const method = (req.method ?? 'GET').toUpperCase()
    let path: string
    try {
      path = normalizeDavPath(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'))
    } catch (error) {
      reply(res, 400, errorMessage(error))
      return
    }
    const scope = this.settings

    // 防 DNS 重绑定：这个服务不设认证（只靠「只有本机连得上」），但浏览器里的恶意网页可以把自己的域名
    // 解析到 127.0.0.1 再来读。正经的 WebDAV 客户端连 127.0.0.1 / localhost，Host 必然是回环。
    if (!isLoopbackHost(String(req.headers.host ?? ''))) {
      reply(res, 403, 'Host 不是本机地址')
      return
    }

    if (!readMethods.has(method) && !writeMethods.has(method)) {
      reply(res, 405, `不支持 ${method}`)
      return
    }

    // ---- 范围检查 ----
    const visibility = visibilityOf(path, scope).visibility
    let destination: string | undefined
    if (method !== 'OPTIONS') {
      if (visibility === 'hidden') {
        reply(res, 404, '不存在')
        return
      }
      // 「路过」的上级目录只能列（PROPFIND），GET 会吐出整页目录 HTML，等于绕开过滤
      if (visibility === 'ancestor' && method !== 'PROPFIND') {
        reply(res, 403, '这一层只用来通往放行的目录')
        return
      }
    }
    if (writeMethods.has(method) && method !== 'COPY') {
      const denial = writeDenial(path, scope, scope.readOnly, method)
      if (denial) {
        reply(res, 403, denial)
        return
      }
    }
    if (method === 'MOVE' || method === 'COPY') {
      const header = String(req.headers.destination ?? '')
      if (!header) {
        reply(res, 400, '缺少 Destination')
        return
      }
      try {
        destination = destinationPath(header)
      } catch (error) {
        reply(res, 400, errorMessage(error))
        return
      }
      const denial = writeDenial(destination, scope, scope.readOnly, 'PUT')
      if (denial) {
        reply(res, 403, `目标${denial}`)
        return
      }
    }

    // ---- 转发 ----
    let upstream: URL
    try {
      upstream = new URL(await this.options.upstream())
      this.upstreamError = ''
    } catch (error) {
      this.upstreamError = errorMessage(error)
      this.stats.noteError(error)
      reply(res, 503, this.upstreamError)
      return
    }

    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || hopByHop.has(name) || name === 'host') continue
      headers[name] = value
    }
    // PROPFIND 的响应要改写，不能让上游压缩
    if (method === 'PROPFIND') delete headers['accept-encoding']
    // 只给路径：上游（x/net/webdav）会拿 Destination 的 host 和自己收到的 Host 比，经过网关后必然不同
    if (destination) headers.destination = encodeDavPath(destination)

    req.on('data', (chunk: Buffer) => {
      this.stats.bytesUp += chunk.length
    })
    const out = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method,
      path: req.url,
      headers,
      agent: false,
    })
    res.on('close', () => {
      if (!res.writableFinished) out.destroy()
    })
    out.on('error', (error) => {
      if (req.socket.destroyed) return // 调用方自己走了，不算失败
      this.stats.noteError(error)
      this.log.warn('本机 WebDAV 转发失败', { method, path, err: errorMessage(error) })
      reply(res, 502, errorMessage(error))
    })
    out.on('response', (up) => {
      const status = up.statusCode ?? 502
      const outHeaders: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined || hopByHop.has(name)) continue
        outHeaders[name] = value
      }
      if (status >= 500) this.stats.noteError(new Error(`上游 HTTP ${status}`))

      if (method === 'PROPFIND' && status === 207) {
        const chunks: Buffer[] = []
        up.on('data', (chunk: Buffer) => chunks.push(chunk))
        up.on('end', () => {
          const body = Buffer.from(filterMultistatus(Buffer.concat(chunks).toString('utf8'), this.settings))
          delete outHeaders['content-length']
          outHeaders['content-length'] = body.length
          res.writeHead(status, outHeaders)
          this.stats.bytesDown += body.length
          res.end(body)
        })
        up.on('error', () => res.destroy())
        return
      }

      res.writeHead(status, outHeaders)
      up.on('data', (chunk: Buffer) => {
        this.stats.bytesDown += chunk.length
      })
      up.pipe(res)
    })
    req.pipe(out)
  }
}
