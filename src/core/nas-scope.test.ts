import { describe, expect, it } from 'vitest'
import { checkScope, parseScope, scopeApiPath } from './nas-scope.js'

const buf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')

describe('NAS 侧暴露范围', () => {
  it('接口地址是网关自己的 /_kura/api/scope', () => {
    expect(scopeApiPath).toBe('/_kura/api/scope')
  })

  it('解析服务端返回：范围与默认值都收下来', () => {
    const view = parseScope(
      buf({
        limits: { include: ['/volume1', '/home'], exclude: ['/volume1/@*'], readOnly: false },
        defaults: { include: ['/volume1', '/home'], exclude: [], readOnly: false },
      }),
    )
    expect(view.include).toEqual(['/volume1', '/home'])
    expect(view.exclude).toEqual(['/volume1/@*'])
    expect(view.readOnly).toBe(false)
    expect(view.defaults.include).toEqual(['/volume1', '/home'])
  })

  it('字段缺了也不炸：退成空列表 / 非只读', () => {
    expect(parseScope(buf({}))).toEqual({ include: [], exclude: [], readOnly: false, defaults: { include: [], exclude: [], readOnly: false } })
    // 数组里混了非字符串要滤掉，不能把脏值带进范围层
    expect(parseScope(buf({ limits: { include: ['/volume1', 42, null] } })).include).toEqual(['/volume1'])
  })

  it('不是 JSON 就说清「可能不是 kura-server」，别报 JSON 解析错', () => {
    expect(() => parseScope(Buffer.from('<!doctype html>'))).toThrow(/不是 JSON/)
  })

  it('自检：放行的可见可写，排除的不可见，上级只路过', () => {
    const scope = { include: ['/volume1/影视'], exclude: ['/volume1/影视/临时'] }
    expect(checkScope(scope, false, '/volume1/影视/电影')).toMatchObject({ visibility: 'full', writable: true })
    expect(checkScope(scope, false, '/volume1/影视/临时')).toMatchObject({ visibility: 'hidden' })
    expect(checkScope(scope, false, '/volume1')).toMatchObject({ visibility: 'ancestor', writable: false })
  })

  it('只读时可见但不可写', () => {
    expect(checkScope({ include: ['/volume1'], exclude: [] }, true, '/volume1/a')).toMatchObject({ visibility: 'full', writable: false })
  })
})
