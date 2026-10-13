import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as realRequest, type HttpRequester } from '../core/http.js'
import type { ConnectionConfig } from '../core/mirror.js'
import { FakeUgreen } from '../core/testing/fake-ugreen.js'
import type { ConnectionForm } from '../shared/ipc.js'
import { mergeForm, summarize, testConnection } from './connection.js'

const form: ConnectionForm = {
  base: 'https://dev-1.cn30.ug.link/',
  ugreenUser: ' someone ',
  ugreenPassword: 'pw',
  lanHost: '',
  mode: 'wan',
  gatewayPort: 8897,
  gatewayUser: 'gw',
  gatewayPassword: 'gwpw',
}

describe('mergeForm', () => {
  it('规范化：去尾斜杠、去空白', () => {
    expect(mergeForm(form, undefined)).toMatchObject({ base: 'https://dev-1.cn30.ug.link', ugreenUser: 'someone' })
  })

  it('密码留空沿用已保存的值', () => {
    const saved = mergeForm(form, undefined)
    const merged = mergeForm({ ...form, ugreenPassword: '', gatewayPassword: '' }, saved)
    expect(merged.ugreenPassword).toBe('pw')
    expect(merged.gatewayPassword).toBe('gwpw')
  })

  it('非绿联设备域、缺账号密码、局域网模式缺地址都拒绝', () => {
    expect(() => mergeForm({ ...form, base: 'https://nas.example.com' }, undefined)).toThrow(/ug\.link/)
    expect(() => mergeForm({ ...form, ugreenUser: '' }, undefined)).toThrow(/账号/)
    expect(() => mergeForm({ ...form, ugreenPassword: '' }, undefined)).toThrow(/密码/)
    expect(() => mergeForm({ ...form, mode: 'auto' }, undefined)).toThrow(/局域网地址/)
  })

  it('不用网关时清掉网关凭据', () => {
    expect(mergeForm({ ...form, gatewayPort: 0 }, undefined)).toMatchObject({ gatewayUser: '', gatewayPassword: '' })
  })
})

describe('summarize', () => {
  it('只告诉有没有密码，不回传明文', () => {
    const summary = summarize(mergeForm(form, undefined))
    expect(summary).toMatchObject({ configured: true, hasUgreenPassword: true, hasGatewayPassword: true })
    expect(JSON.stringify(summary)).not.toContain('gwpw')
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
  const config = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ ...mergeForm(form, undefined), ...patch })

  it('三步都通过', async () => {
    const result = await testConnection(config(), viaFake())
    expect(result.ok).toBe(true)
    expect(result.steps.map((s) => s.name)).toEqual(['绿联账号登录', '网关端口 8897 会话', '网关（Authelia）登录'])
  })

  it('网关密码错：在 Authelia 那一步停下并说明原因', async () => {
    fake.autheliaMode = 'reject'
    const result = await testConnection(config(), viaFake())
    expect(result.ok).toBe(false)
    expect(result.steps.at(-1)).toMatchObject({ name: '网关（Authelia）登录', ok: false })
    expect(result.steps.at(-1)!.detail).toMatch(/凭据被上游拒绝/)
  })

  it('局域网连不上不算整体失败', async () => {
    const result = await testConnection(config({ lanHost: '127.0.0.1', gatewayPort: 1 }), viaFake())
    expect(result.steps.at(-1)).toMatchObject({ name: '局域网可达', ok: false })
    expect(result.ok).toBe(true)
  })
})
