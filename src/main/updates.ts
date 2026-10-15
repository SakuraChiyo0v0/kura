import type { UpdateBackend, UpdateManager } from '@sakura-ui/electron/main'
import type { UpdateStatus } from '@sakura-ui/electron/shared'
import type { Logger } from '../core/log.js'

/** 启动后多久第一次检查：避开启动时最忙的那一阵（登录、拉清单、挂服务） */
export const firstCheckDelayMs = 60_000
export const checkIntervalMs = 6 * 60 * 60_000

export interface UpdateSchedulerOptions {
  manager: Pick<UpdateManager, 'getStatus' | 'check' | 'download' | 'onChange'>
  /** 当前「自动检查更新」开关 */
  enabled: () => boolean
  log: Pick<Logger, 'info' | 'warn'>
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

/**
 * 自动更新的节奏：启动一分钟后查一次，之后每 6 小时查一次；查到新版本就接着在后台下载。
 *
 * 手动点「检查更新」走的也是同一个 manager：开着开关时查到了同样自动下载（manager 自己防重复）；
 * 关掉开关后定时器不再排、查到了也只提示，下载由用户点。
 */
export class UpdateScheduler {
  private timer: unknown
  private stopped = false
  private readonly timers: NonNullable<UpdateSchedulerOptions['timers']>
  private readonly offChange: () => void

  constructor(private readonly options: UpdateSchedulerOptions) {
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref()
        return handle
      },
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    }
    let last: UpdateStatus['state'] | undefined
    this.offChange = options.manager.onChange((status) => {
      if (status.state === last && status.state !== 'error') return
      last = status.state
      if (status.state === 'available') {
        // 关了自动检查：只提示，下不下由用户在设置页点
        if (!options.enabled()) return
        options.log.info('发现新版本，开始后台下载', { version: status.version })
        void options.manager.download()
      } else if (status.state === 'downloaded') {
        options.log.info('新版本已下载，退出时安装', { version: status.version })
      }
      // 失败原因由 friendlyBackend 写日志（原文），这里不重复
    })
  }

  start(): void {
    this.schedule(firstCheckDelayMs)
  }

  /** 开关变了：打开时重新排一次（按首检延迟），关掉时取消已排的 */
  setEnabled(enabled: boolean): void {
    this.cancel()
    if (enabled) this.schedule(firstCheckDelayMs)
  }

  stop(): void {
    this.stopped = true
    this.cancel()
    this.offChange()
  }

  private schedule(delay: number): void {
    if (this.stopped || !this.options.enabled()) return
    this.cancel()
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delay)
  }

  private async tick(): Promise<void> {
    const state = this.options.manager.getStatus().state
    // 已经在下载 / 下好了：没必要再问一遍，等用户重启或退出
    if (state !== 'downloading' && state !== 'downloaded') await this.options.manager.check()
    this.schedule(checkIntervalMs)
  }

  private cancel(): void {
    if (this.timer === undefined) return
    this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** 仓库里还没有任何正式 Release：对用户来说就是「没有更新」，不是失败 */
const noReleaseCodes = new Set(['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'])

/**
 * electron-updater 的报错是英文长串（常带整段堆栈），直接显示在设置页上既看不懂又挤。
 * 这里换成一句中文；原文由调用方写进日志。
 */
export function friendlyUpdateError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if ((typeof code === 'string' && noReleaseCodes.has(code)) || /No published versions/.test(message)) return '更新源上还没有可用的版本'
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/.test(message)) return '连不上更新服务器，检查一下网络'
  if (/ETIMEDOUT|ERR_TIMED_OUT|ESOCKETTIMEDOUT|timeout/i.test(message)) return '连接更新服务器超时'
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNRESET/.test(message)) return '更新服务器拒绝了连接'
  if (/\b403\b|rate limit/i.test(message)) return 'GitHub 暂时限制了访问，稍后再试'
  if (/sha512|checksum/i.test(message)) return '下载的安装包校验没通过，已丢弃'
  return '检查或下载更新时出错，详情见日志'
}

/**
 * 「还没有任何 Release」当成已是最新；其余错误换成中文后再抛。
 * 仓库一个 Release 都没有时，这句是 Atom feed 里找不到 entry、由 XML 解析层抛的 —— 不带 code，只能认文字（实测）
 */
export function isNoReleaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && noReleaseCodes.has(code)) return true
  return /No published versions on GitHub/.test(error instanceof Error ? error.message : String(error))
}

/**
 * 包一层更新后端：让「还没发过版」显示成「已是最新版本」，其它错误显示成一句中文。
 * 原始错误写日志，便于排查。
 */
export function friendlyBackend(backend: UpdateBackend, log: Pick<Logger, 'warn'>): UpdateBackend {
  return {
    async check() {
      try {
        return await backend.check()
      } catch (error) {
        if (isNoReleaseError(error)) return null
        log.warn('检查更新失败', { err: (error as Error).message?.split('\n')[0] ?? String(error) })
        throw new Error(friendlyUpdateError(error))
      }
    },
    async download(onProgress) {
      try {
        await backend.download(onProgress)
      } catch (error) {
        log.warn('下载更新失败', { err: (error as Error).message?.split('\n')[0] ?? String(error) })
        throw new Error(friendlyUpdateError(error))
      }
    },
    install: () => backend.install(),
  }
}

/**
 * 什么情况下接真实更新源。
 * - 冒烟：不接（不能让测试去问 GitHub）
 * - 开发模式（没打包）：默认不接；设了 KURA_UPDATE_URL 就接这个地址，用来在本机演练整条流程
 */
export function updateSource(input: { packaged: boolean; smoke: boolean; env: Record<string, string | undefined> }):
  | { kind: 'off' }
  | { kind: 'github' }
  | { kind: 'generic'; url: string } {
  if (input.smoke) return { kind: 'off' }
  const override = input.env.KURA_UPDATE_URL?.trim()
  if (override) {
    // 只认 http(s)：这个地址是更新包的来源，别让别的协议混进来
    if (!/^https?:\/\//i.test(override)) return { kind: 'off' }
    return { kind: 'generic', url: override }
  }
  return input.packaged ? { kind: 'github' } : { kind: 'off' }
}
