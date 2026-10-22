import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CacheDoctorService, scanOnMountDelayMs } from './cache-doctor-service.js'
import type { DavClient } from '../core/dav-client.js'
import type { CacheDoctorStateView } from '../shared/ipc.js'

/**
 * 这一层不用真文件：核心判定已经在 cache-doctor.test.ts 里测过了。
 * 这里只测「什么时候扫、串行、状态怎么流转」这些服务层的逻辑。
 */
describe('缓存体检服务', () => {
  let dir: string
  let cacheDir: string
  let mounted: boolean
  let states: CacheDoctorStateView[]

  const fakeDav = (): DavClient =>
    ({
      async stat() {
        return undefined
      },
      async readRange() {
        return Buffer.alloc(0)
      },
    }) as unknown as DavClient

  const make = (): CacheDoctorService =>
    new CacheDoctorService({
      cacheDir: () => cacheDir,
      dav: fakeDav,
      dataDir: dir,
      mounted: () => mounted,
      onState: (s) => states.push(s),
      onProgress: () => {},
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kura-cd-svc-'))
    cacheDir = join(dir, 'rclone-cache')
    // 空的缓存目录：扫描会立刻完成，结果全是 0
    mkdirSync(join(cacheDir, 'vfs', '：webdav{t}', 'volume1'), { recursive: true })
    mkdirSync(join(cacheDir, 'vfsMeta', '：webdav{t}', 'volume1'), { recursive: true })
    mounted = false
    states = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('默认设置：挂载后自动扫、每 6 小时一次', () => {
    const service = make()
    expect(service.settingsView()).toEqual({ scanOnMount: true, intervalHours: 6 })
  })

  it('设置能存盘并在下次启动时读回来', () => {
    const first = make()
    first.save({ scanOnMount: false, intervalHours: 12 })
    const second = make()
    expect(second.settingsView()).toEqual({ scanOnMount: false, intervalHours: 12 })
    expect(JSON.parse(readFileSync(join(dir, 'cache-doctor.json'), 'utf8'))).toMatchObject({ intervalHours: 12 })
  })

  it('非法间隔收回来：负数与非数字都当 0（否则会变成死循环扫描）', () => {
    const service = make()
    expect(service.save({ scanOnMount: true, intervalHours: -5 }).intervalHours).toBe(0)
    expect(service.save({ scanOnMount: true, intervalHours: Number.NaN }).intervalHours).toBe(0)
    // 上限一周
    expect(service.save({ scanOnMount: true, intervalHours: 99999 }).intervalHours).toBe(168)
  })

  it('扫描是串行的：正在跑时再调一次直接返回，不会并发两个任务', async () => {
    const service = make()
    const first = service.scan()
    const second = await service.scan() // 立刻返回，不排队
    expect(second.busy).toBe('scan')
    await first
    expect(service.state().busy).toBe('')
  })

  it('没扫过时 repair 什么都不做（不能拿空结果去修）', async () => {
    const service = make()
    const state = await service.repair()
    expect(state.lastRepair).toBeNull()
    expect(state.last.scannedAt).toBe(0)
  })

  it('挂载后延迟扫描：立即调用不扫，等到延迟时间才扫', async () => {
    vi.useFakeTimers()
    const service = make()
    mounted = true
    service.onMounted()

    // 立刻：还没扫
    expect(service.state().last.scannedAt).toBe(0)
    // 差一点：仍然没扫
    await vi.advanceTimersByTimeAsync(scanOnMountDelayMs - 1000)
    expect(service.state().last.scannedAt).toBe(0)
    // 过了延迟：扫了
    await vi.advanceTimersByTimeAsync(2000)
    expect(service.state().last.scannedAt).toBeGreaterThan(0)
  })

  it('挂载后 5 分钟还没挂上就不扫了（省得对着卸掉的盘发请求）', async () => {
    vi.useFakeTimers()
    const service = make()
    mounted = true
    service.onMounted()
    mounted = false // 用户在这 5 分钟里卸掉了
    await vi.advanceTimersByTimeAsync(scanOnMountDelayMs + 1000)
    expect(service.state().last.scannedAt).toBe(0)
  })

  it('关掉「挂载后自动扫」就真的不扫', async () => {
    vi.useFakeTimers()
    const service = make()
    service.save({ scanOnMount: false, intervalHours: 6 })
    mounted = true
    service.onMounted()
    await vi.advanceTimersByTimeAsync(scanOnMountDelayMs + 1000)
    expect(service.state().last.scannedAt).toBe(0)
  })

  it('卸载时清掉定时器，之后不会再扫', async () => {
    vi.useFakeTimers()
    const service = make()
    service.save({ scanOnMount: true, intervalHours: 1 })
    mounted = true
    service.onMounted()
    service.onUnmounted()
    await vi.advanceTimersByTimeAsync(scanOnMountDelayMs + 10 * 3600_000)
    expect(service.state().last.scannedAt).toBe(0)
  })
})
