/**
 * 真实 Electron 冒烟：KURA_SMOKE=1 启动 Kura，主进程自动走一遍检查，输出一行 SMOKE ... 后退出。
 * 用临时 userData，不碰日常数据。
 *
 * 先起一个本地「假 NAS」（绿联登录链 + Authelia + /__services + 一个应用），
 * 主进程通过 KURA_SMOKE_NAS 把发往 *.ug.link / *.ugdocker.link 的请求改拨到它 ——
 * 这样引导、加密保存、映射、服务卡片走的都是真实代码路径。
 *
 *   npm run smoke
 *   KURA_SCREENSHOT_DIR=docs/截图 npm run smoke   # 顺手截图
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const electron = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'kura-smoke-'))
// 假 NAS 每步延迟一点：跑得太快的话「先转圈、再打勾」的中间态一帧都留不住，没法验证
process.env.SMOKE_LATENCY_MS ??= '220'

// ---- 假 NAS ----
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaToken = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/PUBLIC KEY/g, 'RSA PUBLIC KEY')).toString('base64')
let token = 0
// 冒烟里要断言「某个接口被打了几次」（例如保存时有没有重复查 ID）
const counters = { lookups: 0 }
let slowServicesMs = 0
// 假 NAS 上的应用：像真网关那样按 X-Nas-Service 分流到不同的「容器」
//   webdav      → 内存里的 WebDAV（形态照 rclone serve webdav：href 绝对路径、Destination 带 host 要匹配）
//   nas-console → /api/login 发 session cookie，WS /api/tty 回显输入
//   其它        → 一段 HTML
const davFiles = new Map([
  ['/', null],
  ['/volume1', null],
  ['/volume1/docs', null],
  ['/volume1/docs/readme.txt', Buffer.from('hello from smoke nas')],
  ['/volume1/private', null],
  ['/volume1/private/secret.txt', Buffer.from('secret')],
  ['/home', null],
])
const davParent = (p) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
const davHref = (p, dir) => (p === '/' ? '/' : p.split('/').map(encodeURIComponent).join('/') + (dir ? '/' : ''))
function davEntry(p) {
  const data = davFiles.get(p)
  const dir = data === null
  return `<D:response><D:href>${davHref(p, dir)}</D:href><D:propstat><D:prop>${
    dir ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getcontentlength>${data.length}</D:getcontentlength>`
  }<D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}
async function handleDav(req, res, body) {
  const raw = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const p = raw.length > 1 ? raw.replace(/\/+$/, '') : '/'
  const end = (status, text = '') => {
    res.statusCode = status
    res.end(text)
  }
  const exists = davFiles.has(p)
  switch (req.method) {
    case 'PROPFIND': {
      if (!exists) return end(404)
      const kids = davFiles.get(p) === null && req.headers.depth === '1' ? [...davFiles.keys()].filter((k) => k !== p && davParent(k) === p) : []
      res.setHeader('content-type', 'application/xml; charset=utf-8')
      return end(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${[p, ...kids].map(davEntry).join('')}</D:multistatus>`)
    }
    case 'GET':
      if (!exists) return end(404)
      return end(200, davFiles.get(p) ?? 'dir')
    case 'PUT':
      if (davFiles.get(davParent(p)) !== null) return end(409)
      davFiles.set(p, body)
      return end(exists ? 204 : 201)
    case 'MKCOL':
      if (exists) return end(405)
      davFiles.set(p, null)
      return end(201)
    case 'DELETE':
      for (const k of [...davFiles.keys()]) if (k === p || k.startsWith(p + '/')) davFiles.delete(k)
      return end(204)
    case 'MOVE': {
      const dest = new URL(req.headers.destination, `http://${req.headers.host}`)
      if (dest.host !== req.headers.host) return end(502, 'destination host mismatch')
      const to = decodeURIComponent(dest.pathname).replace(/\/+$/, '')
      if (davFiles.has(to) && req.headers.overwrite === 'F') return end(412)
      for (const k of [...davFiles.keys()]) {
        if (k === p || k.startsWith(p + '/')) {
          davFiles.set(to + k.slice(p.length), davFiles.get(k))
          davFiles.delete(k)
        }
      }
      return end(201)
    }
    default:
      return end(405)
  }
}

const consoleSessions = new Set()
const appServer = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const service = req.headers['x-nas-service']
  if (service === 'webdav') return handleDav(req, res, body)
  if (service === 'nas-console' && req.url === '/api/login') {
    const { username, password } = JSON.parse(body.toString() || '{}')
    if (username !== 'smoke-console' || password !== 'smoke-console-pass') {
      res.statusCode = 401
      return res.end('{"error":"bad"}')
    }
    const id = `C${consoleSessions.size + 1}`
    consoleSessions.add(id)
    res.setHeader('set-cookie', `session=${id}; Path=/; HttpOnly`)
    return res.end('{"ok":true}')
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<h1>fake ${service ?? 'direct'}</h1>`)
})
const tty = new WebSocketServer({ noServer: true })
appServer.on('upgrade', (req, socket, head) => {
  const cookie = /session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  if (req.headers['x-nas-service'] !== 'nas-console' || !cookie || !consoleSessions.has(cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  tty.handleUpgrade(req, socket, head, (ws) => {
    ws.send('smoke-nas:~# ')
    ws.on('message', (data) => ws.send(data.toString() === '\r' ? '\r\nsmoke-nas:~# ' : data.toString()))
  })
})
await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve))
const appPort = appServer.address().port

const nas = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const body = await new Promise((resolve) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => resolve(text))
  })
  const json = (data) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(data))
  }
  // 真实网络没这么快。给它一点延迟，冒烟才看得见「先转圈、再逐条打勾」那个中间态。
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SMOKE_LATENCY_MS ?? 0)))
  switch (url.pathname) {
    case '/__smoke/counters':
      return json(counters)
    case '/api/p2p/v2/ta/nodeInfo/byAlias': {
      counters.lookups += 1
      const { alias } = JSON.parse(body || '{}')
      if (alias !== 'smoke-nas-id') return json({ code: 7022, msg: 'UGREENlink ID不存在' })
      return json({ code: 200, msg: 'SUCCESS', data: { alias, relayDomain: 'cn99.ug.link', netInfo: { ipv4: ['127.0.0.1'] } } })
    }
    case '/ugreen/v1/verify/check':
      res.setHeader('X-Rsa-Token', rsaToken)
      return res.end()
    case '/ugreen/v1/verify/login': {
      const { password } = JSON.parse(body)
      const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'base64')).toString()
      if (plain !== 'smoke-pass') return json({ code: 1003, msg: 'wrong password' })
      token += 1
      return json({ code: 200, msg: 'ok', data: { token: `T${token}` } })
    }
    case '/ugreen/v1/gateway/proxy/dockerToken':
      return json({ code: 200, msg: 'ok', data: { redirect_url: `http://smoke-nas/redirect?port=${url.searchParams.get('port')}` } })
    case '/redirect':
      return res.end(`<script>document.cookie='ugreen-proxy-token=SMOKE-${url.searchParams.get('port')}-0000'</script>`)
    case '/api/firstfactor':
      res.setHeader('set-cookie', 'authelia_session=SMOKE; Path=/')
      return json({ status: 'OK' })
    case '/__services':
      // 第二轮（重启）故意拖慢清单：证明界面第一帧的卡片来自缓存，而不是等到了网络
      if (slowServicesMs) await new Promise((resolve) => setTimeout(resolve, slowServicesMs))
      return json({
        services: [
          { name: 'openlist', container_port: 5244, host_port: Number(process.env.SMOKE_PORT_A), published: true },
          { name: 'navidrome', container_port: Number(process.env.SMOKE_PORT_B), host_port: 0, published: false },
          { name: 'webdav', container_port: 18005, host_port: Number(process.env.SMOKE_PORT_WEBDAV), published: true },
          { name: 'nas-console', container_port: 8890, host_port: Number(process.env.SMOKE_PORT_CONSOLE), published: true },
        ],
      })
    default:
      res.statusCode = 404
      return res.end()
  }
})
await new Promise((resolve) => nas.listen(0, '127.0.0.1', resolve))

// 两个空闲本机端口给清单里的服务用
async function freePort() {
  const s = http.createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}
process.env.SMOKE_PORT_A = String(await freePort())
process.env.SMOKE_PORT_B = String(await freePort())

// 本机 WebDAV 也要一个空闲端口（默认 18006 可能被日常的 Kura 占着）
process.env.SMOKE_DAV_PORT = String(await freePort())
// 冒烟时的服务端口：清单里 webdav / nas-console 的本机端口也换成空闲的，免得撞上日常在跑的 Go 版
process.env.SMOKE_PORT_WEBDAV = String(await freePort())
process.env.SMOKE_PORT_CONSOLE = String(await freePort())

/** 起一次 Kura，跑完冒烟返回退出码。两轮共用同一份数据目录：第二轮就是「已配置过的用户再次打开」。 */
function runKura(phase) {
  return new Promise((resolve) => {
    const child = spawn(electron, ['.', `--user-data-dir=${userData}`], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        KURA_SMOKE: '1',
        KURA_SMOKE_PHASE: phase,
        KURA_SMOKE_NAS: `http://127.0.0.1:${nas.address().port}`,
        KURA_SMOKE_APP: `http://127.0.0.1:${appPort}`,
      },
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

let code = await runKura('first')
if (code === 0) {
  slowServicesMs = 2_500
  code = await runKura('restart')
}
nas.close()
appServer.close()
rmSync(userData, { recursive: true, force: true })
process.exit(code)
