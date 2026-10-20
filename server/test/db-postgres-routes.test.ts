import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
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
 * PostgreSQL 数据浏览的 HTTP 路由端到端测试。
 *
 * 一个说真 pg 协议（含 SCRAM 认证）的假服务器 + 完整链路：
 * 容器识别 → 口令从容器环境变量读 → SCRAM 握手 → 查 pg_catalog → 结构化 JSON。
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
  root = mkdtempSync(join(tmpdir(), 'kura-db-pg-')).replace(/\\/g, '/')
  registry = new DatabaseRegistry(join(root, 'databases.json'))
})
afterEach(async () => {
  await docker.stop()
  rmSync(root, { recursive: true, force: true })
})

const BE = { auth: 0x52, ready: 0x5a, rowDesc: 0x54, dataRow: 0x44, cmdComplete: 0x43, error: 0x45, parseComplete: 0x31, bindComplete: 0x32, noData: 0x6e } as const

function message(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head[0] = type
  head.writeInt32BE(payload.length + 4, 1)
  return Buffer.concat([head, payload])
}
function int32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}
function int16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n)
  return b
}
const cstr = (text: string): Buffer => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])])
const authMessage = (method: number, extra?: Buffer): Buffer => message(BE.auth, Buffer.concat([int32(method), extra ?? Buffer.alloc(0)]))
const readyForQuery = (): Buffer => message(BE.ready, Buffer.from([0x49]))

function rowDescription(columns: Array<{ name: string; typeOid: number }>): Buffer {
  return message(
    BE.rowDesc,
    Buffer.concat([
      int16(columns.length),
      ...columns.flatMap((column) => [cstr(column.name), int32(0), int16(0), int32(column.typeOid), int16(-1), int32(-1), int16(0)]),
    ]),
  )
}
function dataRow(values: Array<string | null>): Buffer {
  const parts: Buffer[] = [int16(values.length)]
  for (const value of values) {
    if (value === null) parts.push(int32(-1))
    else {
      const body = Buffer.from(value, 'utf8')
      parts.push(int32(body.length), body)
    }
  }
  return message(BE.dataRow, Buffer.concat(parts))
}
const commandComplete = (tag: string): Buffer => message(BE.cmdComplete, cstr(tag))
const errorResponse = (code: string, msg: string): Buffer =>
  message(BE.error, Buffer.concat([Buffer.from([0x53]), cstr('ERROR'), Buffer.from([0x43]), cstr(code), Buffer.from([0x4d]), cstr(msg), Buffer.from([0])]))

/** 服务端侧的 SCRAM（与客户端实现分开写，互相验证）。 */
function serverScram(password: string, clientFirstBare: string, clientFinal: string, serverFirst: string) {
  const attrs = Object.fromEntries(clientFinal.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  const proof = Buffer.from(attrs.p ?? '', 'base64')
  const withoutProof = clientFinal.slice(0, clientFinal.lastIndexOf(',p='))
  const authMessageText = `${clientFirstBare},${serverFirst},${withoutProof}`
  const serverAttrs = Object.fromEntries(serverFirst.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  const salt = Buffer.from(serverAttrs.s ?? '', 'base64')
  const iterations = Number(serverAttrs.i)
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const clientSignature = createHmac('sha256', storedKey).update(authMessageText).digest()
  const recovered = Buffer.alloc(32)
  for (let i = 0; i < 32; i += 1) recovered[i] = (proof[i] ?? 0) ^ (clientSignature[i] ?? 0)
  const ok = createHash('sha256').update(recovered).digest().equals(storedKey)
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  const serverSignature = createHmac('sha256', serverKey).update(authMessageText).digest()
  return { ok, serverSignature: serverSignature.toString('base64') }
}

interface FakePg {
  port: number
  queries: string[]
  close: () => Promise<void>
}

async function fakePg(options: { user?: string; password?: string; replies: (sql: string) => Buffer[] }): Promise<FakePg> {
  const user = options.user ?? 'postgres'
  const password = options.password ?? 'pgpass'
  const queries: string[] = []

  const server = net.createServer((socket) => {
    let pending: Buffer = Buffer.alloc(0)
    let started = false
    let clientFirstBare = ''
    let serverFirst = ''
    let salt = Buffer.alloc(0)
    const state = socket as unknown as { lastSql: string; frames: Buffer[] }

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        // 1) StartupMessage（无类型字节）
        if (!started) {
          if (pending.length < 4) return
          const len = pending.readInt32BE(0)
          if (pending.length < len) return
          pending = pending.subarray(len)
          started = true
          socket.write(authMessage(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8')))
          continue
        }
        if (pending.length < 5) return

        // 2) PasswordMessage 'p'
        if (pending[0] === 0x70) {
          const len = pending.readInt32BE(1)
          if (pending.length < 1 + len) return
          const payload = pending.subarray(5, 1 + len)
          pending = pending.subarray(1 + len)

          if (serverFirst === '') {
            const nulEnd = payload.indexOf(0)
            const msgLen = payload.readInt32BE(nulEnd + 1)
            const clientFirst = payload.toString('utf8', nulEnd + 5, nulEnd + 5 + msgLen)
            clientFirstBare = clientFirst.slice(3)
            const nonce = clientFirstBare.slice(clientFirstBare.indexOf('r=') + 2)
            salt = randomBytes(16)
            serverFirst = `r=${nonce}SRV,s=${salt.toString('base64')},i=4096`
            socket.write(authMessage(11, Buffer.from(serverFirst, 'utf8')))
            continue
          }
          const result = serverScram(password, clientFirstBare, payload.toString('utf8'), serverFirst)
          if (!result.ok) {
            socket.write(errorResponse('28P01', 'password authentication failed for user "' + user + '"'))
            socket.destroy()
            return
          }
          socket.write(Buffer.concat([authMessage(12, Buffer.from(`v=${result.serverSignature}`, 'utf8')), authMessage(0), readyForQuery()]))
          continue
        }

        // 3) 扩展查询
        const type = pending[0]
        const len = pending.readInt32BE(1)
        if (pending.length < 1 + len) return
        const payload = pending.subarray(5, 1 + len)
        pending = pending.subarray(1 + len)

        if (type === 0x50) {
          const firstNul = payload.indexOf(0)
          const secondNul = payload.indexOf(0, firstNul + 1)
          state.lastSql = payload.toString('utf8', firstNul + 1, secondNul)
          queries.push(state.lastSql)
          socket.write(message(BE.parseComplete, Buffer.alloc(0)))
          continue
        }
        if (type === 0x42) {
          socket.write(message(BE.bindComplete, Buffer.alloc(0)))
          continue
        }
        if (type === 0x44) {
          const frames = options.replies(state.lastSql)
          const desc = frames.find((f) => f[0] === BE.rowDesc || f[0] === BE.error) ?? message(BE.noData, Buffer.alloc(0))
          socket.write(desc)
          state.frames = frames.filter((f) => f[0] !== BE.rowDesc && f[0] !== BE.error)
          continue
        }
        if (type === 0x45) {
          socket.write(Buffer.concat(state.frames ?? []))
          continue
        }
        if (type === 0x53) {
          socket.write(readyForQuery())
          continue
        }
        if (type === 0x58) {
          socket.end()
          return
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

async function serve(pgPort?: number): Promise<{ url: string; close: () => Promise<void> }> {
  const tunnel = new TunnelService({ registry, engine })
  const handler = createDbHandler({
    registry,
    engine,
    tunnel,
    audit: () => {},
    projectRoot: root,
    compose: fakeCompose,
    ...(pgPort ? { connect: () => net.connect({ host: '127.0.0.1', port: pgPort }) } : {}),
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

function registerPg(name: string, user = 'postgres', database = 'postgres'): void {
  registry.add({ name, engine: 'postgres', container: name, port: 5432, user, database, dir: '', managed: true, createdAt: '' })
}

describe('PostgreSQL 数据浏览：HTTP 路由', () => {
  it('列 schema：跳过 pg_catalog / information_schema', async () => {
    const pg = await fakePg({
      replies: () =>
        [rowDescription([{ name: 'name', typeOid: 19 }, { name: 'tables', typeOid: 20 }]), dataRow(['public', '3']), dataRow(['pg_catalog', '80']), commandComplete('SELECT 2')],
    })
    registerPg('main')
    docker.addContainer('main', { image: 'postgres:17-alpine', env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=pgpass', 'POSTGRES_DB=postgres'] })

    const s = await serve(pg.port)
    const res = await fetch(`${s.url}/api/db/main/schemas`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string; tableCount: number }>
    expect(body).toEqual([{ name: 'public', tableCount: 3 }])

    await s.close()
    await pg.close()
  })

  it('列库 + 读一页数据：NULL 与空串分开、bytea 不当文本', async () => {
    const pg = await fakePg({
      replies: (sql) => {
        if (sql.includes('pg_class') && sql.includes('relname')) {
          return [
            rowDescription([{ name: 'name', typeOid: 19 }, { name: 'kind', typeOid: 25 }, { name: 'rows', typeOid: 20 }]),
            dataRow(['users', 'table', '2']),
            commandComplete('SELECT 1'),
          ]
        }
        if (sql.includes('pg_class')) {
          return [rowDescription([{ name: 'rows', typeOid: 20 }]), dataRow(['2']), commandComplete('SELECT 1')]
        }
        return [
          rowDescription([
            { name: 'id', typeOid: 23 },
            { name: 'nick', typeOid: 25 },
            { name: 'avatar', typeOid: 17 },
            { name: 'ok', typeOid: 16 },
          ]),
          dataRow(['1', null, '\\xdead', 't']),
          dataRow(['2', '', null, 'f']),
          commandComplete('SELECT 2'),
        ]
      },
    })
    registerPg('main')
    docker.addContainer('main', { image: 'postgres:17-alpine', env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=pgpass'] })

    const s = await serve(pg.port)

    const tables = await fetch(`${s.url}/api/db/main/tables?schema=public`)
    expect(tables.status).toBe(200)
    expect(((await tables.json()) as unknown[])[0]).toMatchObject({ name: 'users', kind: 'table' })

    const rows = await fetch(`${s.url}/api/db/main/rows?schema=public&table=users&limit=10`)
    expect(rows.status).toBe(200)
    const page = (await rows.json()) as { columns: Array<{ name: string; type: string }>; rows: Array<Array<{ text: string; kind: string }>> }
    expect(page.columns.map((c) => c.type)).toEqual(['int4', 'text', 'bytea', 'bool'])
    expect(page.rows[0]![1]).toMatchObject({ kind: 'null', text: 'NULL' })
    expect(page.rows[1]![1]).toMatchObject({ kind: 'text', text: '' })
    expect(page.rows[0]![2]).toMatchObject({ kind: 'binary', text: '\\xdead' })
    // PG 的 bool 文本是 t/f，要翻成 true/false
    expect(page.rows[0]![3]).toMatchObject({ kind: 'bool', text: 'true' })
    expect(page.rows[1]![3]).toMatchObject({ kind: 'bool', text: 'false' })

    await s.close()
    await pg.close()
  })

  it('跑 SQL：结果集与命令类语句', async () => {
    const pg = await fakePg({
      replies: (sql) =>
        sql.startsWith('UPDATE')
          ? [commandComplete('UPDATE 7')]
          : [rowDescription([{ name: 'n', typeOid: 23 }]), dataRow(['42']), commandComplete('SELECT 1')],
    })
    registerPg('main')
    docker.addContainer('main', { image: 'postgres:17-alpine', env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=pgpass'] })

    const s = await serve(pg.port)

    const rows = await fetch(`${s.url}/api/db/main/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 42 AS n', database: 'postgres' }),
    })
    expect(rows.status).toBe(200)
    const result = (await rows.json()) as { kind: string; rows: Array<Array<{ text: string }>> }
    expect(result.kind).toBe('rows')
    expect(result.rows[0]![0]!.text).toBe('42')

    const update = await fetch(`${s.url}/api/db/main/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'UPDATE t SET a=1' }),
    })
    expect(update.status).toBe(200)
    const command = (await update.json()) as { kind: string; affected: number }
    expect(command.kind).toBe('command')
    expect(command.affected).toBe(7)

    await s.close()
    await pg.close()
  })

  it('口令错了明确报认证失败（SCRAM 走不通）', async () => {
    const pg = await fakePg({ password: 'right-pass', replies: () => [] })
    registerPg('locked')
    // 容器里声明的是别的口令
    docker.addContainer('locked', { image: 'postgres:17-alpine', env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=wrong-pass'] })

    const s = await serve(pg.port)
    const res = await fetch(`${s.url}/api/db/locked/schemas`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toMatch(/认证失败/)

    await s.close()
    await pg.close()
  })

  it('SQL 错误的 SQLSTATE 与原文都透出来', async () => {
    const pg = await fakePg({
      replies: () => [errorResponse('42P01', 'relation "nope" does not exist'), commandComplete('')],
    })
    registerPg('main')
    docker.addContainer('main', { image: 'postgres:17-alpine', env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=pgpass'] })

    const s = await serve(pg.port)
    const res = await fetch(`${s.url}/api/db/main/query`, {
      method: 'POST',
      headers: { 'x-kura-docker': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT * FROM nope' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('does not exist')
    expect(body.error).toContain('42P01')

    await s.close()
    await pg.close()
  })
})
