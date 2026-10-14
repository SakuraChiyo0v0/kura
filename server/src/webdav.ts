import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { handleDavRequest, type DavLimits } from '../../src/core/dav-server.js'
import { normalizeRules, type DavScope } from '../../src/core/dav-scope.js'
import { silentLogger, type Logger } from '../../src/core/log.js'
import { ServiceStats } from '../../src/core/stats.js'
import { hashFile } from './hash.js'

/**
 * 服务端 WebDAV：容器内跑 rclone，前面套一层**和客户端本机 WebDAV 完全相同的范围层**
 * （`handleDavRequest` + `dav-scope`）。
 *
 * 为什么不用 rclone 自己的 filters：现网那套是「勾选页写 filters.txt → 宿主 systemd 发现变了 → 重启
 * nas-webdav」，改一次暴露范围要重启容器，还额外多养一个 files-admin 容器和一个宿主单元。
 * 这里范围在内存里，改完下一个请求就生效。
 *
 * rclone 只监听容器内的回环（`127.0.0.1:<port>`），外面摸不到；对外的入口是 kura-server 的网关。
 * 所以容器要挂整个宿主根 `/:/host`，并且要用 tmpfs 把 `/host/proc`、`/host/sys`、`/host/dev` 掩掉
 * —— rclone 带 `-L` 跟随符号链接，会沿 `/proc/self/root/...` 无限递归（现网踩过）。
 */

/** rclone 固定版本；镜像里带、启动时校验 SHA256（和客户端模块同一套做法）。 */
export const rcloneRelease = {
  version: 'v1.75.2',
  url: 'https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-linux-amd64.zip',
  sha256: '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702',
}

/** 默认暴露范围：只放行 /volume1 与 /home，挡掉系统目录。改在管理页 / state/webdav.json。 */
export const defaultWebdavLimits: DavLimits = {
  include: ['/volume1', '/home'],
  exclude: ['/volume1/@*', '/volume1/.fscrypt', '/volume1/lost+found'],
  readOnly: false,
}

export interface WebdavSettings extends DavLimits {
  /** 容器内 rclone 监听的回环端口 */
  port: number
  /** 挂载的宿主根（容器里看到的位置） */
  root: string
}

export const webdavDefaults: WebdavSettings = {
  ...defaultWebdavLimits,
  port: 18005,
  root: '/host',
}

/** 命令行参数：只监听回环、跟随符号链接、允许写。 */
export function serveArgs(settings: WebdavSettings): string[] {
  return ['serve', 'webdav', settings.root, '--addr', `127.0.0.1:${settings.port}`, '-L', '--read-only=false']
}

export interface WebdavStatus {
  running: boolean
  /** 最近一次拉起的失败原因，'' = 没出错 */
  error: string
  /** rclone 到现在跑了多久（毫秒）；没在跑是 0 */
  uptimeMs: number
  restarts: number
  /** 最近一次探测 rclone 的失败原因，'' = 通 */
  upstreamError: string
}

export interface WebdavOptions {
  settings: WebdavSettings
  /** 拉起 rclone 的命令行；默认 `rclone serve webdav …`。测试注入假实现。 */
  command?: { bin: string; args: string[] }
  /** 状态文件；给了就持久化范围设置（改了即时生效） */
  settingsFile?: string
  startDelayMs?: number
  log?: Logger
}

export class WebdavFeature {
  private current: WebdavSettings
  private child?: ChildProcess
  private startedAt = 0
  private restarts = 0
  private lastError = ''
  private stopped = false
  private retryTimer?: NodeJS.Timeout
  private lastProbeError = ''
  private readonly log: Logger
  private readonly stats = new ServiceStats()

  constructor(private readonly options: WebdavOptions) {
    this.log = options.log ?? silentLogger
    this.current = options.settings
    if (options.settingsFile) {
      const saved = readJson(options.settingsFile)
      if (saved) this.current = mergeSettings(options.settings, saved)
    }
  }

  /** 拉起 rclone；已经在跑就什么都不做。 */
  start(): void {
    this.stopped = false
    if (this.child) return
    const command = this.options.command ?? { bin: 'rclone', args: serveArgs(this.current) }
    const child = spawn(command.bin, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.startedAt = Date.now()
    child.on('error', (error) => {
      this.lastError = `rclone 起不来：${error.message}`
      this.log.warn('rclone 启动失败', { err: error.message })
      if (this.child === child) this.onExit()
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.log.info('rclone 退出', { code, signal })
      this.onExit()
    })
    const tail = (chunk: Buffer): void => {
      const text = chunk.toString('utf8').trim()
      if (text) this.log.info('rclone', { 输出: text.slice(-400) })
    }
    child.stdout?.on('data', tail)
    child.stderr?.on('data', tail)
    this.lastError = ''
    this.log.info('rclone 已拉起', { 端口: this.current.port, 根: this.current.root })
  }

  private onExit(): void {
    this.child = undefined
    this.startedAt = 0
    if (!this.stopped) this.scheduleRetry()
  }

  /** 挂了自动拉起，但别打转：退避到 startDelayMs（默认 3 秒）。 */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.restarts += 1
      this.start()
    }, this.options.startDelayMs ?? 3_000)
    this.retryTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const child = this.child
    this.child = undefined
    if (child && child.pid) {
      child.kill('SIGTERM')
      // 1 秒还不走就强杀，退出时别把容器拖住
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref?.()
    }
  }

  status(): WebdavStatus {
    return {
      running: Boolean(this.child),
      error: this.lastError,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      restarts: this.restarts,
      upstreamError: this.lastProbeError,
    }
  }

  limits(): DavLimits {
    return { include: [...this.current.include], exclude: [...this.current.exclude], readOnly: this.current.readOnly }
  }

  settings(): WebdavSettings {
    return { ...this.current, include: [...this.current.include], exclude: [...this.current.exclude] }
  }

  /** 改范围：不用重启 rclone —— 范围层在内存里，下一个请求就按新的算。 */
  setLimits(limits: DavLimits): void {
    this.current = { ...this.current, ...limits }
    if (this.options.settingsFile) {
      try {
        writeFileSync(this.options.settingsFile, JSON.stringify(this.settings(), null, 2) + '\n')
      } catch (error) {
        this.log.warn('保存 WebDAV 范围失败', { err: (error as Error).message })
      }
    }
  }

  /** 上游 rclone 现在通不通（拿不到就给范围层一个会抛错的 upstream，让它回 503）。 */
  private async upstream(): Promise<string> {
    if (!(await this.ping())) throw new Error(this.lastProbeError || 'rclone 没有在跑')
    return `http://127.0.0.1:${this.current.port}`
  }

  /** OPTIONS 探一下 rclone：它起来了才有响应。 */
  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean, error?: string): void => {
        if (settled) return
        settled = true
        this.lastProbeError = ok ? '' : (error ?? '')
        resolve(ok)
      }
      const req = http.request({ host: '127.0.0.1', port: this.current.port, method: 'OPTIONS', path: '/', timeout: 2_000 }, (res) => {
        res.resume()
        done(true)
      })
      req.on('timeout', () => req.destroy(new Error('rclone 探测超时')))
      req.on('error', (error) => done(false, error.message))
      req.end()
    })
  }

  /** 网关转进来的 WebDAV 请求（认证已由 kura-server 做完，不经本机回环）。 */
  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    void handleDavRequest(req, res, {
      limits: () => this.limits(),
      upstream: () => this.upstream(),
      log: this.log,
      checkHost: false,
      stats: this.stats,
      onUpstreamResult: (error) => {
        this.lastProbeError = error
      },
    })
  }
}

function readJson(file: string): Partial<WebdavSettings> | undefined {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<WebdavSettings>
  } catch {
    return undefined
  }
}

/**
 * 读盘时收一遍规则：`state/webdav.json` 是**可以手改**的（设计上就写着「改在管理页 / state/webdav.json」），
 * 所以这里当外部输入对待。空规则会被 `normalizeRules` 拒绝 —— 一条空白 include 等于放行整个文件系统。
 * 整份读不回来（JSON 坏了、规则非法、include 空了）就退回代码里的默认范围，绝不放一个空范围进去。
 */
function readScope(base: WebdavSettings, saved: Partial<WebdavSettings>): DavScope {
  try {
    const include = Array.isArray(saved.include) ? normalizeRules(saved.include.map(String)) : base.include
    const exclude = Array.isArray(saved.exclude) ? normalizeRules(saved.exclude.map(String)) : base.exclude
    if (include.length === 0) throw new Error('include 不能为空')
    return { include, exclude }
  } catch {
    return { include: [...base.include], exclude: [...base.exclude] }
  }
}

function mergeSettings(base: WebdavSettings, saved: Partial<WebdavSettings>): WebdavSettings {
  return {
    ...base,
    ...readScope(base, saved),
    readOnly: typeof saved.readOnly === 'boolean' ? saved.readOnly : base.readOnly,
    port: typeof saved.port === 'number' && saved.port > 0 ? saved.port : base.port,
  }
}

/** 校验 rclone 二进制：存在，且 SHA256 与固定版本一致（镜像里带的那份）。 */
export async function verifyRclone(binary: string, expected = rcloneRelease.sha256): Promise<void> {
  if (!existsSync(binary)) throw new Error(`找不到 rclone：${binary}`)
  const actual = await hashFile(binary)
  if (actual !== expected) {
    throw new Error(`rclone 校验不通过（SHA256 ${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…），拒绝启动`)
  }
}
