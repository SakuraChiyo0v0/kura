import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HttpRequester } from './http.js'
import { request as realRequest } from './http.js'
import { Mirror, discoveryGroup, type ConnectionConfig } from './mirror.js'
import { FakeUgreen } from './testing/fake-ugreen.js'

/**
 * Mirror 总装测试。外网域名（*.ug.link / *.ugdocker.link）在测试里连不上，
 * 所以注入一个 requester：凡是发往这些域名的请求都改拨假绿联，Host 照原样带上 ——
 * 这样走的仍是真实的 URL 推导与 Host 逻辑，只是落点换成本地。
 */
let fake: FakeUgreen
let dataDir: string
let mirror: Mirror | undefined

beforeEach(async () => {
  fake = await new FakeUgreen().start()
  dataDir = mkdtempSync(join(tmpdir(), 'kura-mirror-'))
})
afterEach(async () => {
  await mirror?.stop()
  mirror = undefined
  await fake.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

function redirectRequester(): HttpRequester {
  return (req) => {
    const url = new URL(req.url)
    if (url.hostname.endsWith('.ug.link') || url.hostname.endsWith('.ugdocker.link')) {
      const local = new URL(fake.url)
      return realRequest({ ...req, url: `${local.origin}${url.pathname}${url.search}`, host: req.host ?? url.host })
    }
    return realRequest(req)
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    base: 'https://dev-1.cn30.ug.link',
    ugreenUser: 'u',
    ugreenPassword: 'p',
    lanHost: '',
    mode: 'wan',
    gatewayPort: 8897,
    gatewayUser: 'gw',
    gatewayPassword: 'pw',
    ...overrides,
  }
}

function newMirror(overrides: Partial<ConnectionConfig> = {}) {
  mirror = new Mirror({
    config: config(overrides),
    dataDir,
    request: redirectRequester(),
    probeIntervalMs: 0,
  })
  return mirror
}

describe('Mirror：服务端清单', () => {
  it('拉清单 → 挂服务并真的开始监听；端口按发布情况选；落缓存', async () => {
    const [unpub, pubH] = [await freePort(), await freePort()]
    fake.servicesBody = JSON.stringify({
      services: [
        { name: 'navidrome', container_port: unpub, host_port: 0, published: false },
        { name: 'bili23-web', container_port: 8787, host_port: pubH, published: true },
      ],
    })
    const m = newMirror()
    expect(await m.syncNow()).toBe(2)
    const snap = m.snapshot()
    const nav = snap.services.find((s) => s.key === 'navidrome')!
    const bili = snap.services.find((s) => s.key === 'bili23-web')!
    expect(nav.spec.port).toBe(unpub)
    expect(bili.spec.port).toBe(pubH)
    expect(nav.spec.group).toBe(discoveryGroup)
    expect(nav.listener.running).toBe(true)
    expect(snap.discovery).toMatchObject({ entries: 2, added: 2, lastError: '' })
    expect(JSON.parse(readFileSync(join(dataDir, 'discovered.json'), 'utf8')).services).toHaveLength(2)

    // 第二轮：已挂上的不动，不再算新增
    expect(await m.syncNow()).toBe(0)
  })

  it('用户手动关掉的服务不会被下一轮同步重新打开，且重启后仍是关的', async () => {
    const port = await freePort()
    fake.servicesBody = JSON.stringify({ services: [{ name: 'navidrome', container_port: port }] })
    const m = newMirror()
    await m.syncNow()
    await m.setServiceEnabled('navidrome', false)
    await m.syncNow()
    expect(m.snapshot().services[0]!.listener.running).toBe(false)
    await m.stop()

    const again = newMirror()
    await again.syncNow()
    expect(again.snapshot().services[0]!.listener).toMatchObject({ enabled: false, running: false })
  })

  it('挂不上的记进 skipped，不影响其它服务', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busy = (blocker.address() as AddressInfo).port
    const free = await freePort()
    fake.servicesBody = JSON.stringify({
      services: [
        { name: 'a', container_port: busy },
        { name: 'b', container_port: free },
        { name: 'bad', container_port: 0 },
      ],
    })
    const m = newMirror()
    await m.syncNow()
    const snap = m.snapshot()
    expect(snap.discovery.skipped).toEqual([expect.stringContaining('bad')])
    // 端口被占不算「跳过」：挂上了，只是没在监听（界面要显示原因）
    expect(snap.services.find((s) => s.key === 'a')!.listener).toMatchObject({ enabled: true, running: false })
    expect(snap.services.find((s) => s.key === 'b')!.listener.running).toBe(true)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  it('拉不到清单：只记错误、不动已挂上的；新实例靠缓存兜底', async () => {
    const port = await freePort()
    fake.servicesBody = JSON.stringify({ services: [{ name: 'navidrome', container_port: port }] })
    const m = newMirror()
    await m.syncNow()
    fake.servicesBody = 'not json'
    await expect(m.syncNow()).rejects.toThrow()
    expect(m.snapshot().discovery.lastError).not.toBe('')
    expect(m.snapshot().services).toHaveLength(1)
    await m.stop()

    const fresh = newMirror({ gatewayPassword: '' }) // 连网关都登不上
    await fresh.start()
    expect(fresh.snapshot().services.map((s) => s.key)).toEqual(['navidrome'])
  })
})

describe('Mirror：端到端', () => {
  it('本机端口 → 反代 → 网关，带上两层 cookie 与分流头', async () => {
    let seen: { service?: string; cookie?: string; host?: string } = {}
    const upstreamFake = http.createServer((req, res) => {
      seen = { service: req.headers['x-nas-service'] as string, cookie: req.headers.cookie, host: req.headers.host }
      res.end('hello from nas')
    })
    await new Promise<void>((resolve) => upstreamFake.listen(0, '127.0.0.1', resolve))
    const upstreamUrl = `http://127.0.0.1:${(upstreamFake.address() as AddressInfo).port}`

    const local = await freePort()
    mirror = new Mirror({
      config: config(),
      dataDir,
      request: redirectRequester(),
      probeIntervalMs: 0,
      discover: false,
      localServices: [{ port: local, service: 'nas-console', label: 'nas-console', source: 'local' }],
    })
    // 反代用的是真实 node:http，连不到 *.ugdocker.link：把路由指到本地上游，其余逻辑照旧
    const realRoute = mirror.router.route.bind(mirror.router)
    mirror.router.route = (svc) => ({ ...realRoute(svc), upstream: upstreamUrl })
    await mirror.start()

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${local}/`, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve(text))
        })
        .on('error', reject)
    })
    expect(body).toBe('hello from nas')
    expect(seen.service).toBe('nas-console')
    expect(seen.cookie).toContain('ugreen-proxy-token=COOKIE-8897')
    expect(seen.cookie).toContain('authelia_session=SSO-SESSION')
    expect(mirror.snapshot().services[0]!.stats.requests).toBe(1)
    await new Promise<void>((resolve) => upstreamFake.close(() => resolve()))
  })

  it('改本机端口：生效、落盘，重启后沿用', async () => {
    const [a, b] = [await freePort(), await freePort()]
    fake.servicesBody = JSON.stringify({ services: [{ name: 'svc', container_port: a }] })
    const m = newMirror()
    await m.syncNow()
    await m.setServicePort('svc', b)
    expect(m.snapshot().services[0]!.listener).toMatchObject({ port: b, running: true })
    await m.stop()

    const again = newMirror()
    await again.syncNow()
    expect(again.snapshot().services[0]!.listener.port).toBe(b)
  })

  it('外链按设备域推导', async () => {
    const port = await freePort()
    fake.servicesBody = JSON.stringify({ services: [{ name: 'svc', container_port: port }] })
    const m = newMirror()
    await m.syncNow()
    expect(m.snapshot().services[0]!.externalUrl).toBe(`https://app-${port}-dev-1.cn30.ugdocker.link`)
  })
})
