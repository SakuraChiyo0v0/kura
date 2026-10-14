import { normalizeDavPath, visibilityOf, writeDenial, type DavScope } from './dav-scope.js'

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
 * 把服务端返回的 JSON 收成界面用的形状；缺字段就退成空/默认，不抛错。
 *
 * 注意是 `limits` 那一层，不是顶层 —— 读错层级会得到一个「空的当前范围」，
 * 界面上看起来像范围被清空了，再一保存就真把服务端的范围覆盖掉。
 */
export function parseScope(body: Buffer): NasScopeView {
  let parsed: ScopeResponse
  try {
    parsed = JSON.parse(body.toString('utf8')) as ScopeResponse
  } catch {
    throw new Error('服务端返回的不是 JSON，可能不是 kura-server')
  }
  const limits = parsed.limits ?? {}
  const defaults = parsed.defaults ?? {}
  return {
    include: stringList(limits.include),
    exclude: stringList(limits.exclude),
    readOnly: limits.readOnly === true,
    defaults: {
      include: stringList(defaults.include),
      exclude: stringList(defaults.exclude),
      readOnly: defaults.readOnly === true,
    },
  }
}

/** 按范围算一条路径可不可见、能不能写。算法与本机那套是同一份 `dav-scope`。 */
export function checkScope(scope: DavScope, readOnly: boolean, path: string): NasScopeCheck {
  const p = normalizeDavPath(path)
  const { visibility, reason } = visibilityOf(p, scope)
  return { path: p, visibility, reason, writable: !writeDenial(p, scope, readOnly, 'PUT') }
}
