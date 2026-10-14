import { randomBytes } from 'node:crypto'
import { readJson, writeJsonAtomic } from '../../src/core/store.js'
import { verifyPassword } from './password.js'

/**
 * 单用户认证，**对外行为照搬现网 Authelia**，让现有 Kura 客户端不改代码就能连：
 *
 *   POST /api/firstfactor {username,password,keepMeLoggedIn}
 *     成功 → 200 {"status":"OK"} + Set-Cookie: authelia_session=…
 *     失败 → 401 {"status":"KO","message":"Authentication failed. Check your credentials."}
 *     封禁 → 401 {"status":"KO","message":"…banned until 3:04:05PM on Oct 14 2026…"}
 *
 * 客户端的处置都依赖这几个形状（src/core/authelia.ts）：401 / KO 停止重试、冷却；文案里的
 * `banned until` 被解析出来显示。所以 cookie 名、状态码、status 字段、封禁文案的格式都不能改。
 */
export const sessionCookie = 'authelia_session'

export interface AuthConfig {
  user: string
  passwordHash: string
  /** 会话滑动过期（毫秒）；keepMeLoggedIn=false 时用 shortTtlMs */
  ttlMs?: number
  shortTtlMs?: number
  /** 会话落盘文件；不给就只在内存里 */
  sessionFile?: string
  /** 防爆破：windowMs 内失败 maxFailures 次封 banMs */
  maxFailures?: number
  windowMs?: number
  banMs?: number
  now?: () => number
}

interface Session {
  user: string
  expiresAt: number
  ttlMs: number
}

export type LoginResult =
  | { ok: true; token: string; maxAgeSeconds: number }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 400; message: string }

/** Authelia 的封禁文案时间格式：`3:04:05PM on Oct 14 2026`（Go 的 time.Kitchen + 日期）。 */
export function autheliaBanTime(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const hh = h % 12 || 12
  const pad = (n: number) => String(n).padStart(2, '0')
  const month = d.toLocaleString('en-US', { month: 'short' })
  return `${hh}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${h < 12 ? 'AM' : 'PM'} on ${month} ${d.getDate()} ${d.getFullYear()}`
}

export class Auth {
  private readonly sessions = new Map<string, Session>()
  /** 按「来源 + 用户名」记失败；封禁也按这个键（换用户名不能绕过，按 IP 统计） */
  private readonly failures = new Map<string, { times: number[]; bannedUntil: number }>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly shortTtlMs: number
  private saveTimer: NodeJS.Timeout | undefined

  constructor(private readonly config: AuthConfig) {
    this.now = config.now ?? Date.now
    this.ttlMs = config.ttlMs ?? 30 * 24 * 3600_000
    this.shortTtlMs = config.shortTtlMs ?? 12 * 3600_000
    if (config.sessionFile) {
      const saved = readJson<Record<string, Session>>(config.sessionFile) ?? {}
      for (const [token, session] of Object.entries(saved)) {
        if (session.expiresAt > this.now() && session.user === config.user) this.sessions.set(token, session)
      }
    }
  }

  private persist(): void {
    const file = this.config.sessionFile
    if (!file || this.saveTimer) return
    // 合并 1 秒内的写：每个请求都续期，不能每次都写盘
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      try {
        writeJsonAtomic(file, Object.fromEntries(this.sessions))
      } catch {
        // 写不了只是重启后要重登，不影响在线
      }
    }, 1_000)
    this.saveTimer.unref?.()
  }

  async login(source: string, body: unknown): Promise<LoginResult> {
    const input = (body ?? {}) as { username?: unknown; password?: unknown; keepMeLoggedIn?: unknown }
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!username || !password) return { ok: false, status: 400, message: 'Unable to parse body.' }

    const key = source
    const record = this.failures.get(key) ?? { times: [], bannedUntil: 0 }
    const now = this.now()
    if (record.bannedUntil > now) {
      return {
        ok: false,
        status: 401,
        message: `Authentication failed. It appears this user is temporarily banned until ${autheliaBanTime(record.bannedUntil)}.`,
      }
    }

    // 用户名不对也照样跑一次 argon2：响应时间不泄露「用户存在与否」
    const passwordOk = await verifyPassword(password, this.config.passwordHash)
    if (username !== this.config.user || !passwordOk) {
      const windowMs = this.config.windowMs ?? 5 * 60_000
      record.times = [...record.times.filter((t) => now - t < windowMs), now]
      if (record.times.length >= (this.config.maxFailures ?? 5)) {
        record.bannedUntil = now + (this.config.banMs ?? 10 * 60_000)
        record.times = []
      }
      this.failures.set(key, record)
      return { ok: false, status: 401, message: 'Authentication failed. Check your credentials.' }
    }

    this.failures.delete(key)
    const ttlMs = input.keepMeLoggedIn === true ? this.ttlMs : this.shortTtlMs
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { user: username, expiresAt: now + ttlMs, ttlMs })
    this.persist()
    return { ok: true, token, maxAgeSeconds: Math.round(ttlMs / 1000) }
  }

  /** 校验会话；有效就滑动续期，返回用户名。 */
  check(token: string | undefined): string | undefined {
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (!session) return undefined
    const now = this.now()
    if (session.expiresAt <= now) {
      this.sessions.delete(token)
      this.persist()
      return undefined
    }
    // 只在剩余不到一半时续期，避免每个请求都写盘
    if (session.expiresAt - now < session.ttlMs / 2) {
      session.expiresAt = now + session.ttlMs
      this.persist()
    }
    return session.user
  }

  logout(token: string | undefined): void {
    if (token && this.sessions.delete(token)) this.persist()
  }

  sessionCount(): number {
    return this.sessions.size
  }
}

/** 从 Cookie 头取会话令牌（cookie 名可能带 Authelia 的 _<hash> 后缀，按前缀认）。 */
export function sessionToken(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === sessionCookie || name.startsWith(`${sessionCookie}_`)) return part.slice(eq + 1).trim()
  }
  return undefined
}
