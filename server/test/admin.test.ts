import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../src/shell/audit.js'
import { adminPage, createAdminHandler, loginPage } from '../src/admin.js'
import { Auth } from '../src/auth.js'
import { hashPassword } from '../src/password.js'
import { Registry } from '../src/registry.js'
import { createKuraServer } from '../src/server.js'
import { TokenStore } from '../src/tokens.js'
import { WebdavFeature, webdavDefaults } from '../src/webdav.js'

/**
 * S4 判据：范围、清单、Token 都能在页面上改。
 * 用真 kura-server（含 admin 路由）跑一遍登录 → 改范围 → 加服务 → 建 Token 的完整流程。
 */

let server: http.Server
let base = ''
let dir = ''
let webdav: WebdavFeature
let registry: Registry
let tokens: TokenStore
const user = 'gw'
const password = 's3cret'
let cookie = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kura-admin-'))
  const auth = new Auth({ user, passwordHash: await hashPassword(password, { memory: 1024, passes: 1, parallelism: 1 }) })
  registry = new Registry(join(dir, 'services.json'), { webdav: 18005, 'nas-console': 8890 })
  registry.save([])
  webdav = new WebdavFeature({ settings: { ...webdavDefaults, port: 1 }, settingsFile: join(dir, 'webdav.json') })
  tokens = new TokenStore(join(dir, 'tokens.json'))
  const audit = new AuditLog(join(dir, 'audit.log'))
  const admin = createAdminHandler({ auth, registry, webdav, tokens, auditTail: (n) => audit.tail(n), shellAlive: async () => true })
  server = createKuraServer({ auth, registry, admin })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // 登录拿 cookie
  const res = await fetch(`${base}/_kura/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: user, password, rd: '/_kura/' }), redirect: 'manual' })
  cookie = res.headers.getSetCookie()[0]!.split(';')[0]!
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> =>
  fetch(`${base}${path}`, { headers: { cookie, ...headers }, redirect: 'manual' }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.text() }))
const post = (path: string, form: Record<string, string>): Promise<{ status: number; headers: Headers }> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'manual' }).then((r) => ({ status: r.status, headers: r.headers }))

describe('管理页', () => {
  it('未登录：浏览器 302 去登录页；登录页能打开', async () => {
    const anon = await fetch(`${base}/_kura/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toContain('/_kura/login?rd=')
    const page = await fetch(`${base}/_kura/login`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('用 NAS 网关账号登录')
  })

  it('密码错：登录页带错误，不发 cookie', async () => {
    const res = await fetch(`${base}/_kura/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: user, password: 'nope' }), redirect: 'manual' })
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(await res.text()).toContain('Authentication failed')
  })

  it('登录后页面渲染出范围、清单、Token、审计四块', async () => {
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

  it('退出登录：清 cookie 回登录页', async () => {
    const res = await post('/_kura/logout', {})
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/_kura/login')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('页面模板', () => {
  it('登录页与主页都转义用户可控的内容（防 XSS）', () => {
    expect(loginPage('/_kura/', '<script>')).toContain('&lt;script&gt;')
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
