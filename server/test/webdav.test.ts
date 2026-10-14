import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DavLimits } from '../../src/core/dav-server.js'
import { excludeMatches, visibilityOf } from '../../src/core/dav-scope.js'
import {
  WebdavFeature,
  defaultWebdavLimits,
  rcloneRelease,
  serveArgs,
  verifyRclone,
  webdavDefaults,
} from '../src/webdav.js'

const rcloneBin = process.env.KURA_RCLONE ?? 'rclone'
const haveRclone = spawnSync(rcloneBin, ['version'], { stdio: 'ignore' }).status === 0

describe('webdav 参数与校验', () => {
  it('只监听回环、跟随符号链接', () => {
    const args = serveArgs({ ...webdavDefaults, port: 18005, root: '/host' })
    expect(args).toEqual(['serve', 'webdav', '/host', '--addr', '127.0.0.1:18005', '-L', '--read-only=false'])
    expect(args.join(' ')).toContain('127.0.0.1:18005')
    expect(args.join(' ')).not.toContain('0.0.0.0')
  })

  it('默认范围与现网 files-admin 一致：放行 /volume1 与 /home，挡掉系统目录', () => {
    expect(defaultWebdavLimits.include).toEqual(['/volume1', '/home'])
    expect(defaultWebdavLimits.exclude).toEqual(['/volume1/@*', '/volume1/.fscrypt', '/volume1/lost+found'])
    // 语义自检（和客户端同一份 dav-scope）
    expect(visibilityOf('/volume1/照片', defaultWebdavLimits).visibility).toBe('full')
    expect(visibilityOf('/volume1/@appstore', defaultWebdavLimits).visibility).toBe('hidden')
    expect(visibilityOf('/volume1/.fscrypt', defaultWebdavLimits).visibility).toBe('hidden')
    expect(visibilityOf('/volume1/lost+found', defaultWebdavLimits).visibility).toBe('hidden')
    expect(visibilityOf('/etc', defaultWebdavLimits).visibility).toBe('hidden')
    expect(visibilityOf('/', defaultWebdavLimits).visibility).toBe('ancestor')
    // 通配只挡 @ 开头；普通目录不受影响
    expect(excludeMatches('/volume1/@eaDir', '/volume1/@*')).toBe(true)
    expect(excludeMatches('/volume1/docker', '/volume1/@*')).toBe(false)
  })

  it('rclone 校验：SHA256 对不上就拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kura-rclone-'))
    const fake = join(dir, 'rclone')
    writeFileSync(fake, 'not the real binary')
    await expect(verifyRclone(fake, rcloneRelease.sha256)).rejects.toThrow(/校验不通过/)
    await expect(verifyRclone(join(dir, 'nope'))).rejects.toThrow(/找不到/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('固定版本的 SHA256 是 64 位十六进制（镜像里照这个校验）', () => {
    expect(rcloneRelease.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rcloneRelease.url).toContain(rcloneRelease.version)
    expect(rcloneRelease.url).toContain('linux-amd64') // 服务端容器用 Linux 版
  })
})

/** 最小的 WebDAV 假后端：PROPFIND 回固定 multistatus，别的回 200。 */
function fakeBackend(multistatus: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if ((req.method ?? '').toUpperCase() === 'PROPFIND') {
        res.writeHead(207, { 'content-type': 'application/xml' })
        res.end(multistatus)
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/volume1/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/volume1/@appstore/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/volume1/photo/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** 把范围层的 handle 挂在临时 http 服务上（正常路径是 kura-server 的网关转进来）。 */
async function serveFeature(): Promise<{ feature: WebdavFeature; port: number; close: () => Promise<void> }> {
  const backend = await fakeBackend(multistatus)
  const feature = new WebdavFeature({
    settings: { ...webdavDefaults, port: backend.port },
    // 不真起 rclone：只留一个不死的子进程，好让 status() 有「在跑」的样子
    command: { bin: process.execPath, args: ['-e', 'setInterval(()=>{},1e9)'] },
  })
  feature.start()
  expect(await feature.ping()).toBe(true) // ping 打到假后端
  const front = http.createServer((req, res) => feature.handle(req, res))
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()))
  const port = (front.address() as { port: number }).port
  return {
    feature,
    port,
    close: async () => {
      front.close()
      feature.stop()
      backend.close()
    },
  }
}

describe('webdav 范围层（经网关，不起监听）', () => {
  let ctx: Awaited<ReturnType<typeof serveFeature>>
  let limits: DavLimits

  beforeAll(async () => {
    ctx = await serveFeature()
  })

  afterAll(async () => {
    await ctx.close()
  })

  it('PROPFIND 过滤掉隐藏项、保留可见项', async () => {
    const res = await request(ctx.port, 'PROPFIND', '/volume1', { depth: '1' })
    expect(res.status).toBe(207)
    expect(res.body).toContain('/volume1/photo')
    expect(res.body).not.toContain('@appstore')
  })

  it('隐藏路径 404；改成放行后同一个路径就通了 —— 不用重启 rclone', async () => {
    expect((await request(ctx.port, 'PROPFIND', '/etc')).status).toBe(404)
    limits = ctx.feature.limits()
    ctx.feature.setLimits({ include: ['/etc'], exclude: [], readOnly: false })
    expect((await request(ctx.port, 'PROPFIND', '/etc')).status).toBe(207)
    ctx.feature.setLimits(limits)
    expect((await request(ctx.port, 'PROPFIND', '/etc')).status).toBe(404)
  })

  it('只读时写被拒', async () => {
    ctx.feature.setLimits({ ...ctx.feature.limits(), readOnly: true })
    const res = await request(ctx.port, 'PUT', '/volume1/photo/x.txt', {}, 'hi')
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/只读/)
    ctx.feature.setLimits({ ...ctx.feature.limits(), readOnly: false })
  })
})

describe('webdav 上游不可用', () => {
  it('rclone 没在跑时回 503 并说明原因', async () => {
    const backend = await fakeBackend(multistatus)
    const feature = new WebdavFeature({
      settings: { ...webdavDefaults, port: backend.port },
      command: { bin: process.execPath, args: ['-e', 'setInterval(()=>{},1e9)'] },
    })
    feature.start()
    backend.close() // 上游没了
    const front = http.createServer((req, res) => feature.handle(req, res))
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()))
    const port = (front.address() as { port: number }).port
    const res = await request(port, 'PROPFIND', '/volume1')
    expect(res.status).toBe(503)
    front.close()
    feature.stop()
  })
})

describe.skipIf(!haveRclone)('webdav × 真 rclone', () => {
  let root = ''
  let feature: WebdavFeature
  let front: http.Server
  let port = 0

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'kura-host-'))
    mkdirSync(join(root, 'volume1', 'photo'), { recursive: true })
    writeFileSync(join(root, 'volume1', 'photo', 'a.txt'), 'hello')
    mkdirSync(join(root, 'volume1', '@appstore'), { recursive: true })

    const probe = await fakeBackend('')
    const backendPort = probe.port
    probe.close()

    feature = new WebdavFeature({ settings: { ...webdavDefaults, root, port: backendPort } })
    feature.start()
    for (let i = 0; i < 40 && !(await feature.ping()); i++) await new Promise((r) => setTimeout(r, 250))
    expect(await feature.ping()).toBe(true)

    front = http.createServer((req, res) => feature.handle(req, res))
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()))
    port = (front.address() as { port: number }).port
  }, 30_000)

  afterAll(() => {
    front?.close()
    feature?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('列 /volume1 只看到 photo；能读到文件内容', async () => {
    const list = await request(port, 'PROPFIND', '/volume1', { depth: '1' })
    expect(list.status).toBe(207)
    expect(list.body).toContain('/volume1/photo')
    expect(list.body).not.toContain('@appstore')

    const file = await request(port, 'GET', '/volume1/photo/a.txt')
    expect(file.status).toBe(200)
    expect(file.body).toBe('hello')
  })

  it('写：只读被拒；可写时 PUT 落地', async () => {
    feature.setLimits({ ...feature.limits(), readOnly: true })
    const denied = await request(port, 'PUT', '/volume1/photo/b.txt', {}, 'world')
    expect(denied.status).toBe(403)
    expect(existsSync(join(root, 'volume1', 'photo', 'b.txt'))).toBe(false)

    feature.setLimits({ ...feature.limits(), readOnly: false })
    const ok = await request(port, 'PUT', '/volume1/photo/b.txt', {}, 'world')
    expect(ok.status).toBeLessThan(300)
    expect(existsSync(join(root, 'volume1', 'photo', 'b.txt'))).toBe(true)
  })
})
