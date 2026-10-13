import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LinkRouter, tcpReachable, type LinkModeSetting } from './link.js'
import { SessionManager } from './session.js'
import { FakeUgreen } from './testing/fake-ugreen.js'
import { UgreenClient } from './ugreen.js'

const base = 'https://dev-1.cn30.ug.link'
let fake: FakeUgreen

beforeEach(async () => {
  fake = await new FakeUgreen().start()
})
afterEach(async () => {
  await fake.stop()
})

function sessions(ugreenBase = fake.url) {
  return new SessionManager({
    ugreen: new UgreenClient({ base: ugreenBase, username: 'u', password: 'p' }),
    ttlMs: 60 * 60_000,
  })
}

function router(mode: LinkModeSetting, lanHost = '192.168.1.10', reachable?: () => Promise<boolean>) {
  const mgr = sessions()
  return {
    mgr,
    r: new LinkRouter({ base, gatewayPort: 8897, lanHost, mode, sessions: mgr, reachable }),
  }
}

describe('LinkRouter：路由', () => {
  it('auto 模式先按外网起步', () => {
    const { r } = router('auto')
    expect(r.mode).toBe('wan')
    expect(r.isAuto).toBe(true)
  })

  it('外网：走网关的服务用网关域名，直连服务用各自的 app-<端口> 域名，都不覆盖 Host', () => {
    const { r } = router('wan')
    expect(r.route({ port: 8890, service: 'nas-console' })).toEqual({
      upstream: 'https://app-8897-dev-1.cn30.ugdocker.link',
      host: '',
      gatewayService: 'nas-console',
      sessionPort: 8897,
    })
    expect(r.route({ port: 5244 })).toEqual({
      upstream: 'https://app-5244-dev-1.cn30.ugdocker.link',
      host: '',
      gatewayService: '',
      sessionPort: 5244,
    })
  })

  it('局域网：拨局域网地址，但 Host 仍是公网域名', () => {
    const { r } = router('lan')
    expect(r.route({ port: 8890, service: 'nas-console' })).toEqual({
      upstream: 'http://192.168.1.10:8897',
      host: 'app-8897-dev-1.cn30.ugdocker.link',
      gatewayService: 'nas-console',
      sessionPort: 8897,
    })
    expect(r.route({ port: 5244 })).toEqual({
      upstream: 'http://192.168.1.10:5244',
      host: 'app-5244-dev-1.cn30.ugdocker.link',
      gatewayService: '',
      sessionPort: 5244,
    })
  })

  it('运行期才出现的服务也能算出路由（Go 版的盲区）', () => {
    const { r } = router('lan')
    expect(r.route({ port: 4533 }).upstream).toBe('http://192.168.1.10:4533')
  })

  it('没有局域网地址：写了 lan 也退回外网，切 lan / auto 报错', async () => {
    const { r } = router('lan', '')
    expect(r.mode).toBe('wan')
    await expect(r.setModeSetting('lan')).rejects.toThrow(/局域网地址/)
    await expect(r.setModeSetting('auto')).rejects.toThrow(/局域网地址/)
  })

  it('网关地址：外网、局域网、局域网 Host', () => {
    const { r } = router('wan')
    expect(r.gatewayAddresses()).toEqual({
      base: 'https://app-8897-dev-1.cn30.ugdocker.link',
      lanBase: 'http://192.168.1.10:8897',
      lanHostHeader: 'app-8897-dev-1.cn30.ugdocker.link',
    })
  })
})

describe('LinkRouter：模式切换', () => {
  it('切换模式作废会话缓存，并通知会话管理器', async () => {
    const { r, mgr } = router('wan')
    await mgr.cookie(5244)
    expect(mgr.sessionCount()).toBe(1)
    const changes: string[] = []
    r.onModeChange((mode) => changes.push(mode))
    await r.setModeSetting('lan')
    expect(r.mode).toBe('lan')
    expect(mgr.sessionCount()).toBe(0)
    expect(mgr.isLan).toBe(true)
    expect(changes).toEqual(['lan'])
  })

  it('局域网直连端口不需要任何会话', async () => {
    const { mgr } = router('lan')
    expect(await mgr.cookie(5244)).toBe('')
    expect(fake.loginCount).toBe(0)
  })

  it('auto 跟着探测结果切换', async () => {
    let reachable = true
    const { r } = router('auto', '192.168.1.10', async () => reachable)
    await r.probeOnce('测试')
    expect(r.mode).toBe('lan')
    reachable = false
    await r.probeOnce('测试')
    expect(r.mode).toBe('wan')
    expect(r.lanReachable).toBe(false)
  })

  it('手动切换后探测不再抢回去', async () => {
    const { r } = router('auto', '192.168.1.10', async () => true)
    await r.setModeSetting('wan')
    await r.probeOnce('不应生效')
    expect(r.mode).toBe('wan')
    expect(r.lanReachable).toBe(true) // 结果照样记下，供界面展示
  })
})

describe('tcpReachable', () => {
  it('连得上为真，关掉后为假', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    expect(await tcpReachable('127.0.0.1', port)).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await tcpReachable('127.0.0.1', port)).toBe(false)
  })
})
