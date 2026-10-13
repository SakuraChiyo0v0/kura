import { AuthRejectedError } from './errors.js'
import { request as defaultRequest, type HttpRequester } from './http.js'
import { parseSetCookie } from './cookies.js'

/** 从 Authelia 的失败文案里抠出封禁到期时间，供日志与状态展示。 */
const bannedUntilRe = /banned until ([0-9]{1,2}:[0-9]{2}:[0-9]{2}[AP]M on [A-Za-z]+ [0-9]{1,2} [0-9]{4})/

export function parseBannedUntil(message: string): string {
  return bannedUntilRe.exec(message)?.[1] ?? ''
}

export interface AutheliaLoginOptions {
  /** 网关地址：外网 https://app-<网关端口>-<设备>...，局域网 http://<NAS IP>:<网关端口> */
  gatewayBase: string
  /**
   * 非空时作为 Host 头发出。局域网模式必须这样：拨号地址是局域网 IP，
   * 但 Authelia 要求请求域匹配它配置的 session cookie 域（只登记了公网域名），否则 401。
   */
  hostHeader?: string
  /** 外网链路上要带的绿联会话；局域网直连时为空 */
  ugreenCookie?: string
  user: string
  password: string
}

/**
 * 用（可选的）绿联会话向网关上的 Authelia 登录，返回它下发的会话 cookie 片段。
 *
 * 为什么由客户端代登、而不是让用户在浏览器里登：Authelia 门户写死了公网域名，
 * 浏览器在门户里登录，cookie 会落在公网域上，本机 127.0.0.1 这一侧永远带不上。
 */
export async function autheliaLogin(
  options: AutheliaLoginOptions,
  request: HttpRequester = defaultRequest,
): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.ugreenCookie) headers.cookie = options.ugreenCookie

  let res
  try {
    res = await request({
      url: `${options.gatewayBase}/api/firstfactor`,
      method: 'POST',
      headers,
      host: options.hostHeader || undefined,
      body: JSON.stringify({
        username: options.user,
        password: options.password,
        targetURL: `${options.gatewayBase}/`,
        keepMeLoggedIn: true, // 用「记住我」换更长的会话，减少重新登录
      }),
      timeoutMs: 30_000,
      maxBody: 8192,
    })
  } catch (error) {
    throw new Error(`Authelia 登录请求失败：${(error as Error).message}`)
  }

  let result: { status?: string; message?: string } = {}
  try {
    result = JSON.parse(res.body.toString('utf8')) as typeof result
  } catch {
    // 非 JSON 响应按失败处理，下面会报出状态码
  }
  const status = result.status ?? ''
  if (res.status !== 200 || status !== 'OK') {
    const message = (result.message ?? '').trim()
    // 「凭据不对」和「被封禁」的正确处置都是停下来等人工处理，而不是继续敲门
    if (res.status === 401 || res.status === 403 || status === 'KO') {
      throw new AuthRejectedError(res.status, status, message, parseBannedUntil(message))
    }
    throw new Error(`Authelia 登录失败：HTTP ${res.status} status=${status} ${message}`.trimEnd())
  }

  // 可能下发多个 cookie（多域名时带 _<hash> 后缀），按前缀收集
  const raw = res.headers['set-cookie'] ?? []
  const pairs = raw
    .map(parseSetCookie)
    .filter((cookie): cookie is NonNullable<typeof cookie> => cookie !== null && cookie.name.startsWith('authelia'))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
  if (pairs.length === 0) throw new Error('Authelia 登录成功但没有下发会话 cookie')
  return pairs.join('; ')
}
