import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { autheliaLogin } from '../../src/core/authelia.js'
import { isAuthRejected } from '../../src/core/errors.js'
import { request as realRequest, type HttpRequester } from '../../src/core/http.js'
import { Mirror } from '../../src/core/mirror.js'
import { FakeUgreen } from '../../src/core/testing/fake-ugreen.js'
import { Auth, autheliaBanTime, sessionToken } from '../src/auth.js'
import { fingerprint, hashPassword, parseHash, verifyPassword } from '../src/password.js'
import { Registry, parseServices } from '../src/registry.js'
import { createKuraServer, stripCookies } from '../src/server.js'

/**
 * S1 判据（设计文档 §十二）：**现有客户端不改代码**就能连上 kura-server；
 * 302 / 401 / KO 的行为与现网 Authelia 一致。所以这里大量直接调用客户端自己的代码（autheliaLogin、Mirror）。
 */

let hash: string
beforeAll(async () => {
  // 测试里用低参数，免得每个用例都花 80ms 算哈希；真实参数另有一条用例覆盖
  hash = await hashPassword('s3cret', { memory: 1024, passes: 1, parallelism: 1 })
})

describe('password', () => {
  it('argon2id PHC：能验对、验错，指纹不泄露原文', async () => {
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/)
    expect(await verifyPassword('s3cret', hash)).toBe(true)
    expect(await verifyPassword('S3cret', hash)).toBe(false)
    expect(await verifyPassword('s3cret', 'garbage')).toBe(false)
    expect(fingerprint(hash)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('认 Authelia 生成的哈希（现网 .env 可以原样搬过来）', async () => {
    // RFC 9106 风格参数、标准 base64 无填充，Authelia `crypto hash generate argon2` 的输出形状
    const real = await hashPassword('pw', { memory: 65536, passes: 3, parallelism: 4 })
    expect(parseHash(real).params).toEqual({ memory: 65536, passes: 3, parallelism: 4 })
    expect(await verifyPassword('pw', real)).toBe(true)
  })

  it('拒绝离谱参数（防拖垮）', () => {
    expect(() => parseHash('$argon2id$v=19$m=99999999,t=3,p=4$AAAA$AAAA')).toThrow(/过大/)
  })
})

describe('Auth', () => {
  it('封禁：5 次失败封 10 分钟，文案带 Authelia 格式的时间，客户端能解析', async () => {
    let now = Date.parse('2026-10-14T15:04:05')
    const auth = new Auth({ user: 'u', passwordHash: hash, now: () => now })
    for (let i = 0; i < 5; i++) expect((await auth.login('1.2.3.4', { username: 'u', password: 'x' })).ok).toBe(false)
    const banned = await auth.login('1.2.3.4', { username: 'u', password: 's3cret' })
    expect(banned).toMatchObject({ ok: false, status: 401 })
    expect((banned as { message: string }).message).toMatch(/banned until \d{1,2}:\d{2}:\d{2}[AP]M on [A-Z][a-z]+ \d{1,2} \d{4}/)
    // 别的来源不受影响
    expect((await auth.login('5.6.7.8', { username: 'u', password: 's3cret' })).ok).toBe(true)
    now += 10 * 60_000 + 1
    expect((await auth.login('1.2.3.4', { username: 'u', password: 's3cret' })).ok).toBe(true)
    expect(autheliaBanTime(Date.parse('2026-10-14T00:05:06'))).toBe('12:05:06AM on Oct 14 2026')
  })

  it('会话：256 位随机、过期失效、滑动续期、落盘后重启仍有效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kura-auth-'))
    let now = 1_000_000
    const file = join(dir, 'sessions.json')
    const a = new Auth({ user: 'u', passwordHash: hash, sessionFile: file, ttlMs: 1000, now: () => now })
    const r = await a.login('x', { username: 'u', password: 's3cret', keepMeLoggedIn: true })
    if (!r.ok) throw new Error('login failed')
    expect(Buffer.from(r.token, 'base64url')).toHaveLength(32)
    expect(a.check(r.token)).toBe('u')
    now += 600 // 过半：续期
    expect(a.check(r.token)).toBe('u')
    now += 900 // 距最初登录 1500ms，但续期过 → 仍有效
    expect(a.check(r.token)).toBe('u')
    await new Promise((res) => setTimeout(res, 1_100)) // 等落盘
    const b = new Auth({ user: 'u', passwordHash: hash, sessionFile: file, ttlMs: 1000, now: () => now })
    expect(b.check(r.token)).toBe('u')
    now += 5_000
    expect(b.check(r.token)).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('cookie 名带 Authelia 的 _<hash> 后缀也认', () => {
    expect(sessionToken('a=1; authelia_session_ab12=TOKEN; b=2')).toBe('TOKEN')
    expect(sessionToken('authelia_session=T2')).toBe('T2')
    expect(sessionToken('other=1')).toBeUndefined()
  })
})

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

  it('清单：内置服务 + 配置服务；docker 里发布了的标 published', async () => {
    const reg = new Registry(undefined, { webdav: 18005, 'nas-console': 8890 }, async () => [
      { Names: ['/openlist'], Ports: [{ PrivatePort: 5244, PublicPort: 5244, Type: 'tcp' }] },
    ])
    reg.set([
      { name: 'openlist', backend: 'http://openlist:5244' },
      { name: 'hermes', backend: 'http://hermes:9119' },
    ])
    expect(await reg.entries()).toEqual([
      { name: 'webdav', container_port: 18005, host_port: 0, published: false },
      { name: 'nas-console', container_port: 8890, host_port: 0, published: false },
      { name: 'openlist', container_port: 5244, host_port: 5244, published: true },
      { name: 'hermes', container_port: 9119, host_port: 0, published: false },
    ])
  })

  it('转发给应用时去掉 kura 会话与绿联令牌，保留应用自己的 cookie', () => {
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
  server = createKuraServer({ auth: new Auth({ user: 'gw', passwordHash: hash }), registry })
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

describe('kura-server：用客户端自己的代码去连', () => {
  it('autheliaLogin 成功拿到 cookie；密码错抛 AuthRejectedError（客户端据此停止重试）', async () => {
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    expect(cookie).toMatch(/^authelia_session=[A-Za-z0-9_-]{43}$/)
    const error = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 'wrong' }).catch((e: unknown) => e)
    expect(isAuthRejected(error)).toBe(true)
  })

  it('未认证：程序拿 401、浏览器拿 302 去登录页；/__services 也必须先认证', async () => {
    expect((await get('/__services')).status).toBe(401)
    expect((await get('/openlist/')).status).toBe(401)
    const browser = await get('/openlist/', { accept: 'text/html' })
    expect(browser.status).toBe(302)
    expect(browser.headers.location).toMatch(/^\/_kura\/login\?rd=/)
  })

  it('X-Nas-Service 分流；路径前缀剥掉；应用看不到网关凭据但收到 Remote-User', async () => {
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    const viaHeader = await get('/some/path?q=1', { cookie: `${cookie}; ugreen-proxy-token=U; mine=1`, 'x-nas-service': 'openlist' })
    expect(viaHeader.body).toBe('app saw /some/path?q=1')
    expect(seen[0]!.headers.cookie).toBe('mine=1')
    expect(seen[0]!.headers['remote-user']).toBe('gw')
    expect(seen[0]!.headers['x-nas-service']).toBeUndefined()
    // 应用自己的 Set-Cookie 原样透传
    expect(viaHeader.headers['set-cookie']).toEqual(['app_session=A; Path=/'])

    const viaPath = await get('/openlist/a/b', { cookie })
    expect(viaPath.body).toBe('app saw /a/b')
  })

  it('路径白名单：/api/firstfactor 不会被当成服务名；不认识的 X-Nas-Service 当门户请求', async () => {
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    expect((await get('/api/whatever', { cookie })).status).toBe(404)
    expect((await get('/nope/', { cookie, 'x-nas-service': 'nope' })).status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('绝对路径跳转：配置了 rewriteRedirect 的服务在路径前缀模式下加回前缀', async () => {
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    const res = await get('/hermes/login-redirect', { cookie })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/hermes/login')
  })

  it('WebSocket 透传（终端 / 应用的实时连接）；未认证握手 401', async () => {
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, 'x-nas-service': 'openlist' } })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'))
      ws.on('message', (d) => resolve(d.toString()))
      ws.on('error', reject)
    })
    expect(reply).toBe('echo:hi')
    ws.close()
    const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'x-nas-service': 'openlist' } })
    const status = await new Promise<number>((resolve) => anon.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0)))
    expect(status).toBe(401)
  })

  it('后端挂了：502 并说明是哪个服务', async () => {
    const dead = net.createServer()
    const deadUrl = await new Promise<string>((resolve) => dead.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(dead.address() as AddressInfo).port}`)))
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    registry.set([{ name: 'openlist', backend: deadUrl }])
    const cookie = await autheliaLogin({ gatewayBase: base, user: 'gw', password: 's3cret' })
    const res = await get('/x', { cookie, 'x-nas-service': 'openlist' })
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

  it('局域网模式：Mirror 拿 kura-server 当网关 —— 登录、拉清单、挂服务、本机端口转发到应用', async () => {
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
        gatewayUser: 'gw',
        gatewayPassword: 's3cret',
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
