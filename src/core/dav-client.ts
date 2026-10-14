import http from 'node:http'
import type { Readable, Writable } from 'node:stream'
import { normalizeDavPath } from './dav-scope.js'

/**
 * 文件管理器用的 WebDAV 客户端，连的是映射层的本机回环地址（Mirror.internalEndpoint('webdav')）。
 * 认证、会话、链路切换都在映射层里做完了，这里只说 WebDAV。
 *
 * NAS 侧是 rclone serve webdav（golang.org/x/net/webdav）。两个实测过的形态：
 * - href 是绝对路径（/volume1/xxx/），名字按 URL 编码；
 * - Destination 只给路径、不给 scheme+host：x/net/webdav 会拿 Destination 的 host 和请求 Host 比，
 *   而请求经过网关时 Host 已经换过，带 host 反而对不上（502）。只给路径它就不比。
 */
export interface DavEntry {
  /** 规范化后的完整路径，如 /volume1/照片 */
  path: string
  name: string
  isDir: boolean
  size: number
  /** 毫秒时间戳；拿不到为 0 */
  modified: number
  contentType: string
}

export class DavError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 按段编码路径（保留 /），中文、空格、# ? 都要编码。 */
export function encodeDavPath(path: string): string {
  return normalizeDavPath(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** multistatus 里的 <response> 块（命名空间前缀不固定：D: / d: / 没有）。 */
export const responseBlockRe = /<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response\s*>/g

function tag(block: string, name: string): string | undefined {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>)`)
  const m = re.exec(block)
  if (!m) return undefined
  return m[1] ?? ''
}

/** 从 <href> 取出规范化的路径；href 可能是绝对 URL，也可能是路径。 */
export function hrefPath(block: string): string | undefined {
  const raw = tag(block, 'href')
  if (raw === undefined) return undefined
  const text = decodeEntities(raw.trim())
  let pathname = text
  try {
    pathname = new URL(text, 'http://dav.invalid').pathname
  } catch {
    // 解析不了就当它本来就是路径
  }
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // 非法转义：保留原样，后面规范化时照样处理
  }
  try {
    return normalizeDavPath(pathname)
  } catch {
    return undefined
  }
}

export function parseMultistatus(xml: string): DavEntry[] {
  const out: DavEntry[] = []
  for (const block of xml.match(responseBlockRe) ?? []) {
    const path = hrefPath(block)
    if (!path) continue
    // 一个 response 里可能有 200 与 404 两个 propstat，只看 200 那份
    const props =
      (block.match(/<(?:[\w-]+:)?propstat\b[\s\S]*?<\/(?:[\w-]+:)?propstat\s*>/g) ?? []).find((p) => /\b200\b/.test(tag(p, 'status') ?? '')) ??
      block
    const resourcetype = tag(props, 'resourcetype') ?? ''
    const modified = Date.parse(decodeEntities(tag(props, 'getlastmodified') ?? ''))
    out.push({
      path,
      name: path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1),
      isDir: /<(?:[\w-]+:)?collection\b/.test(resourcetype),
      size: Number(tag(props, 'getcontentlength') ?? 0) || 0,
      modified: Number.isFinite(modified) ? modified : 0,
      contentType: decodeEntities(tag(props, 'getcontenttype') ?? ''),
    })
  }
  return out
}

const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:getcontenttype/></D:prop></D:propfind>`

export interface DavClientOptions {
  /** 映射层给的本机地址，如 http://127.0.0.1:53211 */
  endpoint: () => Promise<string>
  timeoutMs?: number
}

export class DavClient {
  constructor(private readonly options: DavClientOptions) {}

  private async send(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string | Buffer | Readable; timeoutMs?: number } = {},
  ): Promise<http.IncomingMessage> {
    const base = new URL(await this.options.endpoint())
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: base.hostname,
        port: base.port,
        method,
        path: encodeDavPath(path),
        headers: init.headers,
        agent: false,
      })
      const timeoutMs = init.timeoutMs ?? this.options.timeoutMs ?? 60_000
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`WebDAV 请求超时（${method} ${path}）`)))
      req.on('response', resolve)
      req.on('error', reject)
      const body = init.body
      if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        body.on('error', (error) => req.destroy(error))
        body.pipe(req)
      } else {
        req.end(body)
      }
    })
  }

  private static async text(res: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of res) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  private static async expect(res: http.IncomingMessage, ok: number[], what: string): Promise<void> {
    if (ok.includes(res.statusCode ?? 0)) {
      res.resume()
      return
    }
    const body = (await DavClient.text(res)).trim().slice(0, 300)
    throw new DavError(res.statusCode ?? 0, `${what}失败：HTTP ${res.statusCode}${body ? ` ${body}` : ''}`)
  }

  /** 列一个目录（不含它自己）；目录排前、按名字排序。 */
  async list(path: string): Promise<DavEntry[]> {
    const dir = normalizeDavPath(path)
    const res = await this.send('PROPFIND', dir, {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: propfindBody,
    })
    if (res.statusCode !== 207) await DavClient.expect(res, [207], `列目录 ${dir} `)
    const entries = parseMultistatus(await DavClient.text(res)).filter((e) => e.path !== dir)
    return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  }

  async stat(path: string): Promise<DavEntry | undefined> {
    const target = normalizeDavPath(path)
    const res = await this.send('PROPFIND', target, {
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: propfindBody,
    })
    if (res.statusCode === 404) {
      res.resume()
      return undefined
    }
    if (res.statusCode !== 207) await DavClient.expect(res, [207], `读取 ${target} `)
    return parseMultistatus(await DavClient.text(res)).find((e) => e.path === target)
  }

  async mkdir(path: string): Promise<void> {
    await DavClient.expect(await this.send('MKCOL', path), [201], `新建文件夹 ${path} `)
  }

  async remove(path: string): Promise<void> {
    await DavClient.expect(await this.send('DELETE', path), [200, 204], `删除 ${path} `)
  }

  /** 改名 / 移动；目标已存在时不覆盖（避免静默吞掉同名文件）。 */
  async move(from: string, to: string): Promise<void> {
    const res = await this.send('MOVE', from, { headers: { destination: encodeDavPath(to), overwrite: 'F' } })
    if (res.statusCode === 412) {
      res.resume()
      throw new DavError(412, `目标已存在：${normalizeDavPath(to)}`)
    }
    await DavClient.expect(res, [201, 204], `移动 ${from} `)
  }

  async copy(from: string, to: string): Promise<void> {
    const res = await this.send('COPY', from, { headers: { destination: encodeDavPath(to), overwrite: 'F', depth: 'infinity' } })
    if (res.statusCode === 412) {
      res.resume()
      throw new DavError(412, `目标已存在：${normalizeDavPath(to)}`)
    }
    await DavClient.expect(res, [201, 204], `复制 ${from} `)
  }

  /** 上传：流式，不整份读进内存。size 用来带 content-length（rclone 需要它才知道何时结束）。 */
  async upload(path: string, body: Readable, size: number): Promise<void> {
    const res = await this.send('PUT', path, {
      headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
      body,
      timeoutMs: 0, // 大文件走中继可能很久，靠用户取消，不靠超时
    })
    await DavClient.expect(res, [200, 201, 204], `上传 ${path} `)
  }

  /** 下载：把响应流写进 sink，返回总字节数（服务端给了的话）。 */
  async download(path: string, sink: Writable, onData?: (bytes: number, total: number) => void): Promise<void> {
    const res = await this.send('GET', path, { timeoutMs: 0 })
    if (res.statusCode !== 200) await DavClient.expect(res, [200], `下载 ${path} `)
    const total = Number(res.headers['content-length'] ?? 0) || 0
    let done = 0
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        done += chunk.length
        onData?.(done, total)
      })
      res.on('error', reject)
      sink.on('error', reject)
      sink.on('finish', resolve)
      res.pipe(sink)
    })
  }
}
