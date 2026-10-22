import { errorMessage } from './errors.js'
import { silentLogger, type Logger } from './log.js'
import { ServiceStats, type SavedStats } from './stats.js'
import { readJson, writeJsonAtomic } from './store.js'

/** 写盘节流：统计是每个请求都在变的，绝不能跟着请求写文件。 */
export const statsFlushMs = 15_000

interface StatsFile {
  version: 1
  services: Record<string, SavedStats>
}

/**
 * 流量的落盘。
 *
 * 键是 `Mirror.keyOf()`（服务名，取不到才用 `port-<NAS端口>`），所以**改本机端口不会把统计弄丢**，
 * 与 `services.json` 的口径一致。服务从清单里消失时它那份留着不删 —— 服务端清单本来就是只增不减，
 * 统计比清单更该留着（以后的趋势图要从这里读）。
 */
export class StatsStore {
  private readonly data: Record<string, SavedStats>
  private readonly tracked = new Map<string, { stats: ServiceStats; written: number }>()
  private readonly log: Logger
  private readonly flushMs: number
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly file: string, options: { flushMs?: number; log?: Logger } = {}) {
    this.log = options.log ?? silentLogger
    this.flushMs = options.flushMs ?? statsFlushMs
    this.data = readJson<StatsFile>(file)?.services ?? {}
  }

  /** 上次留下的那份；没有就是全新的一份（由 ServiceStats 自己回落到 0）。 */
  get(key: string): SavedStats | undefined {
    return this.data[key]
  }

  /** 登记一份正在跑着的统计，之后按 revision 判断要不要重写。 */
  track(key: string, stats: ServiceStats): void {
    // 已经记过（同一个键重新挂上）就以新的这份为准；written 也换成它当前的值，免得白写一次
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
  }

  /**
   * 把有变化的几份写出去。**先写盘、写成了才认账**：
   * 反过来先记 `written` 的话，某次写失败（磁盘满、文件被占用）之后这一段变化就永远不会再写了。
   */
  flush(): void {
    const pending: Array<[string, SavedStats, number]> = []
    for (const [key, entry] of this.tracked) {
      if (entry.stats.revision === entry.written) continue
      pending.push([key, entry.stats.toSaved(), entry.stats.revision])
    }
    if (pending.length === 0) return
    const next = { ...this.data }
    for (const [key, saved] of pending) next[key] = saved
    try {
      writeJsonAtomic(this.file, { version: 1, services: next } satisfies StatsFile)
    } catch (error) {
      // 写不进去只影响「重启后数字还在不在」，不能让统计拖垮映射
      this.log.warn('流量统计落盘失败', { err: errorMessage(error) })
      return
    }
    for (const [key, saved, revision] of pending) {
      this.data[key] = saved
      const entry = this.tracked.get(key)
      if (entry) entry.written = revision
    }
  }
}
