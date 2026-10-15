/**
 * 真实 Electron 冒烟：KURA_SMOKE=1 启动 Kura，主进程自动走一遍检查，输出一行 SMOKE ... 后退出。
 * 用临时 userData，不碰日常数据。
 *
 * 先起一个本地「假 NAS」（绿联登录链 + /__services + 一个应用），
 * 主进程通过 KURA_SMOKE_NAS 把发往 *.ug.link / *.ugdocker.link 的请求改拨到它 ——
 * 这样引导、加密保存、映射、服务卡片走的都是真实代码路径。
 *
 *   npm run smoke
 *   KURA_SCREENSHOT_DIR=docs/截图 npm run smoke   # 顺手截图
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const counters = { lookups: 0, terminalResize: 0, terminalResizeCols: 0 }
let slowServicesMs = 0
// 假 NAS 上的应用：像真网关那样按 X-Nas-Service 分流到不同的「容器」
//   webdav      → 内存里的 WebDAV（形态照 rclone serve webdav：href 绝对路径、Destination 带 host 要匹配）
//   nas-console → 模拟 kura-server：不认证，WS /api/tty 回显输入
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
// NAS 侧的暴露范围（kura-server 的 state/webdav.json）。真机上这层在 rclone 前面，
// 冒烟里就由这个假 NAS 自己扮演：文件和列表都按它裁 —— 这样「改范围 → 外部程序看到的变化」
// 才是真在测服务端契约，而不是测客户端自己算的。
let scope = { include: ['/'], exclude: [], readOnly: false }
const inScope = (p) => {
  const norm = p.length > 1 ? p.replace(/\/+$/, '') : '/'
  const covered = (r) => norm === r || norm.startsWith(r === '/' ? '/' : r + '/')
  if (scope.include.some((r) => r !== '/' && covered(r) && !scope.exclude.some((e) => norm === e || norm.startsWith(e + '/')))) return true
  if (scope.include.some(covered)) return !scope.exclude.some((e) => norm === e || norm.startsWith(e + '/'))
  // 上级「路过」：某个放行目录在这个路径下面，就露出来（只读）—— 与 dav-scope 的 ancestor 一致
  return scope.include.some((r) => r.startsWith(norm === '/' ? '/' : norm + '/'))
}

async function handleDav(req, res, body) {
  const raw = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const p = raw.length > 1 ? raw.replace(/\/+$/, '') : '/'
  const end = (status, text = '') => {
    res.statusCode = status
    res.end(text)
  }
  if (!inScope(p)) return end(404, 'not in scope')
  const exists = davFiles.has(p)
  switch (req.method) {
    case 'PROPFIND': {
      if (!exists) return end(404)
      // 范围外的子项要从列表里滤掉，不是只挡直接访问 —— 真 rclone 前面那层就是这么裁的
      const kids = davFiles.get(p) === null && req.headers.depth === '1' ? [...davFiles.keys()].filter((k) => k !== p && davParent(k) === p && inScope(k)) : []
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

// 假 NAS 上的容器管理（kura-server 的 docker 内置服务）。接口形状照 server/src/docker/handler.ts，
// 处理器本身由 server/test/docker*.test.ts 单测；这里只要够界面走通「看 → 操作 → 输出流 → 状态刷新」。
const dockerState = {
  containers: [
    { id: 'c-openlist', name: 'openlist', image: 'openlistteam/openlist:latest', state: 'running', status: 'Up 2 hours', health: '', created: Date.now(), ports: [{ private: 5244, public: 5244, type: 'tcp' }], project: 'openlist', service: 'openlist', protected: false },
    { id: 'c-kura', name: 'kura-server', image: 'ghcr.io/sakurachiyo0v0/kura-server:latest', state: 'running', status: 'Up 1 hour', health: '', created: Date.now(), ports: [], project: 'kura-server', service: 'kura-server', protected: true },
  ],
  activity: [],
  files: {
    compose: [{ path: '/volume1/docker/openlist/docker-compose.yaml', content: 'services:\n  openlist:\n    image: openlistteam/openlist:latest\n    restart: unless-stopped\n' }],
    env: { path: '/volume1/docker/openlist/.env', content: 'TZ=Asia/Shanghai\n', exists: true },
    backups: [],
  },
}
const dockerProjects = () =>
  ['openlist', 'kura-server'].map((name) => {
    const members = dockerState.containers.filter((c) => c.project === name)
    const running = members.filter((c) => c.state === 'running').length
    return {
      name,
      status: running === members.length && members.length ? 'running' : running ? 'partial' : 'stopped',
      kind: name === 'kura-server' ? 'self' : 'managed',
      dir: `/volume1/docker/${name}`,
      configFiles: [`/volume1/docker/${name}/docker-compose.yaml`],
      containers: members.length,
      running,
      services: members.map((c) => c.service),
    }
  })
function handleDocker(req, res, body) {
  const url = new URL(req.url, 'http://x')
  const json = (status, data) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(data))
  }
  if (req.method !== 'GET' && req.headers['x-kura-docker'] !== '1') return json(403, { error: '写操作必须带 x-kura-docker: 1 头' })
  const m = /^\/api\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname)
  if (url.pathname === '/api/overview') return json(200, { containers: dockerState.containers, projects: dockerProjects() })
  if (url.pathname === '/api/images') return json(200, [{ id: 'sha256:aaa', tags: ['openlistteam/openlist:latest'], size: 52_000_000, created: Date.now(), usedBy: 1, dangling: false }])
  if (url.pathname === '/api/activity') return json(200, [...dockerState.activity].reverse())
  if (url.pathname === '/api/volumes') {
    const size = url.searchParams.get('size') === '1' ? 1_234_567 : -1
    return json(200, [
      { name: 'kura-server_shell-token', driver: 'local', mountpoint: '/volume1/@docker/volumes/kura-server_shell-token/_data', created: Date.now(), project: 'kura-server', usedBy: ['kura-server'], size },
      { name: 'old-cache', driver: 'local', mountpoint: '/volume1/@docker/volumes/old-cache/_data', created: Date.now(), project: '', usedBy: [], size },
    ])
  }
  if (url.pathname === '/api/networks') {
    return json(200, [{ id: 'n1', name: 'sso-net', driver: 'bridge', scope: 'local', internal: false, subnet: '172.20.0.0/16', gateway: '172.20.0.1', project: '', containers: [{ name: 'openlist', ip: '172.20.0.3' }], builtin: false }])
  }
  if (url.pathname === '/api/updates' && req.method === 'POST') {
    const { images = [] } = JSON.parse(body.toString() || '{}')
    return json(200, images.map((image) => ({ image, status: image.startsWith('openlistteam/') ? 'update' : 'current', local: 'sha256:old', remote: 'sha256:new', reason: '', checkedAt: Date.now() })))
  }
  if (url.pathname === '/api/projects/openlist/files') {
    if (req.method === 'GET') return json(200, dockerState.files)
    // 和真服务端一样：坏的存不进去（真机上是 docker compose config -q）
    const next = JSON.parse(body.toString() || '{}')
    const edited = next.compose?.[0]?.content
    if (typeof edited === 'string' && !/^services:/m.test(edited)) return json(422, { error: 'compose 校验没通过，没有保存：\ndocker-compose.yaml: services must be a mapping' })
    if (typeof edited === 'string') dockerState.files.compose[0].content = edited
    if (typeof next.env === 'string') dockerState.files.env = { ...dockerState.files.env, content: next.env, exists: true }
    dockerState.files.backups.unshift(new Date().toISOString().replace(/[:.]/g, '-'))
    dockerState.activity.push({ at: new Date().toISOString(), action: 'docker-files-save', detail: 'openlist：docker-compose.yaml', exitCode: 0 })
    return json(200, dockerState.files)
  }
  if (m) {
    const c = dockerState.containers.find((x) => x.id === decodeURIComponent(m[1]))
    if (!c) return json(404, { error: '没有这个容器' })
    if (req.method === 'GET' && !m[2]) {
      return json(200, { ...c, command: '/openlist server', restartPolicy: 'unless-stopped', env: [{ name: 'TZ', value: 'Asia/Shanghai', masked: false }, { name: 'ADMIN_PASSWORD', value: '', masked: true }], mounts: [{ type: 'bind', source: '/volume1/docker/openlist/data', destination: '/opt/openlist/data', rw: true }], networks: ['sso-net'], labels: {}, startedAt: '', finishedAt: '', exitCode: 0, restartCount: 0 })
    }
    if (m[2] === 'stats') return json(200, { cpuPercent: 1.5, memoryUsage: 48_000_000, memoryLimit: 1_000_000_000 })
    if (m[2] === 'logs') {
      res.setHeader('content-type', 'text/plain')
      return res.end('openlist started\n')
    }
    if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(m[2])) {
      if (c.protected) return json(403, { error: '这是 Kura 自己的容器' })
      c.state = m[2] === 'stop' ? 'exited' : 'running'
      c.status = c.state === 'running' ? 'Up 1 second' : 'Exited (0) 1 second ago'
      dockerState.activity.push({ at: new Date().toISOString(), action: `docker-${m[2]}`, detail: c.name, exitCode: 0 })
      return json(200, { ok: true })
    }
  }
  json(404, { error: 'not found' })
}
function upgradeDocker(req, socket, head) {
  const url = new URL(req.url, 'http://x')
  const logs = /^\/api\/containers\/([^/]+)\/logs$/.exec(url.pathname)
  const project = /^\/api\/projects\/([^/]+)\/(up|down|restart|pull)$/.exec(url.pathname)
  const shell = /^\/api\/containers\/([^/]+)\/shell$/.exec(url.pathname)
  if (shell) {
    if (req.headers['x-kura-docker'] !== '1') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    return tty.handleUpgrade(req, socket, head, (ws) => {
      ws.send('/opt/openlist # ')
      ws.on('message', (data) => {
        const text = data.toString()
        if (/^\s*\{\s*"type"\s*:\s*"resize"/.test(text)) return
        ws.send(text === '\r' ? '\r\n/opt/openlist # ' : text)
      })
    })
  }
  if (!logs && !project) return socket.destroy()
  if (project && req.headers['x-kura-docker'] !== '1') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  tty.handleUpgrade(req, socket, head, (ws) => {
    if (logs) {
      ws.send('2026-10-15T00:00:00Z openlist started\n')
      return // 跟着：保持连接，等客户端关
    }
    const [, name, action] = project
    ws.send(` Container ${name}  ${action === 'down' ? 'Removed' : 'Started'}\n`)
    setTimeout(() => {
      for (const c of dockerState.containers) if (c.project === name) c.state = action === 'down' ? 'exited' : 'running'
      dockerState.activity.push({ at: new Date().toISOString(), action: `docker-compose-${action}`, detail: name, exitCode: 0, durationMs: 300 })
      ws.send(JSON.stringify({ type: 'exit', code: 0 }))
      ws.close()
    }, 300)
  })
}

const appServer = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const service = req.headers['x-nas-service']
  if (service === 'webdav') return handleDav(req, res, body)
  // nas-console 端点模拟 **kura-server**（不是独立 nas-console）：不做认证，认不认 cookie 都回 200 ——
  // 终端不需要凭据这一点才测得出来。
  if (service === 'nas-console' && req.url === '/api/me') {
    res.statusCode = 200
    return res.end('{}')
  }
  if (service === 'docker') return handleDocker(req, res, body)
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<h1>fake ${service ?? 'direct'}</h1>`)
})
const tty = new WebSocketServer({ noServer: true })
appServer.on('upgrade', (req, socket, head) => {
  if (req.headers['x-nas-service'] === 'docker') return upgradeDocker(req, socket, head)
  if (req.headers['x-nas-service'] !== 'nas-console') {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  tty.handleUpgrade(req, socket, head, (ws) => {
    ws.send('smoke-nas:~# ')
    ws.on('message', (data) => {
      const text = data.toString()
      // resize 是控制帧，不按输入回显（真终端也不回显）
      if (/^\s*\{\s*"type"\s*:\s*"resize"/.test(text)) {
        const m = /"cols"\s*:\s*(\d+)\s*,\s*"rows"\s*:\s*(\d+)/.exec(text)
        if (m) {
          counters.terminalResize += 1
          counters.terminalResizeCols = Number(m[1])
        }
        return
      }
      ws.send(text === '\r' ? '\r\nsmoke-nas:~# ' : text)
    })
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
      // 旧客户端会先登录；kura-server 不做认证，照 Authelia 的形状回 200
      return json({ status: 'OK' })
    case '/_kura/api/scope': {
      // 客户端「文件」页读写 NAS 上的暴露范围；契约见 server/src/admin.ts（整体替换）
      if (req.method === 'GET') {
        return json({ limits: scope, defaults: { include: ['/'], exclude: [], readOnly: false } })
      }
      const patch = JSON.parse(body.toString() || '{}')
      if (!Array.isArray(patch.include) || !Array.isArray(patch.exclude) || patch.include.length === 0) {
        res.statusCode = 400
        return json({ error: '至少要放行一个目录' })
      }
      scope = { include: patch.include, exclude: patch.exclude, readOnly: patch.readOnly === true }
      // 与真服务端一致：POST 也回 {limits, defaults}（客户端的解析器两种响应同一份）
      return json({ limits: scope, defaults: { include: ['/'], exclude: [], readOnly: false } })
    }
    case '/__services':
      // 第二轮（重启）故意拖慢清单：证明界面第一帧的卡片来自缓存，而不是等到了网络
      if (slowServicesMs) await new Promise((resolve) => setTimeout(resolve, slowServicesMs))
      return json({
        services: [
          { name: 'openlist', container_port: 5244, host_port: Number(process.env.SMOKE_PORT_A), published: true },
          { name: 'navidrome', container_port: Number(process.env.SMOKE_PORT_B), host_port: 0, published: false },
          { name: 'webdav', container_port: 18005, host_port: Number(process.env.SMOKE_PORT_WEBDAV), published: true },
          { name: 'nas-console', container_port: 8890, host_port: Number(process.env.SMOKE_PORT_CONSOLE), published: true },
          { name: 'docker', container_port: 2375, host_port: Number(process.env.SMOKE_PORT_DOCKER), published: true },
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
process.env.SMOKE_PORT_DOCKER = String(await freePort())

/** 起一次 Kura，跑完冒烟返回退出码。两轮共用同一份数据目录：第二轮就是「已配置过的用户再次打开」。 */
function runKura(phase) {
  return new Promise((resolve) => {
    // KURA_SMOKE_EXE=release/win-unpacked/Kura.exe：对打包产物跑同一套冒烟（不带 '.'，应用在 asar 里）
    const exe = process.env.KURA_SMOKE_EXE
    const child = spawn(exe ?? electron, [...(exe ? [] : ['.']), `--user-data-dir=${userData}`], {
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
    // spawn 失败（electron 路径无效之类）只会发 'error'、不发 'exit'：不接住的话这个 Promise 永远挂着，
    // 冒烟卡死，后面的 nas.close() / rmSync 清理也跑不到。
    child.on('error', (error) => {
      console.error('启动 Kura 失败：', error.message)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

let code = await runKura('first')
if (code === 0) {
  slowServicesMs = 2_500
  // 假装第一轮是旧版本：第二轮就是「升级后第一次打开」，应该弹「本次更新内容」
  const settingsFile = join(userData, 'settings.json')
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
  writeFileSync(settingsFile, JSON.stringify({ ...settings, lastSeenVersion: '0.0.1' }))
  code = await runKura('restart')
}
nas.close()
appServer.close()
rmSync(userData, { recursive: true, force: true })
process.exit(code)
