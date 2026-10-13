import { constants, publicEncrypt } from 'node:crypto'
import { headerValue, request as defaultRequest, type HttpRequester } from './http.js'

/**
 * 绿联外网链路的三步（全部来自实测，改动前先看 docs/参考/nas-mirror/设计方案.md）：
 *
 *   ① POST /ugreen/v1/verify/check   取 RSA 公钥（响应头 X-Rsa-Token）
 *   ② POST /ugreen/v1/verify/login   密码 RSA 加密后登录 → api_token
 *   ③ GET  /ugreen/v1/gateway/proxy/dockerToken?port=N&token=<api_token>
 *      → redirect_url，访问一次即可从 HTML 里提取 ugreen-proxy-token
 */
export interface UgreenCredentials {
  /** 设备域，形如 https://<设备>.cn30.ug.link */
  base: string
  username: string
  password: string
}

interface ApiEnvelope<T> {
  code: number
  msg: string
  data?: T
}

function parseEnvelope<T>(body: Buffer, op: string): ApiEnvelope<T> {
  try {
    return JSON.parse(body.toString('utf8')) as ApiEnvelope<T>
  } catch (error) {
    throw new Error(`${op}响应无法解析：${(error as Error).message}`)
  }
}

/**
 * ugreen-proxy-token 是不透明令牌（实测 36 字符 UUID）。刻意不限死成十六进制：
 * 格式由中继决定；万一匹配错了，下一步请求会被 302 踢回登录页，立刻暴露。
 */
const ssoCookieRe = /ugreen-proxy-token=([A-Za-z0-9._~-]{8,})/

export class UgreenClient {
  readonly base: string
  private readonly username: string
  private readonly password: string
  private readonly request: HttpRequester

  constructor(credentials: UgreenCredentials, request: HttpRequester = defaultRequest) {
    this.base = credentials.base.replace(/\/+$/, '')
    this.username = credentials.username
    this.password = credentials.password
    this.request = request
  }

  /** 完成 ① ② 两步，返回 api_token。 */
  async login(): Promise<string> {
    let check
    try {
      check = await this.request({
        url: `${this.base}/ugreen/v1/verify/check`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.username }),
        timeoutMs: 60_000,
      })
    } catch (error) {
      throw new Error(`请求 RSA 公钥失败：${(error as Error).message}`)
    }
    const rsaToken = headerValue(check.headers, 'x-rsa-token')
    if (!rsaToken) throw new Error(`未取到 X-Rsa-Token（HTTP ${check.status}）`)
    const encrypted = encryptPassword(this.password, rsaToken)

    let res
    try {
      res = await this.request({
        url: `${this.base}/ugreen/v1/verify/login`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: this.username,
          password: encrypted,
          // keepalive=true 显著延长 api_token 寿命：实测 false 的令牌在 1200s 已过期时 true 仍有效，
          // 且不改变响应里任何其他字段。客户端常驻，令牌活得久 = 登录次数少。
          keepalive: true,
          otp: false,
          is_simple: false,
        }),
        timeoutMs: 60_000,
      })
    } catch (error) {
      throw new Error(`登录请求失败：${(error as Error).message}`)
    }
    const env = parseEnvelope<{ token?: string }>(res.body, '登录')
    if (env.code !== 200) throw new Error(`登录 失败：code=${env.code} msg=${env.msg}`)
    const token = env.data?.token
    if (!token) throw new Error('登录成功但 api_token 为空')
    return token
  }

  /** 申请某个宿主端口的应用代理令牌，返回一次性授权页地址。 */
  async dockerToken(port: number, apiToken: string): Promise<string> {
    let res
    try {
      res = await this.request({
        url: `${this.base}/ugreen/v1/gateway/proxy/dockerToken?port=${port}&token=${encodeURIComponent(apiToken)}`,
        timeoutMs: 60_000,
      })
    } catch (error) {
      throw new Error(`申请代理令牌失败：${(error as Error).message}`)
    }
    const env = parseEnvelope<{ redirect_url?: string }>(res.body, '代理令牌')
    if (env.code !== 200) throw new Error(`申请代理令牌 失败：code=${env.code} msg=${env.msg}`)
    const redirect = env.data?.redirect_url
    if (!redirect) throw new Error('代理令牌响应里没有 redirect_url')
    return redirect
  }

  /**
   * 访问一次性授权页并提取 SSO cookie 的值。
   * ⚠️ 这个 URL 只能访问一次：重复访问拿不到令牌。授权页用 JS 写 cookie，没有 Set-Cookie 头。
   */
  async fetchSsoCookie(redirectUrl: string): Promise<string> {
    let res
    try {
      res = await this.request({ url: redirectUrl, timeoutMs: 60_000 })
    } catch (error) {
      throw new Error(`访问授权页失败：${(error as Error).message}`)
    }
    const match = ssoCookieRe.exec(res.body.toString('utf8'))
    if (!match?.[1]) throw new Error('未能从授权页提取 ugreen-proxy-token（该页一次性，重复访问即拿不到）')
    return match[1]
  }
}

/**
 * 用中继下发的公钥加密密码（RSA PKCS#1 v1.5）。
 *
 * 坑：X-Rsa-Token 解出来是 base64(PEM 文本)，PEM 标签写着 "RSA PUBLIC KEY"，
 * 里面装的却是 SubjectPublicKeyInfo。按标签当 PKCS#1 解析会失败，
 * 所以这里把标签换成 "PUBLIC KEY"（SPKI）再交给 node:crypto。
 */
export function encryptPassword(password: string, rsaToken: string): string {
  let pemText: string
  try {
    pemText = Buffer.from(rsaToken, 'base64').toString('utf8')
  } catch {
    throw new Error('X-Rsa-Token 不是合法 base64')
  }
  const body = /-----BEGIN [A-Z ]+-----([\s\S]+?)-----END [A-Z ]+-----/.exec(pemText)?.[1]
  if (!body) throw new Error('X-Rsa-Token 里没有 PEM 块')
  const spki = `-----BEGIN PUBLIC KEY-----${body}-----END PUBLIC KEY-----\n`
  try {
    return publicEncrypt({ key: spki, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64')
  } catch (error) {
    throw new Error(`RSA 加密密码失败：${(error as Error).message}`)
  }
}

/**
 * 由设备域推出某个端口的 DApp 域。
 *
 *   设备域：https://<设备>.cn30.ug.link
 *   DApp 域：https://app-<端口>-<设备>.cn30.ugdocker.link
 *
 * 坑：中继部分由 .ug.link 变成 .ugdocker.link，写成 .ug.link 会永远命中 errorPage。
 */
export function appBase(base: string, port: number): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`base 不是合法 URL：${JSON.stringify(base)}`)
  }
  const host = url.host
  const dot = host.indexOf('.')
  if (dot < 0) throw new Error(`base 主机名里没有中继域：${JSON.stringify(host)}`)
  const device = host.slice(0, dot)
  const node = host.slice(dot + 1)
  if (!node.endsWith('.ug.link')) {
    throw new Error(`base 的中继域不是 .ug.link：${JSON.stringify(node)}（只处理绿联外网域）`)
  }
  const dockerNode = node.slice(0, -'.ug.link'.length) + '.ugdocker.link'
  return `${url.protocol}//app-${port}-${device}.${dockerNode}`
}
