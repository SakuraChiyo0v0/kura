import http from 'node:http'
import { errorMessage } from './errors.js'
import { silentLogger, type Logger } from './log.js'

/**
 * 主动探测（watchdog）。
 *
 * 按流量统计的状态有盲区：一个服务彻底死掉时恰恰没有任何请求，状态反而全绿（2026-10-13 索引器
 * 静默停了 1 小时也没人发现）。探测走**本机监听地址**，即完整链路：本机 → Kura → 会话 → 网关 → NAS。
 *
 * 判定口径：HTTP < 500 都算活着（302/401/404 说明服务在应答）；5xx、超时、连接失败才算不可用
 * —— 网关 auth_request 挂掉时正是 500。
 */
export const probeWarnAfter = 3
export const probeErrorAfter = 10
export const probeTimeoutMs = 8_000

export interface ProbeResult {
  ok: boolean
  checkedAt: number
  lastOk: number
  failStreak: number
  error: string
  /** 这一轮连续失败的起点，恢复时用它报中断时长 */
  firstFailureAt: number
}

export interface ProbeTarget {
  key: string
  /** 本机监听地址 host:port */
  address: string
}

/** 发一次 GET /，不跟随重定向，返回状态码。 */
export function probeHttp(address: string, timeoutMs = probeTimeoutMs): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${address}/`, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`探测超时（${timeoutMs}ms）`)))
    req.on('error', reject)
  })
}

export class Watchdog {
  private readonly states = new Map<string, ProbeResult>()
  private readonly log: Logger
  private readonly now: () => number
  private readonly fetchStatus: (address: string) => Promise<number>

  constructor(options: { log?: Logger; now?: () => number; fetchStatus?: (address: string) => Promise<number> } = {}) {
    this.log = options.log ?? silentLogger
    this.now = options.now ?? Date.now
    this.fetchStatus = options.fetchStatus ?? probeHttp
  }

  async probe(target: ProbeTarget): Promise<ProbeResult> {
    let error: unknown
    try {
      const status = await this.fetchStatus(target.address)
      if (status >= 500) error = new Error(`上游返回 HTTP ${status}`)
    } catch (caught) {
      error = caught ?? new Error('探测失败')
    }
    return this.record(target, error)
  }

  private record(target: ProbeTarget, error: unknown): ProbeResult {
    const now = this.now()
    const prev = this.states.get(target.key)
    const cur: ProbeResult = {
      ok: error === undefined,
      checkedAt: now,
      lastOk: error === undefined ? now : (prev?.lastOk ?? 0),
      failStreak: error === undefined ? 0 : (prev?.failStreak ?? 0) + 1,
      error: error === undefined ? '' : errorMessage(error),
      firstFailureAt: error === undefined ? 0 : prev && prev.failStreak > 0 ? prev.firstFailureAt : now,
    }
    this.states.set(target.key, cur)

    const fields = { service: target.key, 本机: target.address }
    if (cur.ok && prev && prev.failStreak > 0) {
      this.log.info('服务探测恢复', {
        ...fields,
        中断秒: Math.round((now - prev.firstFailureAt) / 1000),
        失败次数: prev.failStreak,
      })
    } else if (cur.failStreak === probeWarnAfter) {
      this.log.warn('服务探测连续失败（可能只是抖动，先观察）', { ...fields, 次数: cur.failStreak, err: cur.error })
    } else if (cur.failStreak === probeErrorAfter) {
      this.log.error('服务持续不可用', { ...fields, 次数: cur.failStreak, err: cur.error })
    }
    return cur
  }

  get(key: string): ProbeResult | undefined {
    return this.states.get(key)
  }

  /** 服务被移除或关掉时清掉它的探测记录，免得界面显示过期结果。 */
  forget(key: string): void {
    this.states.delete(key)
  }

  /**
   * 周期探测，返回停止函数；intervalMs <= 0 表示关闭。
   * 首轮等满一个周期：启动瞬间各服务还在登录 / 建立监听，立刻探测只会制造假告警。
   */
  start(intervalMs: number, targets: () => ProbeTarget[]): () => void {
    if (intervalMs <= 0) return () => {}
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void Promise.all(targets().map((target) => this.probe(target))).finally(() => {
        running = false
      })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
