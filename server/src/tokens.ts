import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * API Token：给脚本 / AI 调 `POST /api/exec` 用（`nsc_` 开头，沿用 nas-console 的取名）。
 *
 * 存在 `/state/tokens.json` 里的是**明文**（不是哈希）：这些 token 要能被吊销后原样显示给用户
 * （管理页里「查看」），跟密码不是一回事 —— 它就像一把家里的钥匙，用户有权看到自己那把。
 * 只存文件、不进日志。前缀 `nsc_` 是为了让别人一眼看出这是终端用的 key。
 */
export interface TokenRecord {
  token: string
  label: string
  createdAt: string
}

const prefix = 'nsc_'

export class TokenStore {
  private records: TokenRecord[] = []
  private loadError = ''

  constructor(
    private readonly file: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reload()
  }

  reload(): void {
    if (!this.file) return
    try {
      if (!existsSync(this.file)) {
        this.records = []
        this.loadError = ''
        return
      }
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { tokens?: unknown }
      this.records = Array.isArray(doc.tokens) ? (doc.tokens as TokenRecord[]).filter((t) => typeof t?.token === 'string') : []
      this.loadError = ''
    } catch (error) {
      this.records = []
      this.loadError = (error as Error).message
    }
  }

  error(): string {
    return this.loadError
  }

  list(): Array<{ token: string; label: string; createdAt: string }> {
    return this.records.map((r) => ({ ...r }))
  }

  /** 生成一个 token（43 个 base64url 字符 = 256 位）。 */
  create(label: string): TokenRecord {
    const token = prefix + randomBytes(32).toString('base64url')
    const record: TokenRecord = { token, label: label.trim() || '未命名', createdAt: this.now().toISOString() }
    this.records.push(record)
    this.persist()
    return { ...record }
  }

  revoke(token: string): boolean {
    const before = this.records.length
    this.records = this.records.filter((r) => r.token !== token)
    if (this.records.length !== before) this.persist()
    return this.records.length !== before
  }

  /** 恒定时间比较：一个字符都不匹配、和匹配到最后一位，耗时一样。 */
  verify(token: string | undefined): TokenRecord | undefined {
    if (!token) return undefined
    const given = Buffer.from(token)
    for (const record of this.records) {
      const known = Buffer.from(record.token)
      if (known.length === given.length && timingSafeEqual(known, given)) return { ...record }
    }
    return undefined
  }

  private persist(): void {
    if (!this.file) return
    try {
      writeFileSync(this.file, JSON.stringify({ tokens: this.records }, null, 2) + '\n')
    } catch (error) {
      this.loadError = (error as Error).message
    }
  }
}
