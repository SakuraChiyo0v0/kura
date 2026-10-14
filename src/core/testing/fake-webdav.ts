import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 内存里的 WebDAV 服务器，按 rclone serve webdav（golang.org/x/net/webdav）的行为实现够用的子集：
 * - PROPFIND Depth 0/1，href 是**绝对路径**、按段 URL 编码、目录带结尾 /；
 * - Destination 带 host 时要和请求 Host 一致，否则 502（x/net/webdav 就这样，经网关后 Host 已变）；
 * - MKCOL 父目录不存在 409、已存在 405；MOVE/COPY 遵守 Overwrite: F → 412。
 */
interface Node {
  dir: boolean
  data: Buffer
  modified: number
}

export class FakeWebdav {
  readonly server: http.Server
  url = ''
  readonly nodes = new Map<string, Node>([['/', { dir: true, data: Buffer.alloc(0), modified: Date.now() }]])
  requests: Array<{ method: string; path: string; destination?: string }> = []

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  mkdirp(path: string): this {
    let cur = ''
    for (const seg of path.split('/').filter(Boolean)) {
      cur += '/' + seg
      if (!this.nodes.has(cur)) this.nodes.set(cur, { dir: true, data: Buffer.alloc(0), modified: Date.now() })
    }
    return this
  }

  file(path: string, content: string): this {
    this.mkdirp(path.slice(0, path.lastIndexOf('/')))
    this.nodes.set(path, { dir: false, data: Buffer.from(content), modified: Date.now() })
    return this
  }

  private static parent(path: string): string {
    const at = path.lastIndexOf('/')
    return at <= 0 ? '/' : path.slice(0, at)
  }

  private children(path: string): string[] {
    return [...this.nodes.keys()].filter((p) => p !== path && FakeWebdav.parent(p) === path)
  }

  private subtree(path: string): string[] {
    return [...this.nodes.keys()].filter((p) => p === path || p.startsWith(path === '/' ? '/' : path + '/'))
  }

  private href(path: string, dir: boolean): string {
    const encoded = path === '/' ? '/' : path.split('/').map(encodeURIComponent).join('/')
    return dir && path !== '/' ? encoded + '/' : encoded
  }

  private entry(path: string): string {
    const node = this.nodes.get(path)!
    return `<D:response><D:href>${this.href(path, node.dir)}</D:href><D:propstat><D:prop>${
      node.dir ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getcontentlength>${node.data.length}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`
    }<D:getlastmodified>${new Date(node.modified).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    const path = raw.length > 1 ? raw.replace(/\/+$/, '') : '/'
    const destHeader = req.headers.destination as string | undefined
    this.requests.push({ method: req.method ?? '', path, destination: destHeader })
    const node = this.nodes.get(path)
    const end = (status: number, text = '') => {
      res.statusCode = status
      res.end(text)
    }

    switch (req.method) {
      case 'OPTIONS':
        res.setHeader('dav', '1, 2')
        return end(200)
      case 'PROPFIND': {
        if (!node) return end(404)
        const depth = req.headers.depth ?? 'infinity'
        const paths = [path, ...(node.dir && depth === '1' ? this.children(path) : [])]
        res.setHeader('content-type', 'application/xml; charset=utf-8')
        return end(207, `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">${paths.map((p) => this.entry(p)).join('')}</D:multistatus>`)
      }
      case 'GET':
      case 'HEAD':
        if (!node) return end(404)
        if (node.dir) {
          res.setHeader('content-type', 'text/html')
          return end(200, `<pre>${this.children(path).join('\n')}</pre>`)
        }
        res.setHeader('content-length', node.data.length)
        return end(200, req.method === 'HEAD' ? '' : (node.data as unknown as string))
      case 'PUT':
        if (!this.nodes.get(FakeWebdav.parent(path))?.dir) return end(409)
        this.nodes.set(path, { dir: false, data: body, modified: Date.now() })
        return end(node ? 204 : 201)
      case 'MKCOL':
        if (node) return end(405)
        if (!this.nodes.get(FakeWebdav.parent(path))?.dir) return end(409)
        this.nodes.set(path, { dir: true, data: Buffer.alloc(0), modified: Date.now() })
        return end(201)
      case 'DELETE':
        if (!node) return end(404)
        for (const p of this.subtree(path)) this.nodes.delete(p)
        return end(204)
      case 'MOVE':
      case 'COPY': {
        if (!node) return end(404)
        if (!destHeader) return end(400)
        let destUrl: URL
        try {
          destUrl = new URL(destHeader, `http://${req.headers.host}`)
        } catch {
          return end(400)
        }
        if (destUrl.host !== req.headers.host) return end(502, 'destination host mismatch')
        const dest = decodeURIComponent(destUrl.pathname).replace(/\/+$/, '') || '/'
        const exists = this.nodes.has(dest)
        if (exists && req.headers.overwrite === 'F') return end(412)
        if (!this.nodes.get(FakeWebdav.parent(dest))?.dir) return end(409)
        for (const p of this.subtree(path)) {
          const n = this.nodes.get(p)!
          this.nodes.set(dest + p.slice(path.length), { ...n, data: Buffer.from(n.data) })
          if (req.method === 'MOVE') this.nodes.delete(p)
        }
        return end(exists ? 204 : 201)
      }
      default:
        return end(405)
    }
  }
}
