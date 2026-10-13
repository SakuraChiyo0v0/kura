import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Route } from './link.js'
import { createServiceProxy, type ProxyService } from './proxy.js'
import { SessionManager } from './session.js'
import { ServiceStats, humanBytes } from './stats.js'
import { FakeUgreen } from './testing/fake-ugreen.js'
import { UgreenClient } from './ugreen.js'

/**
 * 用真实的 HTTP 往返验证反代（对应 Go 版 mirror_integration_test.go），不碰真实中继：
 * 本地 upstream + 假绿联会话。
 */

let fake: FakeUgreen
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(async () => {
  fake = await new FakeUgreen().start()
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  await fake.stop()
})

async function listen(server: http.Server): Promise<string> {
  // 升级过的连接不归 closeAllConnections 管（已被接管），自己记下来关，否则 close 永远等不到
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  return `127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function upstreamServer(handler: http.RequestListener): Promise<string> {
  return `http://${await listen(http.createServer(handler))}`
}

interface FrontOptions {
  service?: Partial<ProxyService>
  route?: Partial<Route>
}

/** 造一个本机反代前端：上游指向本地 upstream，会话来自假绿联。 */
async function front(upstream: string, options: FrontOptions = {}) {
  const sessions = new SessionManager({
    ugreen: new UgreenClient({ base: fake.url, username: 'u', password: 'p' }),
    ttlMs: 60 * 60_000,
  })
  const svc: ProxyService = { port: 8899, label: 'test', ...options.service }
  const route: Route = { upstream, host: '', gatewayService: '', sessionPort: svc.port, ...options.route }
  const stats = new ServiceStats()
  const proxy = createServiceProxy(svc, { sessions, router: { route: () => route } }, stats)
  const server = http.createServer(proxy.request)
  server.on('upgrade', proxy.upgrade)
  const addr = await listen(server)
  return { url: `http://${addr}`, addr, sessions, stats }
}

/** 不跟随重定向的 GET（node:http 本来就不跟随），返回状态、头、体。 */
function get(url: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('反代：cookie 与跳转', () => {
  it('注入本端口会话、覆盖陈旧托管 cookie、保留应用自己的 cookie；Set-Cookie 能落在 127.0.0.1', async () => {
    let gotCookie = ''
    const up = await upstreamServer((req, res) => {
      gotCookie = req.headers.cookie ?? ''
      res.setHeader('set-cookie', 'appsession=xyz; Domain=app-8899-x.cn30.ugdocker.link; Path=/; Secure; HttpOnly')
      res.end('ok')
    })
    const { url } = await front(up)
    const res = await get(url + '/', { cookie: 'theme=dark; ugreen-proxy-token=STALE' })
    expect(gotCookie).toContain('ugreen-proxy-token=COOKIE-8899')
    expect(gotCookie).not.toContain('STALE')
    expect(gotCookie).toContain('theme=dark')
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).not.toContain('Domain=')
    expect(setCookie).not.toContain('Secure')
  })

  it('中继 errorPage（200 + 跳转 HTML）识别为失败 502，并计入错误', async () => {
    const up = await upstreamServer((_req, res) => {
      res.end(`<html><script>location.href='https://www.ug.link/errorPage'</script></html>`)
    })
    const { url, stats } = await front(up)
    expect((await get(url + '/')).status).toBe(502)
    expect(stats.errors).toBe(1)
  })

  it('跳到绿联域的绝对地址被本地化', async () => {
    const up = await upstreamServer((_req, res) => {
      res.writeHead(302, { location: 'https://app-8899-x.cn30.ugdocker.link/login?a=1' }).end()
    })
    const { url } = await front(up)
    const res = await get(url + '/')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/login?a=1')
  })

  it('302 → UGOS 登录页：作废会话并报 502，不把登录页当成功', async () => {
    const up = await upstreamServer((_req, res) => {
      res.writeHead(302, { location: 'http://dev.cn30.ug.link/desktop/#/login/account' }).end()
    })
    const { url, sessions } = await front(up)
    expect((await get(url + '/')).status).toBe(502)
    expect(sessions.sessionCount()).toBe(0)
  })

  it('大于嗅探窗口的正常响应原样透传', async () => {
    const big = 'x'.repeat(100_000)
    const up = await upstreamServer((_req, res) => res.end(big))
    const { url, stats } = await front(up)
    const res = await get(url + '/')
    expect(res.body).toBe(big)
    expect(stats.bytesDown).toBe(big.length)
  })
})

describe('反代：请求头', () => {
  it('走网关：带 X-Nas-Service，会话向网关端口要', async () => {
    let gotService = ''
    let gotCookie = ''
    const up = await upstreamServer((req, res) => {
      gotService = String(req.headers['x-nas-service'] ?? '')
      gotCookie = req.headers.cookie ?? ''
      res.end('ok')
    })
    const { url } = await front(up, {
      service: { port: 8890, service: 'nas-console' },
      route: { gatewayService: 'nas-console', sessionPort: 8897 },
    })
    await get(url + '/')
    expect(gotService).toBe('nas-console')
    expect(gotCookie).toContain('COOKIE-8897')
  })

  it('直连不带 X-Nas-Service，且外部伪造的会被去掉', async () => {
    let gotService: string | undefined = 'unset'
    const up = await upstreamServer((req, res) => {
      gotService = req.headers['x-nas-service'] as string | undefined
      res.end('ok')
    })
    const { url } = await front(up)
    await get(url + '/', { 'x-nas-service': 'forged' })
    expect(gotService).toBeUndefined()
  })

  it('局域网路由：Host 发指定的公网域名', async () => {
    let gotHost = ''
    const up = await upstreamServer((req, res) => {
      gotHost = req.headers.host ?? ''
      res.end('ok')
    })
    const { url } = await front(up, { route: { host: 'app-5244-dev.cn30.ugdocker.link' } })
    await get(url + '/')
    expect(gotHost).toBe('app-5244-dev.cn30.ugdocker.link')
  })

  it('配置的附加头会加上；没配的服务什么都不加', async () => {
    const seen: Array<{ auth?: string; custom?: string }> = []
    const up = await upstreamServer((req, res) => {
      seen.push({ auth: req.headers.authorization, custom: req.headers['x-custom'] as string | undefined })
      res.end('ok')
    })
    const configured = await front(up, { service: { headers: { Authorization: 'Basic QUJDRA==', 'X-Custom': 'hello' } } })
    await get(configured.url + '/')
    const plain = await front(up)
    await get(plain.url + '/')
    expect(seen).toEqual([{ auth: 'Basic QUJDRA==', custom: 'hello' }, { auth: undefined, custom: undefined }])
  })

  it('调用方自己带了同名头时以调用方为准', async () => {
    let gotAuth = ''
    const up = await upstreamServer((req, res) => {
      gotAuth = req.headers.authorization ?? ''
      res.end('ok')
    })
    const { url } = await front(up, { service: { headers: { Authorization: 'Basic SU5KRUNURUQ=' } } })
    await get(url + '/', { authorization: 'Basic Y2FsbGVyOnNlY3JldA==' })
    expect(gotAuth).toBe('Basic Y2FsbGVyOnNlY3JldA==')
  })
})

describe('反代：流量统计', () => {
  it('上下行分别统计：上行 = 请求体，下行 = 响应体', async () => {
    const up = await upstreamServer((req, res) => req.pipe(res))
    const { url, stats } = await front(up)
    const payload = 'a'.repeat(2000)
    const res = await get(url + '/', { 'content-type': 'text/plain' }, 'POST', payload)
    expect(res.body).toBe(payload)
    expect(stats.bytesUp).toBe(2000)
    expect(stats.bytesDown).toBe(2000)
  })

  it('没有请求体的 GET 上行为 0', async () => {
    const up = await upstreamServer((_req, res) => res.end('ok'))
    const { url, stats } = await front(up)
    await get(url + '/')
    expect(stats.bytesUp).toBe(0)
    expect(stats.bytesDown).toBe(2)
  })

  it('调用方中途断开不计错误（上游无视取消、一直挂着，避免假阳性）', async () => {
    let arrived!: () => void
    const reached = new Promise<void>((resolve) => (arrived = resolve))
    const up = await upstreamServer(() => arrived()) // 永不响应
    const { addr, stats } = await front(up)
    const socket = net.connect(Number(addr.split(':')[1]), '127.0.0.1')
    socket.write(`GET / HTTP/1.1\r\nHost: ${addr}\r\n\r\n`)
    await reached
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(stats.requests).toBe(1)
    expect(stats.errors).toBe(0)
  })

  it('上游连不上是真故障：502 并计数', async () => {
    const { url, stats } = await front('http://127.0.0.1:1')
    expect((await get(url + '/')).status).toBe(502)
    expect(stats.errors).toBe(1)
  })
})

describe('反代：WebSocket', () => {
  it('升级请求带上会话 cookie，101 后双向字节透传', async () => {
    let sawCookie = ''
    const upServer = http.createServer()
    upServer.on('upgrade', (req, socket) => {
      sawCookie = req.headers.cookie ?? ''
      const accept = createHash('sha1')
        .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.on('data', (data) => socket.write(data)) // 回显
    })
    const up = `http://${await listen(upServer)}`
    const { addr } = await front(up)

    const socket = net.connect(Number(addr.split(':')[1]), '127.0.0.1')
    cleanups.push(() => void socket.destroy())
    const received: Buffer[] = []
    socket.on('data', (chunk) => received.push(chunk))
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: ${addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    const waitFor = async (predicate: (text: string) => boolean) => {
      for (let i = 0; i < 100; i += 1) {
        if (predicate(Buffer.concat(received).toString())) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等不到期望的数据：${Buffer.concat(received).toString()}`)
    }
    await waitFor((text) => text.includes('\r\n\r\n'))
    expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 101/)
    expect(sawCookie).toContain('ugreen-proxy-token=COOKIE-8899')

    received.length = 0
    socket.write('kura-websocket-probe')
    await waitFor((text) => text === 'kura-websocket-probe')
  })
})

describe('humanBytes', () => {
  it('1024 进制', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(1023)).toBe('1023 B')
    expect(humanBytes(1024)).toBe('1.0 KiB')
    expect(humanBytes(1536)).toBe('1.5 KiB')
    expect(humanBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(humanBytes(3.5 * 1024 * 1024)).toBe('3.5 MiB')
    expect(humanBytes(2 * 1024 ** 3)).toBe('2.0 GiB')
  })
})
