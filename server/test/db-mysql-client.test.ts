import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MySqlClient, MySqlType } from '../src/db/mysql.js'
import { describeTable, listSchemas, listTables, readRows, runQuery } from '../src/db/mysql-browse.js'

/**
 * MySQL 客户端的端到端测试：**一个说真协议的真 TCP 服务器**。
 *
 * 这一层要验的是「往返」—— 序号、包边界、认证切换、结果集的 EOF 位置。
 * 协议字段本身的解析有 `db-mysql.test.ts` 覆盖；这里专测**流**：
 * 包可能在任意位置被切开、序号必须逐包递增、认证可能要求换插件。
 */

// ---------------------------------------------------------------- 假服务器

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

/** 包一层（3 字节长度 + 1 字节序号）。 */
function packet(payload: Buffer, seq: number): Buffer {
  const head = Buffer.alloc(4)
  head.writeUIntLE(payload.length, 0, 3)
  head[3] = seq
  return Buffer.concat([head, payload])
}

const okPacket = (): Buffer => Buffer.concat([Buffer.from([0x00]), Buffer.from([0]), Buffer.from([0]), u16(0x0002), u16(0)])
const eofPacket = (): Buffer => Buffer.concat([Buffer.from([0xfe]), u16(0), u16(0)])
const errPacket = (code: number, sqlState: string, message: string): Buffer =>
  Buffer.concat([Buffer.from([0xff]), u16(code), Buffer.from('#'), Buffer.from(sqlState, 'ascii'), Buffer.from(message, 'utf8')])

/** 一个列定义包。 */
function columnDef(name: string, type: number, length = 255, decimals = 0): Buffer {
  return Buffer.concat([
    lenencStr('def'),
    lenencStr('app'),
    lenencStr('users'),
    lenencStr('users'),
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

/** 一个结果集：列数 → 列定义 → EOF → 行 → EOF。 */
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

interface FakeServer {
  port: number
  close: () => Promise<void>
  /** 客户端发来的 SQL（按顺序） */
  queries: string[]
  /** 收到的用户名 */
  users: string[]
}

/**
 * 一个说 MySQL 协议的假服务器。`replies` 把 SQL 开头的关键字映射到应答包列表。
 *
 * `chunkSize` 用来把应答切成小片发出去 —— TCP 会在任意位置切包，
 * 客户端的读取缓冲必须能处理半截包。
 */
async function fakeMySql(options: {
  /** 服务端要求的认证插件；'switch' = 先宣告 native 再发 AuthSwitchRequest 换成 caching_sha2 */
  plugin?: string
  password?: string
  user?: string
  replies: (sql: string) => Buffer[] | undefined
  chunkSize?: number
}): Promise<FakeServer> {
  const queries: string[] = []
  const users: string[] = []
  const chunkSize = options.chunkSize ?? 1024
  const plugin = options.plugin ?? 'mysql_native_password'

  const server = net.createServer((socket) => {
    // ---- 1. 握手 ----
    const salt1 = Buffer.from('12345678', 'ascii')
    const salt2 = Buffer.from('901234567890', 'ascii')
    const greetingPayload = Buffer.concat([
      Buffer.from([10]),
      nul('8.0.36-fake'),
      u32(7),
      salt1,
      Buffer.from([0]),
      u16(0x8000 | 0x0200 | 0x0008 | 0x0001 | 0x2000), // SECURE | 41 | CONNECT_WITH_DB | LONG_PASSWORD | TRANSACTIONS
      Buffer.from([0x21]),
      u16(0x0002),
      u16(0x0008 | 0x0004 | 0x0002 | 0x0001), // PLUGIN_AUTH | LONG_FLAG | MULTI_RESULTS | LONG_PASSWORD
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.concat([salt2, Buffer.from([0])]),
      nul(plugin),
    ])
    let out = packet(greetingPayload, 0)

    // ---- 2. 读客户端应答（HandshakeResponse41） ----
    let pending: Buffer = Buffer.alloc(0)
    let phase: 'auth' | 'query' = 'auth'

    const writeFrames = (frames: Buffer[]): void => {
      const joined = Buffer.concat(frames)
      for (let i = 0; i < joined.length; i += chunkSize) socket.write(joined.subarray(i, i + chunkSize))
    }

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (pending.length < 4) break
        const len = pending.readUIntLE(0, 3)
        if (pending.length < 4 + len) break
        const seq = pending[3]!
        const payload = pending.subarray(4, 4 + len)
        pending = pending.subarray(4 + len)

        if (phase === 'auth') {
          // 能力位（4）/ max packet（4）/ charset（1）/ reserved（23）/ user NUL / auth lenenc / auth / [db] / [plugin]
          let off = 4 + 4 + 1 + 23
          const userEnd = payload.indexOf(0, off)
          const user = payload.toString('utf8', off, userEnd)
          users.push(user)
          off = userEnd + 1
          const authLen = payload[off]!
          const authResponse = payload.subarray(off + 1, off + 1 + authLen)

          // 校验口令：按服务端要求的插件重算一遍
          const salt = Buffer.concat([salt1, salt2])
          const expected =
            (options.password ?? '') === ''
              ? Buffer.alloc(0)
              : plugin === 'caching_sha2_password'
                ? cachingSha2(options.password ?? '', salt)
                : native(options.password ?? '', salt)

          if (user !== (options.user ?? 'kura') || !authResponse.equals(expected)) {
            writeFrames([packet(errPacket(1045, '28000', "Access denied for user '" + user + "'"), seq + 1)])
            socket.destroy()
            return
          }
          // 认证成功：OK
          writeFrames([packet(okPacket(), seq + 1)])
          phase = 'query'
          continue
        }

        // 命令阶段
        const command = payload[0]
        if (command === 0x01) {
          // COM_QUIT
          socket.end()
          return
        }
        if (command === 0x03) {
          const sql = payload.toString('utf8', 1)
          queries.push(sql)
          const frames = options.replies(sql)
          if (!frames) {
            writeFrames([packet(errPacket(1064, '42000', 'fake server: no reply for ' + sql), 1)])
            continue
          }
          // 应答的序号从 1 开始（命令包自己占 0）
          writeFrames(frames.map((frame, index) => {
            const body = frame.subarray(4)
            const head = Buffer.alloc(4)
            head.writeUIntLE(body.length, 0, 3)
            head[3] = index + 1
            return Buffer.concat([head, body])
          }))
          continue
        }
      }
    })
    socket.on('error', () => {})
    socket.write(out)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    queries,
    users,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.unref()
      }),
  }
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

function cachingSha2(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0)
  const s1 = createHash('sha256').update(password).digest()
  const s2 = createHash('sha256').update(s1).digest()
  const seeded = createHash('sha256').update(Buffer.concat([s2, salt])).digest()
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i += 1) out[i] = s1[i]! ^ seeded[i]!
  return out
}

/** 连接并返回 client，用完自动关。 */
async function connectTo(server: FakeServer, overrides: { password?: string; database?: string } = {}): Promise<MySqlClient> {
  return MySqlClient.connect({
    host: '127.0.0.1',
    port: server.port,
    user: 'kura',
    password: overrides.password ?? 'hunter2',
    database: overrides.database ?? 'app',
  })
}

// ---------------------------------------------------------------- 用例

describe('MySqlClient：握手与认证', () => {
  let server: FakeServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('mysql_native_password 认证走通', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () => resultSet([{ name: 'x', type: MySqlType.long }], [['1']]),
    })
    const client = await connectTo(server)
    expect(server.users[0]).toBe('kura')
    const result = await client.query('SELECT 1 AS x')
    expect(result.kind).toBe('rows')
    client.close()
  })

  it('caching_sha2_password 认证走通（MySQL 8 默认）', async () => {
    server = await fakeMySql({
      plugin: 'caching_sha2_password',
      password: 'hunter2',
      replies: () => resultSet([{ name: 'x', type: MySqlType.long }], [['1']]),
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT 1')
    expect(result.rows).toHaveLength(1)
    client.close()
  })

  it('口令错了明确报「认证失败」（不是模糊的连接错误）', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'correct-horse',
      replies: () => [],
    })
    await expect(connectTo(server, { password: 'wrong' })).rejects.toThrow(/认证失败/)
  })

  it('认不出的认证插件在客户端就算出错误，不连上去试', async () => {
    server = await fakeMySql({
      plugin: 'auth_gssapi_client',
      password: 'hunter2',
      replies: () => [],
    })
    await expect(connectTo(server)).rejects.toThrow(/还不支持/)
  })

  it('应答被切成很小的片也能正确拼包（TCP 在任意位置切）', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      chunkSize: 3, // 每 3 字节发一次
      replies: () =>
        resultSet(
          [
            { name: 'id', type: MySqlType.long },
            { name: 'name', type: MySqlType.varchar, length: 255 },
          ],
          [
            ['1', 'alice'],
            ['2', 'bob'],
          ],
        ),
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT * FROM users')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[1]![1]?.toString('utf8')).toBe('bob')
    client.close()
  })
})

describe('MySqlClient：结果集', () => {
  let server: FakeServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('列类型、numeric / binary 标记都对', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () =>
        resultSet(
          [
            { name: 'id', type: MySqlType.long },
            { name: 'avatar', type: MySqlType.blob, length: 65535 },
            { name: 'note', type: MySqlType.varchar },
          ],
          [['1', Buffer.from([0xff, 0x00]), 'hi']],
        ),
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT * FROM t')
    expect(result.columns[0]).toMatchObject({ name: 'id', type: 'int', numeric: true, binary: false })
    expect(result.columns[1]).toMatchObject({ name: 'avatar', numeric: false, binary: true })
    expect(result.columns[2]).toMatchObject({ name: 'note', numeric: false, binary: false })
    client.close()
  })

  it('NULL 与空串在结果里是不同的东西', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () => resultSet([{ name: 'a', type: MySqlType.varchar }, { name: 'b', type: MySqlType.varchar }], [[null, '']]),
    })
    const client = await connectTo(server)
    const result = await client.query('SELECT a, b FROM t')
    expect(result.rows[0]![0]).toBeNull()
    expect(result.rows[0]![1]).toEqual(Buffer.alloc(0))
    client.close()
  })

  it('命令类语句（UPDATE）走 OK 包，带影响行数', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () =>
        // 0x00 / affected=5 / lastInsertId=0 / status / warnings
        [packet(Buffer.concat([Buffer.from([0x00, 0x05, 0x00]), u16(0x0002), u16(0)]), 1)],
    })
    const client = await connectTo(server)
    const result = await client.query('UPDATE t SET a = 1')
    expect(result.kind).toBe('command')
    expect(result.affected).toBe(5)
    client.close()
  })

  it('SQL 错误透出服务端的原文（排查时最有用）', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () => [packet(errPacket(1146, '42S02', "Table 'app.nope' doesn't exist"), 1)],
    })
    const client = await connectTo(server)
    await expect(client.query('SELECT * FROM nope')).rejects.toThrow(/doesn't exist/)
    client.close()
  })
})

describe('mysql-browse：把库翻成界面形状', () => {
  let server: FakeServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('listSchemas 跳过系统库', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: (sql) =>
        sql.includes('information_schema.tables')
          ? resultSet(
              [{ name: 'name', type: MySqlType.varchar }, { name: 'tables', type: MySqlType.longlong }],
              [
                ['app', '7'],
                ['mysql', '31'],
                ['information_schema', '79'],
              ],
            )
          : [packet(okPacket(), 1)],
    })
    const client = await connectTo(server)
    const schemas = await listSchemas(client)
    expect(schemas).toEqual([{ name: 'app', tableCount: 7 }])
    client.close()
  })

  it('listTables / describeTable 认出主键与类型', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: (sql) => {
        if (sql.includes('information_schema.columns')) {
          return resultSet(
            [
              { name: 'column_name', type: MySqlType.varchar },
              { name: 'column_type', type: MySqlType.varchar },
              { name: 'is_nullable', type: MySqlType.varchar },
              { name: 'column_default', type: MySqlType.varchar },
              { name: 'column_key', type: MySqlType.varchar },
            ],
            [
              ['id', 'bigint unsigned', 'NO', null, 'PRI'],
              ['email', 'varchar(255)', 'YES', null, ''],
            ],
          )
        }
        if (sql.includes('table_type')) {
          return resultSet(
            [{ name: 'table_name', type: MySqlType.varchar }, { name: 'table_type', type: MySqlType.varchar }, { name: 'table_rows', type: MySqlType.longlong }],
            [['users', 'BASE TABLE', '42']],
          )
        }
        return [packet(okPacket(), 1)]
      },
    })
    const client = await connectTo(server)
    const tables = await listTables(client, 'app')
    expect(tables).toEqual([{ schema: 'app', name: 'users', kind: 'table', rowEstimate: 42 }])

    const detail = await describeTable(client, 'app', 'users')
    expect(detail.primaryKey).toEqual(['id'])
    expect(detail.columns[1]).toMatchObject({ name: 'email', type: 'varchar(255)', nullable: true, primaryKey: false })
    client.close()
  })

  it('readRows 多取一行判断「后面还有没有」', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: (sql) => {
        if (sql.includes('information_schema.tables')) {
          return resultSet([{ name: 'table_rows', type: MySqlType.longlong }], [['100']])
        }
        // limit=2 时请求 3 行；服务端回 3 行 → hasMore 必须是 true
        return resultSet([{ name: 'id', type: MySqlType.long }], [['1'], ['2'], ['3']])
      },
    })
    const client = await connectTo(server)
    const page = await readRows(client, { schema: 'app', table: 'users', limit: 2 })
    expect(page.rows).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    expect(page.rowEstimate).toBe(100)
    // SQL 里确实是 LIMIT 3（多取一行）
    expect(server.queries.some((q) => q.includes('LIMIT 3 OFFSET 0'))).toBe(true)
    client.close()
  })

  it('runQuery 把 BLOB 列显示成十六进制，不当文本解释', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () => resultSet([{ name: 'data', type: MySqlType.blob }], [[Buffer.from([0xde, 0xad, 0xbe, 0xef])]]),
    })
    const client = await connectTo(server)
    const result = await runQuery(client, 'SELECT data FROM t')
    expect(result.kind).toBe('rows')
    expect(result.rows[0]![0]).toMatchObject({ kind: 'binary', text: '0xdeadbeef', bytes: 4 })
    client.close()
  })

  it('runQuery 超过上限时截断并明说（不静默少返回）', async () => {
    const many = Array.from({ length: 10 }, (_, i) => [String(i + 1)])
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: () => resultSet([{ name: 'n', type: MySqlType.long }], many),
    })
    const client = await connectTo(server)
    const result = await runQuery(client, 'SELECT n FROM t', { maxRows: 3 })
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(true)
    client.close()
  })

  it('表名与 schema 名会被反引号包住（不拼裸标识符）', async () => {
    server = await fakeMySql({
      plugin: 'mysql_native_password',
      password: 'hunter2',
      replies: (sql) => {
        if (sql.includes('information_schema.tables')) return resultSet([{ name: 'table_rows', type: MySqlType.longlong }], [['0']])
        return resultSet([{ name: 'id', type: MySqlType.long }], [])
      },
    })
    const client = await connectTo(server)
    await readRows(client, { schema: 'app', table: 'weird-name' })
    expect(server.queries.some((q) => q.includes('`app`.`weird-name`'))).toBe(true)
    client.close()
  })
})
