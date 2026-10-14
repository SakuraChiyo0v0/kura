import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as realRequest, type HttpRequester } from '../core/http.js'
import type { ConnectionConfig } from '../core/mirror.js'
import { FakeUgreen } from '../core/testing/fake-ugreen.js'
import type { UglinkInfo } from '../core/uglink.js'
import type { ConnectionForm } from '../shared/ipc.js'
import { ConnectionService, mergeForm, summarize, testConnection } from './connection.js'

const form: ConnectionForm = {
  uglinkId: 'https://ug.link/dev-1/',
  ugreenUser: ' someone ',
  ugreenPassword: 'pw',
  lanHost: '',
  mode: 'wan',
  gatewayPort: 8898,
}

const info: UglinkInfo = { id: 'dev-1', base: 'https://dev-1.cn30.ug.link', lanHost: '192.0.2.10' }

describe('mergeForm', () => {
  it('用解析结果当设备域，规范化学号与空白', () => {
    expect(mergeForm(form, undefined, info)).toMatchObject({
      uglinkId: 'dev-1',
      base: 'https://dev-1.cn30.ug.link',
      ugreenUser: 'someone',
    })
  })

  it('用户填的局域网地址优先于查询结果，留空才用它', () => {
    expect(mergeForm(form, undefined, info).lanHost).toBe('192.0.2.10')
    expect(mergeForm({ ...form, lanHost: ' 10.0.0.5 ' }, undefined, info).lanHost).toBe('10.0.0.5')
  })

  it('密码留空沿用已保存的值', () => {
    const saved = mergeForm(form, undefined, info)
    expect(mergeForm({ ...form, ugreenPassword: '' }, saved, info).ugreenPassword).toBe('pw')
  })

  it('缺账号密码、解析结果不是绿联域都拒绝', () => {
    expect(() => mergeForm({ ...form, ugreenUser: '' }, undefined, info)).toThrow(/账号/)
    expect(() => mergeForm({ ...form, ugreenPassword: '' }, undefined, info)).toThrow(/密码/)
    expect(() => mergeForm(form, undefined, { ...info, base: 'https://nas.example.com' })).toThrow(/ug\.link/)
  })

  it('局域网地址不是必填：auto / wan 没地址也接受，只有 lan 模式要', () => {
    const noLan = { ...info, lanHost: '' }
    // 查不到地址、用户也没填 → 纯走外网中继，这是合法配置
    expect(mergeForm({ ...form, mode: 'auto' }, undefined, noLan)).toMatchObject({ lanHost: '', mode: 'auto' })
    expect(mergeForm({ ...form, mode: 'wan' }, undefined, noLan)).toMatchObject({ lanHost: '', mode: 'wan' })
    // 明确要求局域网模式才必须有地址
    expect(() => mergeForm({ ...form, mode: 'lan' }, undefined, noLan)).toThrow(/局域网地址/)
  })

  it('不用网关时端口归零（没有凭据要清理）', () => {
    expect(mergeForm({ ...form, gatewayPort: 0 }, undefined, info).gatewayPort).toBe(0)
  })
})

describe('summarize', () => {
  it('只告诉有没有密码，不回传明文；带上 ID 与解析出的设备域', () => {
    const summary = summarize(mergeForm(form, undefined, info))
    expect(summary).toMatchObject({
      configured: true,
      uglinkId: 'dev-1',
      base: 'https://dev-1.cn30.ug.link',
      hasUgreenPassword: true,
      gatewayPort: 8898,
    })
    expect(JSON.stringify(summary)).not.toContain('pw')
    expect(summarize(undefined).configured).toBe(false)
  })
})

describe('testConnection', () => {
  let fake: FakeUgreen
  beforeEach(async () => {
    fake = await new FakeUgreen().start()
  })
  afterEach(async () => {
    await fake.stop()
  })

  const viaFake = (): HttpRequester => (req) => {
    const url = new URL(req.url)
    return realRequest({ ...req, url: `${fake.url}${url.pathname}${url.search}`, host: req.host ?? url.host })
  }
  const config = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    ...mergeForm(form, undefined, info),
    ...patch,
  })

  it('各步都通过，第一步先报解析结果', async () => {
    const result = await testConnection(config(), viaFake(), info)
    expect(result.ok).toBe(true)
    // 局域网地址由查询结果补齐，所以最后还会多一步「局域网可达」（连不上也不算失败）
    expect(result.steps.map((s) => s.name)).toEqual(['UGREENlink ID', '绿联账号登录', '网关端口 8898 会话', '局域网可达'])
    expect(result.steps[0]!.detail).toContain('https://dev-1.cn30.ug.link')
  })

  it('绿联登录失败：在第一步停下并说明原因', async () => {
    fake.loginMode = 'error'
    const result = await testConnection(config(), viaFake(), info)
    expect(result.ok).toBe(false)
    expect(result.steps.at(-1)).toMatchObject({ name: '绿联账号登录', ok: false })
  })

  it('局域网连不上不算整体失败', async () => {
    const result = await testConnection(config({ lanHost: '127.0.0.1' }), viaFake(), info)
    expect(result.steps.at(-1)).toMatchObject({ name: '局域网可达', ok: false })
    expect(result.ok).toBe(true)
  })
})

describe('ConnectionService 读配置的时机', () => {
  /**
   * 这组用例盯的是一个真出现过的 bug：连接服务在模块顶层 new 出来，
   * 那时 app 还没 ready，safeStorage 不可用，于是构造函数里读盘每次都失败 ——
   * 磁盘上有关配置，却每次启动都弹引导页。修法是把读盘推迟到第一次真正要用。
   */
  const fakeVault = (config: ConnectionConfig | undefined) => {
    let loads = 0
    return {
      loads: () => loads,
      vault: {
        load: () => {
          loads += 1
          return config
        },
        save: () => {},
        clear: () => {},
      } as never,
    }
  }

  const makeService = (vault: unknown) =>
    new ConnectionService(vault as never, { dataDir: '', log: undefined, request: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }) } as never, undefined as never)

  it('构造时不读盘（那时 safeStorage 还不能用）', () => {
    const { vault, loads } = fakeVault(undefined)
    makeService(vault)
    expect(loads()).toBe(0)
  })

  it('第一次用到才读，且只读一次', () => {
    const stored = { uglinkId: 'dev-1', base: 'https://dev-1.cn30.ug.link' } as ConnectionConfig
    const { vault, loads } = fakeVault(stored)
    const service = makeService(vault)

    expect(service.summary()).toMatchObject({ configured: true, uglinkId: 'dev-1' })
    expect(loads()).toBe(1)
    // 再问几次不会再读盘：读过的配置就是当前配置
    service.summary()
    service.summary()
    expect(loads()).toBe(1)
  })

  it('再问几次也不会重复读盘：读过的配置就是当前配置', () => {
    const stored = { uglinkId: 'dev-1', base: 'https://dev-1.cn30.ug.link' } as ConnectionConfig
    const { vault, loads } = fakeVault(stored)
    const service = makeService(vault)

    service.summary()
    service.summary()
    service.summary()
    expect(loads()).toBe(1)
  })
})

describe('ConnectionService.resolve', () => {
  let fake: FakeUgreen
  beforeEach(async () => {
    fake = await new FakeUgreen().start()
  })
  afterEach(async () => {
    await fake.stop()
  })

  const viaFake = (): HttpRequester => (req) => {
    const url = new URL(req.url)
    return realRequest({ ...req, url: `${fake.url}${url.pathname}${url.search}`, host: req.host ?? url.host })
  }

  const service = (request: HttpRequester): ConnectionService =>
    new ConnectionService(
      { load: () => undefined, save: () => {}, clear: () => {} } as never,
      { dataDir: '', log: undefined, request } as never,
      undefined as never,
    )

  it('第一次要查绿联云拿设备域', async () => {
    fake.uglinkAlias = 'dev-1'
    fake.uglinkRelay = 'cn30.ug.link'
    fake.uglinkIpv4 = ['192.0.2.10']
    const result = await service(viaFake()).test(form)
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({ name: 'UGREENlink ID', ok: true })
    expect(fake.uglinkLookups).toBe(1)
  })

  it('测试过的 ID，保存时复用解析结果、不再查一次绿联云', async () => {
    fake.uglinkAlias = 'dev-1'
    const svc = service(viaFake())
    // 不真的起映射：只关心 save 之前那次 resolve
    ;(svc as unknown as { start: () => Promise<void> }).start = async () => {}
    expect((await svc.test(form)).ok).toBe(true)
    await svc.save(form)
    expect(fake.uglinkLookups).toBe(1)
    // 换了 ID 就要重新查
    fake.uglinkAlias = 'dev-2'
    await svc.test({ ...form, uglinkId: 'dev-2' })
    expect(fake.uglinkLookups).toBe(2)
  })

  it('ID 不存在时就地报错，不去连一个不存在的设备', async () => {
    fake.uglinkAlias = '' // 让假 NAS 回 7022
    const result = await service(viaFake()).test(form)
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.detail).toMatch(/没有这个 UGREENlink ID/)
    expect(fake.loginCount).toBe(0)
  })
})
