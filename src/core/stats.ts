/** 趋势柱状图形状：最近 trendBuckets 根柱子，每根 trendBucketMs。 */
export const trendBucketMs = 60_000
export const trendBuckets = 30

export interface TrendPoint {
  /** 这一格的起点（毫秒时间戳，按 bucket 对齐） */
  at: number
  requests: number
  errors: number
}

export interface StatsSnapshot {
  requests: number
  errors: number
  lastError: string
  /** 上行：从本机应用读走、发往 NAS 的请求体字节 */
  bytesUp: number
  /** 下行：从 NAS 收回、写回本机应用的响应体字节 */
  bytesDown: number
  trend: TrendPoint[]
}

/**
 * 一个服务的流量统计。
 *
 * 柱子按**时间**对齐，而不是「来一次请求就挪一格」：空闲期间没人调用，下次来请求时按时间差一次补零
 * —— 否则空闲会被「压缩」，画出来的趋势是假的。
 *
 * ⚠️ WebSocket 升级后字节走被接管的原始连接，不计入 bytesUp/bytesDown（与 Go 版一致）。
 */
export class ServiceStats {
  requests = 0
  errors = 0
  lastError = ''
  bytesUp = 0
  bytesDown = 0
  private buckets: TrendPoint[] = []
  private readonly bucketMs: number
  private readonly now: () => number

  constructor(options: { bucketMs?: number; now?: () => number } = {}) {
    this.bucketMs = options.bucketMs ?? trendBucketMs
    this.now = options.now ?? Date.now
  }

  noteRequest(): void {
    this.requests += 1
    this.current().requests += 1
  }

  noteError(error: unknown): void {
    this.errors += 1
    this.lastError = error instanceof Error ? error.message : String(error)
    this.current().errors += 1
  }

  private current(): TrendPoint {
    this.advance()
    return this.buckets[this.buckets.length - 1]!
  }

  private advance(): void {
    const d = this.bucketMs
    const cur = Math.floor(this.now() / d) * d
    const fill = (lastAt: number) => {
      this.buckets = Array.from({ length: trendBuckets }, (_, i) => ({
        at: lastAt - (trendBuckets - 1 - i) * d,
        requests: 0,
        errors: 0,
      }))
    }
    const last = this.buckets[this.buckets.length - 1]
    if (!last) {
      fill(cur)
      return
    }
    const shift = Math.floor((cur - last.at) / d)
    if (shift <= 0) return
    if (shift >= trendBuckets) {
      fill(cur)
      return
    }
    this.buckets = this.buckets.slice(shift)
    for (let i = 1; i <= shift; i += 1) this.buckets.push({ at: last.at + i * d, requests: 0, errors: 0 })
  }

  /** 最近 trendBuckets 根柱子；即使一条请求都没有，时间轴也推到当前时刻。 */
  trend(): TrendPoint[] {
    this.advance()
    return this.buckets.map((point) => ({ ...point }))
  }

  snapshot(): StatsSnapshot {
    return {
      requests: this.requests,
      errors: this.errors,
      lastError: this.lastError,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      trend: this.trend(),
    }
  }
}

/** 1024 进制的字节显示，界面与日志共用。 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
