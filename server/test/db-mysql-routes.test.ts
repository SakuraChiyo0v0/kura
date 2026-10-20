import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComposeAction, ComposeRun, ComposeTarget } from '../src/docker/compose.js'
import { DockerEngine } from '../src/docker/engine.js'
import { createDbHandler } from '../src/db/handler.js'
import { DatabaseRegistry } from '../src/db/registry.js'
import { TunnelService } from '../src/db/tunnel.js'
import { MySqlType } from '../src/db/mysql.js'
import { FakeDocker } from './fake-docker.js'

/**
 * MySQL 数据浏览的 HTTP 路由端到端测试。
 *
 * 起一个**说真 MySQL 协议的真 TCP 服务器**，走完整链路：
 * 容器识别 → 口令从容器环境变量读 → 握手认证 → 查 information_schema → 结构化 JSON。
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
  root = mkdtempSync(join(tmpdir(), 'kura-db-rel-')).replace(/\\/g, '/')
  registry = new DatabaseRegistry(join(root, 'databases.json'))
})
afterEach(async () => {
  await docker.stop()
  rmSync(root, { recursive: true, force: true })
})

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const lenencStr = (text: string): Buffer => {
  const body = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from([body.length]), body])
}
const nul = (text: string): Buffer => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])])
function packet(payload: Buffer, seq: number): Buffer {
  const head = Buffer.alloc(4)
  head.writeUIntLE(payload.length, 0, 3)
  head[3] = seq
  return Buffer.concat([head, payload])
}
const okPacket = (): Buffer => Buffer.concat([Buffer.from([0x00]), Buffer.from([0]), Buffer.from([0]), u16(0x0002), u16(0)])
const eofPacket = (): Buffer => Buffer.concat([Buffer.from([0xfe]), u16(0), u16(0)])

function columnDef(name: string, type: number, length = 255, decimals = 0): Buffer {
  return Buffer.concat([
    lenencStr('def'),
    lenencStr('app'),
    lenencStr('t'),
    lenencStr('t'),
    lenencStr(name),
    lenencStr(name),
    Buffer.from([0x0c]),
    u16(0x21),
    u32(length),
    Buffer.from([type]),
    u16(0),
    Buffer.from([decimals]),
    Buffer.from([0, 0]),
  ])
}

function resultSet(columns: Array<{ name: string; type: number; length?: number }>, rows: Array<Array<string | Buffer | null>>): Buffer[] {
  const out: Buffer[] = []
  let seq = 1
  out.push(packet(Buffer.from([columns.length]), seq++))
  for (const column of columns) out.push(packet(columnDef(column.name, column.type, column.length), seq++))
  out.push(packet(eofPacket(), seq++))
  for (const row of rows) {
    const parts = row.map((value) => {
      if (value === null) return Buffer.from([0xfb])
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
      return Buffer.concat([Buffer.from([body.length]), body])
    })
    out.push(packet(Buffer.concat(parts), seq++))
  }
  out.push(packet(eofPacket(), seq++))
  return out
}

function native(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const s1 = createHash('sha1').update(password).digest()
  const s2 = createHash('sha1').update(s1).digest()
  const seeded = createHash('sha1').update(Buffer.concat([salt, s2])).digest()
  const out = Buffer.alloc(20)
  for (let i = 0; i < 20; i += 1) out[i] = s1[i]! ^ seeded[i]!
  return out
}

interface FakeMySql {
  port: number
  queries: string[]
  close: () => Promise<void>
}

async function fakeMySql(options: { password: string; replies: (sql: string) => Buffer[] | undefined }): Promise<FakeMySql> {
  const queries: string[] = []
  const salt1 = Buffer.from('12345678', 'ascii')
  const salt2 = Buffer.from('901234567890', 'ascii')

  const server = net.createServer((socket) => {
    const greeting = Buffer.concat([
      Buffer.from([10]),
      nul('8.0.36'),
      u32(7),
      salt1,
      Buffer.from([0]),
      u16(0x8000 | 0x0200 | 0x0008 | 0x0001 | 0x2000),
      Buffer.from([0x21]),
      u16(0x0002),
      u16(0x0008 | 0x0004 | 0x0002 | 0x0001),
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.concat([salt2, Buffer.from([0])]),
      nul('mysql_native_password'),
    ])
    socket.write(packet(greeting, 0))

    let pending: Buffer = Buffer.alloc(0)
    let authed = false
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (pending.length < 4) break
        const len = pending.readUIntLE(0, 3)
        if (pending.length < 4 + len) break
        const seq = pending[3]!
        const payload = pending.subarray(4, 4 + len)
        pending = pending.subarray(4 + len)

        if (!authed) {
          let off = 4 + 4 + 1 + 23
          const userEnd = payload.indexOf(0, off)
          off = userEnd + 1
          const authLen = payload[off]!
          const authResponse = payload.subarray(off + 1, off + 1 + authLen)
          const expected = native(options.password, Buffer.concat([salt1, salt2]))
          if (!authResponse.equals(expected)) {
            socket.write(packet(Buffer.concat([Buffer.from([0xff]), u16(1045), Buffer.from('#'), Buffer.from('28000'), Buffer.from('Access denied')]), seq + 1))
            socket.destroy()
            return
          }
          socket.write(packet(okPacket(), seq + 1))
          authed = true
          continue
        }

        if (payload[0] === 0x01) {
          socket.end()
          return
        }
        if (payload[0] === 0x03) {
          const sql = payload.toString('utf8', 1)
          queries.push(sql)
          const frames = options.replies(sql) ?? [packet(okPacket(), 1)]
          const joined = Buffer.concat(
            frames.map((frame, index) => {
              const body = frame.subarray(4)
              const head = Buffer.alloc(4)
              head.writeUIntLE(body.length, 0, 3)
              head[3] = index + 1
              return Buffer.concat([head, body])
            }),
          )
          socket.write(joined)
        }
      }
    })
    socket.on('error', () => {})
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    queries,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.unref()
      }),
  }
}

/** 起真的 HTTP 服务器；`connect` 注在 handler 上（驱动层那一段）。 */
async function serve(mysqlPort?: number): Promise<{ url: string; close: () => Promise<void> }> {
  const tunnel = new TunnelService({ registry, engine })
  const handler = createDbHandler({
    registry,
    engine,
    tunnel,
    audit: () => {},
    projectRoot: root,
    compose: fakeCompose,
    ...(mysqlPort ? { connect: () => net.connect({ host: '127.0.0.1', port: mysqlPort }) } : {}),
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

function registerMySql(name: string): void {
  registry.add({
    name,
    engine: 'mysql',
    container: name,
    port: 3306,
    user: 'kura',
    database: 'app',
    dir: '',
    managed: true,
    createdAt: '',
  })
}

describe('MySQL 数据浏览：HTTP 路由', () => {
  it('列库：跳过系统库，返回 application 库', async () => {
    const mysql = await fakeMySql({
      password: 'pw123',
      replies: (sql) =>
        sql.includes('information_schema.tables')
          ? resultSet(
              [{ name: 'name', type: MySqlType.varchar }, { name: 'tables', type: MySqlType.longlong }],
              [
                ['app', '3'],
                ['mysql', '31'],
              ],
            )
          : undefined,
    })
    registerMySql('shop')
    docker.addContainer('shop', { image: 'mysql:8.4', env: ['MYSQL_USER=kura', 'MYSQL_PASSWORD=pw123', 'MYSQL_DATABASE=app'] })

    const s = await serve(mysql.port)
    const res = await fetch(`${s.url}/api/db/shop/schemas`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; tableCount: number }>
    expect(body).toEqual([{ name: 'app', tableCount: 3 }])

    // 口令是从容器环境变量读出来的（不是项目 .env —— 接管的容器没有那个文件）
    await s.close()
    await mysql.close()
  })

  it('列表 + 读一页数据：值是结构化的单元格（NULL 与空串分开）', async () => {
    const mysql = await fakeMySql({
      password: 'pw123',
      replies: (sql) => {
        if (sql.includes('information_schema.tables') && sql.includes('table_name')) {
          return resultSet(
            [
              { name: 'table_name', type: MySqlType.varchar },
              { name: 'table_type', type: MySqlType.varchar },
              { name: 'table_rows', type: MySqlType.longlong },
            ],
            [['users', 'BASE TABLE', '2']],
          )
        }
        if (sql.includes('information_schema.tables')) {
          return resultSet([{ name: 'table_rows', type: MySqlType.longlong }], [['2']])
        }
        // SELECT * FROM ...
        return resultSet(
          [
            { name: 'id', type: MySqlType.long },
            { name: 'nick', type: MySqlType.varchar },
            { name: 'avatar', type: MySqlType.blob },
          ],
          [
            ['1', 'alice', null],
            ['2', '', Buffer.from([0xff, 0x00])],
          ],
        )
      },
    })
    registerMySql('shop')
    docker.addContainer('shop', { image: 'mysql:8.4', env: ['MYSQL_USER=kura', 'MYSQL_PASSWORD=pw123'] })

    const s = await serve(mysql.port)

    const tables = await fetch(`${s.url}/api/db/shop/tables?schema=app`)
    expect(tables.status).toBe(200)
    expect(((await tables.json()) as unknown[])[0]).toMatchObject({ name: 'users', kind: 'table' })

    const rows = await fetch(`${s.url}/api/db/shop/rows?schema=app&table=users&limit=10`)
    expect(rows.status).toBe(200)
    const page = (await rows.json()) as { columns: Array<{ name: string; type: string }>; rows: Array<Array<{ text: string; kind: string }>>; hasMore: boolean }
    expect(page.columns.map((c) => c.name)).toEqual(['id', 'nick', 'avatar'])
    // 第一行第三列是 NULL
    expect(page.rows[0]![2]).toMatchObject({ kind: 'null', text: 'NULL' })
    // 第二行第二列是空串 —— 必须与 NULL 不同
    expect(page.rows[1]![1]).toMatchObject({ kind: 'text', text: '' })
    expect(page.rows[1]![1]!.text).not.toBe('NULL')
    // 二进制按十六进制
    expect(page.rows[1]![2]).toMatchObject({ kind: 'binary', text: '0xff00' })

    await s.close()
    await mysql.close()
  })

  it('跑 SQL：结果集与命令类语句都给结构化结果', async () => {
    const mysql = await fakeMySql({
      password: 'pw123',
      replies: (sql) => {
        if (sql.startsWith('UPDATE')) {
          return [packet(Buffer.concat([Buffer.from([0x00, 0x03, 0x00]), u16(0x0002), u16(0)]), 1)]
        }
        return resultSet([{ name: 'n', type: MySqlType.long }], [['42']])
      },
    })
    registerMySql('shop')
    docker.addContainer('shop', { image: 'mysql:8.4', env: ['MYSQL_USER=kura', 'MYSQL_PASSWORD=pw123'] })

    const s = await serve(mysql.port)

    const rows = await fetch(`${s.url}/api/db/shop/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 42 AS n', database: 'app' }),
    })
    expect(rows.status).toBe(200)
    const result = (await rows.json()) as { kind: string; rows: Array<Array<{ text: string }>> }
    expect(result.kind).toBe('rows')
    expect(result.rows[0]![0]!.text).toBe('42')

    const update = await fetch(`${s.url}/api/db/shop/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'UPDATE t SET a=1', database: 'app' }),
    })
    expect(update.status).toBe(200)
    const command = (await update.json()) as { kind: string; affected: number }
    expect(command.kind).toBe('command')
    expect(command.affected).toBe(3)

    await s.close()
    await mysql.close()
  })

  it('对 Redis 的库调 schemas 会被说清楚', async () => {
    registry.add({ name: 'cache', engine: 'redis', container: 'cache', port: 6379, user: '', database: '', dir: '', managed: true, createdAt: '' })
    docker.addContainer('cache', { image: 'redis:7-alpine', env: ['REDIS_PASSWORD=x'] })

    const s = await serve()
    const res = await fetch(`${s.url}/api/db/cache/schemas`)
    expect(res.status).toBe(400)
    // 这条接口给所有关系库用（MySQL / MariaDB / PostgreSQL），所以措辞是「不是关系库」
    expect(((await res.json()) as { error: string }).error).toContain('不是关系库')
    await s.close()
  })

  it('SQL 里的错误原文会透出来（排查时最有用）', async () => {
    const mysql = await fakeMySql({
      password: 'pw123',
      replies: () => [packet(Buffer.concat([Buffer.from([0xff]), u16(1146), Buffer.from('#'), Buffer.from('42S02'), Buffer.from("Table 'app.nope' doesn't exist")]), 1)],
    })
    registerMySql('shop')
    docker.addContainer('shop', { image: 'mysql:8.4', env: ['MYSQL_USER=kura', 'MYSQL_PASSWORD=pw123'] })

    const s = await serve(mysql.port)
    const res = await fetch(`${s.url}/api/db/shop/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM nope', database: 'app' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain("doesn't exist")

    await s.close()
    await mysql.close()
  })
})
