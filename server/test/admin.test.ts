import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const admin = createAdminHandler({ registry, webdav, tokens, auditTail: (n) => audit.tail(n), shellAlive: async () => true })
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

  it('可见性自检：算出这条路径可见不可见、哪条规则决定的', async () => {
    await post('/_kura/scope', { include: '/volume1', exclude: '/volume1/@*' })
    const visible = await get('/_kura/?probe=' + encodeURIComponent('/volume1/照片'))
    expect(visible.body).toContain('可见 · 可写')
    const hidden = await get('/_kura/?probe=' + encodeURIComponent('/volume1/@appstore'))
    expect(hidden.body).toContain('不可见')
    expect(hidden.body).toContain('被排除规则')
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

  it('API Token：生成后能在页面上看到，也能吊销', async () => {
    const created = await post('/_kura/tokens/create', { label: '我的脚本' })
    expect(created.headers.get('location')).toContain('nsc_')
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
})
