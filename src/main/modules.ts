import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../core/errors.js'
import { silentLogger, type Logger } from '../core/log.js'
import { readJson, writeJsonAtomic } from '../core/store.js'
import { folderLeaf as mountLeaf, folderTarget } from '../shared/mount.js'

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

/**
 * 挂出来的形态。三者的差别是 Windows **把它们放哪儿**，跟读写能力无关：
 *
 * - `disk`：固定磁盘。资源管理器「此电脑」里和 C:/D: 并列，程序看不出是远程盘。
 * - `network`：网络驱动器。进「网络位置」区，系统当它是个 SMB 共享；
 *   代价是每次挂载都会在 `HKCU\...\MountPoints2` 留一条 `\\server\<卷名>` 历史，
 *   卸载只卸盘符不删这条，攒久了「网络位置」里全是点不开的死图标 —— 卸载时得顺手清。
 * - `folder`：只挂到一个目录，不占盘符。rclone 在 Windows 上挂目录要求**挂载点必须不存在**
 *   （它自己建、自己删），且不支持与 network 同用，所以这里只允许固定磁盘。
 */
export type MountMode = 'disk' | 'network' | 'folder'

export interface MountSettings {
  /** 挂出来的形态 */
  mode: MountMode
  /** 盘符，如 "N:"；mode 为 folder 时不用 */
  drive: string
  /** mode 为 folder 时的**父目录**（要存在）；挂载点是它下面的 mountLeaf，由 Kura 拼、rclone 建。可为空 = 还没选 */
  folder: string
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
  mode: 'disk',
  drive: 'N:',
  folder: '',
  volumeName: 'Kura NAS',
  readOnly: false,
  autoMount: false,
  cacheMode: 'writes',
}

export interface MountStatus {
  state: 'stopped' | 'starting' | 'mounted' | 'error'
  /** 实际挂出来的位置：盘符（"N:"）或目录路径 */
  target: string
  error: string
  /** rclone 最近几行输出，排障用 */
  log: string[]
}

/** 盘符要么 "X:"，要么就别挂。 */
export function validateDrive(drive: string): string {
  const d = drive.trim().toUpperCase().replace(/\\$/, '')
  if (!/^[D-Z]:$/.test(d)) throw new Error(`盘符不对：${drive}（用 D: 到 Z: 之间的一个）`)
  return d
}

/**
 * folder 模式的**父目录**：必须是绝对路径。两种合法形态 —— `D:\sub`（子目录）与 `D:\`
 * （盘根，去掉末尾分隔符后就是 `D:`）。设成空不算错 —— 那是「还没选」，挂载时才拦
 * （见 mountTarget）。保存设置时不该因为没填完就报「保存失败」。
 */
export function validateFolder(folder: string): string {
  const trimmed = folder.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  // `D:` 单独一个也是绝对路径（盘根）；但 `D:sub` 是「盘符相对」，不是绝对路径
  if (!/^[A-Za-z]:\\/.test(trimmed) && !/^[A-Za-z]:$/.test(trimmed)) throw new Error(`父目录要写成绝对路径：${folder}（例如 D:\\ 或 D:\\KuraNAS）`)
  if (trimmed.includes('..')) throw new Error(`父目录里不能有 ..：${folder}`)
  // 只把盘符统一成大写（和盘符的规范化一致），路径其余部分原样保留
  return trimmed[0]!.toUpperCase() + trimmed.slice(1)
}

/** 这次挂载实际用的位置：盘符还是目录。挂载点与卸载提示都读它。 */
export function mountTarget(settings: MountSettings): string {
  if (settings.mode !== 'folder') return validateDrive(settings.drive)
  const parent = validateFolder(settings.folder)
  if (!parent) throw new Error('还没有选挂载到哪个文件夹（folder 模式要填父目录）')
  return folderTarget(parent)
}

/**
 * 清理 Explorer 留下的网络位置历史：`HKCU\...\MountPoints2\##server#<卷名>`。
 * 网络模式下 rclone 把卷暴露成 `\\server\<卷名>`，Explorer 每次访问都记一条，
 * 卸载后盘符没了但那一条还在，就成了「网络位置」里点不开的死图标。
 *
 * 卸载后 Explorer 可能还握着这条键（它刚访问过那个盘），删一次会失败。实测删不掉时
 * 键多半还在，几秒后就好了 —— 所以重试几次，别像以前那样失败就放弃、让残留一直留着。
 * 删不掉不算挂载失败，返回错误信息由调用方处理。
 */
export async function clearNetworkHistory(volumeName: string, attempts = 5): Promise<string> {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\##server#${volumeName}`
  let last = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' })
      return ''
    } catch (error) {
      last = errorMessage(error)
      // 键本来就不存在不算失败（清过一次、或压根没建过）
      if (!registryKeyExists(key)) return ''
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 600))
    }
  }
  return last
}

/** 键在不在。用 reg query 而不是看 reg delete 的报错 —— 后者「不存在」与「被占用」是同一句话。 */
function registryKeyExists(key: string): boolean {
  try {
    execFileSync('reg', ['query', key], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** rclone mount 的参数。remote 用连接串语法，免得写 rclone.conf。 */
export function mountArgs(settings: MountSettings, davUrl: string, cacheDir: string): string[] {
  const url = davUrl.replace(/\/+$/, '')
  return [
    'mount',
    // :webdav,url='...': 这种「连接串」形态不需要任何配置文件
    `:webdav,url='${url}',vendor=other:/`,
    mountTarget(settings),
    '--volname',
    settings.volumeName || 'Kura NAS',
    '--vfs-cache-mode',
    settings.cacheMode,
    '--cache-dir',
    cacheDir,
    // 资源管理器会频繁列目录，目录缓存短一点：NAS 上别处改了文件能较快看到
    '--dir-cache-time',
    '30s',
    // 只有网络模式加这个开关；固定磁盘与目录挂载都不加
    ...(settings.mode === 'network' ? ['--network-mode'] : []),
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

/** 挂载点是否已经能访问。盘符与目录挂载点的探测方式不同，都必须是异步的（见 driveExists）。 */
function mountPointReady(mode: MountMode, target: string): Promise<boolean> {
  return mode === 'folder' ? access(target).then(() => true, () => false) : driveExists(target)
}

export interface ModuleManagerOptions {
  dir: string
  log?: Logger
  /** 本机 WebDAV 的地址（不在跑时抛出） */
  davUrl: () => string
  /** 测试注入：替代真的去下载与跑 rclone */
  spawnMount?: (exe: string, args: string[]) => ChildProcess
  /** 测试注入：替代真的去读写用户注册表清理网络位置历史 */
  clearNetworkHistory?: (volumeName: string) => Promise<string>
  /** 测试注入：替代真的去探测挂载点（假挂载不会真的产生盘符/目录） */
  probeMountPoint?: (mode: MountMode, target: string) => Promise<boolean>
}

export class ModuleManager {
  private readonly log: Logger
  private installing: Promise<void> | undefined
  private rcloneState: RcloneModuleStatus['rclone'] = { state: 'missing', path: '', version: '', source: '', progress: 0, error: '' }
  private child: ChildProcess | undefined
  private mountState: MountStatus = { state: 'stopped', target: '', error: '', log: [] }
  private settings: MountSettings
  private readonly settingsFile: string
  /** 用户主动卸载时不报「意外退出」 */
  private stopping = false
  /** 上次对账的时刻，给 reconcile 节流用 */
  private reconciledAt = 0

  constructor(private readonly options: ModuleManagerOptions) {
    this.log = options.log ?? silentLogger
    this.settingsFile = join(options.dir, 'mount.json')
    this.settings = { ...mountDefaults, ...readJson<Partial<MountSettings>>(this.settingsFile) }
    this.clearHistory = options.clearNetworkHistory ?? clearNetworkHistory
    this.probeMountPoint = options.probeMountPoint ?? mountPointReady
  }

  private readonly clearHistory: (volumeName: string) => Promise<string>
  private readonly probeMountPoint: (mode: MountMode, target: string) => Promise<boolean>

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

  /**
   * 拿状态前对一次账。
   *
   * mountState 只在 Kura 自己 mount/unmount 时改；进程被外部结束（任务管理器结束 rclone、
   * 系统重启后 WinFsp 掉了）时不会复位，界面就会一直说「已挂载到 X:」，而那个盘其实已经没了。
   * 这里真的去问一次：进程还在不在、挂载点还访问得到吗。
   *
   * 只对 'mounted' 对账：'starting' 是 mount() 自己的等待循环在管，这里插手会误判成失败。
   * 盘符探测要走 WinFsp → rclone → 本机 WebDAV，**不能同步做**（会卡死事件循环，见 driveExists）。
   */
  async reconcile(): Promise<void> {
    if (this.mountState.state !== 'mounted') return
    // 模块页 3 秒轮询一次，每轮都走一遍「WinFsp → rclone → 本机 WebDAV」没必要：几秒内信一次就够
    const now = Date.now()
    if (now - this.reconciledAt < 5_000) return
    this.reconciledAt = now
    // 进程没了，挂载一定也没了
    if (!this.child) {
      this.mountState = { ...this.mountState, state: 'error', error: '挂载进程已经不在运行了（被别的程序结束，或系统休眠后掉了），这个位置已断开。' }
      return
    }
    // 进程还在，但挂载点访问不到了：WinFsp 挂载掉了
    if (this.mountState.target && !(await this.probeMountPoint(this.settings.mode, this.mountState.target))) {
      this.mountState = { ...this.mountState, state: 'error', error: `${this.mountState.target} 已经访问不到了（挂载掉了）。重新挂载可恢复。` }
    }
  }

  saveMountSettings(next: MountSettings): MountSettings {
    const mode: MountMode = (['disk', 'network', 'folder'] as const).includes(next.mode) ? next.mode : mountDefaults.mode
    const clean: MountSettings = {
      mode,
      drive: validateDrive(next.drive),
      // 目录挂载点必须存在父目录；folder 模式下才较真，其它模式允许留空
      folder: mode === 'folder' ? validateFolder(next.folder) : String(next.folder ?? '').trim(),
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
    const target = mountTarget(this.settings)
    // 目录挂载点：rclone 要求它**不存在**（自己建自己删），存在就直接拒绝，别把它当成空目录用
    if (this.settings.mode === 'folder' && !this.options.spawnMount && existsSync(target)) throw new Error(`${target} 已经存在了，换个父目录（挂载点得由 rclone 现建）`)
    if (this.settings.mode !== 'folder' && !this.options.spawnMount && (await driveExists(target))) throw new Error(`盘符 ${target} 已被占用，换一个`)
    const args = mountArgs(this.settings, this.options.davUrl(), join(this.options.dir, 'rclone-cache'))
    this.stopping = false
    this.mountState = { state: 'starting', target, error: '', log: [] }
    const child = this.options.spawnMount
      ? this.options.spawnMount(status.rclone.path, args)
      : spawn(status.rclone.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    // spawn 失败只发 'error'、不发 'exit'。不在这里清掉 child 的话，下面的等待循环条件永远成立，
    // 会白等满 15 秒，而且 this.child 一直指着这个死掉的进程 —— 再点挂载会被 `if (this.child) return` 永久卡住。
    let spawnFailed = false
    child.stdout?.on('data', (c: Buffer) => this.pushLog(c.toString()))
    child.stderr?.on('data', (c: Buffer) => this.pushLog(c.toString()))
    child.on('error', (error) => {
      spawnFailed = true
      if (this.child === child) this.child = undefined
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
    // rclone mount 成功时不会主动报告；等挂载点出现（WinFsp 挂好后就能访问）
    const until = Date.now() + 15_000
    while (Date.now() < until && this.child === child && !spawnFailed) {
      if (this.options.spawnMount || (await mountPointReady(this.settings.mode, target))) {
        this.mountState = { ...this.mountState, state: 'mounted' }
        this.log.info('已挂载', { 形态: this.settings.mode, 位置: target })
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (this.child !== child) throw new Error(this.mountState.error || 'rclone 启动后立刻退出了')
    // 15 秒没出现挂载点：仍在跑就当作还在挂（外网慢），状态留在 starting，界面会继续刷新
    this.pushLog('15 秒内挂载点尚未出现，rclone 仍在运行')
  }

  async unmount(): Promise<void> {
    const child = this.child
    const mode = this.settings.mode
    const volumeName = this.settings.volumeName || mountDefaults.volumeName
    if (!child) {
      this.mountState = { ...this.mountState, state: 'stopped', error: '' }
      // 进程早就没了（被外部杀掉、或上次挂载就失败）也可能留着网络位置残留，顺手清一次
      if (mode === 'network') await this.clearLeftoverNetworkHistory(volumeName)
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
    // 网络模式挂一次就在 Explorer 留一条 \\server\<卷名> 历史（见 MountMode 注释），卸载时顺手清掉
    if (mode === 'network') await this.clearLeftoverNetworkHistory(volumeName)
  }

  /**
   * 清网络位置历史。清不掉不影响卸载结果，但要**说出来** —— 以前只记一行日志，
   * 用户看到的是一个点不开的死图标，却不知道是 Kura 没清干净。
   * 失败原因写进 mount.error：界面把它当「已卸载但有残留」显示，导览里也说一句。
   */
  private async clearLeftoverNetworkHistory(volumeName: string): Promise<void> {
    const failed = await this.clearHistory(volumeName)
    if (!failed) {
      this.mountState = { ...this.mountState, error: '' }
      return
    }
    this.log.warn('清理网络位置历史失败', { 卷名: volumeName, err: failed })
    this.mountState = {
      ...this.mountState,
      error: `已卸载，但「网络位置」里那条 ${volumeName} 的残留没清掉（它会显示成点不开的图标）。重启 Kura 或重新挂载一次会再试。`,
    }
  }
}
