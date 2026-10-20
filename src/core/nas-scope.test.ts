import { describe, expect, it } from 'vitest'
import { browseApiPath, checkScope, parseBrowse, parseScope, scopeApiPath } from './nas-scope.js'

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

  it('缺了 limits / defaults 就报错，不退成空范围（空范围一保存就把真的覆盖掉）', () => {
    expect(() => parseScope(buf({}))).toThrow(/范围/)
    expect(() => parseScope(buf({ limits: { include: ['/volume1'], exclude: [] } }))).toThrow(/默认范围/)
    // include 空数组同样不行：空 include 等于放行一切
    expect(() => parseScope(buf({ limits: { include: [], exclude: [] }, defaults: { include: ['/'], exclude: [] } }))).toThrow(/没有放行目录/)
    // 数组 / 字符串这类非对象 JSON 也要挡住
    expect(() => parseScope(buf([]))).toThrow(/不是范围对象/)
    // 数组里混了非字符串要滤掉，不能把脏值带进范围层
    expect(
      parseScope(buf({ limits: { include: ['/volume1', 42, null], exclude: [] }, defaults: { include: ['/'], exclude: [] } })).include,
    ).toEqual(['/volume1'])
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

  it('目录选择器打的是网关上的 /_kura/api/browse', () => {
    expect(browseApiPath).toBe('/_kura/api/browse')
  })

  it('解析目录列表：只留目录项，缺 path 就报错', () => {
    expect(parseBrowse(buf({ path: '/volume1', entries: [{ name: '照片', path: '/volume1/照片' }], truncated: false }))).toEqual({
      path: '/volume1',
      entries: [{ name: '照片', path: '/volume1/照片' }],
      truncated: false,
    })
    // 空目录是正常情况，不能当成错误（与范围不同：空范围会覆盖真的，空目录树只是空）
    expect(parseBrowse(buf({ path: '/volume1', entries: [] }))).toEqual({ path: '/volume1', entries: [], truncated: false })
    // 没有 path 说明对面不是这个接口，得报出来而不是画一个空目录树
    expect(() => parseBrowse(buf({ entries: [] }))).toThrow(/没有 path/)
    expect(() => parseBrowse(Buffer.from('not json'))).toThrow(/不是 JSON/)
  })

  it('目录列表里的脏项要滤掉，别把没有 path 的条目带进界面', () => {
    const parsed = parseBrowse(buf({ path: '/v', entries: [{ name: 'a', path: '/v/a' }, { name: 'no-path' }, null, 'x'] }))
    expect(parsed.entries).toEqual([{ name: 'a', path: '/v/a' }])
  })
})
