import { describe, expect, it } from 'vitest'
import {
  affectedFromTag,
  AuthMethod,
  isBinaryOid,
  isNumericOid,
  md5Response,
  parseAttributes,
  parseDataRow,
  parseErrorResponse,
  parseRowDescription,
  saslName,
  scramClientFinal,
  scramClientFirst,
  scramVerify,
  typeNameOfOid,
} from '../src/db/postgres.js'

/**
 * PostgreSQL 协议层的单测。
 *
 * **SCRAM 用 RFC 7677 的官方测试向量**，不是自己算一份来对：
 * 自己算的「期望值」如果和实现犯同一个错，测试就是绿的而连不上真库
 * （记忆 feedback_test_real_shapes：假样本会让 bug 一直绿）。
 */

describe('SCRAM-SHA-256：RFC 7677 官方测试向量', () => {
  // RFC 7677 §3 的例子
  const user = 'user'
  const password = 'pencil'
  const clientNonce = 'rOprNGfwEbeRWgbNEkqO'
  const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'
  const expectedClientFinal =
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ='
  const expectedServerSignature = '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='

  it('client-first-message 的形状与 RFC 一致', () => {
    const { message, state } = scramClientFirst(user, clientNonce)
    expect(message).toBe('n,,n=user,r=rOprNGfwEbeRWgbNEkqO')
    expect(state.clientFirstBare).toBe('n=user,r=rOprNGfwEbeRWgbNEkqO')
  })

  it('client-final-message 的 proof 与 RFC 给的完全一致', () => {
    const { state } = scramClientFirst(user, clientNonce)
    const final = scramClientFinal(state, password, serverFirst)
    expect(final.message).toBe(expectedClientFinal)
  })

  it('服务端签名能被验过（RFC 给的那个 v= 值）', () => {
    const { state } = scramClientFirst(user, clientNonce)
    const final = scramClientFinal(state, password, serverFirst)
    // 这一步不抛就是通过
    expect(() => scramVerify(final.state, `v=${expectedServerSignature}`)).not.toThrow()
  })

  it('签名被改过一个字就拒绝（不验签名等于没认证）', () => {
    const { state } = scramClientFirst(user, clientNonce)
    const final = scramClientFinal(state, password, serverFirst)
    expect(() => scramVerify(final.state, 'v=AAAAAAAi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')).toThrow(/签名不匹配/)
  })

  it('口令错了算出不同的 proof', () => {
    const { state } = scramClientFirst(user, clientNonce)
    const right = scramClientFinal(state, 'pencil', serverFirst)
    const wrong = scramClientFinal(state, 'pencill', serverFirst)
    expect(right.message).not.toBe(wrong.message)
  })

  it('服务端 nonce 不以客户端 nonce 开头时拒绝（防中间人）', () => {
    const { state } = scramClientFirst(user, clientNonce)
    expect(() => scramClientFinal(state, password, 'r=EVILNONCE,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096')).toThrow(/nonce/)
  })

  it('服务端回 e=（出错）时明确报出来', () => {
    const { state } = scramClientFirst(user, clientNonce)
    const final = scramClientFinal(state, password, serverFirst)
    expect(() => scramVerify(final.state, 'e=invalid-proof')).toThrow(/invalid-proof/)
  })
})

describe('saslName（RFC 5802 §5.1 的转义）', () => {
  it('= 转成 =3D、, 转成 =2C', () => {
    expect(saslName('a=b')).toBe('a=3Db')
    expect(saslName('a,b')).toBe('a=2Cb')
    // 先转 = 再转 , —— 顺序反了会把 =3D 里的 = 又转一遍
    expect(saslName('a=,b')).toBe('a=3D=2Cb')
  })
})

describe('parseAttributes', () => {
  it('解析 SCRAM 的 a=b,c=d 形状', () => {
    const attrs = parseAttributes('r=abc,s=def==,i=4096')
    expect(attrs.r).toBe('abc')
    expect(attrs.s).toBe('def==')
    expect(attrs.i).toBe('4096')
  })
})

describe('md5Response', () => {
  it('"md5" + md5(md5(pw+user) + salt)', () => {
    // 手算一遍（不是调实现算的期望值）
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const inner = createHash('md5').update('secret' + 'kura').digest('hex')
    const salt = Buffer.from([1, 2, 3, 4])
    const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'ascii'), salt])).digest('hex')
    expect(md5Response('kura', 'secret', salt)).toBe(`md5${outer}`)
  })

  it('以 "md5" 开头（服务端按前缀识别）', () => {
    expect(md5Response('u', 'p', Buffer.alloc(4))).toMatch(/^md5[0-9a-f]{32}$/)
  })
})

describe('parseDataRow', () => {
  /** 拼一个 DataRow：int16 列数，然后每列 int32 长度 + 内容（-1 = NULL）。 */
  function dataRow(values: Array<string | null>): Buffer {
    const parts: Buffer[] = []
    const count = Buffer.alloc(2)
    count.writeInt16BE(values.length)
    parts.push(count)
    for (const value of values) {
      const len = Buffer.alloc(4)
      if (value === null) {
        len.writeInt32BE(-1)
        parts.push(len)
      } else {
        const body = Buffer.from(value, 'utf8')
        len.writeInt32BE(body.length)
        parts.push(len, body)
      }
    }
    return Buffer.concat(parts)
  }

  it('NULL 与空串必须能分开', () => {
    const row = parseDataRow(dataRow(['a', null, '']))
    expect(row[0]?.toString('utf8')).toBe('a')
    expect(row[1]).toBeNull()
    expect(row[2]).toEqual(Buffer.alloc(0))
    expect(row[1]).not.toEqual(row[2])
  })

  it('保留原始字节（bytea 不该被当文本）', () => {
    const row = parseDataRow(dataRow(['ÿ\u0000']))
    expect(Buffer.isBuffer(row[0])).toBe(true)
  })
})

describe('parseRowDescription', () => {
  it('读出一列的 name / typeOid / format', () => {
    const name = Buffer.from('id\0', 'utf8')
    const rest = Buffer.alloc(18)
    rest.writeInt32BE(0, 0) // table oid
    rest.writeInt16BE(0, 4) // column attr
    rest.writeInt32BE(23, 6) // type oid = int4
    rest.writeInt16BE(4, 10) // type size
    rest.writeInt32BE(-1, 12) // type modifier
    rest.writeInt16BE(0, 16) // format 0 = text
    const count = Buffer.alloc(2)
    count.writeInt16BE(1)
    const fields = parseRowDescription(Buffer.concat([count, name, rest]))
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ name: 'id', typeOid: 23, format: 0 })
  })
})

describe('类型 OID', () => {
  it('常见类型翻得对，认不出的如实标 oid:xxx', () => {
    expect(typeNameOfOid(23)).toBe('int4')
    expect(typeNameOfOid(25)).toBe('text')
    expect(typeNameOfOid(3802)).toBe('jsonb')
    expect(typeNameOfOid(2950)).toBe('uuid')
    expect(typeNameOfOid(99999)).toBe('oid:99999')
  })

  it('bytea 是二进制、int/numeric 是数字', () => {
    expect(isBinaryOid(17)).toBe(true)
    expect(isBinaryOid(25)).toBe(false)
    expect(isNumericOid(23)).toBe(true)
    expect(isNumericOid(1700)).toBe(true)
    expect(isNumericOid(25)).toBe(false)
  })
})

describe('affectedFromTag', () => {
  it('从命令标签里抽行数', () => {
    expect(affectedFromTag('SELECT 42')).toBe(42)
    expect(affectedFromTag('INSERT 0 1')).toBe(1)
    expect(affectedFromTag('UPDATE 3')).toBe(3)
    expect(affectedFromTag('DELETE 0')).toBe(0)
  })

  it('没有数字的标签回 -1（不是 0 —— 0 和「不知道」是两件事）', () => {
    expect(affectedFromTag('CREATE TABLE')).toBe(-1)
    expect(affectedFromTag('BEGIN')).toBe(-1)
  })
})

describe('parseErrorResponse', () => {
  it('读出 severity / code / message / hint', () => {
    // 字段串：'S' + "ERROR\0" + 'C' + "42P01\0" + 'M' + "relation ... does not exist\0" + 'H' + "试试加个 schema\0" + 0
    const payload = Buffer.concat([
      Buffer.from([0x53]), Buffer.from('ERROR\0', 'utf8'),
      Buffer.from([0x43]), Buffer.from('42P01\0', 'utf8'),
      Buffer.from([0x4d]), Buffer.from('relation "nope" does not exist\0', 'utf8'),
      Buffer.from([0x48]), Buffer.from('试试加个 schema\0', 'utf8'),
      Buffer.from([0]),
    ])
    const err = parseErrorResponse(payload)
    expect(err.severity).toBe('ERROR')
    expect(err.code).toBe('42P01')
    expect(err.message).toContain('does not exist')
    expect(err.hint).toBe('试试加个 schema')
  })
})

describe('认证方式常量', () => {
  it('和协议文档里的编号一致', () => {
    expect(AuthMethod.ok).toBe(0)
    expect(AuthMethod.cleartext).toBe(3)
    expect(AuthMethod.md5).toBe(5)
    expect(AuthMethod.sasl).toBe(10)
    expect(AuthMethod.saslContinue).toBe(11)
    expect(AuthMethod.saslFinal).toBe(12)
  })
})
