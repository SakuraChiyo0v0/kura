import { describe, expect, it } from 'vitest'
import { ServiceStats, dayBuckets, hourBuckets, hourMs, trendBuckets } from './stats.js'

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

describe('ServiceStats 的 lastError', () => {
  it('成功一次就清掉「最近一次失败」—— 链路恢复了不该还挂着旧错误', () => {
    const stats = new ServiceStats()
    stats.noteError(new Error('getaddrinfo ENOTFOUND app-8898-x.cn30.ugdocker.link'))
    expect(stats.lastError).toContain('ENOTFOUND')
    stats.noteSuccess()
    expect(stats.lastError).toBe('')
  })

  it('清 lastError 但不动 errors 计数 —— 一共失败过几次是统计，不能篡改', () => {
    const stats = new ServiceStats()
    stats.noteError(new Error('a'))
    stats.noteError(new Error('b'))
    stats.noteSuccess()
    expect(stats.lastError).toBe('')
    expect(stats.errors).toBe(2)
    expect(stats.snapshot().errors).toBe(2)
  })

  it('本来就没错误时 noteSuccess 不做任何事', () => {
    const stats = new ServiceStats()
    stats.noteSuccess()
    expect(stats.lastError).toBe('')
    expect(stats.snapshot().lastError).toBe('')
  })
})

describe('ServiceStats 的小时格与「近一天」', () => {
  it('请求 / 失败 / 字节都记进当前小时格', () => {
    const stats = new ServiceStats({ now: () => 0 })
    stats.noteRequest()
    stats.noteError(new Error('x'))
    stats.bytesUp = 100
    stats.bytesDown = 250
    expect(stats.recent()).toEqual({ requests: 1, errors: 1, bytesUp: 100, bytesDown: 250 })
  })

  it('「近一天」只算最近 24 格：一天前那格滚出去，累计仍然保留', () => {
    let clock = 0
    const stats = new ServiceStats({ now: () => clock })
    stats.bytesDown = 500 // 第 0 小时
    clock = dayBuckets * hourMs // 整整一天之后
    stats.bytesDown = 900 // 第 24 小时，这时只有增量的 400 记进新格子
    expect(stats.recent().bytesDown).toBe(400) // 第 0 小时那 500 已经出了窗口
    expect(stats.bytesDown).toBe(900)
  })

  it('小时格跨了两天以上才重来，累计数不受影响', () => {
    let clock = 0
    const stats = new ServiceStats({ now: () => clock })
    stats.bytesDown = 777
    clock = (hourBuckets + 5) * hourMs
    expect(stats.recent()).toEqual({ requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 })
    expect(stats.bytesDown).toBe(777)
  })

  it('字节设成同一个值不重复记账（setter 按增量算）', () => {
    const stats = new ServiceStats({ now: () => 0 })
    stats.bytesDown = 100
    stats.bytesDown = 100
    stats.bytesDown = 150
    expect(stats.bytesDown).toBe(150)
    expect(stats.recent().bytesDown).toBe(150)
  })
})

describe('ServiceStats 落盘与读回', () => {
  it('读回上次保存的累计数与小时格：重启不归零，近一天还能接上', () => {
    let clock = 1_000 * hourMs // 第 1000 小时附近
    const first = new ServiceStats({ now: () => clock })
    first.noteRequest()
    first.noteError(new Error('boom'))
    first.bytesUp = 10
    first.bytesDown = 2048
    const saved = first.toSaved()

    // 同一小时内重启：数字原样接着算
    const restarted = new ServiceStats({ now: () => clock, saved })
    expect(restarted.requests).toBe(1)
    expect(restarted.errors).toBe(1)
    expect(restarted.bytesUp).toBe(10)
    expect(restarted.bytesDown).toBe(2048)
    expect(restarted.recent()).toEqual({ requests: 1, errors: 1, bytesUp: 10, bytesDown: 2048 })

    restarted.noteRequest()
    expect(restarted.requests).toBe(2)
    expect(restarted.recent().requests).toBe(2) // 同一格累加，不是另起一格
  })

  it('保存的 since 留着，用来知道「从什么时候开始统计」', () => {
    const saved = new ServiceStats({ now: () => 12_345 }).toSaved()
    expect(saved.since).toBe(12_345)
    expect(new ServiceStats({ now: () => 0, saved }).toSaved().since).toBe(12_345)
  })

  it('手改坏的文件当 0：负数 / 非数字 / 缺字段都别把统计搞成 NaN', () => {
    const stats = new ServiceStats({
      now: () => 0,
      saved: { requests: -5, errors: Number.NaN, bytesUp: 'x', bytesDown: 100, hours: 'nope' } as never,
    })
    expect(stats.requests).toBe(0)
    expect(stats.errors).toBe(0)
    expect(stats.bytesUp).toBe(0)
    expect(stats.bytesDown).toBe(100)
    expect(stats.recent()).toEqual({ requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 })
  })

  it('同一小时格写了两遍（手改过）只算一次', () => {
    const at = 5 * hourMs
    const point = { at, requests: 3, errors: 0, bytesUp: 1, bytesDown: 2 }
    const stats = new ServiceStats({ now: () => at, saved: { requests: 0, errors: 0, bytesUp: 0, bytesDown: 0, hours: [point, point] } })
    expect(stats.recent().requests).toBe(3)
  })

  it('toSaved 只给动过的格子；markSaved 之后这一批清空', () => {
    // 落盘按这批格子写库，所以契约必须是「动过的」而不是「全部」：
    // 给全部的话每个小时都会把 48 行原样重写一遍。
    const stats = new ServiceStats({ now: () => 0 })
    stats.noteRequest()
    expect(stats.toSaved().hours.map((h) => h.at)).toEqual([0])
    stats.markSaved()
    expect(stats.toSaved().hours).toEqual([]) // 没有新变化，没什么可写的
    stats.bytesDown = 10
    expect(stats.toSaved().hours.map((h) => h.at)).toEqual([0])
  })

  it('revision 只在会落盘的字段变化时才加 —— lastError 不落盘', () => {
    const stats = new ServiceStats({ now: () => 0 })
    const base = stats.revision
    stats.noteSuccess() // 本来就是空的，什么都不做
    expect(stats.revision).toBe(base)
    stats.noteRequest()
    expect(stats.revision).toBe(base + 1)
    stats.bytesDown = 1
    expect(stats.revision).toBe(base + 2)
  })
})
