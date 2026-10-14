import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ConsoleSession, ConsoleTerminal, type ConsoleCredentials } from '../core/console.js'
import { DavClient, type DavEntry } from '../core/dav-client.js'
import { normalizeDavPath, normalizeRules, visibilityOf, writeDenial } from '../core/dav-scope.js'
import { DavServer, davServerDefaults, type DavServerSettings } from '../core/dav-server.js'
import { errorMessage } from '../core/errors.js'
import type { HttpRequester } from '../core/http.js'
import { silentLogger, type Logger } from '../core/log.js'
import type { Mirror } from '../core/mirror.js'
import { readJson, writeJsonAtomic } from '../core/store.js'
import type {
  DavCheckResult,
  DavSettingsView,
  DavStatusView,
  FileListing,
  TerminalConfigForm,
  TerminalConfigView,
  TerminalEventView,
  Transfer,
} from '../shared/ipc.js'
import type { CredentialVault } from './vault.js'

/** 服务端清单里的服务名（nas-mirror 网关 map 里的键，见 server/nginx/conf.d/default.conf）。 */
export const webdavService = 'webdav'
export const consoleService = 'nas-console'

/**
 * v0.2 的三样东西都建在映射层之上（AGENTS.md 架构原则 1）：
 *   文件管理器 → Mirror.internalEndpoint('webdav')
 *   本机 WebDAV → 同上，前面加一道范围
 *   终端       → Mirror.internalEndpoint('nas-console')
 * 映射重建（改了连接配置）时 mirror() 会返回新实例，这里每次现取，不缓存旧的。
 */
export interface FeatureDeps {
  mirror: () => Mirror | undefined
  dataDir: string
  log?: Logger
  request?: HttpRequester
}

function requireMirror(deps: FeatureDeps): Mirror {
  const mirror = deps.mirror()
  if (!mirror) throw new Error('还没有连接 NAS')
  return mirror
}

// ---------------------------------------------------------------- 文件

const maxTransfers = 50

export class FileService {
  readonly client: DavClient
  private readonly transfers = new Map<string, Transfer & { abort?: () => void }>()
  private seq = 0

  constructor(private readonly deps: FeatureDeps) {
    this.client = new DavClient({ endpoint: () => requireMirror(deps).internalEndpoint(webdavService) })
  }

  async list(path: string): Promise<FileListing> {
    const dir = normalizeDavPath(path)
    const entries = await this.client.list(dir)
    return { path: dir, entries: entries.map(({ path, name, isDir, size, modified }: DavEntry) => ({ path, name, isDir, size, modified })) }
  }

  mkdir(path: string): Promise<void> {
    return this.client.mkdir(path)
  }

  rename(from: string, to: string): Promise<void> {
    return this.client.move(from, to)
  }

  async remove(paths: string[]): Promise<void> {
    // 逐个删：一个失败不连累其他，但最后要把失败的报出来
    const failed: string[] = []
    for (const p of paths) {
      try {
        await this.client.remove(p)
      } catch (error) {
        failed.push(`${p}：${errorMessage(error)}`)
      }
    }
    if (failed.length) throw new Error(failed.join('\n'))
  }

  listTransfers(): Transfer[] {
    return [...this.transfers.values()].map(({ abort: _abort, ...t }) => ({ ...t })).sort((a, b) => b.startedAt - a.startedAt)
  }

  private track(kind: Transfer['kind'], remote: string, local: string, total: number): Transfer & { abort?: () => void } {
    const id = `t${++this.seq}`
    const transfer: Transfer & { abort?: () => void } = {
      id,
      kind,
      name: basename(kind === 'upload' ? local : remote),
      remote,
      local,
      done: 0,
      total,
      state: 'running',
      error: '',
      startedAt: Date.now(),
    }
    this.transfers.set(id, transfer)
    // 只留最近的若干条已结束记录
    const finished = [...this.transfers.values()].filter((t) => t.state !== 'running')
    for (const old of finished.slice(0, Math.max(0, this.transfers.size - maxTransfers))) this.transfers.delete(old.id)
    return transfer
  }

  cancel(id: string): void {
    const t = this.transfers.get(id)
    if (!t || t.state !== 'running') return
    t.state = 'cancelled'
    t.abort?.()
  }

  /** 上传本机文件（流式）；返回传输 id，进度靠 transfers() 轮询。 */
  upload(localFile: string, remoteDir: string): string {
    const size = statSync(localFile).size
    const remote = normalizeDavPath(`${remoteDir}/${basename(localFile)}`)
    const t = this.track('upload', remote, localFile, size)
    const stream = createReadStream(localFile)
    t.abort = () => stream.destroy(new Error('已取消'))
    stream.on('data', (chunk) => (t.done += chunk.length))
    this.client.upload(remote, stream, size).then(
      () => {
        if (t.state === 'running') t.state = 'done'
      },
      (error) => {
        if (t.state === 'running') Object.assign(t, { state: 'error', error: errorMessage(error) })
      },
    )
    return t.id
  }

  /** 下载到本机文件，返回传输 id（后台进行）。 */
  download(remote: string, localFile: string): string {
    const { id, finished } = this.startDownload(remote, localFile)
    finished.catch(() => {}) // 错误已记在传输记录里
    return id
  }

  /** 下载并等它完成（「打开」用）；失败抛出。 */
  async downloadNow(remote: string, localFile: string): Promise<void> {
    await this.startDownload(remote, localFile).finished
  }

  /** 先写 .part，完成后才改名：取消或失败不留半截文件。 */
  private startDownload(remote: string, localFile: string): { id: string; finished: Promise<void> } {
    const t = this.track('download', remote, localFile, 0)
    const part = `${localFile}.part`
    const sink = createWriteStream(part)
    t.abort = () => sink.destroy(new Error('已取消'))
    const finished = this.client
      .download(remote, sink, (done, total) => {
        t.done = done
        t.total = total
      })
      .then(
        () => {
          if (t.state === 'cancelled') throw new Error('已取消')
          rmSync(localFile, { force: true })
          renameSync(part, localFile)
          t.state = 'done'
        },
        (error: unknown) => {
          rmSync(part, { force: true })
          if (t.state === 'running') Object.assign(t, { state: 'error', error: errorMessage(error) })
          throw error
        },
      )
    return { id: t.id, finished }
  }

  /** 递归下载一个目录：先在本机建目录，再逐个文件排进传输。 */
  async downloadTree(remoteDir: string, localDir: string): Promise<number> {
    mkdirSync(localDir, { recursive: true })
    let count = 0
    for (const entry of await this.client.list(remoteDir)) {
      const target = join(localDir, safeLocalName(entry.name))
      if (entry.isDir) count += await this.downloadTree(entry.path, target)
      else {
        this.download(entry.path, target)
        count += 1
      }
    }
    return count
  }
}

/** NAS 上的文件名可能含 Windows 不允许的字符（: * ? " < > |），落到本机前换掉。 */
export function safeLocalName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned || '_'
}

// ---------------------------------------------------------------- 本机 WebDAV

export class LocalDavService {
  readonly server: DavServer
  private readonly file: string

  constructor(private readonly deps: FeatureDeps) {
    this.file = join(deps.dataDir, 'webdav.json')
    const saved = readJson<Partial<DavServerSettings>>(this.file)
    // 冒烟时换一个空闲端口：默认 18006 可能被日常在跑的 Kura 占着
    const smokePort = process.env.KURA_SMOKE === '1' ? Number(process.env.SMOKE_DAV_PORT) || undefined : undefined
    this.server = new DavServer({
      settings: { ...davServerDefaults, ...saved, ...(smokePort ? { port: smokePort } : {}) },
      upstream: () => requireMirror(deps).internalEndpoint(webdavService),
      log: deps.log,
    })
  }

  async start(): Promise<void> {
    try {
      await this.server.start()
    } catch (error) {
      ;(this.deps.log ?? silentLogger).warn('本机 WebDAV 启动失败', { err: errorMessage(error) })
    }
  }

  close(): Promise<void> {
    return this.server.close()
  }

  view(): DavStatusView {
    const status = this.server.status()
    const settings = this.server.current()
    return {
      settings: { ...settings, include: [...settings.include], exclude: [...settings.exclude] },
      url: status.url,
      running: status.listener.running,
      lastError: status.listener.lastError,
      upstreamError: status.upstreamError,
      requests: status.stats.requests,
      errors: status.stats.errors,
      bytesUp: status.stats.bytesUp,
      bytesDown: status.stats.bytesDown,
      available: this.deps.mirror()?.hasService(webdavService) ?? false,
    }
  }

  async save(input: DavSettingsView): Promise<DavStatusView> {
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口 ${input.port} 不合法`)
    const next: DavServerSettings = {
      enabled: Boolean(input.enabled),
      port,
      readOnly: Boolean(input.readOnly),
      include: normalizeRules(input.include.filter((r) => r.trim())),
      exclude: normalizeRules(input.exclude.filter((r) => r.trim())),
    }
    if (next.include.length === 0) throw new Error('至少要放行一个目录（想全部关掉就关「启用」开关）')
    if (next.include.length > 200 || next.exclude.length > 200) throw new Error('规则太多（每类最多 200 条）')
    // 端口等运行时改动先做，成功了才落盘：失败时磁盘上留的是仍在生效的那份
    await this.server.apply(next)
    writeJsonAtomic(this.file, this.server.current())
    return this.view()
  }

  check(path: string): DavCheckResult {
    const p = normalizeDavPath(path)
    const scope = this.server.current()
    const result = visibilityOf(p, scope)
    return { path: p, visibility: result.visibility, reason: result.reason, writable: !writeDenial(p, scope, scope.readOnly, 'PUT') }
  }
}

// ---------------------------------------------------------------- 终端

interface ConsoleSecrets {
  method: 'password' | 'token'
  user: string
  password: string
  token: string
}

export class TerminalService {
  private readonly session: ConsoleSession
  private readonly terminals = new Map<string, ConsoleTerminal>()
  /** undefined = 还没读过（惰性读，理由见 secretsOf） */
  private secrets: ConsoleSecrets | undefined
  private seq = 0

  constructor(
    private readonly deps: FeatureDeps,
    private readonly vault: CredentialVault<ConsoleSecrets>,
    private readonly emit: (event: TerminalEventView) => void,
  ) {
    this.session = new ConsoleSession(
      () => requireMirror(deps).internalEndpoint(consoleService),
      () => this.credentials(this.secretsOf()),
      deps.request,
    )
  }

  /**
   * 惰性读终端凭据，别在构造函数里读。
   *
   * 同一个坑（连接核心那边也有）：服务是在模块顶层 new 的，那时 `app.whenReady()` 还没发生，
   * `safeStorage` 在 ready 之前不可用，构造函数里读盘必然失败 —— 表现是
   * 「nas-console 的账号密码每次重启都要重填」。
   */
  private secretsOf(): ConsoleSecrets {
    this.secrets ??= this.vault.load() ?? { method: 'password', user: '', password: '', token: '' }
    return this.secrets
  }

  private credentials(s: ConsoleSecrets): ConsoleCredentials {
    return s.method === 'token' ? { token: s.token } : { user: s.user, password: s.password }
  }

  config(): TerminalConfigView {
    const secrets = this.secretsOf()
    return {
      method: secrets.method,
      user: secrets.user,
      hasPassword: Boolean(secrets.password),
      hasToken: Boolean(secrets.token),
      available: this.deps.mirror()?.hasService(consoleService) ?? false,
    }
  }

  private merge(form: TerminalConfigForm): ConsoleSecrets {
    const saved = this.secretsOf()
    const method = form.method === 'token' ? 'token' : 'password'
    const next: ConsoleSecrets = {
      method,
      user: form.user.trim(),
      password: form.password || saved.password,
      token: form.token.trim() || saved.token,
    }
    if (method === 'token' && !/^nsc_/.test(next.token)) throw new Error('API Token 应以 nsc_ 开头（在 nas-console 网页的 Token 页生成）')
    // 账号密码**可以都留空**：kura-server 部署下由映射层带网关会话，不需要这一层凭据（与页面文案一致）。
    // 但不能只填一半——那是误操作，会得到一个怎么都连不上的会话。
    if (method === 'password' && Boolean(next.user) !== Boolean(next.password)) throw new Error('账号和密码要么都填，要么都留空（留空 = 用网关会话）')
    return next
  }

  async test(form: TerminalConfigForm): Promise<string> {
    const candidate = this.merge(form)
    const probe = new ConsoleSession(
      () => requireMirror(this.deps).internalEndpoint(consoleService),
      () => this.credentials(candidate),
      this.deps.request,
    )
    return probe.check()
  }

  saveConfig(form: TerminalConfigForm): TerminalConfigView {
    const next = this.merge(form)
    this.vault.save(next)
    this.secrets = next
    this.session.invalidate()
    return this.config()
  }

  async open(): Promise<string> {
    const id = `term-${++this.seq}`
    const terminal = new ConsoleTerminal(id, this.session, (event) => {
      this.emit({ id, ...event } as TerminalEventView)
      if (event.type === 'status' && event.status === 'closed') this.terminals.delete(id)
    }, this.deps.log)
    this.terminals.set(id, terminal)
    // 不等握手：id 先给界面，状态随事件推过去（界面先显示「连接中」）
    void terminal.open()
    return id
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.terminals.get(id)?.resize(cols, rows)
  }

  close(id: string): void {
    this.terminals.get(id)?.close()
    this.terminals.delete(id)
  }

  closeAll(): void {
    for (const t of this.terminals.values()) t.close()
    this.terminals.clear()
  }
}
