import { describe, expect, it } from 'vitest'
import { ServiceStats, trendBuckets } from './stats.js'

describe('ServiceStats 趋势', () => {
  it('柱子按时间对齐：空闲期间补零，而不是被压缩', () => {
    let clock = 10 * 60_000
    const stats = new ServiceStats({ now: () => clock })
    stats.noteRequest()
    clock += 3 * 60_000 // 空闲 3 分钟
    stats.noteRequest()
    stats.noteError(new Error('boom'))
    const trend = stats.trend()
    expect(trend).toHaveLength(trendBuckets)
    expect(trend.slice(-4).map((p) => p.requests)).toEqual([1, 0, 0, 1])
    expect(trend.at(-1)!.errors).toBe(1)
    expect(stats.lastError).toBe('boom')
  })

  it('一条请求都没有，时间轴也推到当前时刻', () => {
    let clock = 0
    const stats = new ServiceStats({ now: () => clock })
    stats.noteRequest()
    clock = 5 * 60_000
    expect(stats.trend().at(-1)!.at).toBe(5 * 60_000)
  })

  it('整圈过期只留当前一格', () => {
    let clock = 0
    const stats = new ServiceStats({ now: () => clock })
    stats.noteRequest()
    clock = (trendBuckets + 5) * 60_000
    expect(stats.trend().every((p) => p.requests === 0)).toBe(true)
    expect(stats.requests).toBe(1) // 累计不受窗口影响
  })
})
