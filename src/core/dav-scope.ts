/**
 * 本机 WebDAV 的暴露范围：哪些 NAS 目录给本机其他程序看、能不能写。
 *
 * 语义沿用 files-admin（服务端那套勾选页，用户已经用熟了）：
 * 1. **排除优先**：落在任何一条排除规则下 → 不可见；
 * 2. **放行**：落在某条放行规则下 → 完全可见（可读，非只读时可写）；
 * 3. **通往放行目录的上级**也可见，但只能「路过」：列目录时只露出通往放行目录的那一支，不能写；
 * 4. 其余一律不可见（白名单兜底）。
 *
 * 和 rclone filters 的区别：这里按**路径前缀**判断，不是 glob —— 不存在「只写目录名不生效、
 * 必须写 /**」那个坑（files-admin 踩过两次）。规则里写目录本身就够了。
 */
export interface DavScope {
  include: readonly string[]
  exclude: readonly string[]
}

export type Visibility = 'full' | 'ancestor' | 'hidden'

export interface VisibilityResult {
  visibility: Visibility
  /** 由哪条规则决定的，给「可见性自检」显示 */
  reason: string
}

/**
 * 规范化一个 WebDAV 路径：以 / 开头、去掉多余斜杠与结尾斜杠。
 * 含 `..` 或 `.` 段直接拒绝 —— 不解析，避免「规范化后跑到范围外」这类越界。
 */
export function normalizeDavPath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/')
  const segments = raw.split('/').filter((s) => s !== '')
  if (segments.some((s) => s === '..' || s === '.')) throw new Error(`路径里不能有 . 或 ..：${input}`)
  return '/' + segments.join('/')
}

/** path 是否就是 root、或在 root 之下（按段比较，/volume10 不在 /volume1 之下）。 */
export function isUnder(path: string, root: string): boolean {
  if (root === '/') return true
  return path === root || path.startsWith(root + '/')
}

/** 规范化并去重一组规则；非法的抛出（界面上逐条报错）。 */
export function normalizeRules(rules: readonly string[]): string[] {
  const out: string[] = []
  for (const rule of rules) {
    const p = normalizeDavPath(rule)
    if (!out.includes(p)) out.push(p)
  }
  return out.sort()
}

export function visibilityOf(path: string, scope: DavScope): VisibilityResult {
  const p = normalizeDavPath(path)
  const excluded = scope.exclude.find((rule) => isUnder(p, rule))
  if (excluded) return { visibility: 'hidden', reason: `被排除规则 ${excluded} 挡住` }
  const included = scope.include.find((rule) => isUnder(p, rule))
  if (included) return { visibility: 'full', reason: `在放行目录 ${included} 之内` }
  // 是某个（本身没被排除的）放行目录的上级：可以路过
  const leadsTo = scope.include.find((rule) => isUnder(rule, p) && !scope.exclude.some((ex) => isUnder(rule, ex)))
  if (leadsTo) return { visibility: 'ancestor', reason: `是放行目录 ${leadsTo} 的上级，只露出通往它的路径、不能写` }
  return { visibility: 'hidden', reason: '不在任何放行目录里（白名单兜底）' }
}

/**
 * 某个写操作（PUT / MKCOL / DELETE / MOVE / COPY 目标 / PROPPATCH / LOCK）能不能落在这个路径上。
 * 放行目录**本身**不能删、不能挪走：那等于把整块暴露面连根拔掉，外部程序不该有这个权力。
 */
export function writeDenial(path: string, scope: DavScope, readOnly: boolean, method: string): string | undefined {
  if (readOnly) return '本机 WebDAV 设为只读'
  const p = normalizeDavPath(path)
  const { visibility } = visibilityOf(p, scope)
  if (visibility !== 'full') return '不在可写范围内'
  if ((method === 'DELETE' || method === 'MOVE') && scope.include.includes(p)) return '放行目录本身不能删除或移走'
  return undefined
}
