import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { errorMessage } from './errors.js'
import { silentLogger, type Logger } from './log.js'
import { ServiceStats, hourMs, hourBuckets, type SavedStats } from './stats.js'

/** 写库节流：统计是每个请求都在变的，绝不能跟着请求写盘。 */
export const statsFlushMs = 15_000

/**
 * 落盘方要做的事。抽出接口是为了有个「什么都不做」的兜底：
 * 库打不开（文件坏了、磁盘满、或者这个 Electron 没有 node:sqlite）时映射还得照常跑，
 * 只是数字按本次启动算、重启后归零 —— 不能因为统计把服务拖垮。
 */
export interface StatsSink {
  get(key: string): SavedStats | undefined
  track(key: string, stats: ServiceStats): void
  start(): void
  stop(): void
  flush(): void
}

/** 兜底：一份都不存。 */
export class NullStatsStore implements StatsSink {
  get(): undefined {
    return undefined
  }
  track(): void {}
  start(): void {}
  stop(): void {}
  flush(): void {}
}

/**
 * 两张表，各管一件事：
 *
 * - `service_total`：一个服务一行，装机以来的累计数。只 upsert，不跟着明细清理。
 * - `hourly`：按小时分格。以后做统计（今天走了多少、哪个服务占大头）直接按这个查。
 *
 * 分开的理由：明细可以按保留期清掉，累计不能 —— 清明细顺手把「一共多少」也清了，
 * 用户看到的数字会自己往回缩。
 */
const schema = `
CREATE TABLE IF NOT EXISTS service_total (
  service    TEXT PRIMARY KEY,
  since      INTEGER NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes_up   INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hourly (
  service    TEXT NOT NULL,
  hour       INTEGER NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  bytes_up   INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS hourly_by_hour ON hourly (hour);
`

interface TotalRow {
  service: string
  since: number
  requests: number
  errors: number
  bytes_up: number
  bytes_down: number
}

interface HourlyRow {
  service: string
  hour: number
  requests: number
  errors: number
  bytes_up: number
  bytes_down: number
}

/** 数据库里的东西可能是手改过的、或旧版本写的：能坏的地方都当 0。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 流量的落盘（SQLite）。
 *
 * 用 `node:sqlite`：Electron 44 带的是 Node 24，它是内置模块，不用装依赖、也不用编原生模块
 * （原生模块还得跟着 Electron ABI 重编，打包最容易坏在这一步）。
 *
 * 键是 `Mirror.keyOf()`（服务名，取不到才 `port-<NAS端口>`），所以**改本机端口不会把统计弄丢**，
 * 与 `services.json` 的口径一致。服务从清单里消失时它那份留着不删 —— 统计比清单更该留着。
 */
export class StatsStore implements StatsSink {
  private readonly db: DatabaseSync
  private readonly tracked = new Map<string, { stats: ServiceStats; written: number }>()
  private readonly log: Logger
  private readonly flushMs: number
  private timer: NodeJS.Timeout | undefined
  private readonly upsertTotal: ReturnType<DatabaseSync['prepare']>
  private readonly upsertHour: ReturnType<DatabaseSync['prepare']>

  constructor(private readonly file: string, options: { flushMs?: number; log?: Logger } = {}) {
    this.log = options.log ?? silentLogger
    this.flushMs = options.flushMs ?? statsFlushMs
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    try {
      // WAL：写的时候不挡读（界面每 3 秒读一次快照，别和落盘互相等）
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec(schema)
      this.upsertTotal = this.db.prepare(`
        INSERT INTO service_total (service, since, requests, errors, bytes_up, bytes_down, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(service) DO UPDATE SET
          requests = excluded.requests, errors = excluded.errors,
          bytes_up = excluded.bytes_up, bytes_down = excluded.bytes_down,
          updated_at = excluded.updated_at
      `)
      // 小时格写绝对值：同一个格子重复写不会翻倍，写盘重试因此是安全的
      this.upsertHour = this.db.prepare(`
        INSERT INTO hourly (service, hour, requests, errors, bytes_up, bytes_down)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(service, hour) DO UPDATE SET
          requests = excluded.requests, errors = excluded.errors,
          bytes_up = excluded.bytes_up, bytes_down = excluded.bytes_down
      `)
    } catch (error) {
      // 文件不是 SQLite、或被别的进程独占：这里的错要往上抛（映射层记一条 WARN 并关掉落盘），
      // 但句柄必须先关掉 —— 开着不关，Windows 上那个文件连删都删不掉。
      try {
        this.db.close()
      } catch {
        // 已经不可用了
      }
      throw error
    }
  }

  /** 上次留下的那份；没有就是全新的一份（由 ServiceStats 自己回落到 0）。 */
  get(key: string): SavedStats | undefined {
    const total = this.db.prepare('SELECT * FROM service_total WHERE service = ?').get(key) as TotalRow | undefined
    const hours = this.db
      .prepare('SELECT * FROM hourly WHERE service = ? ORDER BY hour DESC LIMIT ?')
      .all(key, hourBuckets) as unknown as HourlyRow[]
    if (!total && hours.length === 0) return undefined
    return {
      since: total ? num(total.since) : undefined,
      requests: num(total?.requests),
      errors: num(total?.errors),
      bytesUp: num(total?.bytes_up),
      bytesDown: num(total?.bytes_down),
      // 查询按 hour 倒序取最近的，拼回来要按时间正序 —— advance() 假设最后一个是最新的
      hours: hours
        .map((row) => ({
          at: num(row.hour),
          requests: num(row.requests),
          errors: num(row.errors),
          bytesUp: num(row.bytes_up),
          bytesDown: num(row.bytes_down),
        }))
        .reverse(),
    }
  }

  /** 登记一份正在跑着的统计，之后按 revision 判断要不要写。 */
  track(key: string, stats: ServiceStats): void {
    this.tracked.set(key, { stats, written: stats.revision })
  }

  start(): void {
    if (this.timer) return
    const timer = setInterval(() => this.flush(), this.flushMs)
    timer.unref?.()
    this.timer = timer
  }

  /** 停表并兜一次：进程要走了，最后一段变化不能丢。 */
  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.flush()
    try {
      this.db.close()
    } catch {
      // 已经关了
    }
  }

  /**
   * 把有变化的几份写出去。
   *
   * **先落库、落成了才认账**（`markSaved`）：反过来先清脏标记的话，某次写失败（库被占、
   * 磁盘满）之后这一段变化就永远不会再写了，而且看不出来。
   *
   * 整批放在一个事务里：几十个服务一起写，中途失败不该留下「一半是新的、一半是旧的」。
   */
  flush(): void {
    const pending: Array<[string, ServiceStats, SavedStats]> = []
    for (const [key, entry] of this.tracked) {
      if (entry.stats.revision === entry.written) continue
      pending.push([key, entry.stats, entry.stats.toSaved()])
    }
    if (pending.length === 0) return
    const now = Date.now()
    try {
      this.db.exec('BEGIN')
      for (const [key, , saved] of pending) {
        this.upsertTotal.run(
          key,
          saved.since ?? now,
          saved.requests,
          saved.errors,
          saved.bytesUp,
          saved.bytesDown,
          now,
        )
        for (const hour of saved.hours) {
          this.upsertHour.run(key, hour.at, hour.requests, hour.errors, hour.bytesUp, hour.bytesDown)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务可能压根没开起来
      }
      // 写不进去只影响「重启后数字还在不在」，不能让统计拖垮映射
      this.log.warn('流量统计落盘失败', { err: errorMessage(error) })
      return
    }
    for (const [key, stats] of pending) {
      // 写成功了才清脏标记、才认下这次的 revision。顺序反了的话，写失败那一段会永久丢掉。
      stats.markSaved()
      const entry = this.tracked.get(key)
      if (entry) entry.written = stats.revision
    }
  }

  /** 明细的保留期：超过这么多天的小时格清掉。累计数在另一张表，不受影响。 */
  prune(keepDays = 60): number {
    const edge = Math.floor((Date.now() - keepDays * 24 * 3_600_000) / hourMs) * hourMs
    try {
      const result = this.db.prepare('DELETE FROM hourly WHERE hour < ?').run(edge)
      return Number(result.changes ?? 0)
    } catch (error) {
      this.log.warn('清理历史小时格失败', { err: errorMessage(error) })
      return 0
    }
  }
}
