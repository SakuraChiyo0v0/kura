import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { ProjectFileStore, type FileValidator } from '../src/docker/files.js'
import { createDbHandler } from '../src/db/handler.js'
import { DatabaseRegistry, discoverDatabases, readProjectEnv } from '../src/db/registry.js'
import { TunnelService } from '../src/db/tunnel.js'
import { clientArgs, clientEnv, generatePassword, passwordEnvKey, readEnv, templates } from '../src/db/templates.js'
import { FakeDocker } from './fake-docker.js'

let docker: FakeDocker
let root = ''
let registry: DatabaseRegistry
let engine: DockerEngine
let tunnel: TunnelService

const okValidator: FileValidator = async () => ''

/** 记下跑过的 compose 动作，不真跑。 */
let composeRuns: Array<{ target: ComposeTarget; action: ComposeAction }> = []
function fakeCompose(target: ComposeTarget, action: ComposeAction): ComposeRun {
  composeRuns.push({ target, action })
  const listeners: Array<(text: string) => void> = []
  return {
    onOutput: (listener) => listeners.push(listener),
    done: Promise.resolve(0),
    kill: () => {},
  }
}

beforeEach(async () => {
  docker = await new FakeDocker().start()
  engine = new DockerEngine({ socketPath: docker.socketPath })
  root = mkdtempSync(join(tmpdir(), 'kura-db-')).replace(/\\/g, '/')
  registry = new DatabaseRegistry(join(root, 'databases.json'))
  tunnel = new TunnelService({ registry, engine })
  composeRuns = []
})
afterEach(async () => {
  tunnel.closeAll()
  await docker.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('templates', () => {
  it('生成的 compose 能被 compose 解析器读（结构完整）', () => {
    for (const t of Object.values(templates)) {
      const text = t.compose('mydb', 'sso-net', t.image)
      expect(text).toContain('services:')
      expect(text).toContain('image: ' + t.image)
      // 不发布宿主端口：隧道连容器名，发布了等于把库摊在整个局域网上
      expect(text).not.toMatch(/^\s+ports:/m)
      // 绑定挂载 ./data，不用具名卷
      expect(text).toMatch(/\.\/data:/)
      expect(text).toContain('sso-net')
    }
  })

  it('Redis 模板必须带 requirepass（不然容器网络进来的连接会被拒）', () => {
    expect(templates.redis.compose('r', 'sso-net', templates.redis.image)).toContain('--requirepass')
  })

  it('口令不含 shell 特殊字符，且每次不同', () => {
    const a = generatePassword()
    const b = generatePassword()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9]+$/)
    expect(a.length).toBeGreaterThan(20)
  })

  it('.env 的键与镜像的环境变量名对得上', () => {
    const password = 'pw123'
    expect(readEnv(templates.postgres.env('postgres', 'postgres', password), passwordEnvKey('postgres'))).toBe(password)
    expect(readEnv(templates.mysql.env('app', 'kura', password), passwordEnvKey('mysql'))).toBe(password)
    expect(readEnv(templates.redis.env('', '', password), passwordEnvKey('redis'))).toBe(password)
  })
})

describe('registry：登记表与发现', () => {
  it('不存密码：只有连接参数，密码的唯一真相在 .env', () => {
    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: 5432, user: 'postgres', database: 'postgres', dir: `${root}/pg`, managed: true, createdAt: '' })
    const text = readFileSync(join(root, 'databases.json'), 'utf8')
    expect(text).not.toMatch(/password/i)
  })

  it('接管已有数据库：不写盘，但能列出来', async () => {
    docker.addContainer('sakura-pg', { image: 'postgres:18', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    const found = await discoverDatabases(engine, registry)
    expect(found.map((d) => d.name)).toContain('sakura-pg')
    expect(found.find((d) => d.name === 'sakura-pg')!.managed).toBe(false)
    // 没有写进登记表
    expect(registry.list()).toHaveLength(0)
  })

  it('端口从容器读，不按引擎硬编码（sakura-pg 跑在 5444）', async () => {
    docker.addContainer('sakura-pg', { image: 'postgres:18', ports: [{ PrivatePort: 5444, Type: 'tcp' }] })
    const found = await discoverDatabases(engine, registry)
    expect(found.find((d) => d.name === 'sakura-pg')!.port).toBe(5444)
  })

  it('认不出的镜像不当成数据库', async () => {
    docker.addContainer('openlist', { image: 'openlistteam/openlist:latest' })
    const found = await discoverDatabases(engine, registry)
    expect(found.find((d) => d.name === 'openlist')).toBeUndefined()
  })

  it('重名不许重复登记', () => {
    const entry = { name: 'pg', engine: 'postgres' as const, container: 'pg', port: 5432, user: '', database: '', dir: '', managed: true, createdAt: '' }
    registry.add(entry)
    expect(() => registry.add(entry)).toThrow(/已经有一个/)
  })

  it('读一个不存在的项目 .env 当空串，不抛', () => {
    expect(readProjectEnv(`${root}/nope`)).toBe('')
    mkdirSync(`${root}/app`, { recursive: true })
    writeFileSync(`${root}/app/.env`, 'POSTGRES_PASSWORD=secret\n')
    expect(readProjectEnv(`${root}/app`)).toContain('secret')
  })
})

describe('TunnelService：白名单', () => {
  // 这些用例打的是**真实路径** `targetOf()`（handler 与 MCP 都从这里过），
  // 不是一个"查登记表"的辅助函数 —— 那种函数很容易没人调用，单测全绿却挡不住任何东西。
  const entryOf = (name: string, container = name, port = 5432) =>
    ({ name, engine: 'postgres' as const, container, port, user: '', database: '', dir: '', managed: true, createdAt: '' })

  it('登记表为空时一律拒绝（没用过这功能的人，NAS 上零暴露面）', async () => {
    await expect(tunnel.targetOf(entryOf('pg'))).rejects.toThrow(/还没有登记任何数据库/)
  })

  it('登记表为空时在碰容器之前就拦掉 —— 不发起任何网络动作', async () => {
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    docker.calls = []
    await expect(tunnel.targetOf(entryOf('pg'))).rejects.toThrow(/还没有登记任何数据库/)
    expect(docker.calls.filter((c) => c.includes('containers'))).toHaveLength(0)
  })

  it('接管的容器（登记表非空、但自己没登记）可以开隧道', async () => {
    // 登记表里放别的库，让闸门放行；sakura-pg 本身是接管的、不在登记表里
    registry.add(entryOf('some-pg'))
    docker.addContainer('sakura-pg', { image: 'postgres:18', ports: [{ PrivatePort: 5444, Type: 'tcp' }] })
    const target = await tunnel.targetOf({ ...entryOf('sakura-pg', 'sakura-pg', 5444), managed: false })
    expect(target.host).toBe('sakura-pg')
    expect(target.port).toBe(5444)
  })

  it('解析到容器名（不是 IP）—— 重启后 IP 变了也不受影响', async () => {
    registry.add(entryOf('pg'))
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    const target = await tunnel.targetOf(entryOf('pg'))
    expect(target.host).toBe('pg')
    expect(target.port).toBe(5432)
  })

  it('容器没在跑就拒绝，说清原因', async () => {
    registry.add(entryOf('pg'))
    docker.addContainer('pg', { image: 'postgres:17-alpine', state: 'exited' })
    await expect(tunnel.targetOf(entryOf('pg'))).rejects.toThrow(/没有在运行/)
  })

  it('连接数上限：单目标满了就拒绝新隧道', async () => {
    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: 5432, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    // 假的「数据库」：本地 TCP echo
    const echo = net.createServer((s) => s.pipe(s))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    const port = (echo.address() as AddressInfo).port
    const t = new TunnelService({ registry, engine, maxPerTarget: 1, connect: () => net.connect({ host: '127.0.0.1', port }) })

    expect(t.canAccept('pg').ok).toBe(true)
    const pair = await wsPair()
    const stop = await t.attach('pg', { host: 'pg', port: 5432, label: 'pg' }, pair.server)
    // 已占满：再来一条就拒绝
    const room = t.canAccept('pg')
    expect(room.ok).toBe(false)
    if (!room.ok) expect(room.status).toBe(429)

    stop()
    pair.client.close()
    pair.wsServer.close()
    await new Promise<void>((r) => echo.close(() => r()))
  })
})

/** 一对连上的 WebSocket（服务端 + 客户端），测试里当隧道的两端。 */
async function wsPair(): Promise<{ client: WebSocket; server: WebSocket; wsServer: WebSocketServer }> {
  const wsServer = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wsServer.on('listening', resolve))
  const { port } = wsServer.address() as AddressInfo
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  const server = await new Promise<WebSocket>((resolve) => wsServer.once('connection', resolve))
  await new Promise<void>((resolve) => client.once('open', resolve))
  return { client, server, wsServer }
}

describe('createDbHandler：HTTP 路由', () => {
  function serve(): Promise<{ url: string; close: () => Promise<void> }> {
    const files = new ProjectFileStore(root, okValidator)
    const handler = createDbHandler({
      registry,
      engine,
      tunnel,
      audit: () => {},
      projectRoot: root,
      files,
      compose: fakeCompose,
    })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        })
      })
    })
  }

  async function call(base: string, path: string, options: { method?: string; body?: unknown; write?: boolean } = {}): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...(options.write ? { 'x-kura-docker': '1' } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }

  it('列出模板', async () => {
    const s = await serve()
    const r = await call(s.url, '/api/db/templates')
    expect(r.status).toBe(200)
    expect((r.body as unknown[]).length).toBeGreaterThanOrEqual(4)
    await s.close()
  })

  it('写操作没带 x-kura-docker 头就被拒', async () => {
    const s = await serve()
    const r = await call(s.url, '/api/db/create', { method: 'POST', body: { engine: 'postgres', name: 'x' } })
    expect(r.status).toBe(403)
    await s.close()
  })

  it('快捷安装：建项目、起容器、登记，且密码落在 .env 里', async () => {
    const s = await serve()
    const r = await call(s.url, '/api/db/create', { method: 'POST', write: true, body: { engine: 'postgres', name: 'mypg' } })
    expect(r.status).toBe(200)
    expect((r.body as { ok: boolean }).ok).toBe(true)

    // 文件真的写了，且 .env 里有密码
    const env = readFileSync(`${root}/mypg/.env`, 'utf8')
    const password = readEnv(env, 'POSTGRES_PASSWORD')
    expect(password).toMatch(/^[A-Za-z0-9]+$/)
    // compose 里没有密码明文（走 .env 插值）
    expect(readFileSync(`${root}/mypg/docker-compose.yaml`, 'utf8')).not.toContain(password)

    // 登记了
    expect(registry.find('mypg')?.managed).toBe(true)
    // 跑了一次 up
    expect(composeRuns.map((c) => c.action)).toEqual(['up'])
    await s.close()
  })

  it('连接信息默认不给密码，显式要才给', async () => {
    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: 5432, user: 'postgres', database: 'postgres', dir: `${root}/pg`, managed: true, createdAt: '' })
    mkdirSync(`${root}/pg`, { recursive: true })
    writeFileSync(`${root}/pg/.env`, 'POSTGRES_PASSWORD=topsecret\n')
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    const s = await serve()

    const without = await call(s.url, '/api/db/pg/info', { method: 'POST', write: true, body: {} })
    expect(JSON.stringify(without.body)).not.toContain('topsecret')

    const withPw = await call(s.url, '/api/db/pg/info', { method: 'POST', write: true, body: { includePassword: true } })
    expect((withPw.body as { password: string }).password).toBe('topsecret')
    await s.close()
  })

  it('接管的数据库不给删（不是 Kura 装的）', async () => {
    docker.addContainer('sakura-pg', { image: 'postgres:18' })
    const s = await serve()
    const r = await call(s.url, '/api/db/sakura-pg', { method: 'DELETE', write: true })
    expect(r.status).toBe(403)
    expect(String((r.body as { error: string }).error)).toContain('不是 Kura 装的')
    await s.close()
  })

  it('列表里带上隧道可用性', async () => {
    const s = await serve()
    const r = await call(s.url, '/api/db/list')
    expect(r.status).toBe(200)
    // 登记表为空 → 隧道不可用
    expect((r.body as { tunnelAvailable: boolean }).tunnelAvailable).toBe(false)
    await s.close()
  })
})

describe('createDbHandler：隧道 upgrade', () => {
  async function serveWs(): Promise<{ port: number; close: () => Promise<void> }> {
    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root, compose: fakeCompose })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) }))
    })
  }

  it('未登记的目标：101 之前就被拒（403/404）', async () => {
    const s = await serveWs()
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/db/evil/tunnel`, { headers: { 'x-kura-docker': '1' } })
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(-1))
    })
    expect([403, 404]).toContain(status)
    await s.close()
  })

  it('缺写头：403', async () => {
    const s = await serveWs()
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/db/pg/tunnel`)
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(-1))
    })
    expect(status).toBe(403)
    await s.close()
  })

  // 下面两条是这次补的那个缺口的回归。原来的用例都先 add 了登记项再开隧道，
  // 于是「登记表为空时能不能开」从来没被走过 —— 闸门写在一个没人调用的函数里，
  // 单测全绿，实际放开着。所以这里必须打**真实的 HTTP 升级路径**。
  it('登记表为空：接管的数据库也开不了隧道（403），闸门确实在真实路径上', async () => {
    docker.addContainer('sakura-pg', { image: 'postgres:18', ports: [{ PrivatePort: 5444, Type: 'tcp' }] })
    expect(registry.list()).toHaveLength(0)
    const s = await serveWs()
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/db/sakura-pg/tunnel`, { headers: { 'x-kura-docker': '1' } })
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(-1))
    })
    expect(status).toBe(403)
    await s.close()
  })

  it('登记表非空：接管的数据库能开隧道，字节原样来回', async () => {
    const echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    const dbPort = (echo.address() as AddressInfo).port

    // 登记表里放别的库，只为让闸门放行；sakura-pg 自己是接管的，不在登记表里
    registry.add({ name: 'other-pg', engine: 'postgres', container: 'other-pg', port: 5432, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('sakura-pg', { image: 'postgres:18', ports: [{ PrivatePort: dbPort, Type: 'tcp' }] })
    const localTunnel = new TunnelService({ registry, engine, connect: () => net.connect({ host: '127.0.0.1', port: dbPort }) })
    const handler = createDbHandler({ registry, engine, tunnel: localTunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/sakura-pg/tunnel`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a])
    const echoed = await new Promise<Buffer>((resolve) => {
      ws.on('message', (data: Buffer) => resolve(data))
      ws.send(payload)
    })
    expect(echoed.equals(payload)).toBe(true)

    ws.close()
    localTunnel.closeAll()
    await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => echo.close(() => r()))
  })

  it('登记的数据库：隧道通了，字节原样来回（含 NUL 与 0xFF）', async () => {
    // 假的「数据库」：本地 TCP echo
    const echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    const dbPort = (echo.address() as AddressInfo).port

    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: dbPort, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: dbPort, Type: 'tcp' }] })
    // 隧道连到本地 echo（不是真的容器名）
    const localTunnel = new TunnelService({ registry, engine, connect: () => net.connect({ host: '127.0.0.1', port: dbPort }) })
    const handler = createDbHandler({ registry, engine, tunnel: localTunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/pg/tunnel`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x50, 0x47, 0x00])
    const echoed = await new Promise<Buffer>((resolve) => {
      ws.on('message', (data: Buffer) => resolve(data))
      ws.send(payload)
    })
    expect(echoed.equals(payload)).toBe(true)

    ws.close()
    localTunnel.closeAll()
    await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => echo.close(() => r()))
  })
})

describe('clientEnv / clientArgs', () => {
  it('空值一个都不传（PGUSER= 会把容器自己的默认值覆盖成空，比不传更糟）', () => {
    expect(clientEnv('postgres', { user: '', database: '', password: '' })).toEqual([])
    expect(clientArgs('postgres', { user: '', database: '' })).toEqual([])
    // 只有部分字段有值时就只传那几个
    expect(clientEnv('postgres', { user: 'app', database: '', password: 'pw' })).toEqual(['PGUSER=app', 'PGPASSWORD=pw'])
  })

  it('口令一律走环境变量，不进命令行（命令行的 Cmd 能在 docker inspect 里看到）', () => {
    for (const engine of ['postgres', 'mysql', 'mariadb', 'redis'] as const) {
      const args = clientArgs(engine, { user: 'u', database: 'd' })
      expect(args.some((a) => a.includes('pw-should-not-be-here'))).toBe(false)
      const env = clientEnv(engine, { user: 'u', database: 'd', password: 'pw-should-not-be-here' })
      expect(env.some((line) => line === 'PGPASSWORD=pw-should-not-be-here' || line === 'MYSQL_PWD=pw-should-not-be-here' || line === 'REDISCLI_AUTH=pw-should-not-be-here')).toBe(true)
    }
  })

  it('Redis 不给用户/库参数（redis-cli 没有这两个概念）', () => {
    expect(clientArgs('redis', { user: 'u', database: 'd' })).toEqual([])
  })
})

describe('命令执行：连接身份由服务端补（psql 不再是 root）', () => {
  /**
   * 复现真机那个 bug 的形状：容器里 `POSTGRES_USER=app`，命令台只发 `-c "SELECT version()"`。
   *
   * 这两条断言是这次修复的核心 —— 修之前 psql 没有 `PGUSER`、于是按 OS 用户 root 登录，
   * 报 `FATAL: role "root" does not exist`（psql 只认 PGUSER，不认镜像的 POSTGRES_USER）。
   */
  it('PostgreSQL：补 PGUSER / PGDATABASE，容器里没有 .env 时口令从容器环境变量取', async () => {
    // 接管的容器（不在登记表里）：user / database 只能是空串，全靠容器 Env 推出来
    docker.addContainer('sakura-pg', {
      image: 'postgres:17-alpine',
      ports: [{ PrivatePort: 5432, Type: 'tcp' }],
      env: ['POSTGRES_USER=app', 'POSTGRES_DB=appdb', 'POSTGRES_PASSWORD=s3cret-pw'],
    })
    // 登记表非空才能用命令执行（tunnel.targetOf 里那道闸门）—— 另一条 Kura 装的库把它撑起来
    registry.add({ name: 'other', engine: 'postgres', container: 'other', port: 5432, user: 'postgres', database: 'postgres', dir: '', managed: true, createdAt: '' })
    docker.addContainer('other', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })

    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/sakura-pg/exec`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        if ((JSON.parse(data.toString('utf8')) as { type: string }).type === 'exit') resolve()
      })
      ws.send(JSON.stringify({ cli: 'psql', args: ['-c', 'SELECT version()'] }))
    })

    const exec = [...docker.execs.values()][0]!
    expect(exec.cmd[0]).toBe('psql')
    // 用户给的参数原样保留、且在后面（出现在后面的会覆盖环境变量）
    expect(exec.cmd.slice(1)).toEqual(['-c', 'SELECT version()'])
    // 身份走环境变量：psql 只认 PGUSER / PGDATABASE / PGPASSWORD
    expect(exec.env).toEqual(expect.arrayContaining(['PGUSER=app', 'PGDATABASE=appdb', 'PGPASSWORD=s3cret-pw']))
    // 不带镜像那套变量名（POSTGRES_USER 对客户端无效，带了反而误导）
    expect(exec.env!.some((line) => line.startsWith('POSTGRES_'))).toBe(false)

    await new Promise<void>((r) => server.close(() => r()))
  })

  it('MySQL：用户名与库走参数，口令走 MYSQL_PWD', async () => {
    docker.addContainer('my', {
      image: 'mysql:8.4',
      ports: [{ PrivatePort: 3306, Type: 'tcp' }],
      env: ['MYSQL_USER=kura', 'MYSQL_DATABASE=app', 'MYSQL_PASSWORD=pw-mysql'],
    })
    registry.add({ name: 'seed', engine: 'postgres', container: 'seed', port: 5432, user: 'postgres', database: 'postgres', dir: '', managed: true, createdAt: '' })
    docker.addContainer('seed', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })

    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/my/exec`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        if ((JSON.parse(data.toString('utf8')) as { type: string }).type === 'exit') resolve()
      })
      ws.send(JSON.stringify({ cli: 'mysql', args: ['-e', 'SELECT version()'] }))
    })

    const exec = [...docker.execs.values()][0]!
    // mysql 客户端不认环境变量指定用户/库，只能走参数；口令走 MYSQL_PWD（不进命令行）
    expect(exec.cmd).toEqual(['mysql', '-u', 'kura', 'app', '-e', 'SELECT version()'])
    expect(exec.env).toContain('MYSQL_PWD=pw-mysql')

    await new Promise<void>((r) => server.close(() => r()))
  })

  it('Redis：口令走 REDISCLI_AUTH（redis-cli 不认 REDIS_PASSWORD）', async () => {
    docker.addContainer('rd', {
      image: 'redis:7-alpine',
      ports: [{ PrivatePort: 6379, Type: 'tcp' }],
      env: ['REDIS_PASSWORD=pw-redis'],
    })
    registry.add({ name: 'seed', engine: 'postgres', container: 'seed', port: 5432, user: 'postgres', database: 'postgres', dir: '', managed: true, createdAt: '' })
    docker.addContainer('seed', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })

    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/rd/exec`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        if ((JSON.parse(data.toString('utf8')) as { type: string }).type === 'exit') resolve()
      })
      ws.send(JSON.stringify({ cli: 'redis-cli', args: ['PING'] }))
    })

    const exec = [...docker.execs.values()][0]!
    expect(exec.cmd).toEqual(['redis-cli', 'PING'])
    expect(exec.env).toContain('REDISCLI_AUTH=pw-redis')

    await new Promise<void>((r) => server.close(() => r()))
  })
})

describe('命令执行：exec 分流与白名单', () => {
  it('非 TTY exec 的 stdout / stderr 分得开', async () => {
    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: 5432, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    const { frame } = await import('./fake-docker.js')

    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    // 预置输出：一行结果、一行错误
    docker.onExecStart = (exec, socket) => {
      socket.write(frame(1, 'id | name\n1 | alice\n'))
      socket.write(frame(2, 'NOTICE: something\n'))
      socket.end()
    }
    expect(docker.calls).toBeDefined()

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/pg/exec`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    const frames: Array<{ stream: number; text: string }> = []
    const exit = await new Promise<{ code: number }>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString('utf8')) as { type: string; stream?: number; text?: string; code?: number }
        if (msg.type === 'out') frames.push({ stream: msg.stream!, text: msg.text! })
        if (msg.type === 'exit') resolve({ code: msg.code! })
      })
      ws.send(JSON.stringify({ cli: 'psql', args: ['-c', 'select 1'] }))
    })
    expect(exit.code).toBe(0)
    expect(frames.find((f) => f.stream === 1)!.text).toContain('alice')
    expect(frames.find((f) => f.stream === 2)!.text).toContain('NOTICE')
    // 用的就是白名单里的 CLI
    expect([...docker.execs.values()][0]!.cmd[0]).toBe('psql')
    // 命令没开 TTY（要分 stdout/stderr）
    expect([...docker.execs.values()][0]!.tty).toBe(false)

    await new Promise<void>((r) => server.close(() => r()))
  })

  it('白名单外的 CLI 被拒（不接受任意命令）', async () => {
    registry.add({ name: 'pg', engine: 'postgres', container: 'pg', port: 5432, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('pg', { image: 'postgres:17-alpine', ports: [{ PrivatePort: 5432, Type: 'tcp' }] })
    const handler = createDbHandler({ registry, engine, tunnel, audit: () => {}, projectRoot: root })
    const server = http.createServer((req, res) => void handler.handle(req, res))
    server.on('upgrade', (req, socket, head) => handler.upgrade(req, socket as Socket, head))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/db/pg/exec`, { headers: { 'x-kura-docker': '1' } })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    const exit = await new Promise<{ code: number; error?: string }>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString('utf8')) as { type: string; code?: number; error?: string }
        if (msg.type === 'exit') resolve({ code: msg.code!, error: msg.error })
      })
      ws.send(JSON.stringify({ cli: '/bin/sh', args: ['-c', 'rm -rf /'] }))
    })
    expect(exit.code).toBe(1)
    expect(exit.error).toContain('只能用这些')
    await new Promise<void>((r) => server.close(() => r()))
  })
})

/**
 * Docker 守护进程系统信息（「Docker → 配置」页的数据来源）。
 *
 * 这一条的重点是**只读**：Kura 不该代用户改 daemon.json —— 那要重启 dockerd，
 * 会停掉 NAS 上所有容器。所以这里断言只发了 GET。
 */
describe('DockerEngine.info', () => {
  it('读出系统信息，含 daemon.json 里的镜像加速器', async () => {
    docker.addContainer('a', { state: 'running' })
    docker.addContainer('b', { state: 'exited' })
    docker.registryMirrors = ['https://docker.1ms.run']

    const info = await engine.info()
    expect(info.version).toBe('27.3.1')
    expect(info.rootDir).toBe('/volume1/@docker')
    expect(info.storageDriver).toBe('overlay2')
    expect(info.registryMirrors).toEqual(['https://docker.1ms.run'])
    expect(info.containersRunning).toBe(1)
    expect(info.containersStopped).toBe(1)
  })

  it('没配加速器时是空数组（不是 undefined —— 界面直接 map）', async () => {
    docker.registryMirrors = []
    const info = await engine.info()
    expect(info.registryMirrors).toEqual([])
  })

  it('只发了 GET，没有任何写操作（改 daemon.json 要重启 docker，不能代劳）', async () => {
    await engine.info()
    const writes = docker.calls.filter((call) => !call.startsWith('GET '))
    expect(writes).toEqual([])
  })
})
