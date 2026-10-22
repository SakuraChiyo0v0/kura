import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceStats, hourMs } from './stats.js'
import { StatsStore } from './stats-store.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kura-stats-'))
  file = join(dir, 'stats.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** 直接开库读，绕开 StatsStore —— 断言的是真正落下去的数据，不是它自己算出来的。 */
function read<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(file)
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

describe('StatsStore', () => {
  it('flush 把总量与小时格写进库', () => {
    const store = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 0 })
    store.track('navidrome', stats)
    stats.noteRequest()
    stats.bytesDown = 1234
    store.flush()
    store.stop()

    expect(read('SELECT requests, bytes_down FROM service_total WHERE service = ?', 'navidrome')).toEqual([
      { requests: 1, bytes_down: 1234 },
    ])
    expect(read('SELECT requests, bytes_down FROM hourly WHERE service = ?', 'navidrome')).toEqual([
      { requests: 1, bytes_down: 1234 },
    ])
  })

  it('没有变化就什么都不写', () => {
    const store = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 0 })
    store.track('svc', stats)
    stats.bytesDown = 10
    store.flush()
    const before = read('SELECT updated_at FROM service_total WHERE service = ?', 'svc')
    store.flush() // 没变化
    expect(read('SELECT updated_at FROM service_total WHERE service = ?', 'svc')).toEqual(before)
    store.stop()
  })

  it('新实例读回上次的份，接着上次的数往上加', () => {
    const first = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 0 })
    first.track('svc', stats)
    stats.bytesDown = 500
    first.stop()

    const again = new StatsStore(file, { log: quiet })
    const fresh = new ServiceStats({ now: () => 0, saved: again.get('svc') })
    expect(fresh.bytesDown).toBe(500)
    expect(fresh.recent().bytesDown).toBe(500)
    again.stop()
  })

  it('读回的小时格按时间正序，advance() 才能接上', () => {
    const store = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 3 * hourMs })
    store.track('svc', stats)
    stats.noteRequest()
    store.stop()

    const again = new StatsStore(file, { log: quiet })
    const hours = again.get('svc')!.hours
    expect(hours.length).toBeGreaterThan(0)
    expect([...hours].sort((a, b) => a.at - b.at)).toEqual(hours)
    again.stop()
  })

  it('稳态下只写动过的那一格，不整份重写', () => {
    // 这一条盯的是「按小时格增量写」：整份重写会让库里出现一堆没变化的行，
    // 单测里看不出来，只有直接查库才知道。
    const store = new StatsStore(file, { log: quiet })
    const first = new ServiceStats({ now: () => 0 })
    store.track('svc', first)
    first.noteRequest()
    store.flush()
    const writtenFirst = read<{ hour: number }>('SELECT hour FROM hourly WHERE service = ?', 'svc').length
    expect(writtenFirst).toBe(1)

    // 下一个小时再动一下：应该只写新的一格，旧的那格不被重写
    const oldAt = read<{ hour: number }>('SELECT hour FROM hourly WHERE service = ?', 'svc')[0]!.hour
    const second = new ServiceStats({ now: () => hourMs })
    store.track('svc', second)
    second.noteRequest()
    store.flush()
    const rows = read<{ hour: number; requests: number }>('SELECT hour, requests FROM hourly WHERE service = ? ORDER BY hour', 'svc')
    expect(rows.map((r) => r.hour)).toEqual([oldAt, hourMs])
    store.stop()
  })

  it('清理明细不动累计数 —— 否则「一共多少」会自己往回缩', () => {
    const store = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 0 })
    store.track('svc', stats)
    stats.bytesDown = 4096
    store.flush()

    // 把这条明细改到很久以前，再按 60 天清理
    const ancient = Date.now() - 200 * 24 * 3_600_000
    const db = new DatabaseSync(file)
    db.prepare('UPDATE hourly SET hour = ? WHERE service = ?').run(ancient, 'svc')
    db.close()

    expect(store.prune(60)).toBe(1)
    expect(read('SELECT COUNT(*) AS n FROM hourly')).toEqual([{ n: 0 }])
    expect(read('SELECT bytes_down FROM service_total WHERE service = ?', 'svc')).toEqual([{ bytes_down: 4096 }])
    store.stop()
  })

  it('写库失败不清脏标记：下一次还会重写这一段', () => {
    const store = new StatsStore(file, { log: quiet })
    const stats = new ServiceStats({ now: () => 0 })
    store.track('svc', stats)
    stats.bytesDown = 42

    // 把 hourly 表改名，写小时格必然失败（总量那张表也会跟着整批回滚）
    const db = new DatabaseSync(file)
    db.exec('ALTER TABLE hourly RENAME TO hourly_gone')
    db.close()
    expect(() => store.flush()).not.toThrow()
    expect(read('SELECT COUNT(*) AS n FROM service_total')).toEqual([{ n: 0 }]) // 整批回滚了

    // 表修回来，再 flush：这一份变化还在，应该被写出去
    const fix = new DatabaseSync(file)
    fix.exec('ALTER TABLE hourly_gone RENAME TO hourly')
    fix.close()
    store.flush()
    expect(read('SELECT bytes_down FROM service_total WHERE service = ?', 'svc')).toEqual([{ bytes_down: 42 }])
    expect(read('SELECT bytes_down FROM hourly WHERE service = ?', 'svc')).toEqual([{ bytes_down: 42 }])
    store.stop()
  })

  it('库建得起来，是 SQLite 文件而不是 JSON', () => {
    const store = new StatsStore(file, { log: quiet })
    store.stop()
    expect(existsSync(file)).toBe(true)
    const db = new DatabaseSync(file)
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    db.close()
  })

  it('文件不是 SQLite 时构造直接抛错 —— 不静默降级成「每次都是 0」', () => {
    // 与 JSON 版不同，这里是刻意的：库坏了要立刻看见（映射层会记一条 WARN），
    // 而不是看起来一切正常、数字却永远从头开始。
    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'definitely not a database')
    expect(() => new StatsStore(junk, { log: quiet })).toThrow()
  })

  it('start 之后定时写库，stop 时再兜一次', () => {
    vi.useFakeTimers()
    try {
      const store = new StatsStore(file, { flushMs: 1_000, log: quiet })
      const stats = new ServiceStats({ now: () => 0 })
      store.track('svc', stats)
      store.start()
      stats.bytesDown = 7
      vi.advanceTimersByTime(1_000)
      expect(read('SELECT bytes_down FROM service_total WHERE service = ?', 'svc')).toEqual([{ bytes_down: 7 }])
      store.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
