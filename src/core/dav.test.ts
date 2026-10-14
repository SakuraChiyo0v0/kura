import http from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DavClient, encodeDavPath, parseMultistatus } from './dav-client.js'
import { normalizeDavPath, normalizeRules, visibilityOf, writeDenial } from './dav-scope.js'
import { DavServer, davServerDefaults, filterMultistatus, isLoopbackHost, type DavServerSettings } from './dav-server.js'
import { FakeWebdav } from './testing/fake-webdav.js'

describe('dav-scope', () => {
  const scope = { include: ['/volume1/照片', '/home'], exclude: ['/volume1/照片/私密'] }

  it('规范化：去多余斜杠、拒绝 . 与 ..', () => {
    expect(normalizeDavPath('volume1//照片/')).toBe('/volume1/照片')
    expect(normalizeDavPath('\\a\\b')).toBe('/a/b')
    expect(() => normalizeDavPath('/volume1/../etc')).toThrow(/\.\./)
    expect(normalizeRules(['/b/', 'b', '/a'])).toEqual(['/a', '/b'])
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
