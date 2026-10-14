import { argon2, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const argon2Async = promisify(argon2)

/**
 * 密码哈希：argon2id，PHC 字符串格式 `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`。
 *
 * 和 Authelia 生成的格式一样（`authelia crypto hash generate argon2` 的输出），
 * 所以现网 sso-gateway `.env` 里的 ADMIN_PASSWORD_HASH 可以原样搬过来用。
 * 用的是 Node 24 自带的 crypto.argon2，不引入原生依赖。
 */
export interface Argon2Params {
  memory: number
  passes: number
  parallelism: number
}

export const defaultParams: Argon2Params = { memory: 65536, passes: 3, parallelism: 4 }

/** PHC 里的 base64 不带填充（RFC 4648 标准字母表）。 */
const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '')
const unb64 = (text: string) => Buffer.from(text, 'base64')

export async function hashPassword(password: string, params: Argon2Params = defaultParams): Promise<string> {
  const salt = randomBytes(16)
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: salt,
    memory: params.memory,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: 32,
  })
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`
}

interface ParsedHash {
  params: Argon2Params
  salt: Buffer
  tag: Buffer
}

export function parseHash(phc: string): ParsedHash {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc.trim())
  if (!m) throw new Error('密码哈希格式不对：要 argon2id 的 PHC 字符串（$argon2id$v=19$m=…,t=…,p=…$盐$哈希）')
  const params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) }
  // 防止有人塞一个 m=4GB 的哈希把服务拖垮：上限给到 1 GiB、t ≤ 10
  if (params.memory > 1 << 20 || params.passes > 10 || params.parallelism > 16) throw new Error('密码哈希参数过大')
  return { params, salt: unb64(m[4]!), tag: unb64(m[5]!) }
}

/** 恒定时间比较；哈希坏了直接 false，不抛（登录接口不该因为配置错而 500 泄露信息）。 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  let parsed: ParsedHash
  try {
    parsed = parseHash(phc)
  } catch {
    return false
  }
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: parsed.salt,
    memory: parsed.params.memory,
    passes: parsed.params.passes,
    parallelism: parsed.params.parallelism,
    tagLength: parsed.tag.length,
  })
  return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag)
}

/** 凭据指纹：sha256 前 8 位。两端（服务启动日志 / 客户端）对一眼就知道凭据有没有发错，又反推不出原文。 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}
