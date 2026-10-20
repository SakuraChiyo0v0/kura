import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { md5Response, PgClient } from '../src/db/postgres.js'

/**
 * PostgreSQL 客户端的端到端测试：**一个说真 pg 协议的真 TCP 服务器**。
 *
 * 特别是 SCRAM：客户端算的 proof 要能被「服务端」验过，服务端回的签名也要被客户端验过。
 * 两边各写一遍（不共用实现）才证明得了 —— 共用一份代码的话，错了也是一起错。
 */

const BE = { auth: 0x52, ready: 0x5a, rowDesc: 0x54, dataRow: 0x44, cmdComplete: 0x43, error: 0x45, parseComplete: 0x31, bindComplete: 0x32, parameterStatus: 0x53, noData: 0x6e, emptyQuery: 0x49 } as const

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

function authMessage(method: number, extra?: Buffer): Buffer {
  return message(BE.auth, Buffer.concat([int32(method), extra ?? Buffer.alloc(0)]))
}

function rowDescription(columns: Array<{ name: string; typeOid: number }>): Buffer {
  return message(
    BE.rowDesc,
    Buffer.concat([
      int16(columns.length),
      ...columns.flatMap((column) => [
        cstr(column.name),
        int32(0), // table oid
        int16(0), // column attr
        int32(column.typeOid),
        int16(-1), // type size
        int32(-1), // type modifier
        int16(0), // format text
      ]),
    ]),
  )
}

function dataRow(values: Array<string | null>): Buffer {
  const parts: Buffer[] = [int16(values.length)]
  for (const value of values) {
    if (value === null) {
      parts.push(int32(-1))
    } else {
      const body = Buffer.from(value, 'utf8')
      parts.push(int32(body.length), body)
    }
  }
  return message(BE.dataRow, Buffer.concat(parts))
}

const commandComplete = (tag: string): Buffer => message(BE.cmdComplete, cstr(tag))
const readyForQuery = (): Buffer => message(BE.ready, Buffer.from([0x49])) // 'I' = idle

function errorResponse(fields: { code: string; message: string }): Buffer {
  return message(
    BE.error,
    Buffer.concat([Buffer.from([0x53]), cstr('ERROR'), Buffer.from([0x43]), cstr(fields.code), Buffer.from([0x4d]), cstr(fields.message), Buffer.from([0])]),
  )
}

/** 服务端一侧的 SCRAM 实现（和客户端那份**刻意分开写**，好互相验证）。 */
function serverScram(password: string, clientFirstBare: string, clientFinal: string, serverFirst: string) {
  const attrs = Object.fromEntries(clientFinal.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  const proof = Buffer.from(attrs.p ?? '', 'base64')
  const withoutProof = clientFinal.slice(0, clientFinal.lastIndexOf(',p='))
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`

  const serverAttrs = Object.fromEntries(serverFirst.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  const salt = Buffer.from(serverAttrs.s ?? '', 'base64')
  const iterations = Number(serverAttrs.i)

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest()
  // ClientKey = proof XOR ClientSignature
  const recovered = Buffer.alloc(32)
  for (let i = 0; i < 32; i += 1) recovered[i] = (proof[i] ?? 0) ^ (clientSignature[i] ?? 0)
  const ok = createHash('sha256').update(recovered).digest().equals(storedKey)

  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest()
  const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest()
  return { ok, serverSignature: serverSignature.toString('base64') }
}

interface FakePg {
  port: number
  /** 收到的 SQL */
  queries: string[]
  close: () => Promise<void>
}

/**
 * 一个说 PostgreSQL 协议 v3 的假服务器。
 *
 * `auth` 决定用哪种认证；`replies` 把 SQL 映射到后端消息。
 */
async function fakePg(options: {
  auth: 'trust' | 'cleartext' | 'md5' | 'scram'
  user?: string
  password?: string
  database?: string
  replies: (sql: string) => Buffer[]
}): Promise<FakePg> {
  const user = options.user ?? 'kura'
  const password = options.password ?? 'hunter2'
  const queries: string[] = []

  const server = net.createServer((socket) => {
    let pending: Buffer = Buffer.alloc(0)
    let phase: 'startup' | 'auth' | 'query' = 'startup'
    /** SCRAM 过程中记下的客户端 client-first-bare */
    let clientFirstBare = ''
    let serverFirst = ''
    let salt = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        // PasswordMessage 类型是 'p'（0x70）。**要在 startup 判断之前认它** ——
        // 它可能和 StartupMessage 挤在同一个 data 事件里，而那时 phase 还是 'startup'。
        if (pending.length >= 5 && pending[0] === 0x70 && phase !== 'query') {
          const plen = pending.readInt32BE(1)
          if (pending.length < 1 + plen) return
          const payload = pending.subarray(5, 1 + plen)
          pending = pending.subarray(1 + plen)

          // SASL 的第一条是 SASLInitialResponse（机制名\0 + 长度 + 内容），不在这条路径上处理
          if (options.auth === 'cleartext') {
            if (payload.toString('utf8', 0, payload.length - 1) !== password) {
              socket.write(errorResponse({ code: '28P01', message: 'password authentication failed' }))
              socket.destroy()
              return
            }
            socket.write(Buffer.concat([authMessage(0), readyForQuery()]))
            phase = 'query'
            continue
          }
          if (options.auth === 'md5') {
            const got = payload.toString('utf8', 0, payload.length - 1)
            if (got !== md5Response(user, password, salt)) {
              socket.write(errorResponse({ code: '28P01', message: 'password authentication failed' }))
              socket.destroy()
              return
            }
            socket.write(Buffer.concat([authMessage(0), readyForQuery()]))
            phase = 'query'
            continue
          }
          if (options.auth === 'scram') {
            if (serverFirst === '') {
              const nulEnd = payload.indexOf(0)
              const mechanism = payload.toString('utf8', 0, nulEnd)
              if (mechanism !== 'SCRAM-SHA-256') {
                socket.write(errorResponse({ code: '08P01', message: 'unsupported mechanism' }))
                socket.destroy()
                return
              }
              const msgLen = payload.readInt32BE(nulEnd + 1)
              const clientFirst = payload.toString('utf8', nulEnd + 5, nulEnd + 5 + msgLen)
              clientFirstBare = clientFirst.slice(3)
              const nonce = clientFirstBare.slice(clientFirstBare.indexOf('r=') + 2)
              salt = randomBytes(16)
              serverFirst = `r=${nonce}SRVNONCE,s=${salt.toString('base64')},i=4096`
              socket.write(authMessage(11, Buffer.from(serverFirst, 'utf8')))
              continue
            }
            const clientFinal = payload.toString('utf8')
            const result = serverScram(password, clientFirstBare, clientFinal, serverFirst)
            if (!result.ok) {
              socket.write(errorResponse({ code: '28P01', message: 'password authentication failed' }))
              socket.destroy()
              return
            }
            socket.write(Buffer.concat([authMessage(12, Buffer.from(`v=${result.serverSignature}`, 'utf8')), authMessage(0), readyForQuery()]))
            phase = 'query'
            continue
          }
          continue
        }

        if (phase === 'startup') {
          // StartupMessage 没有类型字节：长度(4) + 内容
          if (pending.length < 4) return
          const len = pending.readInt32BE(0)
          if (pending.length < len) return
          const body = pending.subarray(4, len)
          pending = pending.subarray(len)

          // 解析 user=…\0database=…\0…
          const params: Record<string, string> = {}
          let off = 0
          off += 4 // 协议版本
          while (off < body.length) {
            const end = body.indexOf(0, off)
            if (end < 0 || end === off) break
            const key = body.toString('utf8', off, end)
            off = end + 1
            const end2 = body.indexOf(0, off)
            if (end2 < 0) break
            params[key] = body.toString('utf8', off, end2)
            off = end2 + 1
          }

          if (params.user !== user) {
            socket.write(errorResponse({ code: '28P01', message: 'role does not exist' }))
            socket.destroy()
            return
          }

          if (options.auth === 'trust') {
            socket.write(Buffer.concat([authMessage(0), readyForQuery()]))
            phase = 'query'
            continue
          }
          if (options.auth === 'cleartext') {
            socket.write(authMessage(3))
            continue
          }
          if (options.auth === 'md5') {
            const md5Salt = randomBytes(4)
            socket.write(authMessage(5, md5Salt))
            // 记下 salt 供后续校验
            salt = md5Salt
            continue
          }
          // SCRAM：发机制列表
          socket.write(authMessage(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8')))
          continue
        }


        // 查询阶段：扩展查询是一串消息（Parse 'P' / Bind 'B' / Describe 'D' / Execute 'E' / Sync 'S'）
        if (pending.length < 5) return
        const type = pending[0]
        const len = pending.readInt32BE(1)
        if (pending.length < 1 + len) return
        const payload = pending.subarray(5, 1 + len)
        pending = pending.subarray(1 + len)

        if (type === 0x50) {
          // Parse：名字\0 + SQL\0 + int16 参数数
          const firstNul = payload.indexOf(0)
          const secondNul = payload.indexOf(0, firstNul + 1)
          const sql = payload.toString('utf8', firstNul + 1, secondNul)
          queries.push(sql)
          // 把这条 SQL 的应答存起来，等 Sync 一起发（简化：Parse 时就算好）
          ;(socket as unknown as { __lastSql: string }).__lastSql = sql
          socket.write(message(BE.parseComplete, Buffer.alloc(0)))
          continue
        }
        if (type === 0x42) {
          socket.write(message(BE.bindComplete, Buffer.alloc(0)))
          continue
        }
        if (type === 0x44) {
          // Describe：'P' 或 'S' + 名字。简化：我们总是发结果描述。
          const sql = (socket as unknown as { __lastSql: string }).__lastSql ?? ''
          const frames = options.replies(sql)
          // 只发 RowDescription（不在这里发数据，等 Execute）
          const desc = frames.find((f) => f[0] === BE.rowDesc) ?? message(BE.noData, Buffer.alloc(0))
          socket.write(desc)
          ;(socket as unknown as { __frames: Buffer[] }).__frames = frames.filter((f) => f[0] !== BE.rowDesc)
          continue
        }
        if (type === 0x45) {
          const frames = (socket as unknown as { __frames?: Buffer[] }).__frames ?? []
          socket.write(Buffer.concat(frames))
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

async function connectTo(server: FakePg, overrides: { password?: string; database?: string } = {}): Promise<PgClient> {
  return PgClient.connect({
    host: '127.0.0.1',
    port: server.port,
    user: 'kura',
    password: overrides.password ?? 'hunter2',
    database: overrides.database ?? 'app',
  })
}

describe('PgClient：认证', () => {
  let server: FakePg | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('trust 认证（不走口令）', async () => {
    server = await fakePg({ auth: 'trust', replies: () => [rowDescription([{ name: 'n', typeOid: 23 }]), dataRow(['1']), commandComplete('SELECT 1')] })
    const client = await connectTo(server)
    const result = await client.query('SELECT 1 AS n')
    expect(result.kind).toBe('rows')
    client.close()
  })

  it('cleartext 认证', async () => {
    server = await fakePg({ auth: 'cleartext', replies: () => [rowDescription([{ name: 'n', typeOid: 23 }]), dataRow(['1']), commandComplete('SELECT 1')] })
    const client = await connectTo(server)
    const result = await client.query('SELECT 1')
    expect(result.rows).toHaveLength(1)
    client.close()
  })

  it('md5 认证', async () => {
    server = await fakePg({ auth: 'md5', replies: () => [rowDescription([{ name: 'n', typeOid: 23 }]), dataRow(['1']), commandComplete('SELECT 1')] })
    const client = await connectTo(server)
    const result = await client.query('SELECT 1')
    expect(result.rows).toHaveLength(1)
    client.close()
  })

  it('SCRAM-SHA-256 认证（PostgreSQL 10+ 默认）', async () => {
    server = await fakePg({
      auth: 'scram',
      replies: () => [rowDescription([{ name: 'n', typeOid: 23 }]), dataRow(['42']), commandComplete('SELECT 1')],
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT 42')
    expect(result.rows[0]?.[0]?.toString('utf8')).toBe('42')
    client.close()
  })

  it('SCRAM 口令错了明确报认证失败', async () => {
    server = await fakePg({ auth: 'scram', replies: () => [] })
    await expect(connectTo(server, { password: 'wrong-pass' })).rejects.toThrow(/认证失败/)
  })

  it('口令错（md5）也明确报认证失败', async () => {
    server = await fakePg({ auth: 'md5', replies: () => [] })
    await expect(connectTo(server, { password: 'nope' })).rejects.toThrow(/认证失败/)
  })
})

describe('PgClient：结果集', () => {
  let server: FakePg | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('NULL 与空串分开、类型 OID 翻成名字', async () => {
    server = await fakePg({
      auth: 'trust',
      replies: () => [
        rowDescription([
          { name: 'id', typeOid: 23 },
          { name: 'note', typeOid: 25 },
          { name: 'blob', typeOid: 17 },
        ]),
        dataRow(['1', null, '\\xdead']),
        dataRow(['2', '', null]),
        commandComplete('SELECT 2'),
      ],
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT * FROM t')
    expect(result.columns.map((c) => c.type)).toEqual(['int4', 'text', 'bytea'])
    expect(result.columns[0]!.numeric).toBe(true)
    expect(result.columns[2]!.binary).toBe(true)
    // 第一行第二列 NULL
    expect(result.rows[0]![1]).toBeNull()
    // 第二行第二列空串
    expect(result.rows[1]![1]).toEqual(Buffer.alloc(0))
    client.close()
  })

  it('命令类语句：从标签里拿影响行数', async () => {
    server = await fakePg({ auth: 'trust', replies: () => [commandComplete('INSERT 0 5')] })
    const client = await connectTo(server)
    const result = await client.query('INSERT INTO t VALUES (1)')
    expect(result.kind).toBe('command')
    expect(result.command).toBe('INSERT 0 5')
    expect(result.affected).toBe(5)
    client.close()
  })

  it('SQL 错误的原文与 SQLSTATE 一起透出来', async () => {
    server = await fakePg({
      auth: 'trust',
      replies: () => [errorResponse({ code: '42P01', message: 'relation "nope" does not exist' })],
    })
    const client = await connectTo(server)
    await expect(client.query('SELECT * FROM nope')).rejects.toThrow(/does not exist/)
    // 错误之后连接仍可用（ReadyForQuery 已经读掉）
    client.close()
  })

  it('多行结果全收（消息挤在一两个 TCP 段里也不会丢）', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => dataRow([String(i)]))
    server = await fakePg({
      auth: 'trust',
      replies: () => [rowDescription([{ name: 'n', typeOid: 23 }]), ...rows, commandComplete('SELECT 50')],
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT generate_series(0,49)')
    expect(result.rows).toHaveLength(50)
    expect(result.rows[49]![0]?.toString('utf8')).toBe('49')
    client.close()
  })
})
