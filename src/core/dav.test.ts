import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DavClient, encodeDavPath, parseMultistatus } from './dav-client.js'
import { excludeMatches, normalizeDavPath, normalizeRules, visibilityOf, writeDenial } from './dav-scope.js'
import {
  DavServer,
  davServerDefaults,
  filterMultistatus,
  handleDavRequest,
  isLoopbackHost,
  rewriteHrefBase,
  stripHrefBase,
  type DavServerSettings,
} from './dav-server.js'
import { FakeWebdav } from './testing/fake-webdav.js'

describe('dav-scope', () => {
  const scope = { include: ['/volume1/照片', '/home'], exclude: ['/volume1/照片/私密'] }

  it('规范化：去多余斜杠、拒绝 . 与 ..', () => {
    expect(normalizeDavPath('volume1//照片/')).toBe('/volume1/照片')
    expect(normalizeDavPath('\\a\\b')).toBe('/a/b')
    expect(() => normalizeDavPath('/volume1/../etc')).toThrow(/\.\./)
    expect(normalizeRules(['/b/', 'b', '/a'])).toEqual(['/a', '/b'])
  })

  it('空规则要被拒绝：空白 include 会变成放行整个文件系统', () => {
    // 关键：空串规范化成 '/'，一旦当成规则，include 就是「放行一切」、exclude 就是「挡住一切」
    expect(normalizeDavPath('')).toBe('/')
    expect(() => normalizeRules(['/volume1', ''])).toThrow(/不能为空/)
    expect(() => normalizeRules(['   '])).toThrow(/不能为空/)
    expect(() => normalizeRules([''])).toThrow(/不能为空/)
  })

  it('放行目录及其子项完全可见；排除优先；上级只能路过；其余隐藏', () => {
    expect(visibilityOf('/volume1/照片/2024', scope).visibility).toBe('full')
    expect(visibilityOf('/volume1/照片/私密/x.jpg', scope).visibility).toBe('hidden')
    expect(visibilityOf('/volume1', scope).visibility).toBe('ancestor')
    expect(visibilityOf('/', scope).visibility).toBe('ancestor')
    expect(visibilityOf('/volume1/电影', scope).visibility).toBe('hidden')
    // 按段比较：/home2 不在 /home 之下
    expect(visibilityOf('/home2', scope).visibility).toBe('hidden')
  })

  it('整个放行目录都被排除时，它的上级也不再露出', () => {
    expect(visibilityOf('/volume1', { include: ['/volume1/a'], exclude: ['/volume1/a'] }).visibility).toBe('hidden')
  })

  it('排除规则支持单段通配：/volume1/@* 挡掉所有 @ 目录（含以后新建的）', () => {
    expect(excludeMatches('/volume1/@appstore', '/volume1/@*')).toBe(true)
    expect(excludeMatches('/volume1/@appstore/x', '/volume1/@*')).toBe(true)
    expect(excludeMatches('/volume1/照片', '/volume1/@*')).toBe(false)
    expect(excludeMatches('/volume1', '/volume1/@*')).toBe(false) // 规则比路径长，不匹配
    // 通配不跨段
    expect(excludeMatches('/volume1/a/b', '/volume1/*')).toBe(true)
    expect(excludeMatches('/volume1/a/c', '/volume1/a/*')).toBe(true)
    expect(excludeMatches('/volume1/b/c', '/volume1/a/*')).toBe(false) // 字面段必须对上
    // 无通配的规则仍按前缀（字面），行为与以前一致
    expect(excludeMatches('/volume1/lost+found', '/volume1/lost+found')).toBe(true)
    expect(excludeMatches('/volume1/lost+found/x', '/volume1/lost+found')).toBe(true)
    // 目录名里的正则元字符不该被当元字符
    expect(excludeMatches('/volume1/lost1found', '/volume1/lost+found')).toBe(false)

    const scope = { include: ['/volume1'], exclude: ['/volume1/@*', '/volume1/.fscrypt', '/volume1/lost+found'] }
    expect(visibilityOf('/volume1/@appstore', scope).visibility).toBe('hidden')
    expect(visibilityOf('/volume1/@appstore/foo', scope).visibility).toBe('hidden')
    expect(visibilityOf('/volume1/照片', scope).visibility).toBe('full')
  })

  it('写：只读全拒；范围外拒；放行目录本身不能删或移走', () => {
    expect(writeDenial('/home/a.txt', scope, true, 'PUT')).toMatch(/只读/)
    expect(writeDenial('/volume1/x', scope, false, 'PUT')).toMatch(/范围/)
    expect(writeDenial('/home', scope, false, 'DELETE')).toMatch(/放行目录本身/)
    expect(writeDenial('/home/a.txt', scope, false, 'DELETE')).toBeUndefined()
  })
})

describe('parseMultistatus', () => {
  it('认不同命名空间前缀、绝对 URL href、编码过的中文', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>http://x/volume1/%E7%85%A7%E7%89%87/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/volume1/a%20b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Tue, 13 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`
    const entries = parseMultistatus(xml)
    expect(entries).toMatchObject([
      { path: '/volume1/照片', name: '照片', isDir: true },
      { path: '/volume1/a b.txt', name: 'a b.txt', isDir: false, size: 12 },
    ])
    expect(entries[1]!.modified).toBe(Date.parse('Tue, 13 Oct 2026 10:00:00 GMT'))
  })

  it('编码路径：按段编码，保留斜杠', () => {
    expect(encodeDavPath('/volume1/照片 #1')).toBe('/volume1/%E7%85%A7%E7%89%87%20%231')
  })
})

describe('DavClient（对着 x/net/webdav 行为的假服务器）', () => {
  let dav: FakeWebdav
  let client: DavClient
  beforeEach(async () => {
    dav = await new FakeWebdav().start()
    dav.file('/volume1/docs/readme.txt', 'hello').mkdirp('/volume1/照片')
    client = new DavClient({ endpoint: async () => dav.url })
  })
  afterEach(() => dav.stop())

  it('列目录：目录排前、不含自己', async () => {
    dav.file('/volume1/z.txt', 'z')
    // 目录在前；同类按 zh-CN 排序（中文在拉丁字母前，这是 ICU 的 zh 排序规则）
    expect((await client.list('/volume1')).map((e) => e.name)).toEqual(['照片', 'docs', 'z.txt'])
  })

  it('建目录、上传、下载、改名、复制、删除', async () => {
    await client.mkdir('/volume1/新建')
    const content = Buffer.from('上传的内容')
    await client.upload('/volume1/新建/a.txt', Readable.from([content]), content.length)
    const sink = new PassThrough()
    const got: Buffer[] = []
    sink.on('data', (c: Buffer) => got.push(c))
    await client.download('/volume1/新建/a.txt', sink)
    expect(Buffer.concat(got).toString()).toBe('上传的内容')

    await client.move('/volume1/新建/a.txt', '/volume1/新建/b.txt')
    await client.copy('/volume1/新建/b.txt', '/volume1/docs/b.txt')
    expect((await client.list('/volume1/新建')).map((e) => e.name)).toEqual(['b.txt'])
    expect(await client.stat('/volume1/docs/b.txt')).toMatchObject({ size: content.length })

    await client.remove('/volume1/新建')
    expect(await client.stat('/volume1/新建')).toBeUndefined()
  })

  it('Destination 只发路径（发了 host 上游会因 Host 不符报 502）', async () => {
    await client.move('/volume1/docs/readme.txt', '/volume1/docs/r.txt')
    const move = dav.requests.find((r) => r.method === 'MOVE')!
    expect(move.destination).toBe('/volume1/docs/r.txt')
  })

  it('改名撞上同名文件：报「已存在」，不覆盖', async () => {
    dav.file('/volume1/docs/r.txt', 'old')
    await expect(client.move('/volume1/docs/readme.txt', '/volume1/docs/r.txt')).rejects.toThrow(/已存在/)
    expect(dav.nodes.get('/volume1/docs/r.txt')!.data.toString()).toBe('old')
  })
})

describe('DavServer：范围裁剪', () => {
  let dav: FakeWebdav
  let server: DavServer
  let base: string
  const settings = (patch: Partial<DavServerSettings> = {}): DavServerSettings => ({
    ...davServerDefaults,
    port: 0,
    include: ['/volume1/docs', '/home'],
    exclude: ['/volume1/docs/secret'],
    ...patch,
  })

  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(base)
      const req = http.request({ hostname: url.hostname, port: url.port, method, path: encodeDavPath(path), headers }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      })
      req.on('error', reject)
      req.end(body)
    })

  beforeEach(async () => {
    dav = await new FakeWebdav().start()
    dav.file('/volume1/docs/a.txt', 'A').file('/volume1/docs/secret/s.txt', 'S').file('/volume1/movies/m.mkv', 'M').mkdirp('/home/u')
    server = new DavServer({ settings: settings(), upstream: async () => dav.url })
    await server.start()
    base = server.status().url
  })
  afterEach(async () => {
    await server.close()
    await dav.stop()
  })

  it('根目录只露出通往放行目录的那一支', async () => {
    const root = parseMultistatus((await send('PROPFIND', '/', { depth: '1' })).body).map((e) => e.path)
    expect(root.sort()).toEqual(['/', '/home', '/volume1'])
    const v1 = parseMultistatus((await send('PROPFIND', '/volume1', { depth: '1' })).body).map((e) => e.path)
    expect(v1.sort()).toEqual(['/volume1', '/volume1/docs'])
    const docs = parseMultistatus((await send('PROPFIND', '/volume1/docs', { depth: '1' })).body).map((e) => e.path)
    expect(docs.sort()).toEqual(['/volume1/docs', '/volume1/docs/a.txt'])
  })

  it('范围外直连也进不去：404；路过的上级不能 GET（目录页会绕开过滤）', async () => {
    expect((await send('GET', '/volume1/movies/m.mkv')).status).toBe(404)
    expect((await send('PROPFIND', '/volume1/docs/secret', { depth: '1' })).status).toBe(404)
    expect((await send('GET', '/volume1')).status).toBe(403)
    expect((await send('GET', '/volume1/docs/a.txt')).body).toBe('A')
  })

  it('范围内能写；往范围外 MOVE / COPY 被拒；上游收到的 Destination 是路径', async () => {
    expect((await send('PUT', '/home/u/n.txt', {}, 'N')).status).toBe(201)
    expect((await send('MOVE', '/home/u/n.txt', { destination: `${base}volume1/movies/n.txt` })).status).toBe(403)
    expect((await send('MOVE', '/home/u/n.txt', { destination: `${base}home/u/m.txt` })).status).toBe(201)
    expect(dav.requests.find((r) => r.method === 'MOVE')!.destination).toBe('/home/u/m.txt')
    expect(dav.nodes.has('/home/u/m.txt')).toBe(true)
  })

  it('只读、改范围即时生效', async () => {
    await server.apply({ ...server.current(), readOnly: true })
    expect((await send('PUT', '/home/u/x.txt', {}, 'x')).status).toBe(403)
    await server.apply({ ...server.current(), readOnly: false, include: ['/volume1'], exclude: [] })
    expect((await send('GET', '/volume1/movies/m.mkv')).body).toBe('M')
    expect((await send('PROPFIND', '/home', { depth: '0' })).status).toBe(404)
  })

  it('上游不可用：503 并说明原因', async () => {
    const down = new DavServer({ settings: settings(), upstream: async () => { throw new Error('服务端清单里没有「webdav」服务') } })
    await down.start()
    const prev = base
    base = down.status().url
    const res = await send('PROPFIND', '/', { depth: '0' })
    base = prev
    await down.close()
    expect(res.status).toBe(503)
    expect(res.body).toContain('webdav')
    expect(down.status().upstreamError).toContain('webdav')
  })

  it('Host 不是回环地址（DNS 重绑定）一律拒绝', async () => {
    expect((await send('GET', '/volume1/docs/a.txt', { host: 'evil.example:18006' })).status).toBe(403)
    expect((await send('GET', '/volume1/docs/a.txt', { host: 'localhost:18006' })).body).toBe('A')
    expect(isLoopbackHost('[::1]:18006')).toBe(true)
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false)
  })

  it('filterMultistatus 整块剔除，不留空壳', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/volume1/movies/</D:href></D:response><D:response><D:href>/volume1/docs/</D:href></D:response></D:multistatus>`
    const out = filterMultistatus(xml, { include: ['/volume1/docs'], exclude: [] })
    expect(out).not.toContain('movies')
    expect(out).toContain('/volume1/docs/')
  })
})


describe('handleDavRequest：网关路径前缀（/webdav）', () => {
  let dav: FakeWebdav
  let gateway: http.Server
  let base: string

  /** 照 kura-server 的做法：先把前缀从 req.url 剥掉，再把前缀当参数交给内置处理器。 */
  const startGateway = async (hrefBase: string): Promise<void> => {
    gateway = http.createServer((req, res) => {
      const url = req.url ?? '/'
      req.url = url === hrefBase ? '/' : url.slice(hrefBase.length) || '/'
      void handleDavRequest(req, res, {
        limits: () => ({ include: ['/'], exclude: [], readOnly: false }),
        upstream: async () => dav.url,
        hrefBase,
      })
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/webdav`
  }

  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(base)
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          method,
          path: encodeDavPath(path),
          headers,
        },
        (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
        },
      )
      req.on('error', reject)
      req.end(body)
    })

  beforeEach(async () => {
    dav = await new FakeWebdav().start()
    dav.mkdirp('/home/u').file('/home/u/a.txt', 'A')
    await startGateway('/webdav')
  })
  afterEach(async () => {
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await dav.stop()
  })

  it('列表 href 补上网关前缀：客户端按 href 拼下一跳能落在入口上', async () => {
    const res = await send('PROPFIND', '/webdav/home/u', { depth: '1' })
    expect(res.status).toBe(207)
    // 上游给的是 /home/u/a.txt，客户端看到必须是 /webdav/home/u/a.txt
    expect(res.body).toContain('<D:href>/webdav/home/u/')
    expect(res.body).toContain('<D:href>/webdav/home/u/a.txt')
    expect(res.body).not.toContain('<D:href>/home/')
    const paths = parseMultistatus(res.body).map((e) => e.path)
    expect(paths.sort()).toEqual(['/webdav/home/u', '/webdav/home/u/a.txt'])
    // 客户端用 new URL(href, 入口) 拼下一跳时必须真的能取到
    const viaHref = new URL('/webdav/home/u/a.txt', base).toString()
    expect(viaHref).toBe(`${base}/home/u/a.txt`)
    expect((await send('GET', '/webdav/home/u/a.txt')).body).toBe('A')
  })

  it('MOVE 的 Destination 带着前缀也照样能对上（剥掉前缀再转发）', async () => {
    const res = await send('MOVE', '/webdav/home/u/a.txt', { destination: `${base}/home/u/b.txt` })
    expect(res.status).toBe(201)
    expect(dav.requests.find((r) => r.method === 'MOVE')!.destination).toBe('/home/u/b.txt')
    expect(dav.nodes.has('/home/u/b.txt')).toBe(true)
  })

  it('stripHrefBase / rewriteHrefBase 各管一个方向', () => {
    expect(stripHrefBase('/webdav/home/u/a.txt', '/webdav')).toBe('/home/u/a.txt')
    expect(stripHrefBase('/webdav', '/webdav')).toBe('/')
    expect(stripHrefBase('/other/x', '/webdav')).toBe('/other/x')
    expect(stripHrefBase('/home/u', '')).toBe('/home/u')

    const xml = '<D:response><D:href>/volume1/x/</D:href></D:response>'
    expect(rewriteHrefBase(xml, '/webdav')).toContain('<D:href>/webdav/volume1/x/</D:href>')
    // 没有前缀、或已经带前缀时不动
    expect(rewriteHrefBase(xml, '')).toBe(xml)
    expect(rewriteHrefBase('<d:href>/webdav/a</d:href>', '/webdav')).toBe('<d:href>/webdav/a</d:href>')
    // 绝对 URL 原样保留
    expect(rewriteHrefBase('<d:href>http://nas/a</d:href>', '/webdav')).toBe('<d:href>http://nas/a</d:href>')
  })
})
