/** Cookie 与跳转地址的改写：反代把 NAS 的响应搬到 127.0.0.1 时必须做的几件事。 */

export interface SetCookie {
  name: string
  value: string
  /** 名值对之后的属性，保持原顺序，键名小写便于判断 */
  attributes: Array<{ key: string; raw: string }>
}

export function parseSetCookie(line: string): SetCookie | null {
  const [pair, ...attrs] = line.split(';')
  if (!pair) return null
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  if (!name) return null
  return {
    name,
    value: pair.slice(eq + 1).trim(),
    attributes: attrs
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => ({ key: (raw.split('=')[0] ?? '').trim().toLowerCase(), raw })),
  }
}

/**
 * 去掉 Domain 与 Secure，没有 Path 的补 Path=/。
 *
 * 后端下发的 cookie 带着 Domain=app-xxx.ugdocker.link 与 Secure，而浏览器此刻访问的是
 * http://127.0.0.1:<端口> —— 原样透传浏览器会直接丢弃，应用的登录态永远建立不起来。
 * 解析不了的行丢弃（与 Go 版一致）。
 */
export function rewriteSetCookie(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const cookie = parseSetCookie(line)
    if (!cookie) continue
    const kept = cookie.attributes.filter((attr) => attr.key !== 'domain' && attr.key !== 'secure')
    if (!kept.some((attr) => attr.key === 'path')) kept.push({ key: 'path', raw: 'Path=/' })
    out.push([`${cookie.name}=${cookie.value}`, ...kept.map((attr) => attr.raw)].join('; '))
  }
  return out
}

/**
 * 保留应用自己的 cookie，只替换客户端管理的那几个。
 *
 * 不能整体替换：openlist / nas-console 这类应用的登录态靠它们自己下的 cookie。
 * 按**名字**剔除入站里的同名项（续期后值会变，按值匹配会漏掉旧值）。
 */
export function mergeCookie(inbound: string, managed: string): string {
  const managedNames = new Set<string>()
  const managedPairs: string[] = []
  for (const raw of managed.split(';')) {
    const item = raw.trim()
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    managedNames.add(item.slice(0, eq).trim())
    managedPairs.push(item)
  }
  const parts: string[] = []
  for (const raw of inbound.split(';')) {
    const item = raw.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    const name = (eq < 0 ? item : item.slice(0, eq)).trim()
    if (managedNames.has(name)) continue
    parts.push(item)
  }
  return [...parts, ...managedPairs].join('; ')
}

/**
 * 把指向绿联域的绝对跳转改写成本机相对路径；不改写的话浏览器会跟着 Location 跑到公网域名、绕开客户端。
 * fragment 要接回去（中继的登录页地址就带 #）。
 */
export function rewriteLocation(location: string): string {
  if (!location) return location
  let url: URL
  try {
    url = new URL(location)
  } catch {
    return location // 相对路径，本来就在本机
  }
  if (!url.host.endsWith('.ugdocker.link') && !url.host.endsWith('.ug.link')) return location
  return url.pathname + url.search + url.hash
}

/** 中继判定「未认证」时把我们踢回去的地址特征。 */
export const authRedirectMarker = '/desktop/#/login/account'
/** 中继拒绝请求时返回的「假成功」：HTTP 200 + 一段跳转 errorPage 的 HTML。 */
export const errorPageMarker = 'ug.link/errorPage'

export function isAuthRedirect(status: number, location: string): boolean {
  return (status === 302 || status === 301) && location.includes(authRedirectMarker)
}
