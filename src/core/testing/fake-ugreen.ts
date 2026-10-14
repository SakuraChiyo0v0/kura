import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 2048 位 RSA 密钥每生成一次要几百毫秒；每个测试都新建一对，并行跑时会把用例拖过超时。
 * 同一进程共用一对就够了 —— 测的是加密链路，不是密钥本身。
 */
let keys: { privateKey: KeyObject; publicPemB64: string } | undefined
function sharedKeys() {
  if (!keys) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    // 真实服务端就这样：PEM 标签写 RSA PUBLIC KEY，内容却是 SubjectPublicKeyInfo
    const mislabeled = spki.replace(/PUBLIC KEY/g, 'RSA PUBLIC KEY')
    keys = { privateKey: pair.privateKey, publicPemB64: Buffer.from(mislabeled).toString('base64') }
  }
  return keys
}

/**
 * 模拟绿联中继三个接口 + 网关的 /__services，按真实行为实现（对应 Go 版 fakeUGreen）：
 * - RSA 加密的密码必须能被私钥解开，否则登录失败
 * - 公钥 PEM 标签写 "RSA PUBLIC KEY"，内容却是 SubjectPublicKeyInfo（真实服务端就这样）
 * - 一次性授权页用 JS 写 cookie，没有 Set-Cookie 头
 * - api_token 对不上就返回 1024
 *
 * kura-server 不做认证，所以这里**没有** Authelia 登录那一段了。
 */
export class FakeUgreen {
  readonly server: http.Server
  url = ''
  private readonly privateKey: KeyObject
  private readonly publicPemB64: string

  receivedUser = ''
  receivedPass = ''
  receivedKeepalive = false
  tokenSeq = 0
  loginCount = 0
  /** 绿联登录返回什么：ok / error（500，链路故障） */
  loginMode: 'ok' | 'error' = 'ok'
  dockerAttempts = 0
  /** 下一次 dockerToken 返回这个错误码（0 表示正常） */
  failNextDocker = 0
  redirectHits = new Map<string, number>()
  servicesBody = '{"services":[]}'
  servicesRequests = 0
  /** UGREENlink ID 查询：认识的 ID（空串 = 一律回「ID 不存在」7022） */
  uglinkAlias = ''
  uglinkRelay = 'cn30.ug.link'
  uglinkIpv4: string[] = []
  uglinkLookups = 0

  constructor() {
    const keys = sharedKeys()
    this.privateKey = keys.privateKey
    this.publicPemB64 = keys.publicPemB64
    this.server = http.createServer((req, res) => void this.handle(req, res))
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  currentToken(): string {
    return `TOKEN-${this.tokenSeq}`
  }

  private json(res: http.ServerResponse, code: number, msg: string, data?: unknown): void {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(data === undefined ? { code, msg } : { code, msg, data }))
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake')
    switch (url.pathname) {
      // 绿联云的 ID 查询接口（不在设备域上，走 api.ugnas.com）
      case '/api/p2p/v2/ta/nodeInfo/byAlias': {
        this.uglinkLookups += 1
        const { alias } = JSON.parse(await this.readBody(req)) as { alias?: string }
        if (!this.uglinkAlias || alias !== this.uglinkAlias) {
          this.json(res, 7022, 'UGREENlink ID不存在')
          return
        }
        this.json(res, 200, 'SUCCESS', {
          alias: this.uglinkAlias,
          relayDomain: this.uglinkRelay,
          netInfo: { ipv4: this.uglinkIpv4 },
        })
        return
      }
      case '/ugreen/v1/verify/check':
        res.setHeader('X-Rsa-Token', this.publicPemB64)
        res.end()
        return
      case '/ugreen/v1/verify/login': {
        const body = JSON.parse(await this.readBody(req)) as { username: string; password: string; keepalive: boolean }
        if (this.loginMode === 'error') {
          // 链路故障的真实样子：nginx 的 5xx 页面
          res.statusCode = 502
          res.end('<html><body>502 Bad Gateway</body></html>')
          return
        }
        let plain: string
        try {
          plain = privateDecrypt(
            { key: this.privateKey, padding: constants.RSA_PKCS1_PADDING },
            Buffer.from(body.password, 'base64'),
          ).toString('utf8')
        } catch {
          this.json(res, 1003, 'decrypt failed') // 明文提交或密钥不匹配
          return
        }
        this.receivedUser = body.username
        this.receivedPass = plain
        this.receivedKeepalive = body.keepalive
        this.tokenSeq += 1
        this.loginCount += 1
        this.json(res, 200, 'ok', { token: this.currentToken(), role: 'admin' })
        return
      }
      case '/ugreen/v1/gateway/proxy/dockerToken': {
        this.dockerAttempts += 1
        if (this.failNextDocker !== 0) {
          const code = this.failNextDocker
          this.failNextDocker = 0
          this.json(res, code, 'Login has expired, please login again!')
          return
        }
        if (url.searchParams.get('token') !== this.currentToken()) {
          this.json(res, 1024, 'Login has expired, please login again!')
          return
        }
        const port = url.searchParams.get('port') ?? ''
        this.json(res, 200, 'ok', { redirect_url: `${this.url}/redirect?port=${port}`, token: 'once' })
        return
      }
      case '/redirect': {
        const port = url.searchParams.get('port') ?? ''
        this.redirectHits.set(port, (this.redirectHits.get(port) ?? 0) + 1)
        res.end(`<script>document.cookie='ugreen-proxy-token=COOKIE-${port}; path=/'</script>`)
        return
      }
      case '/api/firstfactor':
        // 旧客户端会先登录一次。kura-server 不做认证，照 Authelia 的形状回 200 即可。
        await this.readBody(req)
        res.end('{"status":"OK","message":"kura-server 不做认证，直接访问即可"}')
        return

      case '/__services':
        // kura-server 不认证：不带任何 cookie 也要能拿到清单
        this.servicesRequests += 1
        res.setHeader('content-type', 'application/json')
        res.end(this.servicesBody)
        return
      default:
        res.statusCode = 404
        res.end('not found')
    }
  }
}
