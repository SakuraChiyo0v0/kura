import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../src/shell/audit.js'
import { adminPage, createAdminHandler } from '../src/admin.js'
import { Registry } from '../src/registry.js'
import { createKuraServer } from '../src/server.js'
import { TokenStore } from '../src/tokens.js'
import { WebdavFeature, webdavDefaults } from '../src/webdav.js'

/**
 * S4 判据：范围、清单、Token 都能在页面上改。
 * 用真 kura-server（含 admin 路由）跑一遍改范围 → 加服务 → 建 Token 的完整流程。
 * kura-server 不做认证，管理页直接打开。
 */

let server: http.Server
let base = ''
let dir = ''
let webdav: WebdavFeature
let registry: Registry
let tokens: TokenStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kura-admin-'))
  registry = new Registry(join(dir, 'services.json'), { webdav: 18005, 'nas-console': 8890 })
  registry.save([])
  webdav = new WebdavFeature({ settings: { ...webdavDefaults, port: 1 }, settingsFile: join(dir, 'webdav.json') })
  tokens = new TokenStore(join(dir, 'tokens.json'))
  const audit = new AuditLog(join(dir, 'audit.log'))
  const admin = createAdminHandler({ registry, webdav, tokens, hostRoot: dir, auditTail: (n) => audit.tail(n), shellAlive: async () => true })
  server = createKuraServer({ registry, admin })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> =>
  fetch(`${base}${path}`, { headers, redirect: 'manual' }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text() }))
const post = (path: string, form: Record<string, string>): Promise<{ status: number; headers: Headers }> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'manual' }).then((r) => ({ status: r.status, headers: r.headers }))
/** JSON 接口（客户端用的那个）。 */
const json = (path: string, body: unknown): Promise<{ status: number; body: string }> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.text() }))

describe('管理页', () => {
  it('不需要登录：直接打开就渲染出范围、清单、Token、审计四块', async () => {
    const res = await get('/_kura/')
    expect(res.status).toBe(200)
    for (const section of ['WebDAV 暴露范围', '可见性自检', '服务清单', 'API Token', '最近审计', 'kura-server']) {
      expect(res.body).toContain(section)
    }
  })

  it('改范围：保存后 WebdavFeature 立刻拿到新范围', async () => {
    const res = await post('/_kura/scope', { include: '/volume1\n/home\n', exclude: '/volume1/@*\n', readOnly: '1' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('ok=')
    const limits = webdav.limits()
    expect(limits.include).toEqual(['/home', '/volume1']) // normalizeRules 会排序
    expect(limits.exclude).toEqual(['/volume1/@*'])
    expect(limits.readOnly).toBe(true)
  })

  it('改范围写坏了：报错、不改动', async () => {
    const before = webdav.limits()
    const res = await post('/_kura/scope', { include: '/volume1/../etc' })
    expect(res.headers.get('location')).toContain('err=')
    expect(webdav.limits()).toEqual(before)
  })

  it('JSON 接口：GET 读得到当前范围与默认值，POST 整体替换', async () => {
    const first = await get('/_kura/api/scope')
    expect(first.status).toBe(200)
    const parsed = JSON.parse(first.body) as { limits: { include: string[] }; defaults: { include: string[] } }
    expect([...parsed.limits.include].sort()).toEqual(['/home', '/volume1'])
    // 默认值也回给客户端：界面上「恢复默认」不用把默认表抄一遍
    expect(parsed.defaults.include).toEqual(['/volume1', '/home'])

    const saved = await json('/_kura/api/scope', { include: ['/volume1/影视'], exclude: [] })
    expect(saved.status).toBe(200)
    expect(webdav.limits().include).toEqual(['/volume1/影视'])
    expect(webdav.limits().exclude).toEqual([])
  })

  it('JSON 接口是整体替换：删掉一条再保存必须真的删掉', async () => {
    await json('/_kura/api/scope', { include: ['/home', '/volume1', '/volume1/影视'], exclude: [] })
    expect(webdav.limits().include).toEqual(['/home', '/volume1', '/volume1/影视'])
    // 界面上移除 /home 后保存：提交的是剩下两条，/home 必须消失
    await json('/_kura/api/scope', { include: ['/volume1', '/volume1/影视'], exclude: [] })
    expect(webdav.limits().include).toEqual(['/volume1', '/volume1/影视'])
  })

  it('JSON 接口挡住了坏输入：空放行 / 非数组 / 超量都不改现状', async () => {
    const before = webdav.limits()
    expect((await json('/_kura/api/scope', { include: ['/volume1/../etc'], exclude: [] })).status).toBe(400)
    expect((await json('/_kura/api/scope', { include: [], exclude: [] })).status).toBe(400)
    expect((await json('/_kura/api/scope', { include: 'nope', exclude: [] })).status).toBe(400)
    expect((await json('/_kura/api/scope', { include: Array.from({ length: 300 }, (_, i) => `/v/${i}`), exclude: [] })).status).toBe(400)
    expect((await json('/_kura/api/scope', { include: ['/volume1'] })).status).toBe(400) // 缺 exclude：不替客户端猜
    expect(webdav.limits()).toEqual(before)
    // 请求体不是 JSON 也要给 400，别把服务打挂
    const bad = await fetch(`${base}/_kura/api/scope`, { method: 'POST', body: '{oops' })
    expect(bad.status).toBe(400)
  })

  it('可见性自检：算出这条路径可见不可见、哪条规则决定的', async () => {
    await post('/_kura/scope', { include: '/volume1', exclude: '/volume1/@*' })
    const visible = await get('/_kura/?probe=' + encodeURIComponent('/volume1/照片'))
    expect(visible.body).toContain('可见 · 可写')
    const hidden = await get('/_kura/?probe=' + encodeURIComponent('/volume1/@appstore'))
    expect(hidden.body).toContain('不可见')
    expect(hidden.body).toContain('被排除规则')
  })

  it('目录选择器：只列子目录，不列文件', async () => {
    mkdirSync(join(dir, 'volume1', '照片'), { recursive: true })
    mkdirSync(join(dir, 'volume1', '@appstore'), { recursive: true })
    writeFileSync(join(dir, 'volume1', 'readme.txt'), 'x')
    const res = await get('/_kura/api/browse?path=/volume1')
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as { path: string; entries: Array<{ name: string; path: string }>; truncated: boolean }
    expect(parsed.path).toBe('/volume1')
    expect(parsed.entries.map((e) => e.name).sort()).toEqual(['@appstore', '照片'])
    expect(parsed.entries.every((e) => e.path.startsWith('/volume1/'))).toBe(true)
    expect(parsed.truncated).toBe(false)
  })

  it('目录选择器：没放行的目录照样列得出来（这正是它存在的理由）', async () => {
    await json('/_kura/api/scope', { include: ['/home'], exclude: [] })
    mkdirSync(join(dir, 'volume2'), { recursive: true })
    // WebDAV 视图里 /volume2 不存在，但在范围**之外**挑目录时正需要它
    const res = await get('/_kura/api/browse?path=/')
    expect(res.status).toBe(200)
    expect((JSON.parse(res.body) as { entries: Array<{ name: string }> }).entries.map((e) => e.name)).toContain('volume2')
  })

  it('目录选择器：越界一律拒绝', async () => {
    expect((await get('/_kura/api/browse?path=/../etc')).status).toBe(400)
    expect((await get('/_kura/api/browse?path=/no-such-dir')).status).toBe(400)
    writeFileSync(join(dir, 'a-file.txt'), 'x')
    expect((await get('/_kura/api/browse?path=/a-file.txt')).status).toBe(400)
  })

  it('加服务：写进 services.json 并出现在页面上', async () => {
    const res = await post('/_kura/services/add', { name: 'openlist', backend: 'http://openlist:5244' })
    expect(res.status).toBe(302)
    expect(registry.find('openlist')?.backend).toBe('http://openlist:5244')
    expect((await get('/_kura/')).body).toContain('openlist')
    // 非法名字被拒
    await post('/_kura/services/add', { name: 'Bad Name', backend: 'http://x' })
    expect(registry.find('Bad Name')).toBeUndefined()
  })

  it('删服务', async () => {
    await post('/_kura/services/add', { name: 'hermes', backend: 'http://hermes:8080' })
    await post('/_kura/services/delete', { name: 'hermes' })
    expect(registry.find('hermes')).toBeUndefined()
  })

  it('API Token：生成后能在页面上看到，也能吊销（且 Token 不进 URL）', async () => {
    const created = await post('/_kura/tokens/create', { label: '我的脚本' })
    // Token 不能出现在跳转地址里：会留在浏览器历史、反代与访问日志中
    expect(created.headers.get('location')).not.toContain('nsc_')
    const token = tokens.list()[0]!.token
    expect((await get('/_kura/')).body).toContain(token)
    await post('/_kura/tokens/revoke', { token })
    expect(tokens.list()).toHaveLength(0)
  })

})

describe('页面模板', () => {
  it('主页转义用户可控的内容（防 XSS）', () => {
    const html = adminPage({
      webdav: { limits: () => ({ include: ['/volume1'], exclude: [], readOnly: false }), status: () => ({ running: true, error: '', uptimeMs: 1000, restarts: 0, upstreamError: '' }) } as unknown as WebdavFeature,
      registry: { list: () => [{ name: '<img src=x onerror=alert(1)>', backend: 'http://x', rewriteRedirect: false }], error: () => '' } as unknown as Registry,
      tokens: new TokenStore(undefined),
      audit: [],
      shellAlive: false,
    })
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img')
  })

  it('服务名里的引号不能从内联 JS 字符串里逃出来', () => {
    // escapeHtml 会把 ' 变成 &#39;，但浏览器解析内联事件属性时会先还原成 '，于是闭合 JS 字符串
    const payload = "');alert(1);//"
    const html = adminPage({
      webdav: { limits: () => ({ include: ['/volume1'], exclude: [], readOnly: false }), status: () => ({ running: true, error: '', uptimeMs: 1000, restarts: 0, upstreamError: '' }) } as unknown as WebdavFeature,
      registry: { list: () => [{ name: payload, backend: 'http://x', rewriteRedirect: false }], error: () => '' } as unknown as Registry,
      tokens: new TokenStore(undefined),
      audit: [],
      shellAlive: false,
    })
    // 服务名不再插进内联 JS：确认文案放在 data-confirm，由 this.dataset 读，不参与 JS 解析
    expect(html).not.toContain(`confirm('删除服务`)
    expect(html).toContain('data-confirm=')
    // 原始单引号序列不以可执行的形式存在
    expect(html).not.toContain("');alert(1);//")
  })
})
