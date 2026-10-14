import http from 'node:http'
import type { Registry } from './registry.js'
import type { AuditEntry } from './shell/audit.js'
import type { TokenStore } from './tokens.js'
import type { WebdavFeature } from './webdav.js'
import { excludeMatches, normalizeDavPath, normalizeRules, visibilityOf, type DavScope } from '../../src/core/dav-scope.js'
import type { DavLimits } from '../../src/core/dav-server.js'
import { defaultWebdavLimits } from './webdav.js'
import { errorMessage } from '../../src/core/errors.js'

/**
 * 管理页 `/_kura/`（服务端渲染 + 无前端库，沿用 files-admin 那套做法）。
 *
 * 管的东西：WebDAV 暴露范围、服务清单、API Token、状态与最近审计。
 * **不再有登录**：kura-server 自己不做认证（见 server.ts 顶部的说明），管理页跟着一起打开。
 *
 * 为什么范围这块要在这里重做一遍「可见性自检」：客户端那页只能算**本机 WebDAV** 的范围，
 * 服务端的范围是另一份（`state/webdav.json`），得能在 NAS 上直接看。算法是同一份 `dav-scope`。
 */

export interface AdminOptions {
  registry: Registry
  webdav: WebdavFeature
  tokens: TokenStore
  /** 最近审计，从 shell 那边的 audit.log 读；返回最近 n 条 */
  auditTail: (limit: number) => AuditEntry[]
  /** kura-shell 在不在（拿 health 探） */
  shellAlive?: () => Promise<boolean>
  log?: (message: string, fields?: Record<string, unknown>) => void
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const page = (title: string, body: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#1a1620; --card:#241f2e; --line:#3a3346; --fg:#ece8f2; --dim:#9c93ac; --accent:#c78ef0; --ok:#7ec98a; --warn:#e0b96a; --err:#e8838b; }
  * { box-sizing: border-box; } body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 12px; color:var(--accent); }
  .sub { color:var(--dim); margin:0 0 20px; } .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); max-width:1100px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  label { display:block; color:var(--dim); font-size:12px; margin:10px 0 4px; }
  input,textarea,select { width:100%; padding:8px 10px; background:#171320; color:var(--fg); border:1px solid var(--line); border-radius:6px; font:inherit; }
  textarea { min-height:74px; font-family:ui-monospace,Consolas,monospace; font-size:12px; resize:vertical; }
  button { margin-top:12px; padding:8px 14px; background:var(--accent); color:#1a1620; border:0; border-radius:6px; font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--line); }
  code { background:#171320; padding:1px 5px; border-radius:4px; font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .note { color:var(--dim); font-size:12px; margin:8px 0 0; } .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; }
  .ok { background:rgba(126,201,138,.15); color:var(--ok); } .warn { background:rgba(224,185,106,.15); color:var(--warn); } .err { background:rgba(232,131,139,.15); color:var(--err); }
  table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); } th { color:var(--dim); font-weight:500; }
  .row { display:flex; gap:8px; align-items:flex-end; } .row > * { flex:1; } .row > button { flex:0 0 auto; }
  .flash { margin:0 0 16px; padding:10px 14px; border-radius:8px; max-width:1100px; }
</style></head><body>${body}</body></html>`

/** 管理页没有登录，也没有 `rd` 参数。 */
function scopeSelfCheck(scope: DavScope, path: string): string {
  let normalized: string
  try {
    normalized = normalizeDavPath(path)
  } catch (error) {
    return `<p class="note">${escapeHtml(errorMessage(error))}</p>`
  }
  const { visibility, reason } = visibilityOf(normalized, scope)
  const badge = visibility === 'full' ? 'ok' : visibility === 'ancestor' ? 'warn' : 'err'
  const label = visibility === 'full' ? '可见 · 可写' : visibility === 'ancestor' ? '仅路过' : '不可见'
  return `<p class="note"><span class="badge ${badge}">${label}</span> <code>${escapeHtml(normalized)}</code> ${escapeHtml(reason)}</p>`
}

export function adminPage(options: {
  webdav: WebdavFeature
  registry: Registry
  tokens: TokenStore
  audit: AuditEntry[]
  shellAlive: boolean | undefined
  flash?: string
  error?: string
  probe?: string
}): string {
  const limits = options.webdav.limits()
  const status = options.webdav.status()
  const tokenRows = options.tokens
    .list()
    .map(
      (t) =>
        `<tr><td><code>${escapeHtml(t.token)}</code></td><td>${escapeHtml(t.label)}</td><td>${escapeHtml(t.createdAt.slice(0, 19).replace('T', ' '))}</td>
         <td><form method="post" action="/_kura/tokens/revoke" onsubmit="return confirm('吊销这个 Token？用了它的脚本会立刻失效。')"><input type="hidden" name="token" value="${escapeHtml(t.token)}"><button class="ghost" style="margin:0;padding:4px 10px">吊销</button></form></td></tr>`,
    )
    .join('') || '<tr><td colspan="4" class="note">还没有 Token</td></tr>'

  const serviceRows = options.registry
    .list()
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.name)}</td><td><code>${escapeHtml(s.backend)}</code></td><td>${s.rewriteRedirect ? '是' : ''}</td>
         <td><form method="post" action="/_kura/services/delete" onsubmit="return confirm(this.dataset.confirm)" data-confirm="删除服务 ${escapeHtml(s.name)}？"><input type="hidden" name="name" value="${escapeHtml(s.name)}"><button class="ghost" style="margin:0;padding:4px 10px">删除</button></form></td></tr>`,
    )
    .join('') || '<tr><td colspan="4" class="note">没有配置额外的应用</td></tr>'

  const auditRows = options.audit
    .map((a) => `<tr><td>${escapeHtml(String(a.at ?? '').slice(0, 19).replace('T', ' '))}</td><td>${escapeHtml(String(a.action ?? ''))}</td><td>${escapeHtml(String(a.user ?? ''))}</td><td><code>${escapeHtml(String(a.detail ?? '').slice(0, 80))}</code></td><td>${a.exitCode === undefined ? '' : escapeHtml(String(a.exitCode))}</td></tr>`)
    .join('') || '<tr><td colspan="5" class="note">没有记录</td></tr>'

  const shellBadge = options.shellAlive === undefined ? '<span class="badge warn">未配置</span>' : options.shellAlive ? '<span class="badge ok">连通</span>' : '<span class="badge err">连不上</span>'

  return page(
    'Kura 管理',
    `<h1>Kura 管理</h1><p class="sub">kura-server${options.registry.error() ? ` · <span class="badge err">清单有错：${escapeHtml(options.registry.error())}</span>` : ''}</p>
    ${options.flash ? `<div class="flash ok">${escapeHtml(options.flash)}</div>` : ''}
    ${options.error ? `<div class="flash err">${escapeHtml(options.error)}</div>` : ''}
    <div class="grid">
      <section>
        <h2>状态</h2>
        <p>rclone：${status.running ? `<span class="badge ok">在跑</span>（${Math.round(status.uptimeMs / 1000)} 秒，重启 ${status.restarts} 次）` : `<span class="badge err">没在跑</span>`}</p>
        ${status.error ? `<p class="note">${escapeHtml(status.error)}</p>` : ''}
        ${status.upstreamError ? `<p class="note">上游：${escapeHtml(status.upstreamError)}</p>` : ''}
        <p>kura-shell：${shellBadge}</p>
        <p>清单服务数：${options.registry.list().length}</p>
      </section>

      <section>
        <h2>WebDAV 暴露范围</h2>
        <form method="post" action="/_kura/scope">
          <label>放行目录（每行一个）</label>
          <textarea name="include" spellcheck="false">${escapeHtml(limits.include.join('\n'))}</textarea>
          <label>排除目录（每行一个，优先于放行；支持 <code>*</code> 通配，如 <code>/volume1/@*</code>）</label>
          <textarea name="exclude" spellcheck="false">${escapeHtml(limits.exclude.join('\n'))}</textarea>
          <label><input type="checkbox" name="readOnly" value="1" ${limits.readOnly ? 'checked' : ''} style="width:auto"> 只读（外部程序只能看不能改）</label>
          <button type="submit">保存范围</button>
          <p class="note">改完立即生效，不用重启 rclone。</p>
        </form>
      </section>

      <section>
        <h2>可见性自检</h2>
        <form method="post" action="/_kura/probe">
          <label>NAS 路径</label><input name="path" value="${escapeHtml(options.probe ?? '')}" spellcheck="false" placeholder="/volume1/照片">
          <button type="submit">检查</button>
        </form>
        ${options.probe ? scopeSelfCheck(limits, options.probe) : ''}
      </section>

      <section>
        <h2>服务清单</h2>
        <table><thead><tr><th>名字</th><th>后端</th><th>改写跳转</th><th></th></tr></thead><tbody>${serviceRows}</tbody></table>
        <form method="post" action="/_kura/services/add">
          <label>加一个应用</label>
          <div class="row"><input name="name" placeholder="名字（小写字母数字连字符）"><input name="backend" placeholder="http://容器名:端口"></div>
          <label><input type="checkbox" name="rewriteRedirect" value="1" style="width:auto"> 应用会发绝对路径跳转（如 hermes）</label>
          <button type="submit">添加</button>
        </form>
      </section>

      <section>
        <h2>API Token</h2>
        <p class="note">给脚本 / AI 调 <code>POST /api/exec</code> 用。请求头带 <code>Authorization: Bearer nsc_…</code>。</p>
        <table><thead><tr><th>Token</th><th>用途</th><th>创建</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table>
        <form method="post" action="/_kura/tokens/create">
          <label>新建 Token</label><input name="label" placeholder="用途备注">
          <button type="submit">生成</button>
        </form>
      </section>

      <section style="grid-column:1/-1">
        <h2>最近审计</h2>
        <table><thead><tr><th>时间</th><th>动作</th><th>用户</th><th>命令 / shell</th><th>退出码</th></tr></thead><tbody>${auditRows}</tbody></table>
      </section>
    </div>`,
  )
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** `/_kura/api/scope` 的请求体：客户端提交的**完整**范围（include/exclude 都按现状发全）。 */
interface ScopePayload {
  include?: unknown
  exclude?: unknown
  readOnly?: boolean
}

const maxRules = 200

/**
 * 校验并规范化客户端提交的范围。
 *
 * 是**整体替换**，不是增量合并：客户端那页是个全量列表编辑器，用户删掉一条再保存必须真的删掉 ——
 * 用合并的话「删除」这类操作会静默失效，这是最难发现的一类 bug。
 */
export function resolveScope(current: DavLimits, payload: ScopePayload): DavLimits {
  const strings = (key: 'include' | 'exclude'): string[] => {
    const raw = payload[key]
    if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) throw new Error(`${key} 必须是字符串数组`)
    return normalizeRules(raw as string[])
  }
  const include = strings('include')
  const exclude = strings('exclude')
  if (include.length === 0) throw new Error('至少要放行一个目录')
  if (include.length > maxRules || exclude.length > maxRules) throw new Error(`规则太多（每类最多 ${maxRules} 条）`)
  return { include, exclude, readOnly: payload.readOnly ?? current.readOnly }
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body)
}

export interface AdminHandler {
  handle(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void>
}

export function createAdminHandler(options: AdminOptions): AdminHandler {
  const log = options.log ?? (() => {})
  const redirect = (res: http.ServerResponse, location: string): void => {
    res.writeHead(302, { location, 'cache-control': 'no-store' })
    res.end()
  }
  const html = (res: http.ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> => {
    const query = new URL(req.url ?? '/', 'http://kura-server').searchParams
    const readBodyText = (): Promise<string> =>
      new Promise((resolve, reject) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => resolve(body))
        req.on('error', reject)
      })

    if (path === '/' || path === '') {
      if (req.method === 'GET') {
        html(
          res,
          200,
          adminPage({
            webdav: options.webdav,
            registry: options.registry,
            tokens: options.tokens,
            audit: options.auditTail(50),
            shellAlive: options.shellAlive ? await options.shellAlive() : undefined,
            probe: query.get('probe') ?? undefined,
            flash: query.get('ok') ?? undefined,
            error: query.get('err') ?? undefined,
          }),
        )
        return
      }
      redirect(res, '/_kura/')
      return
    }

    if (path === '/scope' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      try {
        options.webdav.setLimits({
          include: normalizeRules(parseLines(form.get('include') ?? '')),
          exclude: normalizeRules(parseLines(form.get('exclude') ?? '')),
          readOnly: form.get('readOnly') === '1',
        })
        log('管理页改了 WebDAV 范围')
        redirect(res, '/_kura/?ok=' + encodeURIComponent('范围已保存，立即生效'))
      } catch (error) {
        redirect(res, '/_kura/?err=' + encodeURIComponent(errorMessage(error)))
      }
      return
    }

    // 客户端「文件」页要能在应用里改同一份范围，所以给一个 JSON 接口。
    // 上面那个 form 版本给浏览器直接用；两者读写的是同一处 `state/webdav.json`。
    if (path === '/api/scope' && req.method === 'GET') {
      json(res, 200, { limits: options.webdav.limits(), defaults: defaultWebdavLimits })
      return
    }
    if (path === '/api/scope' && req.method === 'POST') {
      let body: unknown
      try {
        body = JSON.parse(await readBodyText())
      } catch {
        json(res, 400, { error: '请求体不是 JSON' })
        return
      }
      try {
        options.webdav.setLimits(resolveScope(options.webdav.limits(), body as ScopePayload))
        log('客户端改了 WebDAV 范围')
        // 形状与 GET 一致（也带 defaults）：客户端的解析器两种响应走同一份，缺字段会被当成「不是 kura-server」
        json(res, 200, { limits: options.webdav.limits(), defaults: defaultWebdavLimits })
      } catch (error) {
        json(res, 400, { error: errorMessage(error) })
      }
      return
    }

    if (path === '/probe' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      redirect(res, '/_kura/?probe=' + encodeURIComponent(form.get('path') ?? ''))
      return
    }

    if (path === '/services/add' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      const name = (form.get('name') ?? '').trim()
      const backend = (form.get('backend') ?? '').trim()
      if (!name || !backend) {
        redirect(res, '/_kura/?err=' + encodeURIComponent('名字和后端都要填'))
        return
      }
      try {
        const next = [...options.registry.list().filter((s) => s.name !== name), { name, backend, rewriteRedirect: form.get('rewriteRedirect') === '1' }]
        options.registry.save(next)
        log('管理页加了服务', { 服务: name })
        redirect(res, '/_kura/?ok=' + encodeURIComponent(`已添加 ${name}`))
      } catch (error) {
        redirect(res, '/_kura/?err=' + encodeURIComponent(errorMessage(error)))
      }
      return
    }

    if (path === '/services/delete' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      const name = form.get('name') ?? ''
      options.registry.save(options.registry.list().filter((s) => s.name !== name))
      log('管理页删了服务', { 服务: name })
      redirect(res, '/_kura/?ok=' + encodeURIComponent(`已删除 ${name}`))
      return
    }

    if (path === '/tokens/create' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      const record = options.tokens.create(form.get('label') ?? '')
      log('管理页生成了 API Token', { 用途: record.label })
      // Token 不放进 URL：会留在浏览器历史、反代与访问日志里。生成后它就在下面的表格里，看得到。
      redirect(res, '/_kura/?ok=' + encodeURIComponent('已生成，见下表'))
      return
    }

    if (path === '/tokens/revoke' && req.method === 'POST') {
      const form = parseForm(await readBodyText())
      options.tokens.revoke(form.get('token') ?? '')
      redirect(res, '/_kura/?ok=' + encodeURIComponent('已吊销'))
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没有这个页面')
  }

  return { handle }
}

export { excludeMatches }
