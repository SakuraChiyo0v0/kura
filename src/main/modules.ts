import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../core/errors.js'
import { silentLogger, type Logger } from '../core/log.js'
import { readJson, writeJsonAtomic } from '../core/store.js'

/**
 * 按需安装的模块。首个：rclone 挂载为磁盘（rclone + WinFsp）。
 *
 * 决定（AGENTS.md）：进阶功能做成模块，不默认打包 —— rclone 一个 exe 就 60 MB，WinFsp 要驱动级安装。
 *
 * - **rclone**：Kura 自己下载到 %APPDATA%\Kura\modules\rclone\，**版本与 SHA256 写死在这里**，
 *   下载完先校验再解压，对不上直接删掉（官方 SHA256SUMS 2026-10-14 取的值）。也认系统 PATH 里已有的 rclone。
 * - **WinFsp**：是内核驱动，必须管理员权限、由用户自己装。Kura 只检测（注册表 / 安装目录），
 *   缺了就给官方下载页，不替用户静默装驱动。
 *
 * 挂载走的是**本机 WebDAV**（设置里那份带范围的 127.0.0.1 服务），所以挂出来的盘天然遵守暴露范围，
 * 链路切换、续期也都在映射层里 —— rclone 只连本机回环。
 */
export const rcloneRelease = {
  version: 'v1.75.2',
  url: 'https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-windows-amd64.zip',
  sha256: '8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818',
}

export const winfspDownloadPage = 'https://winfsp.dev/rel/'

export type ModuleState = 'missing' | 'installing' | 'ready' | 'error'

export interface RcloneModuleStatus {
  rclone: { state: ModuleState; path: string; version: string; source: 'kura' | 'system' | ''; progress: number; error: string }
  winfsp: { installed: boolean; path: string }
  mount: MountStatus
}

export interface MountSettings {
  /** 盘符，如 "N:" */
  drive: string
  /** 挂载时显示的卷名 */
  volumeName: string
  /** 只读挂载（另外，本机 WebDAV 设为只读时也写不进去） */
  readOnly: boolean
  /** Kura 启动时自动挂载 */
  autoMount: boolean
  /** VFS 缓存模式：writes 能让 Office 之类程序正常保存，off 最省磁盘 */
  cacheMode: 'off' | 'minimal' | 'writes' | 'full'
}

export const mountDefaults: MountSettings = {
  drive: 'N:',
  volumeName: 'Kura NAS',
  readOnly: false,
  autoMount: false,
  cacheMode: 'writes',
}

export interface MountStatus {
  state: 'stopped' | 'starting' | 'mounted' | 'error'
  drive: string
  error: string
  /** rclone 最近几行输出，排障用 */
  log: string[]
}

/** 盘符要么 "X:"，要么就别挂：rclone 也接受目录路径，但那是另一种用法，先不做。 */
export function validateDrive(drive: string): string {
  const d = drive.trim().toUpperCase().replace(/\\$/, '')
  if (!/^[D-Z]:$/.test(d)) throw new Error(`盘符不对：${drive}（用 D: 到 Z: 之间的一个）`)
  return d
}

/** rclone mount 的参数。remote 用连接串语法，免得写 rclone.conf。 */
export function mountArgs(settings: MountSettings, davUrl: string, cacheDir: string): string[] {
  const url = davUrl.replace(/\/+$/, '')
  return [
    'mount',
    // :webdav,url='...': 这种「连接串」形态不需要任何配置文件
    `:webdav,url='${url}',vendor=other:/`,
    validateDrive(settings.drive),
    '--volname',
    settings.volumeName || 'Kura NAS',
    '--vfs-cache-mode',
    settings.cacheMode,
    '--cache-dir',
    cacheDir,
    // 资源管理器会频繁列目录，目录缓存短一点：NAS 上别处改了文件能较快看到
    '--dir-cache-time',
    '30s',
    '--network-mode',
    '--no-console',
    ...(settings.readOnly ? ['--read-only'] : []),
    '--log-level',
    'NOTICE',
  ]
}

function findWinfsp(): string {
  for (const dir of [
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'WinFsp'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'WinFsp'),
  ]) {
    if (dir && existsSync(join(dir, 'bin', 'winfsp-x64.dll'))) return dir
  }
  return ''
}

/** PATH 里的 rclone.exe（用户自己装过的也认）。 */
function findSystemRclone(): string {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    const candidate = join(dir.replace(/"/g, ''), 'rclone.exe')
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function download(url: string, file: string, onProgress: (fraction: number) => void, redirects = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { timeout: 60_000 }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume()
        // 只跟随到 https —— 下载内容最后还要过 SHA256，这里只防降级
        const next = new URL(res.headers.location, url)
        if (next.protocol !== 'https:') return reject(new Error(`拒绝跳转到非 https 地址：${next.href}`))
        download(next.href, file, onProgress, redirects - 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`下载失败：HTTP ${status}`))
      }
      const total = Number(res.headers['content-length'] ?? 0)
      let done = 0
      const out = createWriteStream(file)
      res.on('data', (chunk: Buffer) => {
        done += chunk.length
        if (total) onProgress(done / total)
      })
      res.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolve())
      res.pipe(out)
    })
      .on('timeout', function (this: { destroy(e: Error): void }) {
        this.destroy(new Error('下载超时'))
      })
      .on('error', reject)
  })
}

async function sha256(file: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 用 Windows 自带的 tar（bsdtar，Win10 1803+）解 zip，不引入解压依赖。 */
function unzip(zip: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 必须用 System32 里那个：PATH 里可能先有 Git 的 GNU tar，它把 C:\... 当成「远程主机:路径」（实测：
    // Cannot execute remote shell），而且 GNU tar 解不了 zip
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const child = spawn(tar, ['-xf', zip, '-C', dir], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (c) => (err += c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）：${err.trim()}`))))
  })
}

function runVersion(exe: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(exe, ['version'], { windowsHide: true })
    } catch {
      // 文件坏了（不是可执行文件）时 spawn 同步抛 EFTYPE，而不是发 error 事件
      resolve('')
      return
    }
    let out = ''
    child.stdout?.on('data', (c) => (out += c))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(/rclone (v[\d.]+)/.exec(out)?.[1] ?? ''))
  })
}

/**
 * 盘符在不在。**必须异步**：盘挂好后，探测它会走 WinFsp → rclone → 本机 WebDAV，
 * 而本机 WebDAV 就在主进程里 —— 用 existsSync 会卡住事件循环，WebDAV 答不了，两边互相等死
 * （真机测试里实测卡了 10 分钟，最后 ECANCELED）。
 */
function driveExists(drive: string): Promise<boolean> {
  return access(`${drive}\\`).then(
    () => true,
    () => false,
  )
}

export interface ModuleManagerOptions {
  dir: string
  log?: Logger
  /** 本机 WebDAV 的地址（不在跑时抛出） */
  davUrl: () => string
  /** 测试注入：替代真的去下载与跑 rclone */
  spawnMount?: (exe: string, args: string[]) => ChildProcess
}

export class ModuleManager {
  private readonly log: Logger
  private installing: Promise<void> | undefined
  private rcloneState: RcloneModuleStatus['rclone'] = { state: 'missing', path: '', version: '', source: '', progress: 0, error: '' }
  private child: ChildProcess | undefined
  private mountState: MountStatus = { state: 'stopped', drive: '', error: '', log: [] }
  private settings: MountSettings
  private readonly settingsFile: string
  /** 用户主动卸载时不报「意外退出」 */
  private stopping = false

  constructor(private readonly options: ModuleManagerOptions) {
    this.log = options.log ?? silentLogger
    this.settingsFile = join(options.dir, 'mount.json')
    this.settings = { ...mountDefaults, ...readJson<Partial<MountSettings>>(this.settingsFile) }
  }

  private get rcloneDir(): string {
    return join(this.options.dir, 'rclone')
  }

  private kuraRclone(): string {
    const exe = join(this.rcloneDir, 'rclone.exe')
    return existsSync(exe) ? exe : ''
  }

  /** 重新检测 rclone 与 WinFsp（启动时、安装后、用户点「重新检测」）。 */
  async detect(): Promise<void> {
    if (this.installing) return
    const own = this.kuraRclone()
    const system = own ? '' : findSystemRclone()
    const path = own || system
    if (!path) {
      this.rcloneState = { ...this.rcloneState, state: this.rcloneState.state === 'error' ? 'error' : 'missing', path: '', version: '', source: '' }
      return
    }
    this.rcloneState = { state: 'ready', path, version: await runVersion(path), source: own ? 'kura' : 'system', progress: 1, error: '' }
  }

  status(): RcloneModuleStatus {
    const winfsp = findWinfsp()
    return {
      rclone: { ...this.rcloneState },
      winfsp: { installed: Boolean(winfsp), path: winfsp },
      mount: { ...this.mountState, log: [...this.mountState.log] },
    }
  }

  mountSettings(): MountSettings {
    return { ...this.settings }
  }

  saveMountSettings(next: MountSettings): MountSettings {
    const clean: MountSettings = {
      drive: validateDrive(next.drive),
      volumeName: next.volumeName.trim().slice(0, 32) || mountDefaults.volumeName,
      readOnly: Boolean(next.readOnly),
      autoMount: Boolean(next.autoMount),
      cacheMode: (['off', 'minimal', 'writes', 'full'] as const).includes(next.cacheMode) ? next.cacheMode : 'writes',
    }
    writeJsonAtomic(this.settingsFile, clean)
    this.settings = clean
    return this.mountSettings()
  }

  /** 下载并安装 rclone（固定版本 + SHA256 校验）。 */
  installRclone(): Promise<void> {
    if (this.installing) return this.installing
    this.installing = (async () => {
      const dir = this.rcloneDir
      const staging = join(this.options.dir, 'rclone.staging')
      const zip = join(this.options.dir, 'rclone.zip.part')
      this.rcloneState = { state: 'installing', path: '', version: '', source: '', progress: 0, error: '' }
      try {
        mkdirSync(this.options.dir, { recursive: true })
        rmSync(staging, { recursive: true, force: true })
        mkdirSync(staging, { recursive: true })
        this.log.info('开始下载 rclone', { 版本: rcloneRelease.version })
        await download(rcloneRelease.url, zip, (p) => (this.rcloneState.progress = Math.min(0.95, p * 0.95)))
        const actual = await sha256(zip)
        if (actual !== rcloneRelease.sha256) {
          throw new Error(`下载的 rclone 校验不通过（SHA256 ${actual.slice(0, 12)}… ≠ ${rcloneRelease.sha256.slice(0, 12)}…），已丢弃`)
        }
        await unzip(zip, staging)
        // 压缩包里是 rclone-v1.x-windows-amd64/rclone.exe
        const inner = readdirSync(staging).map((name) => join(staging, name)).find((p) => existsSync(join(p, 'rclone.exe')))
        if (!inner) throw new Error('压缩包里没找到 rclone.exe')
        // 不整目录 rename：刚解出来的 exe 正被杀毒软件扫描时，改名目录会 EPERM（实测）。
        // 只复制要用的那一个文件，复制失败就稍等重试几次。
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        for (let attempt = 1; ; attempt++) {
          try {
            copyFileSync(join(inner, 'rclone.exe'), join(dir, 'rclone.exe'))
            break
          } catch (error) {
            if (attempt >= 10) throw error
            await new Promise((r) => setTimeout(r, 500))
          }
        }
        this.log.info('rclone 已安装', { 位置: dir })
      } catch (error) {
        this.rcloneState = { state: 'error', path: '', version: '', source: '', progress: 0, error: errorMessage(error) }
        this.log.warn('安装 rclone 失败', { err: errorMessage(error) })
        throw error
      } finally {
        rmSync(zip, { force: true })
        rmSync(staging, { recursive: true, force: true })
        this.installing = undefined
      }
      await this.detect()
    })()
    return this.installing
  }

  /** 只删 Kura 自己下载的那份；系统 PATH 里的 rclone 不碰。 */
  async uninstallRclone(): Promise<void> {
    await this.unmount()
    if (this.rcloneState.source === 'system') throw new Error('当前用的是系统里已有的 rclone，不归 Kura 管，不会删它')
    const dir = this.rcloneDir
    if (existsSync(dir) && statSync(dir).isDirectory()) rmSync(join(dir, 'rclone.exe'), { force: true })
    rmSync(dir, { recursive: true, force: true })
    this.rcloneState = { state: 'missing', path: '', version: '', source: '', progress: 0, error: '' }
    await this.detect()
  }

  private pushLog(line: string): void {
    const log = this.mountState.log
    for (const l of line.split(/\r?\n/)) if (l.trim()) log.push(l.trim())
    if (log.length > 40) log.splice(0, log.length - 40)
  }

  async mount(): Promise<void> {
    if (this.child) return
    const status = this.status()
    if (status.rclone.state !== 'ready') throw new Error('还没有安装 rclone')
    if (!status.winfsp.installed && !this.options.spawnMount) throw new Error('还没有安装 WinFsp（挂载磁盘需要它，装一次即可，需要管理员权限）')
    const drive = validateDrive(this.settings.drive)
    if (!this.options.spawnMount && (await driveExists(drive))) throw new Error(`盘符 ${drive} 已被占用，换一个`)
    const args = mountArgs(this.settings, this.options.davUrl(), join(this.options.dir, 'rclone-cache'))
    this.stopping = false
    this.mountState = { state: 'starting', drive, error: '', log: [] }
    const child = this.options.spawnMount
      ? this.options.spawnMount(status.rclone.path, args)
      : spawn(status.rclone.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (c: Buffer) => this.pushLog(c.toString()))
    child.stderr?.on('data', (c: Buffer) => this.pushLog(c.toString()))
    child.on('error', (error) => {
      this.mountState = { ...this.mountState, state: 'error', error: errorMessage(error) }
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined
      if (this.stopping) {
        this.mountState = { ...this.mountState, state: 'stopped', error: '' }
        return
      }
      const last = this.mountState.log.at(-1) ?? ''
      this.mountState = { ...this.mountState, state: 'error', error: `rclone 意外退出（${code}）${last ? `：${last}` : ''}` }
      this.log.warn('rclone 挂载进程退出', { code, last })
    })
    // rclone mount 成功时不会主动报告；等盘符出现（WinFsp 挂好后 X:\ 就能访问）
    const until = Date.now() + 15_000
    while (Date.now() < until && this.child === child) {
      if (this.options.spawnMount || (await driveExists(drive))) {
        this.mountState = { ...this.mountState, state: 'mounted' }
        this.log.info('已挂载为磁盘', { 盘符: drive })
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (this.child !== child) throw new Error(this.mountState.error || 'rclone 启动后立刻退出了')
    // 15 秒没出现盘符：仍在跑就当作还在挂（外网慢），状态留在 starting，界面会继续刷新
    this.pushLog('15 秒内盘符尚未出现，rclone 仍在运行')
  }

  async unmount(): Promise<void> {
    const child = this.child
    if (!child) {
      this.mountState = { ...this.mountState, state: 'stopped', error: '' }
      return
    }
    this.stopping = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Windows 上 kill() 就是 TerminateProcess；WinFsp 会在进程退出时自动卸盘
        child.kill()
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      // 先礼后兵：rclone 收到 SIGINT 会干净地卸载并刷写缓存（Node 在 Windows 上把它转成 Ctrl+C 事件不可靠，超时再强杀）
      child.kill('SIGINT')
    })
    this.child = undefined
    this.mountState = { ...this.mountState, state: 'stopped', error: '' }
  }
}
