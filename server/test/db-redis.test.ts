import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerError } from '../src/docker/engine.js'
import { decodeMaybe, encodeCommand, RedisClient, RespReader, type Resp } from '../src/db/redis.js'
import { readValue, scanKeys, typeSummary } from '../src/db/redis-browse.js'

/**
 * Redis 客户端的单测。
 *
 * **用一个真的 TCP 服务器逐字节回真实的 RESP 帧**，不用 mock 掉解析器：
 * 这里最容易错的就是「TCP 在任意位置切包」—— 把解析器换成桩函数，那个坑就永远测不到
 * （本项目踩过「假样本让 bug 一直绿」，见记忆 feedback_test_real_shapes）。
 */

/** 把一条命令编成 RESP 数组，供假服务器读请求用。 */
function parseRequest(buf: Buffer): { args: string[]; rest: Buffer } | undefined {
  if (buf[0] !== 0x2a) return undefined
  const lineEnd = buf.indexOf('\r\n', 0)
  if (lineEnd < 0) return undefined
  const count = Number(buf.toString('utf8', 1, lineEnd))
  const args: string[] = []
  let off = lineEnd + 2
  for (let i = 0; i < count; i += 1) {
    const headEnd = buf.indexOf('\r\n', off)
    if (headEnd < 0) return undefined
    const len = Number(buf.toString('utf8', off + 1, headEnd))
    const start = headEnd + 2
    if (buf.length < start + len + 2) return undefined
    args.push(buf.toString('utf8', start, start + len))
    off = start + len + 2
  }
  return { args, rest: buf.subarray(off) }
}

/** 一个能按脚本应答的假 Redis。 */
class FakeRedis {
  readonly server = net.createServer()
  port = 0
  /** 收到的每条命令（数组形式） */
  received: string[][] = []
  /** 命令名（大写）→ 应答函数 */
  handlers = new Map<string, (args: string[]) => Buffer | Buffer[]>()

  /** 逐字节吐（模拟 TCP 切包）；默认按 3 字节一片。 */
  chunkSize = 3

  async start(): Promise<this> {
    this.server.on('connection', (socket) => {
      let pending: Buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk])
        for (;;) {
          const parsed = parseRequest(pending)
          if (!parsed) break
          pending = parsed.rest
          this.received.push(parsed.args)
          const handler = this.handlers.get((parsed.args[0] ?? '').toUpperCase())
          const reply = handler ? handler(parsed.args) : Buffer.from('-ERR unknown command\r\n')
          // 把应答切成小片发出去：解析器必须能处理半截帧
          const frames = Array.isArray(reply) ? reply : [reply]
          for (const frame of frames) {
            for (let i = 0; i < frame.length; i += this.chunkSize) socket.write(frame.subarray(i, i + this.chunkSize))
          }
        }
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.unref()
    })
  }
}

const bulk = (text: string): Buffer => Buffer.from(`$${Buffer.byteLength(text)}\r\n${text}\r\n`)
const bulkBin = (body: Buffer): Buffer => Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n')])
const int = (n: number): Buffer => Buffer.from(`:${n}\r\n`)
const simple = (text: string): Buffer => Buffer.from(`+${text}\r\n`)
const errReply = (text: string): Buffer => Buffer.from(`-${text}\r\n`)
const arr = (items: Buffer[]): Buffer => Buffer.concat([Buffer.from(`*${items.length}\r\n`), ...items])
const nil = (): Buffer => Buffer.from('$-1\r\n')

describe('RespReader', () => {
  it('能解析五种前缀', () => {
    const reader = new RespReader()
    reader.feed(Buffer.from('+OK\r\n:42\r\n$5\r\nhello\r\n-ERR nope\r\n*-1\r\n'))
    expect(reader.read()).toBe('OK')
    expect(reader.read()).toBe(42)
    expect(reader.read()).toEqual(Buffer.from('hello'))
    expect((reader.read() as Error).message).toBe('ERR nope')
    expect(reader.read()).toBe(null)
    expect(reader.read()).toBeUndefined()
  })

  it('数据不够时返回 undefined，补上后再读出来（TCP 会在任意位置切包）', () => {
    const reader = new RespReader()
    // 一个 bulk string 的长度行和内容分开到
    reader.feed(Buffer.from('$11\r\nhello'))
    expect(reader.read()).toBeUndefined()
    reader.feed(Buffer.from(' world\r\n'))
    expect(reader.read()).toEqual(Buffer.from('hello world'))
  })

  it('嵌套数组（CONFIG GET 之类）能整段读出来', () => {
    const reader = new RespReader()
    const frame = arr([bulk('maxmemory'), int(0), arr([simple('a'), nil()])])
    // 逐字节喂，最严的切法
    for (let i = 0; i < frame.length; i += 1) {
      reader.feed(frame.subarray(i, i + 1))
      const value = reader.read()
      if (i < frame.length - 1) expect(value).toBeUndefined()
      else expect(value).toEqual([Buffer.from('maxmemory'), 0, ['a', null]])
    }
  })

  it('认不出的前缀当协议错误抛出来，不猜着往后跳', () => {
    const reader = new RespReader()
    reader.feed(Buffer.from('%2\r\n'))
    expect(() => reader.read()).toThrow(DockerError)
  })
})

describe('encodeCommand', () => {
  it('编出来的数组能被对端解回原样（含二进制参数）', () => {
    const bin = Buffer.from([0x00, 0xff, 0x0a, 0x0d])
    const encoded = encodeCommand(['SET', 'k', bin])
    const parsed = parseRequest(encoded)
    expect(parsed?.args[0]).toBe('SET')
    expect(parsed?.args[1]).toBe('k')
    // 二进制参数按字节数算长度，不是按字符数
    expect(encoded.toString('latin1')).toContain('$4\r\n')
  })
})

describe('decodeMaybe', () => {
  it('合法 UTF-8 当文本', () => {
    expect(decodeMaybe(Buffer.from('中文 ok')).text).toBe('中文 ok')
    expect(decodeMaybe(Buffer.from('中文 ok')).binary).toBe(false)
  })

  it('非法字节序列明确标成二进制，不吐乱码', () => {
    const bad = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    const decoded = decodeMaybe(bad)
    expect(decoded.binary).toBe(true)
    expect(decoded.text).toContain('二进制')
    expect(decoded.bytes).toBe(4)
  })
})

describe('RedisClient', () => {
  let fake: FakeRedis

  beforeEach(async () => {
    fake = await new FakeRedis().start()
  })
  afterEach(async () => {
    await fake.stop()
  })

  it('连上后自动 AUTH（requirepass 的实例不给未认证命令）', async () => {
    fake.handlers.set('AUTH', () => simple('OK'))
    fake.handlers.set('PING', () => simple('PONG'))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port, password: 'secret' })
    expect(fake.received[0]).toEqual(['AUTH', 'secret'])
    expect(await client.run(['PING'])).toBe('PONG')
    client.close()
  })

  it('AUTH 失败时明确报认证失败（不是模糊的连接错误）', async () => {
    fake.handlers.set('AUTH', () => errReply('WRONGPASS invalid username-password pair'))
    await expect(RedisClient.connect({ host: '127.0.0.1', port: fake.port, password: 'wrong' })).rejects.toThrow(/认证失败/)
  })

  it('命令级的 -ERR 不摧毁连接，后续命令照常', async () => {
    fake.handlers.set('GET', () => errReply('WRONGTYPE Operation against a key holding the wrong kind of value'))
    fake.handlers.set('PING', () => simple('PONG'))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    // 直接 run 会把 -ERR 抛出
    await expect(client.run(['GET', 'list-key'])).rejects.toThrow(/WRONGTYPE/)
    // 但连接还活着
    expect(await client.run(['PING'])).toBe('PONG')
    client.close()
  })

  it('命令超时会拒绝，之后连接仍可用', async () => {
    // SLOW 永远不回（模拟对端卡住）；
    fake.handlers.set('SLOW', () => Buffer.alloc(0))
    fake.handlers.set('PING', () => simple('PONG'))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    await expect(client.command(['SLOW', 'x'], 50)).rejects.toThrow(/超时/)
    expect(await client.run(['PING'])).toBe('PONG')
    client.close()
  })
})

describe('scanKeys', () => {
  let fake: FakeRedis
  beforeEach(async () => {
    fake = await new FakeRedis().start()
  })
  afterEach(async () => {
    await fake.stop()
  })

  it('把 SCAN + TYPE + TTL + 长度拼成一条完整记录', async () => {
    fake.handlers.set('SCAN', () => arr([Buffer.from('0\r\n').subarray(0, 0), arr([bulk('user:1'), bulk('queue')])]))
    // 上面那条故意写歪，改用标准形状
    fake.handlers.set('SCAN', () => arr([bulk('0'), arr([bulk('user:1'), bulk('queue')])]))
    fake.handlers.set('TYPE', (args) => simple(args[1] === 'queue' ? 'list' : 'string'))
    fake.handlers.set('TTL', (args) => int(args[1] === 'user:1' ? 300 : -1))
    fake.handlers.set('STRLEN', () => int(11))
    fake.handlers.set('LLEN', () => int(7))
    fake.handlers.set('GETRANGE', () => bulk('hello world'))
    fake.handlers.set('MEMORY', () => int(64))

    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const page = await scanKeys(client, { match: 'user:*' })
    expect(page.cursor).toBe('0')
    expect(page.keys).toHaveLength(2)

    const first = page.keys.find((k) => k.key === 'user:1')!
    expect(first.type).toBe('string')
    expect(first.ttl).toBe(300)
    expect(first.size).toBe(11)
    expect(first.preview).toBe('hello world')

    const second = page.keys.find((k) => k.key === 'queue')!
    expect(second.type).toBe('list')
    expect(second.size).toBe(7)
    client.close()

    // MATCH 原样透传（glob 语义是 Redis 自己的，不该转义）
    expect(fake.received[0]).toEqual(['SCAN', '0', 'COUNT', '200', 'MATCH', 'user:*'])
  })

  it('游标非 0 时照原样传下去（分页靠它）', async () => {
    fake.handlers.set('SCAN', () => arr([bulk('42'), arr([])]))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const page = await scanKeys(client, { cursor: '17' })
    expect(page.cursor).toBe('42')
    client.close()
    expect(fake.received[0]![1]).toBe('17')
  })
})

describe('readValue', () => {
  let fake: FakeRedis
  beforeEach(async () => {
    fake = await new FakeRedis().start()
  })
  afterEach(async () => {
    await fake.stop()
  })

  it('string：读回文本与字节数', async () => {
    fake.handlers.set('TYPE', () => simple('string'))
    fake.handlers.set('TTL', () => int(-1))
    fake.handlers.set('STRLEN', () => int(5))
    fake.handlers.set('GET', () => bulk('hello'))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const value = await readValue(client, 'k')
    expect(value.value).toEqual({ kind: 'string', text: 'hello', binary: false, bytes: 5 })
    expect(value.truncated).toBe(false)
    client.close()
  })

  it('string：超过上限时只取一段并标 truncated（别把 100MB blob 拉进内存）', async () => {
    fake.handlers.set('TYPE', () => simple('string'))
    fake.handlers.set('TTL', () => int(-1))
    fake.handlers.set('STRLEN', () => int(5_000_000))
    fake.handlers.set('GETRANGE', () => bulk('head-only'))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const value = await readValue(client, 'big')
    expect(value.truncated).toBe(true)
    expect(value.size).toBe(5_000_000)
    expect((value.value as { text: string }).text).toBe('head-only')
    client.close()
    // 用的是 GETRANGE 而不是 GET
    expect(fake.received.some((r) => r[0] === 'GETRANGE')).toBe(true)
    expect(fake.received.some((r) => r[0] === 'GET')).toBe(false)
  })

  it('hash：HRANDFIELD WITHVALUES 的扁平数组配成 field/value', async () => {
    fake.handlers.set('TYPE', () => simple('hash'))
    fake.handlers.set('TTL', () => int(-1))
    fake.handlers.set('HLEN', () => int(2))
    fake.handlers.set('HRANDFIELD', () => arr([bulk('name'), bulk('kura'), bulk('port'), bulk('8080')]))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const value = await readValue(client, 'h')
    expect(value.value).toEqual({
      kind: 'hash',
      entries: [
        { field: 'name', text: 'kura', binary: false },
        { field: 'port', text: '8080', binary: false },
      ],
    })
    client.close()
  })

  it('zset：ZRANGE WITHSCORES 的扁平数组配成 member/score', async () => {
    fake.handlers.set('TYPE', () => simple('zset'))
    fake.handlers.set('TTL', () => int(-1))
    fake.handlers.set('ZCARD', () => int(2))
    fake.handlers.set('ZRANGE', () => arr([bulk('alice'), bulk('1.5'), bulk('bob'), bulk('2')]))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const value = await readValue(client, 'z')
    expect(value.value).toEqual({
      kind: 'zset',
      members: [
        { member: 'alice', score: 1.5 },
        { member: 'bob', score: 2 },
      ],
    })
    client.close()
  })

  it('key 不在了报 404（可能刚好过期）', async () => {
    fake.handlers.set('TYPE', () => simple('none'))
    fake.handlers.set('TTL', () => int(-2))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    await expect(readValue(client, 'gone')).rejects.toMatchObject({ status: 404 })
    client.close()
  })

  it('认不出的类型如实说出来，不假装能读', async () => {
    fake.handlers.set('TYPE', () => simple('ReJSON-RL'))
    fake.handlers.set('TTL', () => int(-1))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const value = await readValue(client, 'json-doc')
    expect(value.value).toEqual({ kind: 'other', extra: 'ReJSON-RL' })
    expect(value.note).toContain('ReJSON-RL')
    client.close()
  })
})

describe('typeSummary', () => {
  it('按类型统计 key 条数', async () => {
    const fake = await new FakeRedis().start()
    fake.handlers.set('SCAN', () => arr([bulk('0'), arr([bulk('a'), bulk('b'), bulk('c')])]))
    fake.handlers.set('TYPE', (args) => simple(args[1] === 'c' ? 'hash' : 'string'))
    fake.handlers.set('TTL', () => int(-1))
    fake.handlers.set('STRLEN', () => int(1))
    fake.handlers.set('HLEN', () => int(1))
    const client = await RedisClient.connect({ host: '127.0.0.1', port: fake.port })
    const types = await typeSummary(client)
    expect(types[0]).toEqual({ type: 'string', count: 2 })
    expect(types[1]).toEqual({ type: 'hash', count: 1 })
    client.close()
    await fake.stop()
  })
})

describe('Resp 形状', () => {
  it('describeResp 能描述嵌套（给 MCP 用的文本形状）', async () => {
    const { describeResp } = await import('../src/db/redis.js')
    const value: Resp = [Buffer.from('a'), 1, null, new Error('boom')]
    const text = describeResp(value)
    expect(text).toContain('1) a')
    expect(text).toContain('2) 1')
    expect(text).toContain('3) (nil)')
    expect(text).toContain('4) (error) boom')
  })
})