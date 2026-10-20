import { normalizeDavPath, visibilityOf, writeDenial, type DavScope } from './dav-scope.js'
import type { NasDirListing } from '../shared/ipc.js'

/**
 * NAS 侧那份 WebDAV 暴露范围（kura-server 的 `state/webdav.json`）。
 *
 * 客户端在「文件」页里直接改它：走统一网关打 `/_kura/api/scope`，与 NAS 管理页是同一份配置。
 * 这是**唯一**一份范围 —— 本机 WebDAV 那层不再有自己的放行/排除，否则文件页、Z: 盘、
 * 外部程序看到的范围会各不相同，排查时得同时看两处。
 *
 * 契约：整体替换。include / exclude 都要发全（客户端那页是全量列表编辑器，删一条得真的删掉）。
 */
export interface NasScopeView {
  include: string[]
  exclude: string[]
  readOnly: boolean
  /** 服务端代码里的默认范围，界面「恢复默认」直接用。 */
  defaults: { include: string[]; exclude: string[]; readOnly: boolean }
}

export interface NasScopeCheck {
  path: string
  visibility: 'full' | 'ancestor' | 'hidden'
  reason: string
  writable: boolean
}

/** 范围接口的地址（网关自己的接口，不是某个应用）。 */
export const scopeApiPath = '/_kura/api/scope'

/** 服务端 `/_kura/api/scope` 的响应形状：`{ limits, defaults }`，两边都是同一套字段。 */
interface ScopeLimits {
  include?: unknown
  exclude?: unknown
  readOnly?: unknown
}

interface ScopeResponse {
  limits?: ScopeLimits
  defaults?: ScopeLimits
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/**
 * 一段范围字段必须是「非空数组」。**不能退回空范围**：契约是整体替换，界面一旦拿到一段空范围
 * 又照常渲染成「范围是空的」，用户点保存就把服务端真实范围覆盖成空了。
 * `include` 更必须非空 —— 空等于放行一切（服务端 `resolveScope` 也据此回 400）。
 */
function requireScope(raw: unknown, what: string): { include: string[]; exclude: string[]; readOnly: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`服务端返回的${what}不是对象，可能不是 kura-server`)
  }
  const limits = raw as ScopeLimits
  if (!Array.isArray(limits.include) || limits.include.length === 0) {
    throw new Error(`服务端返回的${what}里没有放行目录，可能不是 kura-server`)
  }
  if (!Array.isArray(limits.exclude)) throw new Error(`服务端返回的${what}里没有排除字段，可能不是 kura-server`)
  return { include: stringList(limits.include), exclude: stringList(limits.exclude), readOnly: limits.readOnly === true }
}

/**
 * 把服务端返回的 JSON 收成界面用的形状。
 *
 * 注意是 `limits` 那一层，不是顶层 —— 读错层级会得到一个「空的当前范围」，
 * 界面上看起来像范围被清空了，再一保存就真把服务端的范围覆盖掉。所以读不到就**抛错**，
 * 让界面走「读不到范围」的提示，而不是拿一份空范围当真。
 */
export function parseScope(body: Buffer): NasScopeView {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('服务端返回的不是 JSON，可能不是 kura-server')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('服务端返回的不是范围对象，可能不是 kura-server')
  }
  const response = parsed as ScopeResponse
  return { ...requireScope(response.limits, '范围'), defaults: requireScope(response.defaults, '默认范围') }
}

/** 目录选择器用的接口。与范围接口一样走统一网关（同属 kura-server 自己的接口）。 */
export const browseApiPath = '/_kura/api/browse'

/**
 * 把 `GET /_kura/api/browse` 的响应收成界面用的形状。
 *
 * 与范围不同，这里拿到空列表**不是**危险信号（空目录就是空的），所以缺字段就当成空，
 * 不像 `parseScope` 那样抛错。但 `path` 要有：界面上要显示「当前在哪一层」，
 * 没有这个字段说明对面不是这个接口，得报出来而不是画一个空目录树。
 */
export function parseBrowse(body: Buffer): NasDirListing {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('服务端返回的不是 JSON，可能不是 kura-server')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('服务端返回的不是目录列表')
  }
  const raw = parsed as { path?: unknown; entries?: unknown; truncated?: unknown }
  if (typeof raw.path !== 'string') throw new Error('服务端返回的目录列表里没有 path，可能不是 kura-server')
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .filter((e): e is { name: string; path: string } => typeof e === 'object' && e !== null && typeof (e as { path?: unknown }).path === 'string')
        .map((e) => ({ name: typeof e.name === 'string' ? e.name : e.path.slice(e.path.lastIndexOf('/') + 1), path: e.path }))
    : []
  return { path: raw.path, entries, truncated: raw.truncated === true }
}

/** 按范围算一条路径可不可见、能不能写。算法与本机那套是同一份 `dav-scope`。 */
export function checkScope(scope: DavScope, readOnly: boolean, path: string): NasScopeCheck {
  const p = normalizeDavPath(path)
  const { visibility, reason } = visibilityOf(p, scope)
  return { path: p, visibility, reason, writable: !writeDenial(p, scope, readOnly, 'PUT') }
}
