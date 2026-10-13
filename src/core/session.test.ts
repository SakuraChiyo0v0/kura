import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeUgreen } from './testing/fake-ugreen.js'
import { captureLogger } from './log.js'
import { SessionManager, credentialCooldownMs, noGateway, type GatewayAuth } from './session.js'
import { UgreenClient } from './ugreen.js'

let fake: FakeUgreen
let clock: number
const now = () => clock

beforeEach(async () => {
  fake = await new FakeUgreen().start()
  clock = 1_000_000
})
afterEach(async () => {
  await fake.stop()
})

function manager(ttlMs = 60 * 60_000, gateway: Partial<GatewayAuth> = {}) {
  const log = captureLogger()
  const mgr = new SessionManager({
    ugreen: new UgreenClient({ base: fake.url, username: 'tester', password: 's3cret-password' }),
    ttlMs,
    gateway: { ...noGateway, ...gateway },
    log,
    now,
  })
  return { mgr, log }
}

describe('SessionManager：绿联链路', () => {
  it('密码按 RSA PKCS#1 v1.5 加密后提交（假服务端用私钥解出来要等于原文）', async () => {
    const { mgr } = manager()
    expect(await mgr.cookie(8899)).toBe('ugreen-proxy-token=COOKIE-8899')
    expect(fake.receivedUser).toBe('tester')
    expect(fake.receivedPass).toBe('s3cret-password')
  })

  it('登录必须带 keepalive=true（能显著拉长 api_token 寿命）', async () => {
    const { mgr } = manager()
    await mgr.cookie(8899)
    expect(fake.receivedKeepalive).toBe(true)
  })

  it('会话按端口隔离并缓存；多端口只登录一次', async () => {
    const { mgr } = manager()
    const first = await mgr.cookie(8899)
    expect(await mgr.cookie(8899)).toBe(first)
    expect(await mgr.cookie(5244)).not.toBe(first)
    expect(fake.dockerAttempts).toBe(2)
    expect(fake.loginCount).toBe(1)
  })

  it('force 绕过缓存', async () => {
    const { mgr } = manager()
    await mgr.cookie(8899)
    await mgr.cookie(8899, true)
    expect(fake.dockerAttempts).toBe(2)
  })

  it('TTL 到期后重建', async () => {
    const { mgr } = manager(10_000)
    await mgr.cookie(8899)
    clock += 10_001
    await mgr.cookie(8899)
    expect(fake.dockerAttempts).toBe(2)
  })

  it('api_token 过期时丢弃、重登，并把这次请求救回来', async () => {
    const { mgr } = manager()
    fake.failNextDocker = 1024
    expect(await mgr.cookie(8899)).toBe('ugreen-proxy-token=COOKIE-8899')
    expect(fake.loginCount).toBe(2)
    expect(fake.dockerAttempts).toBe(2)
  })

  it('invalidate 之后重建', async () => {
    const { mgr } = manager()
    await mgr.cookie(8899)
    expect(mgr.sessionCount()).toBe(1)
    mgr.invalidate(8899)
    expect(mgr.sessionCount()).toBe(0)
    await mgr.cookie(8899)
    expect(fake.dockerAttempts).toBe(2)
  })

  it('一次性授权页：每次重建恰好访问一次', async () => {
    const { mgr } = manager()
    for (let i = 0; i < 3; i += 1) await mgr.cookie(8899, true)
    expect(fake.redirectHits.get('8899')).toBe(3)
  })

  it('同一端口并发取会话只建一次（授权页一次性，重复访问会失败）', async () => {
    const { mgr } = manager()
    const results = await Promise.all([mgr.cookie(8899), mgr.cookie(8899), mgr.cookie(8899)])
    expect(new Set(results).size).toBe(1)
    expect(fake.redirectHits.get('8899')).toBe(1)
    expect(fake.loginCount).toBe(1)
  })

  it('primeAll 逐端口报告，并发冷启动只登录一次', async () => {
    const { mgr } = manager()
    for (const port of [8899, 5244, 8890]) mgr.addRefreshPort(port)
    const results = await mgr.primeAll()
    expect([...results.keys()].sort()).toEqual([5244, 8890, 8899])
    expect([...results.values()].every((error) => error === undefined)).toBe(true)
    expect(fake.loginCount).toBe(1)
  })

  it('续期集合升序去重，忽略非法端口', () => {
    const { mgr } = manager()
    mgr.addRefreshPort(8897)
    mgr.addRefreshPort(8890)
    mgr.addRefreshPort(8897)
    mgr.addRefreshPort(0)
    expect(mgr.refreshPortList()).toEqual([8890, 8897])
  })

  it('运行期才登记的端口也会被续期', async () => {
    const { mgr } = manager()
    await mgr.cookie(8899, true)
    const before = fake.dockerAttempts
    mgr.addRefreshPort(8899)
    await mgr.refreshOnce()
    expect(fake.dockerAttempts).toBeGreaterThan(before)
  })
})

describe('SessionManager：统一网关（Authelia）', () => {
  it('网关端口的会话同时带绿联与 Authelia 两层 cookie', async () => {
    const { mgr } = manager(60_000, { port: 8899, base: fake.url, user: 'gw', password: 'pw' })
    const cookie = await mgr.cookie(8899)
    expect(cookie).toContain('ugreen-proxy-token=COOKIE-8899')
    expect(cookie).toContain('authelia_session=SSO-SESSION')
  })

  it('非网关端口不登 Authelia', async () => {
    const { mgr } = manager(60_000, { port: 8899, base: fake.url, user: 'gw', password: 'pw' })
    expect(await mgr.cookie(5244)).not.toContain('authelia')
    expect(fake.autheliaLogins).toBe(0)
  })

  it('没有第二层凭据时照常工作（只带绿联 cookie）', async () => {
    const { mgr } = manager(60_000, { port: 8899, base: fake.url })
    expect(await mgr.cookie(8899)).toBe('ugreen-proxy-token=COOKIE-8899')
  })
})

describe('SessionManager：局域网模式', () => {
  const lanGateway = (url: string): Partial<GatewayAuth> => ({
    port: 8897,
    base: 'https://app-8897-dev.cn30.ugdocker.link',
    lanBase: url,
    lanHostHeader: 'app-8897-dev.cn30.ugdocker.link',
    user: 'gw',
    password: 'pw',
  })

  it('直连端口什么都不用带，也不碰绿联', async () => {
    const { mgr } = manager(60_000, lanGateway(fake.url))
    mgr.setLan(true)
    expect(await mgr.cookie(5244)).toBe('')
    expect(fake.loginCount).toBe(0)
  })

  it('网关端口只登 Authelia，且 Host 发公网域名而不是局域网地址', async () => {
    fake.autheliaRequiredHost = 'app-8897-dev.cn30.ugdocker.link'
    const { mgr } = manager(60_000, lanGateway(fake.url))
    mgr.setLan(true)
    expect(await mgr.cookie(8897)).toBe('authelia_session=SSO-SESSION')
    expect(fake.autheliaHosts).toEqual(['app-8897-dev.cn30.ugdocker.link'])
    expect(fake.loginCount).toBe(0)
  })

  it('reset 之后缓存清空，建立到一半的旧会话不写回', async () => {
    const { mgr } = manager()
    const pending = mgr.cookie(8899)
    mgr.reset()
    await pending
    expect(mgr.sessionCount()).toBe(0)
  })
})

describe('SessionManager：认证退避', () => {
  const gw = (): Partial<GatewayAuth> => ({ port: 8899, base: fake.url, user: 'gw', password: 'pw' })

  it('凭据被拒：冷却 10 分钟，窗口内一个请求都不发，并打 ERROR', async () => {
    fake.autheliaMode = 'reject'
    const { mgr, log } = manager(60_000, gw())
    await expect(mgr.cookie(8899)).rejects.toThrow(/凭据被上游拒绝/)
    const logins = fake.autheliaLogins
    await expect(mgr.cookie(8899)).rejects.toThrow(/认证退避中/)
    expect(fake.autheliaLogins).toBe(logins)
    expect(mgr.authStatus()).toMatchObject({ blocked: true, credential: true, fails: 1 })
    expect(log.entries.some((e) => e.level === 'error' && e.message.includes('停止自动重试'))).toBe(true)

    clock += credentialCooldownMs - 1
    await expect(mgr.cookie(8899)).rejects.toThrow(/认证退避中/)
    clock += 2
    fake.autheliaMode = 'ok'
    await expect(mgr.cookie(8899)).resolves.toContain('authelia_session')
    expect(mgr.authStatus().blocked).toBe(false)
  })

  it('链路类失败按台阶退避：5s、10s、20s…，封顶 2 分钟', async () => {
    fake.autheliaMode = 'error'
    const { mgr } = manager(60_000, gw())
    const windows: number[] = []
    for (let i = 0; i < 7; i += 1) {
      await expect(mgr.cookie(8899)).rejects.toThrow()
      const status = mgr.authStatus()
      expect(status.credential).toBe(false)
      windows.push(status.retryAt - clock)
      clock = status.retryAt
    }
    expect(windows).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000])
  })

  it('续期轮次跳过退避中的端口', async () => {
    fake.autheliaMode = 'reject'
    const { mgr } = manager(60_000, gw())
    mgr.addRefreshPort(8899)
    await mgr.refreshOnce()
    const attempts = fake.dockerAttempts
    await mgr.refreshOnce()
    expect(fake.dockerAttempts).toBe(attempts)
  })

  it('clearAllAuthFailures 后允许立刻重试', async () => {
    fake.autheliaMode = 'reject'
    const { mgr } = manager(60_000, gw())
    await expect(mgr.cookie(8899)).rejects.toThrow()
    fake.autheliaMode = 'ok'
    mgr.clearAllAuthFailures()
    await expect(mgr.cookie(8899)).resolves.toContain('authelia_session')
  })
})

describe('SessionManager：gatewayGet', () => {
  it('带会话取网关接口', async () => {
    fake.servicesBody = '{"services":[{"name":"openlist"}]}'
    const { mgr } = manager(60_000, { port: 8899, base: fake.url, user: 'gw', password: 'pw' })
    const body = await mgr.gatewayGet('/__services')
    expect(JSON.parse(body.toString())).toEqual({ services: [{ name: 'openlist' }] })
  })

  it('没启用网关时直接报错，不发请求', async () => {
    const { mgr } = manager()
    await expect(mgr.gatewayGet('/__services')).rejects.toThrow(/未启用统一网关/)
    expect(fake.servicesRequests).toBe(0)
  })
})
