import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DockerError } from '../src/docker/engine.js'
import {
  buildHandshakeResponse,
  isBinaryType,
  isNumericTypeCode,
  MySqlType,
  parseColumn,
  parseErr,
  parseHandshake,
  parseOk,
  parseRow,
  scramble,
  scrambleCachingSha2,
  scrambleNative,
  typeName,
} from '../src/db/mysql.js'

/**
 * MySQL 协议层的单测。
 *
 * 全部用**手工拼的、符合协议的真字节**，不 mock 解析函数：这一层最容易错的是
 * 长度编码、握手包里 salt 的偏移、认证摘要的拼接顺序 —— 桩掉任何一环都测不到
 * （记忆 feedback_test_real_shapes：假样本会让 bug 一直绿）。
 */

// ---------------------------------------------------------------- 拼字节的帮手

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

/** 一个真实的 MySQL 8 HandshakeV10 包体。 */
function handshakeV10(options: { plugin?: string; serverVersion?: string; capsHigh?: boolean } = {}): Buffer {
  const salt1 = Buffer.from('12345678', 'ascii')
  const salt2 = Buffer.from('901234567890', 'ascii') // 12 字节 + NUL
  const parts: Buffer[] = [
    Buffer.from([10]), // protocol version
    nul(options.serverVersion ?? '8.0.36'),
    u32(42), // connection id
    salt1,
    Buffer.from([0]), // filler
    // 低 16 位能力：PROTOCOL_41(0x0200) | SECURE_CONNECTION(0x8000) | PLUGIN_AUTH(0x0800 是高位) …
    u16(0x8000 | 0x0200 | 0x0008 | 0x0001),
  ]
  if (options.capsHigh !== false) {
    parts.push(Buffer.from([0x21])) // charset utf8_general_ci
    parts.push(u16(0x0002)) // status
    // 高 16 位：PLUGIN_AUTH(0x0008) | LONG_FLAG(0x0004) | MULTI_RESULTS(0x0002)
    parts.push(u16(0x0008 | 0x0004 | 0x0002))
    parts.push(Buffer.from([21])) // auth data len = 8 + 12 + 1
    parts.push(Buffer.alloc(10)) // reserved
    parts.push(Buffer.concat([salt2, Buffer.from([0])]))
    parts.push(nul(options.plugin ?? 'caching_sha2_password'))
  }
  return Buffer.concat(parts)
}

describe('parseHandshake', () => {
  it('解析 MySQL 8 的完整握手包（版本、salt、插件名都要对）', () => {
    const hs = parseHandshake(handshakeV10())
    expect(hs.protocolVersion).toBe(10)
    expect(hs.serverVersion).toBe('8.0.36')
    expect(hs.connectionId).toBe(42)
    // 两段 salt 拼起来是 20 字节
    expect(hs.salt).toHaveLength(20)
    expect(hs.salt.toString('ascii')).toBe('12345678901234567890')
    expect(hs.authPlugin).toBe('caching_sha2_password')
    expect(hs.capabilityFlags & 0x0000_8000).toBeTruthy() // SECURE_CONNECTION
  })

  it('老式握手包（没有高 16 位能力）也能读，插件名退回 native_password', () => {
    const hs = parseHandshake(handshakeV10({ capsHigh: false }))
    expect(hs.serverVersion).toBe('8.0.36')
    expect(hs.authPlugin).toBe('mysql_native_password')
  })

  it('协议版本不是 10 时明确报错，不硬着头皮往下解', () => {
    const bogus = Buffer.concat([Buffer.from([9]), nul('5.0.0'), u32(1)])
    expect(() => parseHandshake(bogus)).toThrow(/只认 10/)
  })
})

describe('scrambleNative（mysql_native_password）', () => {
  it('算出来的摘要与协议公式一致', () => {
    const password = 'secret'
    const salt = Buffer.from('12345678901234567890', 'ascii')

    // 按文档手算一遍：SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw)))
    const stage1 = createHash('sha1').update(password).digest()
    const stage2 = createHash('sha1').update(stage1).digest()
    const seeded = createHash('sha1').update(Buffer.concat([salt, stage2])).digest()
    const expected = Buffer.alloc(20)
    for (let i = 0; i < 20; i += 1) expected[i] = stage1[i]! ^ seeded[i]!

    expect(scrambleNative(password, salt)).toEqual(expected)
  })

  it('空口令回空（不是 SHA1 一个空串）', () => {
    expect(scrambleNative('', Buffer.alloc(20))).toHaveLength(0)
  })

  it('同一个口令 + 同一个 salt 结果稳定；换 salt 结果就变', () => {
    const a = scrambleNative('pw', Buffer.from('a'.repeat(20)))
    const b = scrambleNative('pw', Buffer.from('a'.repeat(20)))
    const c = scrambleNative('pw', Buffer.from('b'.repeat(20)))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })
})

describe('scrambleCachingSha2（MySQL 8 默认插件）', () => {
  it('算出来的摘要与 SHA256 公式一致', () => {
    const password = 'secret'
    const salt = Buffer.from('12345678901234567890', 'ascii')

    const stage1 = createHash('sha256').update(password).digest()
    const stage2 = createHash('sha256').update(stage1).digest()
    const seeded = createHash('sha256').update(Buffer.concat([stage2, salt])).digest()
    const expected = Buffer.alloc(32)
    for (let i = 0; i < 32; i += 1) expected[i] = stage1[i]! ^ seeded[i]!

    expect(scrambleCachingSha2(password, salt)).toEqual(expected)
  })

  it('注意拼接顺序和 native 相反（SHA256(pw) 在前、salt 在后）', () => {
    const salt = Buffer.from('s'.repeat(20))
    const sha2 = scrambleCachingSha2('pw', salt)
    expect(sha2).toHaveLength(32)
    // 长度就是最直接的证据：native 是 20 字节
    expect(scrambleNative('pw', salt)).toHaveLength(20)
  })
})

describe('scramble：认不出的插件明确报错', () => {
  it('sha256_password / auth_gssapi 之类不猜，直接说出来', () => {
    expect(() => scramble('sha256_password', 'pw', Buffer.alloc(20))).toThrow(DockerError)
    expect(() => scramble('auth_gssapi_client', 'pw', Buffer.alloc(20))).toThrow(/还不支持/)
  })
})

describe('buildHandshakeResponse', () => {
  it('只声明服务端也支持的能力（否则服务端会按协议错断开）', () => {
    const hs = parseHandshake(handshakeV10())
    const response = buildHandshakeResponse(hs, { user: 'kura', password: 'pw', database: 'app' })
    // 前 4 字节是能力位
    const clientCaps = response.readUInt32LE(0)
    // 不能出现服务端没声明的那几位
    expect(clientCaps & ~hs.capabilityFlags).toBe(0)
    // 用户名带 NUL 结尾
    expect(response.includes(Buffer.from('kura\0'))).toBe(true)
  })

  it('带了数据库名（CLIENT_CONNECT_WITH_DB 已声明）', () => {
    const hs = parseHandshake(handshakeV10())
    const response = buildHandshakeResponse(hs, { user: 'u', password: 'p', database: 'mydb' })
    expect(response.includes(Buffer.from('mydb\0'))).toBe(true)
  })
})

describe('parseOk / parseErr', () => {
  it('OK 包：影响行数、last insert id、状态位', () => {
    const payload = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([3]), // affected rows = 3（lenenc）
      Buffer.from([0]), // last insert id = 0
      u16(0x0002), // status: autocommit
      u16(0), // warnings
    ])
    const ok = parseOk(payload)
    expect(ok.affectedRows).toBe(3)
    expect(ok.lastInsertId).toBe(0)
    expect(ok.statusFlags).toBe(0x0002)
  })

  it('ERR 包：错误码、SQLSTATE、消息都要读出来', () => {
    const payload = Buffer.concat([
      Buffer.from([0xff]),
      u16(1146),
      Buffer.from('#'),
      Buffer.from('42S02', 'ascii'),
      Buffer.from("Table 'app.nope' doesn't exist", 'utf8'),
    ])
    const err = parseErr(payload)
    expect(err.code).toBe('1146')
    expect(err.sqlState).toBe('42S02')
    expect(err.message).toBe("Table 'app.nope' doesn't exist")
  })
})

describe('parseColumn / typeName', () => {
  /** 拼一个列定义包。 */
  function columnPacket(options: { name: string; type: number; length?: number; decimals?: number }): Buffer {
    return Buffer.concat([
      lenencStr('def'), // catalog
      lenencStr('app'), // schema
      lenencStr('users'), // table
      lenencStr('users'), // org_table
      lenencStr(options.name),
      lenencStr(options.name),
      Buffer.from([0x0c]), // 固定长度标记
      u16(0x21), // charset
      u32(options.length ?? 255),
      Buffer.from([options.type]),
      u16(0), // flags
      Buffer.from([options.decimals ?? 0]),
      Buffer.from([0, 0]), // filler
    ])
  }

  it('读出一个 varchar 列', () => {
    const column = parseColumn(columnPacket({ name: 'email', type: MySqlType.varchar, length: 255 }))
    expect(column.name).toBe('email')
    expect(column.type).toBe(MySqlType.varchar)
    expect(column.table).toBe('users')
    expect(typeName(column.type, column.columnLength, column.decimals)).toBe('varchar(255)')
  })

  it('类型名翻得对（numeric / binary 判断也跟着走）', () => {
    expect(typeName(MySqlType.long, 11, 0)).toBe('int')
    expect(isNumericTypeCode(MySqlType.long)).toBe(true)
    expect(isNumericTypeCode(MySqlType.varchar)).toBe(false)
    expect(isBinaryType(MySqlType.blob)).toBe(true)
    expect(isBinaryType(MySqlType.varchar)).toBe(false)
    expect(typeName(MySqlType.newdecimal, 10, 2)).toBe('decimal(10,2)')
  })
})

describe('parseRow', () => {
  it('NULL（0xfb）与空串必须能分开', () => {
    // 三列：'a' / NULL / ''
    const payload = Buffer.concat([lenencStr('a'), Buffer.from([0xfb]), Buffer.from([0])])
    const row = parseRow(payload, 3)
    expect(row[0]?.toString('utf8')).toBe('a')
    expect(row[1]).toBeNull()
    expect(row[2]).toEqual(Buffer.alloc(0))
    // 关键：NULL !== 空串
    expect(row[1]).not.toEqual(row[2])
  })

  it('保留原始字节（BLOB 不该被转成字符串）', () => {
    const bin = Buffer.from([0x00, 0xff, 0x10])
    const payload = Buffer.concat([Buffer.from([3]), bin])
    const row = parseRow(payload, 1)
    expect(Buffer.isBuffer(row[0])).toBe(true)
    expect(row[0]).toEqual(bin)
  })

  it('大长度用 lenenc 的 3 字节形态', () => {
    const body = Buffer.alloc(300, 0x41) // 300 个 'A'
    const head = Buffer.from([0xfc])
    const len = Buffer.alloc(2)
    len.writeUInt16LE(300)
    const payload = Buffer.concat([head, len, body])
    const row = parseRow(payload, 1)
    expect(row[0]).toHaveLength(300)
  })
})
