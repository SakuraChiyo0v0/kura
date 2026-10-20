import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { createDbHandler } from '../src/db/handler.js'
import { DatabaseRegistry } from '../src/db/registry.js'
import { TunnelService } from '../src/db/tunnel.js'
import { FakeDocker } from './fake-docker.js'

/**
 * Redis 数据浏览的端到端测试：**真的 HTTP 路由 + 真的 TCP 假 Redis**。
 *
 * 为什么不 mock 掉 `RedisClient`：这一层最容易错的是「连接参数拼错了」
 * （端口读错、口令没带上、忘了 AUTH），而 mock 掉客户端正好把这类错误遮住 ——
 * 本项目踩过「假样本让 bug 一直绿」（记忆 feedback_test_real_shapes）。
 */

let docker: FakeDocker
let root = ''
let registry: DatabaseRegistry
let engine: DockerEngine

function fakeCompose(target: ComposeTarget, action: ComposeAction): ComposeRun {
  void target
  void action
  return { onOutput: () => {}, done: Promise.resolve(0), kill: () => {} }
}

beforeEach(async () => {
  docker = await new FakeDocker().start()
  engine = new DockerEngine({ socketPath: docker.socketPath })
  root = mkdtempSync(join(tmpdir(), 'kura-db-redis-')).replace(/\\/g, '/')
  registry = new DatabaseRegistry(join(root, 'databases.json'))
})
afterEach(async () => {
  await docker.stop()
  rmSync(root, { recursive: true, force: true })
})

/** 一个只认几条命令的假 Redis（真 TCP，逐字节吐 RESP 帧）。 */
async function fakeRedis(options: { password?: string } = {}): Promise<{ port: number; close: () => Promise<void>; received: string[][] }> {
  const received: string[][] = []
  const server = net.createServer()
  const bulk = (text: string): string => `$${Buffer.byteLength(text)}\r\n${text}\r\n`
  const arr = (items: string[]): string => `*${items.length}\r\n${items.join('')}`

  server.on('connection', (socket) => {
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (pending[0] !== 0x2a) break
        const lineEnd = pending.indexOf('\r\n', 0)
        if (lineEnd < 0) break
        const count = Number(pending.toString('utf8', 1, lineEnd))
        const args: string[] = []
        let off = lineEnd + 2
        let complete = true
        for (let i = 0; i < count; i += 1) {
          const headEnd = pending.indexOf('\r\n', off)
          if (headEnd < 0) {
            complete = false
            break
          }
          const len = Number(pending.toString('utf8', off + 1, headEnd))
          const start = headEnd + 2
          if (pending.length < start + len + 2) {
            complete = false
            break
          }
          args.push(pending.toString('utf8', start, start + len))
          off = start + len + 2
        }
        if (!complete) break
        pending = pending.subarray(off)
        received.push(args)

        const head = (args[0] ?? '').toUpperCase()
        const authed = received.some((r) => (r[0] ?? '').toUpperCase() === 'AUTH')
        let reply: string
        if (head === 'AUTH') reply = options.password && args[1] === options.password ? '+OK\r\n' : '-WRONGPASS invalid\r\n'
        else if (options.password && !authed) reply = '-NOAUTH Authentication required.\r\n'
        else if (head === 'SCAN') reply = arr([bulk('0'), arr([bulk('greeting')])])
        else if (head === 'TYPE') reply = '+string\r\n'
        else if (head === 'TTL') reply = ':-1\r\n'
        else if (head === 'STRLEN') reply = ':5\r\n'
        else if (head === 'GETRANGE' || head === 'GET') reply = bulk('hello')
        else if (head === 'MEMORY') reply = ':48\r\n'
        else if (head === 'PING') reply = '+PONG\r\n'
        else reply = `-ERR unknown command '${args[0]}'\r\n`
        socket.write(reply)
      }
    })
    socket.on('error', () => {})
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.unref()
      }),
  }
}

/**
 * 让「容器名」能解析到 127.0.0.1 上的假 Redis。
 *
 * 真机上走 Docker 内置 DNS（容器名 → 容器 IP）；测试里没有 docker，
 * 只能把驱动层的 `net.connect` 换掉 —— **必须注在 `connect` 这个选项上**（传给 handler →
 * DbConnector → RedisClient），而不是只换隧道那层：隧道那层只做校验，真正连的是驱动。
 * 只换隧道层的写法会让测试看起来是绿的，实际驱动仍在解析容器名（ENOTFOUND）——
 * 这里踩过一次，所以注入点是 handler 的 `connect`。
 */
function connectTo(port: number): (host: string, want: number) => net.Socket {
  return () => net.connect({ host: '127.0.0.1', port })
}

/** 起一个真的 HTTP 服务器，返回 base url 与关闭函数。 */
async function serve(options: { redisPort?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const tunnel = new TunnelService({ registry, engine })
  const connect = options.redisPort ? connectTo(options.redisPort) : undefined
  const handler = createDbHandler({
    registry,
    engine,
    tunnel,
    audit: () => {},
    projectRoot: root,
    compose: fakeCompose,
    ...(connect ? { connect } : {}),
  })
  const server = http.createServer((req, res) => void handler.handle(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          tunnel.closeAll()
          r()
        })
      }),
  }
}

function register(name: string, engineKind: 'redis' | 'postgres' = 'redis'): void {
  registry.add({
    name,
    engine: engineKind,
    container: name,
    port: engineKind === 'redis' ? 6379 : 5432,
    user: engineKind === 'redis' ? '' : 'postgres',
    database: engineKind === 'redis' ? '' : 'postgres',
    dir: '',
    managed: true,
    createdAt: '',
  })
}

describe('Redis 数据浏览：HTTP 路由', () => {
  it('browse-capabilities 存在（客户端据此判断镜像带不带数据浏览）', async () => {
    const s = await serve()
    const res = await fetch(`${s.url}/api/db/browse-capabilities`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redis: boolean }
    expect(body.redis).toBe(true)
    await s.close()
  })

  it('扫 key：连上真 Redis，返回结构化的 key 列表，口令从容器环境变量读', async () => {
    const redis = await fakeRedis({ password: 's3cret' })
    register('cache')
    docker.addContainer('cache', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=s3cret'] })

    const s = await serve({ redisPort: redis.port })
    const res = await fetch(`${s.url}/api/db/cache/keys`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { keys: Array<{ key: string; type: string; size: number; preview: string }> }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).toMatchObject({ key: 'greeting', type: 'string', size: 5, preview: 'hello' })

    // 关键断言：口令是从**容器自己的环境变量**读出来的，并真的发出去了 ——
    // 接管的容器没有项目 .env，这是它们能自动连上的唯一原因
    expect(redis.received[0]).toEqual(['AUTH', 's3cret'])

    await s.close()
    await redis.close()
  })

  it('口令拿不到时明确让用户输一次（不是模糊的连接失败）', async () => {
    const redis = await fakeRedis({ password: 'real-pass' })
    register('locked')
    // 容器里没有口令变量，也没有项目 .env
    docker.addContainer('locked', { image: 'redis:7-alpine', env: [] })

    const s = await serve({ redisPort: redis.port })

    const res = await fetch(`${s.url}/api/db/locked/keys`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toMatch(/口令/)

    // 带上用户手输的口令就能连
    const ok = await fetch(`${s.url}/api/db/locked/keys?password=real-pass`)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { keys: unknown[] }).keys).toHaveLength(1)

    await s.close()
    await redis.close()
  })

  it('读一个 key 的值', async () => {
    const redis = await fakeRedis({ password: 's3cret' })
    register('cache')
    docker.addContainer('cache', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=s3cret'] })

    const s = await serve({ redisPort: redis.port })
    const res = await fetch(`${s.url}/api/db/cache/value?key=greeting`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { key: string; type: string; value: { kind: string; text: string } }
    expect(body.key).toBe('greeting')
    expect(body.value).toMatchObject({ kind: 'string', text: 'hello' })

    await s.close()
    await redis.close()
  })

  it('MONITOR 这类会变成推送流的命令被拒（否则后面所有命令都错位）', async () => {
    const redis = await fakeRedis({ password: 's3cret' })
    register('cache2')
    docker.addContainer('cache2', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=s3cret'] })

    const s = await serve({ redisPort: redis.port })
    const res = await fetch(`${s.url}/api/db/cache2/command`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['MONITOR'] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('MONITOR')

    await s.close()
    await redis.close()
  })

  it('跑一条普通命令能拿到结果', async () => {
    const redis = await fakeRedis({ password: 's3cret' })
    register('cache3')
    docker.addContainer('cache3', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=s3cret'] })

    const s = await serve({ redisPort: redis.port })
    const res = await fetch(`${s.url}/api/db/cache3/command`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['PING'] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { text: string }).text).toBe('PONG')

    await s.close()
    await redis.close()
  })

  it('对一个非 Redis 的库调 keys 会被说清楚（不是让它去连一个 MySQL 端口）', async () => {
    register('pg', 'postgres')
    docker.addContainer('pg', { image: 'postgres:17-alpine', env: ['POSTGRES_PASSWORD=pw'] })

    const s = await serve()
    const res = await fetch(`${s.url}/api/db/pg/keys`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('不是 Redis')
    await s.close()
  })

  it('写操作缺少 x-kura-docker 头就被拒（命令台是写操作）', async () => {
    register('cache')
    docker.addContainer('cache', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=s3cret'] })

    const s = await serve()
    const res = await fetch(`${s.url}/api/db/cache/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['PING'] }),
    })
    expect(res.status).toBe(403)
    await s.close()
  })
})
