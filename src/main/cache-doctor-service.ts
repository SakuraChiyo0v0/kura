/**
 * 挂载缓存体检的服务层：管设置、跑扫描 / 修复、把结果推给界面。
 *
 * 核心判定在 `cache-doctor.ts`（纯函数，好单测）；这里只管生命周期：
 * 什么时候扫、串行化、进度怎么推、结果存哪。
 *
 * ## 为什么要串行
 *
 * 扫描和修复都要读大量远端文件。挂载刚起来时用户往往正在浏览，两个体检叠着跑
 * 会把中继和 NAS 的 WebDAV 都拖慢。所以同一时刻只允许一个任务在跑，后来的调
 * 直接拿到「正在进行中」的状态，而不是排队。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DavClient } from '../core/dav-client.js'
import {
  repairCache,
  scanCache,
  type CacheScanResult,
  type RepairResult,
} from './cache-doctor.js'
import type {
  CacheDoctorSettingsView,
  CacheDoctorStateView,
  CacheScanView,
} from '../shared/ipc.js'

/** 挂载后等多久再扫：给用户留出「刚挂上就打开文件」的时间窗，别跟他抢带宽。 */
export const scanOnMountDelayMs = 5 * 60 * 1000
export const cacheDoctorDefaults: CacheDoctorSettingsView = { scanOnMount: true, intervalHours: 6 }

export interface CacheDoctorDeps {
  /** rclone 的 --cache-dir */
  cacheDir: () => string
  /** 走本机 WebDAV（和挂载同一条路） */
  dav: () => DavClient
  dataDir: string
  log?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void }
  /** 是否已挂载：自动扫描只在挂载时跑 */
  mounted: () => boolean
  /** 推给界面 */
  onState: (state: CacheDoctorStateView) => void
  onProgress: (progress: { done: number; total: number; phase: string }) => void
  /** 测试注入：跳过等待 */
  now?: () => number
}

const emptyScan = (): CacheScanView => ({
  scannedAt: 0,
  total: 0,
  intact: 0,
  stale: [],
  orphans: [],
  skipped: 0,
  bytes: { total: 0, stale: 0, orphans: 0, needDownload: 0, fullRedownload: 0 },
})

export class CacheDoctorService {
  private settings: CacheDoctorSettingsView
  private readonly settingsFile: string
  private last: CacheScanView = emptyScan()
  /**
   * 上一次扫描的**完整**结果（含相对路径）。
   * 修复必须用它 —— View 里只有文件名，缓存文件在子目录里时会拼错路径。
   */
  private scanned: CacheScanResult | undefined
  private lastRepair: CacheDoctorStateView['lastRepair'] = null
  private busy: '' | 'scan' | 'repair' = ''
  private progressState = { done: 0, total: 0, phase: '' }
  private timer: NodeJS.Timeout | undefined
  private autoTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: CacheDoctorDeps) {
    this.settingsFile = join(deps.dataDir, 'cache-doctor.json')
    let stored: Partial<CacheDoctorSettingsView> = {}
    try {
      stored = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<CacheDoctorSettingsView>
    } catch {
      // 没配过就用默认
    }
    this.settings = {
      scanOnMount: stored.scanOnMount ?? cacheDoctorDefaults.scanOnMount,
      // 没配过（undefined）要用默认值，不能走 clampInterval ——
      // clampInterval 把 undefined 收成 0，会让「首次启动」等于「用户关掉了定时体检」。
      // 只有真的存过值才钳。
      intervalHours: stored.intervalHours === undefined ? cacheDoctorDefaults.intervalHours : clampInterval(stored.intervalHours),
    }
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  state(): CacheDoctorStateView {
    return {
      settings: this.settings,
      last: this.last,
      busy: this.busy,
      progress: this.progressState,
      lastRepair: this.lastRepair,
    }
  }

  settingsView(): CacheDoctorSettingsView {
    return { ...this.settings }
  }

  save(input: CacheDoctorSettingsView): CacheDoctorSettingsView {
    this.settings = { scanOnMount: Boolean(input.scanOnMount), intervalHours: clampInterval(input.intervalHours) }
    try {
      writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, '\t'))
    } catch (error) {
      this.deps.log?.warn('缓存体检设置写盘失败', { err: (error as Error).message })
    }
    this.armInterval()
    this.deps.onState(this.state())
    return this.settingsView()
  }

  /** 挂载成功后调用：按设置排一次延迟扫描；挂载期间还开着定时器。 */
  onMounted(): void {
    this.armInterval()
    if (!this.settings.scanOnMount) return
    this.clearAuto()
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined
      if (!this.deps.mounted()) return
      void this.scan().catch((error) => this.deps.log?.warn('自动体检失败', { err: (error as Error).message }))
    }, scanOnMountDelayMs)
  }

  /** 卸载时清掉定时器，别对着已经卸掉的挂载点发请求。 */
  onUnmounted(): void {
    this.clearAuto()
    this.clearIntervalTimer()
  }

  private clearAuto(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = undefined
  }

  private clearIntervalTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private armInterval(): void {
    this.clearIntervalTimer()
    const hours = this.settings.intervalHours
    if (!hours || hours <= 0) return
    this.timer = setInterval(() => {
      if (!this.deps.mounted()) return
      void this.scan().catch((error) => this.deps.log?.warn('定期体检失败', { err: (error as Error).message }))
    }, hours * 3600_000)
    // 别让这个定时器把进程钉住（Electron 里 setInterval 会阻止退出）
    this.timer.unref?.()
  }

  private setBusy(next: '' | 'scan' | 'repair'): void {
    this.busy = next
    if (next === '') this.progressState = { done: 0, total: 0, phase: '' }
    this.deps.onState(this.state())
  }

  private reportProgress(done: number, total: number, phase: string): void {
    this.progressState = { done, total, phase }
    this.deps.onProgress(this.progressState)
  }

  /** 扫描（只读）。正在跑别的任务时直接返回当前状态。 */
  async scan(): Promise<CacheDoctorStateView> {
    if (this.busy) return this.state()
    this.setBusy('scan')
    try {
      const result = await scanCache({
        cacheDir: this.deps.cacheDir(),
        dav: this.deps.dav(),
        onProgress: (done, total, phase) => this.reportProgress(done, total, phase),
      })
      this.scanned = result
      this.last = toView(result, () => this.now)
      this.deps.log?.info('缓存体检完成', {
        条目: result.total,
        一致: result.intact,
        过期: result.stale.length,
        孤儿: result.orphans.length,
      })
    } finally {
      this.setBusy('')
    }
    return this.state()
  }

  /** 修复上一次扫描发现的问题。必须先扫过。 */
  async repair(): Promise<CacheDoctorStateView> {
    if (this.busy) return this.state()
    if (!this.scanned) return this.state()
    this.setBusy('repair')
    try {
      // 用扫描时留下的**完整结果**（带 relative），不要从 View 反推 ——
      // View 里只有文件名，缓存文件在子目录里时拼出来的路径是错的。
      const result = this.scanned
      const fixed: RepairResult = await repairCache(result, {
        cacheDir: this.deps.cacheDir(),
        dav: this.deps.dav(),
        onProgress: (done, total, phase) => this.reportProgress(done, total, phase),
      })
      this.lastRepair = { ...fixed, failed: fixed.failed.length, at: this.now }
      // 先清掉 busy，否则下面的 scan() 会被「已有任务在跑」挡回去
      this.busy = ''
      return await this.scan()
    } finally {
      if (this.busy) this.setBusy('')
    }
  }
}

function clampInterval(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(168, Math.floor(n)) // 最多一周一次
}

function toView(result: CacheScanResult, now: () => number): CacheScanView {
  return {
    scannedAt: now(),
    total: result.total,
    intact: result.intact,
    stale: result.stale.map((s) => ({ name: s.name, size: s.size, kind: s.kind, reason: s.reason })),
    orphans: result.orphans.map((o) => ({ name: o.name, size: o.size })),
    skipped: result.skipped.length,
    bytes: result.bytes,
  }
}
