import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceStats } from './stats.js'
import { StatsStore } from './stats-store.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kura-stats-'))
  file = join(dir, 'stats.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function read(): { version: number; services: Record<string, { bytesDown: number; requests: number }> } {
  return JSON.parse(readFileSync(file, 'utf8'))
}

describe('StatsStore', () => {
  it('flush 把有变化的份写出去，没变化的不反复写', () => {
    const store = new StatsStore(file)
    const stats = new ServiceStats({ now: () => 0 })
    store.track('navidrome', stats)
    stats.noteRequest()
    stats.bytesDown = 1234
    store.flush()
    expect(read().services.navidrome).toMatchObject({ requests: 1, bytesDown: 1234 })

    // 再 flush 一次：这次没有变化，不该碰文件
    const before = readFileSync(file, 'utf8')
    store.flush()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('新实例读回上次的份，接着上次的数往上加', () => {
    const first = new StatsStore(file)
    const stats = new ServiceStats({ now: () => 0 })
    first.track('svc', stats)
    stats.bytesDown = 500
    first.stop() // 停表时会兜一次

    const again = new StatsStore(file)
    const fresh = new ServiceStats({ now: () => 0, saved: again.get('svc') })
    expect(fresh.bytesDown).toBe(500)
  })

  it('写盘失败不改账：下次还能再写一次，不会把这一段永久丢掉', () => {
    const store = new StatsStore(file, { log: { debug() {}, info() {}, warn() {}, error() {} } })
    const stats = new ServiceStats({ now: () => 0 })
    store.track('svc', stats)
    stats.bytesDown = 42

    // 目标路径先占成一个目录：改名那一步必然失败
    mkdirSync(file)
    expect(() => store.flush()).not.toThrow()

    // 障碍去掉后再 flush：这一份变化还在，应该被写出去（先记 written 就会永远漏掉）
    rmSync(file, { recursive: true, force: true })
    store.flush()
    expect(read().services.svc).toMatchObject({ bytesDown: 42 })
  })

  it('文件坏了当空的：不影响新统计从 0 开始', () => {
    writeFileSync(file, '{ 不是 json')
    const store = new StatsStore(file)
    expect(store.get('svc')).toBeUndefined()
  })

  it('start 之后的定时写盘会落盘，stop 时再兜一次', () => {
    vi.useFakeTimers()
    try {
      const store = new StatsStore(file, { flushMs: 1_000 })
      const stats = new ServiceStats({ now: () => 0 })
      store.track('svc', stats)
      store.start()
      stats.bytesDown = 7
      vi.advanceTimersByTime(1_000)
      expect(read().services.svc).toMatchObject({ bytesDown: 7 })
      store.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
