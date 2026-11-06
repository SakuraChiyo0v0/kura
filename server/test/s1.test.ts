import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as realRequest, type HttpRequester } from '../../src/core/http.js'
import { Mirror } from '../../src/core/mirror.js'
import { FakeUgreen } from '../../src/core/testing/fake-ugreen.js'
import { Registry, parseServices, type DockerContainer } from '../src/registry.js'
import { createKuraServer, stripCookies } from '../src/server.js'

/**
 * S1 判据：**现有客户端不改代码**就能连上 kura-server。
 * kura-server 自己**不做认证**（见 AGENTS.md）：这里验证未认证也能直接访问、凭据不再需要。
 * 仍然直接调用客户端自己的代码（Mirror）走一遍完整链路。
 */

describe('registry', () => {
  it('校验服务名与地址', () => {
    expect(parseServices('{"services":[{"name":"openlist","backend":"http://openlist:5244/x"}]}')).toEqual([
      { name: 'openlist', backend: 'http://openlist:5244', rewriteRedirect: false },
    ])
    expect(() => parseServices('{"services":[{"name":"API","backend":"http://a"}]}')).toThrow(/服务名/)
    expect(() => parseServices('{"services":[{"name":"a","backend":"file:///etc"}]}')).toThrow(/http/)
    expect(() => parseServices('{"services":[{"name":"a","backend":"http://a"},{"name":"a","backend":"http://b"}]}')).toThrow(/重复/)
  })

  it('坏文件保留上一份，不让所有应用一起 404', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kura-reg-'))
    const file = join(dir, 's.json')
    writeFileSync(file, '{"services":[{"name":"a","backend":"http://a:1"}]}')
    const reg = new Registry(file, {})
    writeFileSync(file, '{oops')
    reg.reload()
    expect(reg.list().map((s) => s.name)).toEqual(['a'])
    expect(reg.error()).not.toBe('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('有 Docker 时名单来自正在运行的容器；文件里多出来的名字不出现，改写跳转还在', async () => {
    const containers: DockerContainer[] = [
      { Names: ['/kura-server'], Ports: [{ PrivatePort: 8080, PublicPort: 8898, Type: 'tcp', IP: '0.0.0.0' }], NetworkSettings: { Networks: { 'sso-net': { Gateway: '172.25.0.1' }, 'kura-internal': {} } } },
      { Names: ['/kura-shell'], Ports: [{ PrivatePort: 8890, Type: 'tcp' }], NetworkSettings: { Networks: { 'kura-internal': {} } } },
      // 同一网络、端口发布了：后端用容器名，宿主端口另记
      { Names: ['/hermes'], Ports: [{ PrivatePort: 9119, PublicPort: 9119, Type: 'tcp', IP: '0.0.0.0' }, { PrivatePort: 9119, PublicPort: 9119, Type: 'tcp', IP: '::' }], NetworkSettings: { Networks: { 'sso-net': { Gateway: '172.25.0.1' } } } },
      // 同一网络、没发布：照样登记，走容器 DNS
      { Names: ['/navidrome'], Ports: [{ PrivatePort: 4533, Type: 'tcp' }], NetworkSettings: { Networks: { 'sso-net': { Gateway: '172.25.0.1' } } } },
      // 不在同一网络、发布到了非回环：后端用网关地址 + 宿主端口
      { Names: ['/nginx'], Ports: [{ PrivatePort: 80, PublicPort: 8730, Type: 'tcp', IP: '0.0.0.0' }], NetworkSettings: { Networks: { bridge: { Gateway: '172.17.0.1' } } } },
      // 只绑回环，又不在同一网络：不登记
      { Names: ['/mihomo'], Ports: [{ PrivatePort: 9090, PublicPort: 9090, Type: 'tcp', IP: '127.0.0.1' }], NetworkSettings: { Networks: { 'proxy-net': { Gateway: '172.19.0.1' } } } },
      // 没发布、也不在同一网络（数据库这种）：不登记
      { Names: ['/postgres'], Ports: [{ PrivatePort: 5432, Type: 'tcp' }], NetworkSettings: { Networks: { 'proxy-net': { Gateway: '172.19.0.1' } } } },
      // 下划线收成连字符，后端仍用容器原名
      { Names: ['/my_site'], Ports: [{ PrivatePort: 8080, Type: 'tcp' }], NetworkSettings: { Networks: { 'sso-net': {} } } },
    ]
    const reg = new Registry(undefined, { webdav: 18005, 'nas-console': 8890 }, async () => containers)
    reg.set([
      { name: 'hermes', backend: 'http://hermes:9119', rewriteRedirect: true },
      { name: 'astrahub', backend: 'http://astrahub:4310' },
    ])
    expect(await reg.entries()).toEqual([
      { name: 'webdav', container_port: 18005, host_port: 0, published: false },
      { name: 'nas-console', container_port: 8890, host_port: 0, published: false },
      { name: 'hermes', container_port: 9119, host_port: 9119, published: true },
      { name: 'my-site', container_port: 8080, host_port: 0, published: false },
      { name: 'navidrome', container_port: 4533, host_port: 0, published: false },
      { name: 'nginx', container_port: 8730, host_port: 8730, published: true },
    ])
    expect(reg.find('hermes')).toEqual({ name: 'hermes', backend: 'http://hermes:9119', rewriteRedirect: true })
    expect(reg.find('nginx')?.backend).toBe('http://172.17.0.1:8730')
    expect(reg.find('my-site')?.backend).toBe('http://my_site:8080')
    expect(reg.find('astrahub')).toBeUndefined()
    expect(reg.find('kura-server')).toBeUndefined()
  })

  it('docker 暂时不可用时沿用上一份，不把文件里的幽灵又请回来', async () => {
    let up = true
    const reg = new Registry(undefined, {}, async () =>
      up
        ? [{ Names: ['/nginx'], Ports: [{ PrivatePort: 80, PublicPort: 8730, Type: 'tcp', IP: '0.0.0.0' }], NetworkSettings: { Networks: { bridge: { Gateway: '172.17.0.1' } } } }]
        : null,
    )
    reg.set([{ name: 'astrahub', backend: 'http://astrahub:4310' }])
    expect((await reg.entries()).map((entry) => entry.name)).toEqual(['nginx'])
    up = false
    expect((await reg.entries()).map((entry) => entry.name)).toEqual(['nginx'])
  })

  it('还从没扫成过、docker 又不可用：退回文件里的名单', async () => {
    const reg = new Registry(undefined, { webdav: 1 }, async () => null)
    reg.set([{ name: 'navidrome', backend: 'http://navidrome:4533' }])
    expect((await reg.entries()).map((entry) => entry.name)).toEqual(['webdav', 'navidrome'])
  })

  it('一个容器发布多个端口：仍是多条兼容入口，但共享容器和完整 ports 列表', async () => {
    const id = 'a'.repeat(64)
    const reg = new Registry(undefined, {}, async () => [
      {
        Id: id,
        Names: ['/snowluma'],
        Ports: [
          { PrivatePort: 3000, PublicPort: 3000, Type: 'tcp', IP: '0.0.0.0' },
          { PrivatePort: 3001, PublicPort: 3001, Type: 'tcp', IP: '0.0.0.0' },
          { PrivatePort: 5099, PublicPort: 5099, Type: 'tcp', IP: '0.0.0.0' },
          { PrivatePort: 5900, Type: 'tcp' },
        ],
        NetworkSettings: { Networks: { bridge: { Gateway: '172.17.0.1' } } },
      },
    ])
    const entries = await reg.entries()
    const ports = [
      { name: 'snowluma-3000', container_port: 3000, host_port: 3000, published: true },
      { name: 'snowluma-3001', container_port: 3001, host_port: 3001, published: true },
      { name: 'snowluma-5099', container_port: 5099, host_port: 5099, published: true },
    ]
    expect(entries).toEqual(ports.map((entry) => ({ ...entry, container: 'snowluma', container_id: id, ports })))
    // 旧客户端读顶部字段仍然拿到入口名、容器端口 / 宿主端口和发布状态。
    expect(entries.map(({ name, container_port, host_port, published }) => ({ name, container_port, host_port, published }))).toEqual(ports)
  })

  it('转发给应用时去掉绿联令牌与旧客户端残留的网关会话，保留应用自己的 cookie', () => {
    expect(stripCookies('authelia_session=S; app=1; ugreen-proxy-token=U; authelia_session_x=S2; other=2')).toBe('app=1; other=2')
  })
})

// ---------------------------------------------------------------- 起一个真的 kura-server

let server: http.Server
let base: string
let app: http.Server
let appUrl: string
/** 第二个应用：清单里服务按容器端口映射到本机，两个服务不能共用一个后端端口 */
let app2: http.Server
let app2Url: string
let seen: Array<{ url: string; headers: http.IncomingHttpHeaders }>
let registry: Registry
/** 内置 webdav 处理器看到的请求（验证路径前缀被剥掉） */
let builtinSeen: Array<{ url: string; path: string }>

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

beforeEach(async () => {
  seen = []
  app = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    if (req.url?.startsWith('/login-redirect')) {
      res.writeHead(302, { location: 'http://hermes.internal/login' })
      return res.end()
    }
    res.setHeader('set-cookie', 'app_session=A; Path=/')
    res.end(`app saw ${req.url}`)
  })
  const wss = new WebSocketServer({ server: app })
  wss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d.toString()}`)))
  appUrl = await listen(app)
  app2 = http.createServer((req, res) => {
    if (req.url?.startsWith('/login-redirect')) {
      res.writeHead(302, { location: 'http://hermes.internal/login' })
      return res.end()
    }
    res.end('hermes')
  })
  app2Url = await listen(app2)
  registry = new Registry(undefined, { webdav: 18005, 'nas-console': 8890 })
  registry.set([
    { name: 'openlist', backend: appUrl },
    { name: 'hermes', backend: app2Url, rewriteRedirect: true },
  ])
  // 假的内置 webdav 处理器：只回显它看到的路径，验证前缀剥掉了
  builtinSeen = []
  server = createKuraServer({
    registry,
    admin: {
      handle: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<h1>管理页</h1>')
      },
    },
    builtins: {
      webdav: {
        request: (req, res, path) => {
          builtinSeen.push({ url: req.url ?? '', path })
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(`builtin saw ${req.url}`)
        },
      },
    },
  })
  base = await listen(server)
})

afterEach(async () => {
  for (const s of [server, app, app2]) {
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, { headers }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      .on('error', reject)
  })
}

describe('kura-server：不做认证，客户端也不需要凭据', () => {
  it('不需要登录：清单、受保护路径、管理页都直接可达', async () => {
    const svc = await get('/__services')
    expect(svc.status).toBe(200)
    expect(JSON.parse(svc.body).services.map((s: { name: string }) => s.name)).toContain('openlist')
    expect((await get('/openlist/')).status).toBe(200)
    expect((await get('/api/health')).status).toBe(200)
    expect((await get('/_kura/')).status).toBe(200)
  })

  it('旧客户端先登录也不碍事：/api/firstfactor 回 200 OK + 占位 cookie', async () => {
    const res = await new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
      const req = http.request(`${base}/api/firstfactor`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
        let body = ''
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body, cookies: r.headers['set-cookie'] ?? [] }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ username: 'anything', password: 'whatever' }))
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).status).toBe('OK')
    // 这个 cookie 不是认证，是给旧客户端看的：它按 authelia 前缀收集 set-cookie，
    // 一个都没收到就直接抛错。删了它，老版本客户端会在换镜像那一刻全面失联。
    expect(res.cookies.some((c) => c.startsWith('authelia_session='))).toBe(true)
  })

  it('X-Nas-Service 分流；路径前缀剥掉；应用看不到绿联令牌', async () => {
    const viaHeader = await get('/some/path?q=1', { cookie: 'ugreen-proxy-token=U; mine=1', 'x-nas-service': 'openlist' })
    expect(viaHeader.body).toBe('app saw /some/path?q=1')
    expect(seen[0]!.headers.cookie).toBe('mine=1')
    expect(seen[0]!.headers['remote-user']).toBe('kura')
    expect(seen[0]!.headers['x-nas-service']).toBeUndefined()
    // 应用自己的 Set-Cookie 原样透传
    expect(viaHeader.headers['set-cookie']).toEqual(['app_session=A; Path=/'])

    const viaPath = await get('/openlist/a/b')
    expect(viaPath.body).toBe('app saw /a/b')
  })

  it('路径白名单：门户路径不会被当成服务名；不认识的 X-Nas-Service 当门户请求', async () => {
    expect((await get('/api/whatever')).status).toBe(404)
    expect((await get('/nope/', { 'x-nas-service': 'nope' })).status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('绝对路径跳转：配置了 rewriteRedirect 的服务在路径前缀模式下加回前缀', async () => {
    const res = await get('/hermes/login-redirect')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/hermes/login')
  })

  it('内置服务（webdav）：走路径前缀时把 /webdav 剥掉再交给处理器', async () => {
    const res = await get('/webdav/volume1/photo')
    expect(res.status).toBe(200)
    expect(res.body).toBe('builtin saw /volume1/photo')
    expect(builtinSeen.at(-1)).toMatchObject({ url: '/volume1/photo', path: '/volume1/photo' })
    // 头模式（X-Nas-Service: webdav）：路径原样
    const viaHeader = await get('/volume1/photo', { 'x-nas-service': 'webdav' })
    expect(viaHeader.body).toBe('builtin saw /volume1/photo')
  })

  it('WebSocket 透传（终端 / 应用的实时连接）', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'x-nas-service': 'openlist' } })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'))
      ws.on('message', (d) => resolve(d.toString()))
      ws.on('error', reject)
    })
    expect(reply).toBe('echo:hi')
    ws.close()
  })

  it('后端挂了：502 并说明是哪个服务', async () => {
    const dead = net.createServer()
    const deadUrl = await new Promise<string>((resolve) => dead.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(dead.address() as AddressInfo).port}`)))
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    registry.set([{ name: 'openlist', backend: deadUrl }])
    const res = await get('/x', { 'x-nas-service': 'openlist' })
    expect(res.status).toBe(502)
    expect(res.body).toContain('openlist')
  })
})

describe('kura-server：现有 Mirror（客户端映射核心）整条链路不改代码跑通', () => {
  let fake: FakeUgreen
  let dataDir: string
  let mirror: Mirror | undefined
  beforeEach(async () => {
    fake = await new FakeUgreen().start()
    dataDir = mkdtempSync(join(tmpdir(), 'kura-s1-mirror-'))
  })
  afterEach(async () => {
    await mirror?.stop()
    await fake.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('局域网模式：Mirror 拿 kura-server 当网关 —— 拉清单、挂服务、本机端口转发到应用（无需网关凭据）', async () => {
    // 局域网模式下 Mirror 直接拨 http://<lanHost>:<网关端口>，正好就是这台 kura-server
    const port = Number(new URL(base).port)
    const request: HttpRequester = (req) => {
      const url = new URL(req.url)
      // 绿联域（登录链）仍去假绿联；网关那一跳是真的 kura-server
      if (url.hostname.endsWith('.ug.link') || url.hostname.endsWith('.ugdocker.link')) {
        return realRequest({ ...req, url: `${fake.url}${url.pathname}${url.search}`, host: req.host ?? url.host })
      }
      return realRequest(req)
    }
    mirror = new Mirror({
      config: {
        base: 'https://dev-1.cn30.ug.link',
        ugreenUser: 'u',
        ugreenPassword: 'p',
        lanHost: '127.0.0.1',
        mode: 'lan',
        gatewayPort: port,
      },
      dataDir,
      request,
      probeIntervalMs: 0,
    })
    await mirror.start()
    // start() 在后台已经同步了一轮；再同步一次确保拿到最新清单（新增数可能是 0，看结果集）
    await mirror.syncNow()
    expect(mirror.snapshot().discovery.skipped).toEqual([])
    expect(mirror.snapshot().services.map((s) => s.key).sort()).toEqual(['hermes', 'nas-console', 'openlist', 'webdav'])
    expect(mirror.snapshot().phase).toBe('ready')
    // 假应用和客户端在同一台机器上：清单里的端口正被假应用自己占着，本机监听换一个空闲端口
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port
        probe.close(() => resolve(p))
      })
    })
    // 原端口被占的服务改端口后应当直接在新端口起来（不用再拨开关）
    await mirror.setServicePort('openlist', free)
    const local = mirror.snapshot().services.find((s) => s.key === 'openlist')!
    expect(local.listener.running).toBe(true)
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`${local.localUrl}/hello`, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve(text))
        })
        .on('error', reject)
    })
    expect(body).toBe('app saw /hello')
    expect(mirror.snapshot().auth.blocked).toBe(false)
  })
})
