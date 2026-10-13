import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogger } from './log.js'
import { Watchdog, probeErrorAfter, probeHttp, probeWarnAfter } from './watchdog.js'

const target = { key: 'unit', address: '127.0.0.1:1' }

describe('Watchdog 判定', () => {
  it('5xx 计为连续失败，记下起点与原因；恢复时清零并报中断时长', async () => {
    let status = 503
    let clock = 0
    const log = captureLogger()
    const dog = new Watchdog({ log, now: () => clock, fetchStatus: async () => status })
    for (let i = 1; i <= probeWarnAfter; i += 1) {
      clock += 60_000
      const r = await dog.probe(target)
      expect(r).toMatchObject({ ok: false, failStreak: i, firstFailureAt: 60_000 })
      expect(r.error).toMatch(/503/)
    }
    expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(1)

    status = 200
    clock += 60_000
    const r = await dog.probe(target)
    expect(r).toMatchObject({ ok: true, failStreak: 0, lastOk: clock })
    const recovered = log.entries.find((e) => e.message === '服务探测恢复')
    expect(recovered?.fields).toMatchObject({ 中断秒: 180, 失败次数: probeWarnAfter })
  })

  it('302 / 401 / 404 不是故障', async () => {
    for (const status of [302, 401, 404]) {
      const dog = new Watchdog({ fetchStatus: async () => status })
      expect((await dog.probe(target)).ok).toBe(true)
    }
  })

  it('连接失败算不可用；第 10 次升级为 ERROR', async () => {
    const log = captureLogger()
    const dog = new Watchdog({ log, fetchStatus: async () => Promise.reject(new Error('ECONNREFUSED')) })
    for (let i = 0; i < probeErrorAfter; i += 1) await dog.probe(target)
    expect(dog.get('unit')?.failStreak).toBe(probeErrorAfter)
    expect(log.entries.filter((e) => e.level === 'error')).toHaveLength(1)
  })
})

describe('probeHttp', () => {
  let server: http.Server | undefined
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  })

  it('不跟随重定向，返回原始状态码', async () => {
    server = http.createServer((_req, res) => res.writeHead(302, { location: '/login' }).end())
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    expect(await probeHttp(`127.0.0.1:${(server.address() as AddressInfo).port}`)).toBe(302)
  })
})
