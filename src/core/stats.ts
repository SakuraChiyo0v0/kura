/** 趋势柱状图形状：最近 trendBuckets 根柱子，每根 trendBucketMs。 */
export const trendBucketMs = 60_000
export const trendBuckets = 30

/**
 * 小时桶的粒度。**这个才是落盘的**。
 *
 * 分钟桶（趋势柱）重启后接不上：写进去的格子早就过期，读回来也会被补零算法抹掉，
 * 落盘只是自欺欺人。小时桶粗一档，重启前后的同一格能接上，数字才不会归零。
 */
export const hourMs = 3_600_000
/** 保留多少格小时桶：两天。界面上的「近一天」取末尾 24 格，多留一天给后续的统计功能。 */
export const hourBuckets = 48
/** 「近一天」窗口：末尾 24 格。 */
export const dayBuckets = 24

export interface TrendPoint {
  /** 这一格的起点（毫秒时间戳，按 bucket 对齐） */
  at: number
  requests: number
  errors: number
}

/** 一段时间内的合计。 */
export interface Totals {
  requests: number
  errors: number
  bytesUp: number
  bytesDown: number
}

/** 一个小时格。 */
export interface HourlyPoint extends Totals {
  /** 这一格的起点（毫秒时间戳，按整点对齐） */
  at: number
}

export interface StatsSnapshot {
  requests: number
  errors: number
  lastError: string
  /** 上行：从本机应用读走、发往 NAS 的请求体字节 */
  bytesUp: number
  /** 下行：从 NAS 收回、写回本机应用的响应体字节 */
  bytesDown: number
  /** 近一天（最近 dayBuckets 个小时格）。概览上的卡片显示的就是它。 */
  recent: Totals
  trend: TrendPoint[]
}

/**
 * 落盘形状：一个服务的累计数 + 最近的小时格。
 *
 * 累计数是「装机以来一共多少」，不随重启归零；小时格给「近一天」和以后的数据统计用。
 */
export interface SavedStats extends Totals {
  /** 首次开始统计的时刻；老文件可能没有 */
  since?: number
  hours: HourlyPoint[]
}

/** 从磁盘读回来的数字可能是手改过的、或者是旧版本写的：能坏的地方都当 0。 */
function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function loadHourly(hours: unknown): HourlyPoint[] {
  if (!Array.isArray(hours)) return []
  const clean = hours
    .filter((h): h is HourlyPoint => Boolean(h) && typeof h === 'object' && Number.isFinite((h as HourlyPoint).at))
    .map((h) => ({
      at: Math.floor(h.at / hourMs) * hourMs,
      requests: safeNumber(h.requests),
      errors: safeNumber(h.errors),
      bytesUp: safeNumber(h.bytesUp),
      bytesDown: safeNumber(h.bytesDown),
    }))
    .sort((a, b) => a.at - b.at)
  // 同一格出现两次（手改过文件）就留后面那条，别把一天的数算两遍
  const byAt = new Map<number, HourlyPoint>()
  for (const point of clean) byAt.set(point.at, point)
  return [...byAt.values()].slice(-hourBuckets)
}

const blankHour = (at: number): HourlyPoint => ({ at, requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 })
const blankMinute = (at: number): TrendPoint => ({ at, requests: 0, errors: 0 })

/**
 * 把一个「按时间对齐的格子数组」推到 now：缺格补零、过期裁掉、跨了整轮就重来。
 *
 * 只在跨格时才重建数组；还在同一格时**原样返回同一个数组** —— 字节计数是逐 chunk 进来的，
 * 稳定状态下每个 chunk 都走这里，不能顺手分配一堆对象。
 */
function advance<T extends { at: number }>(
  list: T[],
  size: number,
  step: number,
  now: number,
  blank: (at: number) => T,
): T[] {
  const cur = Math.floor(now / step) * step
  const last = list[list.length - 1]
  if (!last) return Array.from({ length: size }, (_, i) => blank(cur - (size - 1 - i) * step))
  const shift = Math.floor((cur - last.at) / step)
  if (shift <= 0) return list
  if (shift >= size) return Array.from({ length: size }, (_, i) => blank(cur - (size - 1 - i) * step))
  return [...list.slice(shift), ...Array.from({ length: shift }, (_, i) => blank(last.at + (i + 1) * step))]
}

/**
 * 一个服务的流量统计。
 *
 * 柱子按**时间**对齐，而不是「来一次请求就挪一格」：空闲期间没人调用，下次来请求时按时间差一次补零
 * —— 否则空闲会被「压缩」，画出来的趋势是假的。
 *
 * 两份账各管一件事：
 * - **累计数**（requests / errors / bytesUp / bytesDown）：装机以来一共多少，落盘，重启不归零；
 * - **小时格**：最近两天，落盘，概览的「近一天」与以后的统计功能从它算。
 *
 * ⚠️ WebSocket 升级后字节走被接管的原始连接，不计入 bytesUp/bytesDown（与 Go 版一致）。
 */
export class ServiceStats {
  requests = 0
  errors = 0
  lastError = ''
  /**
   * 落盘方靠它判断「这一份要不要重写」：每有一次数字变化就加一。
   * 只数会落盘的字段 —— lastError 不落盘，改它不该触发写文件。
   */
  revision = 0
  private readonly since: number
  private up = 0
  private down = 0
  private buckets: TrendPoint[] = []
  private hourly: HourlyPoint[]
  private readonly bucketMs: number
  private readonly now: () => number

  constructor(options: { bucketMs?: number; now?: () => number; saved?: SavedStats } = {}) {
    this.bucketMs = options.bucketMs ?? trendBucketMs
    this.now = options.now ?? Date.now
    const saved = options.saved
    this.requests = safeNumber(saved?.requests)
    this.errors = safeNumber(saved?.errors)
    this.up = safeNumber(saved?.bytesUp)
    this.down = safeNumber(saved?.bytesDown)
    this.hourly = loadHourly(saved?.hours)
    this.since = saved?.since ?? this.now()
  }

  /** 上行：从本机应用读走、发往 NAS 的请求体字节。 */
  get bytesUp(): number {
    return this.up
  }

  set bytesUp(value: number) {
    const delta = value - this.up
    if (delta === 0) return
    this.up = value
    // 只把「多出来的量」记进当前小时格；倒退（没人这么用）只改总数
    if (delta > 0) this.currentHour().bytesUp += delta
    this.revision += 1
  }

  /** 下行：从 NAS 收回、写回本机应用的响应体字节。 */
  get bytesDown(): number {
    return this.down
  }

  set bytesDown(value: number) {
    const delta = value - this.down
    if (delta === 0) return
    this.down = value
    if (delta > 0) this.currentHour().bytesDown += delta
    this.revision += 1
  }

  noteRequest(): void {
    this.requests += 1
    this.current().requests += 1
    this.currentHour().requests += 1
    this.revision += 1
  }

  noteError(error: unknown): void {
    this.errors += 1
    this.lastError = error instanceof Error ? error.message : String(error)
    this.current().errors += 1
    this.currentHour().errors += 1
    this.revision += 1
  }

  /**
   * 一次请求顺利走完。**只清 lastError，不动 errors 计数。**
   *
   * 不清的话那句「最近一次失败：…」会一直挂在服务卡片上，即使后面几千个请求全都成功 ——
   * 用户看到红字会以为服务还是坏的。而「最近一次失败」本来就该是最近一次，不是历史上任意一次。
   *
   * 累计的 errors 保留：它是「一共失败过多少次」，清掉等于篡改统计。
   */
  noteSuccess(): void {
    if (this.lastError) this.lastError = ''
  }

  private current(): TrendPoint {
    this.buckets = advance(this.buckets, trendBuckets, this.bucketMs, this.now(), blankMinute)
    return this.buckets[this.buckets.length - 1]!
  }

  private currentHour(): HourlyPoint {
    this.hourly = advance(this.hourly, hourBuckets, hourMs, this.now(), blankHour)
    return this.hourly[this.hourly.length - 1]!
  }

  /** 近一天：末尾 dayBuckets 个小时格的和。 */
  recent(): Totals {
    this.currentHour()
    const window = this.hourly.slice(-dayBuckets)
    return window.reduce<Totals>(
      (sum, point) => ({
        requests: sum.requests + point.requests,
        errors: sum.errors + point.errors,
        bytesUp: sum.bytesUp + point.bytesUp,
        bytesDown: sum.bytesDown + point.bytesDown,
      }),
      { requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 },
    )
  }

  /** 最近 trendBuckets 根柱子；即使一条请求都没有，时间轴也推到当前时刻。 */
  trend(): TrendPoint[] {
    this.current()
    return this.buckets.map((point) => ({ ...point }))
  }

  snapshot(): StatsSnapshot {
    return {
      requests: this.requests,
      errors: this.errors,
      lastError: this.lastError,
      bytesUp: this.up,
      bytesDown: this.down,
      recent: this.recent(),
      trend: this.trend(),
    }
  }

  /** 落盘用：先把小时格推到当前，写出去的才是最新的一份。 */
  toSaved(): SavedStats {
    this.currentHour()
    return {
      since: this.since,
      requests: this.requests,
      errors: this.errors,
      bytesUp: this.up,
      bytesDown: this.down,
      hours: this.hourly.map((point) => ({ ...point })),
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
