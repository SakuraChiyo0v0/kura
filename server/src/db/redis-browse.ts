import { DockerError } from '../docker/engine.js'
import type { RedisKeyEntry, RedisKeyPage, RedisValue } from '../../../src/core/db-browse.js'
import { decodeMaybe, type RedisClient } from './redis.js'

/**
 * Redis 的「浏览」形状：数据库列表、key 扫描、单个 key 的值。
 *
 * 和关系库那边刻意长得不一样：Redis 没有表、没有列，key 是扁平的一坨。
 * 硬塞进「库→表→列」那套界面两边都别扭，所以这一层单独一套接口与界面。
 * 返回的形状定义在 `src/core/db-browse.ts`（客户端与服务端共用一份）。
 */

/**
 * 一次扫描最多回多少个 key。
 *
 * SCAN 的 COUNT 只是「一次大概扫多少」的提示，实际可能多也可能少；这里按**返回条数**再截一次，
 * 保证界面拿到的东西不会因为一个 COUNT 很大的实例而爆掉。
 */
const maxScanKeys = 500
/** 一个 key 最多列多少元素（LIST / SET / ZSET / HASH 都可能上百万）。 */
const maxElements = 200
/** 显示一个值最多占多少字节。 */
const maxValueBytes = 64 * 1024

/** 一次扫描：`SCAN` 加每个 key 的 TYPE / TTL / 少量预览。 */
export async function scanKeys(client: RedisClient, options: { cursor?: string; match?: string; count?: number; withPreview?: boolean }): Promise<RedisKeyPage> {
  const cursor = options.cursor && options.cursor !== '' ? options.cursor : '0'
  const count = Math.max(10, Math.min(options.count ?? 200, 1000))
  const scanArgs: string[] = ['SCAN', cursor, 'COUNT', String(count)]
  const match = options.match?.trim()
  // MATCH 里的 glob 原样透传：* ? [] 都是 Redis 自己的语义，不该在这里转义
  if (match) scanArgs.push('MATCH', match)

  const reply = await client.run(scanArgs)
  if (!Array.isArray(reply) || reply.length !== 2) throw new DockerError(502, 'SCAN 回了个看不懂的结果')
  const nextCursor = String(Buffer.isBuffer(reply[0]) ? reply[0].toString('utf8') : reply[0])
  const rawKeys = Array.isArray(reply[1]) ? reply[1] : []
  const names = rawKeys
    .map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : String(item)))
    .slice(0, maxScanKeys)

  // 一个 key 三条命令：用 pipeline 太复杂（要自己配序号），这里并发发，连接本身是串行的
  const keys = await Promise.all(
    names.map(async (key): Promise<RedisKeyEntry> => {
      const [typeReply, ttlReply, sizeReply] = await Promise.all([
        client.command(['TYPE', key]),
        client.command(['TTL', key]),
        client.command(['MEMORY', 'USAGE', key]).catch(() => 0),
      ])
      const type = typeReply instanceof Error ? 'unknown' : String(Buffer.isBuffer(typeReply) ? typeReply.toString('utf8') : typeReply)
      const ttl = typeof ttlReply === 'number' ? ttlReply : -1
      const memoryBytes = typeof sizeReply === 'number' ? sizeReply : 0

      let size = 0
      if (type === 'string') {
        const len = await client.command(['STRLEN', key])
        size = typeof len === 'number' ? len : memoryBytes
      } else if (type === 'list') {
        const n = await client.command(['LLEN', key])
        size = typeof n === 'number' ? n : 0
      } else if (type === 'set') {
        const n = await client.command(['SCARD', key])
        size = typeof n === 'number' ? n : 0
      } else if (type === 'zset') {
        const n = await client.command(['ZCARD', key])
        size = typeof n === 'number' ? n : 0
      } else if (type === 'hash') {
        const n = await client.command(['HLEN', key])
        size = typeof n === 'number' ? n : 0
      } else if (type === 'stream') {
        const n = await client.command(['XLEN', key])
        size = typeof n === 'number' ? n : 0
      }

      let preview = ''
      let binary = false
      // 预览只对 string 做：其它类型取一个元素要额外多条命令，而列表里也放不下
      if (options.withPreview !== false && type === 'string' && size > 0) {
        const chunk = await client.command(['GETRANGE', key, '0', String(Math.min(maxValueBytes, 200) - 1)])
        if (Buffer.isBuffer(chunk)) {
          const decoded = decodeMaybe(chunk)
          preview = decoded.text.replace(/\s+/g, ' ').slice(0, 120)
          binary = decoded.binary
        }
      }

      return { key, type, size, ttl, preview, binary }
    }),
  )

  return { keys, cursor: nextCursor, scanned: names.length }
}

/** 读一个 key 的值（每种类型各一套读法）。 */
export async function readValue(client: RedisClient, key: string): Promise<RedisValue> {
  const typeReply = await client.run(['TYPE', key])
  const type = String(Buffer.isBuffer(typeReply) ? typeReply.toString('utf8') : typeReply)
  const ttlReply = await client.command(['TTL', key])
  const ttl = typeof ttlReply === 'number' ? ttlReply : -1

  const text = (value: unknown): { text: string; binary: boolean } => {
    if (Buffer.isBuffer(value)) {
      const decoded = decodeMaybe(value.length > maxValueBytes ? value.subarray(0, maxValueBytes) : value)
      return { text: decoded.text, binary: decoded.binary }
    }
    return { text: String(value), binary: false }
  }
  const asText = (value: unknown): string => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value))

  if (type === 'none') throw new DockerError(404, `key「${key}」不在了（可能刚过期）`)

  if (type === 'string') {
    const lenReply = await client.command(['STRLEN', key])
    const size = typeof lenReply === 'number' ? lenReply : 0
    // 大值只取前面一段：把 100 MB 的 blob 拉进内存再塞进 JSON 会把服务端和界面一起拖死
    const raw = size > maxValueBytes ? await client.run(['GETRANGE', key, '0', String(maxValueBytes - 1)]) : await client.run(['GET', key])
    const decoded = Buffer.isBuffer(raw) ? decodeMaybe(raw) : { text: String(raw), binary: false, bytes: size }
    return {
      key,
      type,
      ttl,
      size,
      truncated: size > maxValueBytes,
      value: { kind: 'string', text: decoded.text, binary: decoded.binary, bytes: size },
    }
  }

  if (type === 'list') {
    const sizeReply = await client.command(['LLEN', key])
    const size = typeof sizeReply === 'number' ? sizeReply : 0
    const raw = await client.run(['LRANGE', key, '0', String(maxElements - 1)])
    const items = (Array.isArray(raw) ? raw : []).map((item) => text(item))
    return { key, type, ttl, size, truncated: size > maxElements, value: { kind: 'list', items } }
  }

  if (type === 'set') {
    const sizeReply = await client.command(['SCARD', key])
    const size = typeof sizeReply === 'number' ? sizeReply : 0
    // SRANDMEMBER 而不是 SMEMBERS：大集合 SMEMBERS 会一次拉全部
    const raw = await client.run(['SRANDMEMBER', key, String(maxElements)])
    const items = (Array.isArray(raw) ? raw : []).map((item) => text(item))
    return { key, type, ttl, size, truncated: size > maxElements, value: { kind: 'set', items } }
  }

  if (type === 'zset') {
    const sizeReply = await client.command(['ZCARD', key])
    const size = typeof sizeReply === 'number' ? sizeReply : 0
    const raw = await client.run(['ZRANGE', key, '0', String(maxElements - 1), 'WITHSCORES'])
    const members: Array<{ member: string; score: number }> = []
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        members.push({ member: asText(raw[i]), score: Number(asText(raw[i + 1])) })
      }
    }
    return { key, type, ttl, size, truncated: size > maxElements, value: { kind: 'zset', members } }
  }

  if (type === 'hash') {
    const sizeReply = await client.command(['HLEN', key])
    const size = typeof sizeReply === 'number' ? sizeReply : 0
    const raw = await client.run(['HRANDFIELD', key, String(maxElements), 'WITHVALUES'])
    const entries: Array<{ field: string; text: string; binary: boolean }> = []
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const field = asText(raw[i])
        const value = text(raw[i + 1])
        entries.push({ field, text: value.text, binary: value.binary })
      }
    }
    return { key, type, ttl, size, truncated: size > maxElements, value: { kind: 'hash', entries } }
  }

  if (type === 'stream') {
    const sizeReply = await client.command(['XLEN', key])
    const size = typeof sizeReply === 'number' ? sizeReply : 0
    const raw = await client.run(['XRANGE', key, '-', '+', 'COUNT', String(maxElements)])
    const entries: Array<{ id: string; fields: Array<{ field: string; text: string; binary: boolean }> }> = []
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length < 2) continue
        const id = asText(entry[0])
        const flat = Array.isArray(entry[1]) ? entry[1] : []
        const fields: Array<{ field: string; text: string; binary: boolean }> = []
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const field = asText(flat[i])
          const value = text(flat[i + 1])
          fields.push({ field, text: value.text, binary: value.binary })
        }
        entries.push({ id, fields })
      }
    }
    return { key, type, ttl, size, truncated: size > maxElements, value: { kind: 'stream', entries } }
  }

  // 未知类型（新版本加的，或模块类型）：不假装能读，把类型如实回给界面
  return {
    key,
    type,
    ttl,
    size: 0,
    truncated: false,
    value: { kind: 'other', extra: type },
    note: `Kura 还不认识「${type}」类型的值，只能显示它的类型`,
  }
}

/** 跑一条用户输入的命令，结果转成「能显示」的形状。 */
export async function runUserCommand(client: RedisClient, args: string[], timeoutMs?: number): Promise<{ text: string; binary: boolean; ms: number }> {
  const startedAt = Date.now()
  const reply = await client.command(args, timeoutMs)
  return {
    text: reply instanceof Error ? `(error) ${reply.message}` : describeInline(reply),
    binary: false,
    ms: Date.now() - startedAt,
  }
}

/** 命令结果压成一段文本（界面里就是一块 `pre`）。 */
function describeInline(value: import('./redis.js').Resp): string {
  if (value === null) return '(nil)'
  if (value instanceof Error) return `(error) ${value.message}`
  if (Buffer.isBuffer(value)) {
    const decoded = decodeMaybe(value)
    return decoded.text
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return value
    .map((item, index) => `${index + 1}) ${describeInline(item)}`)
    .join('\n')
}

/** 所有 key 的类型分布（界面上给一句概览）。 */
export async function typeSummary(client: RedisClient, limit = 200): Promise<Array<{ type: string; count: number }>> {
  const page = await scanKeys(client, { count: limit, withPreview: false })
  const counts = new Map<string, number>()
  for (const entry of page.keys) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1)
  return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
}
