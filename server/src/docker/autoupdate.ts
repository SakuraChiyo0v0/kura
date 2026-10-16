import { readJson, writeJsonAtomic } from '../../../src/core/store.js'
import type { AutoUpdateRunResult, AutoUpdateStatus } from '../../../src/core/docker-types.js'
import type { DockerEngine } from './engine.js'
import { runCompose, type ComposeRun } from './compose.js'
import { ProjectLocks } from './locks.js'
import { selfProject, type DockerService } from './service.js'

/**
 * 按项目的自动更新（`state/autoupdate.json`）。
 *
 * 为什么放在 kura-server 的 `serve()` 进程里，而不是单起一个容器：
 * 这个进程本来就 7×24 常驻（`restart: unless-stopped`）、本来就挂着 docker.sock 与项目目录，
 * 自动更新要的东西它全都有。单起容器要跟着发布第二个镜像、多一份配置，而隔离并没有变强
 * —— 它照样得挂 docker.sock，权限完全一样。所以「别人的项目 Kura 管，Kura 自己继续 watchtower 管」，
 * 这条线划在 `selfProject` 上。
 *
 * 语义跟 watchtower 的 label 模式对齐，但开关存在 Kura 这边（`state/autoupdate.json`），
 * 不去动别人的 compose 文件：给项目打标签要改宿主的 yaml，Kura 不该去改它管的项目文件。
 *
 * **每轮先问再拉**：`checkUpdate` 只问仓库 digest、不拉镜像（和界面上「检查更新」同一个口径），
 * 只有真有变化才 `pull` + `up -d`。没变化就什么都不做，不留无谓的容器重建。
 */

/** Kura 只管这些目录下的项目（跟 DockerService.kindOf 的 managed 一致）：别的项目连 compose 文件都读不到。 */
const updateableKinds = new Set(['managed', 'appstore'])

/** 调度间隔；也可以当成「多久问一次仓库」。 */
export const defaultIntervalMs = 6 * 60 * 60 * 1000

interface AutoUpdateFile {
  version: 1
  /** 开了自动更新的项目名。默认空 —— 不 opt-in 就永远不动别人的东西。 */
  projects: string[]
}

export interface AutoUpdateOptions {
  engine: DockerEngine
  service: DockerService
  /** 状态文件；不传就是一个纯内存的（测试用） */
  file?: string
  intervalMs?: number
  /** 测试注入 */
  compose?: typeof runCompose
  /** 与界面操作共用的项目锁；不给就自己造一个（测试用） */
  locks?: ProjectLocks
  onResult?: (result: AutoUpdateRunResult) => void
  log?: (message: string, fields?: Record<string, unknown>) => void
}

/** 当前正在更新、不让第二轮插进来的项目。 */
export class AutoUpdate {
  private projects = new Set<string>()
  private lastRunAt = 0
  private lastResult: AutoUpdateRunResult[] = []
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private readonly file?: string
  private readonly intervalMs: number
  private readonly compose: typeof runCompose
  private readonly locks: ProjectLocks
  private readonly log: (message: string, fields?: Record<string, unknown>) => void

  constructor(private readonly options: AutoUpdateOptions) {
    this.file = options.file
    this.intervalMs = options.intervalMs ?? defaultIntervalMs
    this.compose = options.compose ?? runCompose
    this.locks = options.locks ?? new ProjectLocks()
    this.log = options.log ?? (() => {})
    const doc = options.file ? readJson<AutoUpdateFile>(options.file) : undefined
    if (Array.isArray(doc?.projects)) this.projects = new Set(doc.projects.filter((p) => typeof p === 'string'))
  }

  status(): AutoUpdateStatus {
    return { projects: [...this.projects].sort(), lastRunAt: this.lastRunAt, lastResult: [...this.lastResult], running: this.running }
  }

  isOn(name: string): boolean {
    return this.projects.has(name)
  }

  /**
   * 开 / 关一个项目的自动更新。落盘失败就不改内存 —— 否则界面显示「已开」、重启后却没了，
   * 是 store.ts 顶部记的那类最难查的不一致。
   */
  set(name: string, on: boolean): AutoUpdateStatus {
    // 硬拦一道：kura-server 自己归 watchtower 管，开了就是两边抢着重启同一个容器
    if (name === selfProject) throw new Error(`${selfProject} 由 NAS 上的 watchtower 更新，不能在 Kura 里开自动更新`)
    const next = new Set(this.projects)
    if (on) next.add(name)
    else next.delete(name)
    this.persist(next)
    this.projects = next
    return this.status()
  }

  private persist(next: Set<string>): void {
    if (!this.file) return
    writeJsonAtomic(this.file, { version: 1, projects: [...next].sort() } satisfies AutoUpdateFile)
  }

  /** 起调度：跟 watchdog 一个套路（重入保护 + unref，不让它拖住进程退出）。 */
  start(): () => void {
    if (this.timer || this.intervalMs <= 0) return () => {}
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 跑一轮。上一轮还没结束就直接跳过（重入保护）。 */
  async tick(): Promise<AutoUpdateRunResult[]> {
    if (this.running) return []
    this.running = true
    try {
      const names = [...this.projects].sort()
      if (names.length === 0) return []
      const results: AutoUpdateRunResult[] = []
      for (const name of names) {
        // 每个项目自己兜住错误：一个项目出问题不该让同一轮里其余项目都不跑
        try {
          const result = await this.updateProject(name)
          if (result) results.push(result)
        } catch (error) {
          const reason = `更新出错：${(error as Error).message}`
          this.log('自动更新：项目出错', { 项目: name, err: reason })
          const result: AutoUpdateRunResult = { project: name, images: [], ok: false, reason, at: Date.now() }
          results.push(result)
          this.options.onResult?.(result)
        }
      }
      this.lastRunAt = Date.now()
      this.lastResult = results
      return results
    } finally {
      this.running = false
    }
  }

  /** 更新一个项目；没变化返回 undefined（不往结果里塞一堆「没变」）。 */
  private async updateProject(name: string): Promise<AutoUpdateRunResult | undefined> {
    const at = Date.now()
    let project: Awaited<ReturnType<DockerService['project']>>
    try {
      project = await this.options.service.project(name)
    } catch (error) {
      return { project: name, images: [], ok: false, reason: `找不到这个项目：${(error as Error).message}`, at }
    }
    // 先拦自己：kindOf 对 kura-server 也返回 'self'，排在前面才能给出说得通的原因。
    // set() 已经挡了一道，但状态文件是可以手改的，这里再挡一道。
    if (name === selfProject || project.kind === 'self') {
      return { project: name, images: [], ok: false, reason: `${selfProject} 由 NAS 上的 watchtower 更新，不归 Kura 管`, at }
    }
    // 只在能部署的项目上跑：external 的项目连 compose 文件都读不到（kindOf 的口径）
    if (!updateableKinds.has(project.kind)) {
      return { project: name, images: [], ok: false, reason: `这个项目不在项目目录里，Kura 动不了它（${project.dir}）`, at }
    }

    const images = await this.projectImages(name)
    if (images.length === 0) return undefined

    const changed: string[] = []
    const unknown: string[] = []
    for (const image of images) {
      try {
        const check = await this.options.service.checkUpdate(image)
        if (check.status === 'update') changed.push(image)
        else if (check.status === 'unknown') unknown.push(`${image}（${check.reason}）`)
      } catch {
        // checkUpdate 自己就不抛（失败标 unknown）；这里兜底，一个镜像问不到不该中断其余
      }
    }
    if (changed.length === 0) {
      // 「仓库问不到」不能当成「都是最新的」：那两个结论对用户不一样。
      // 有 unknown 却不说话，就是一次静默失败（界面上会一直显示「都是最新的」）。
      if (unknown.length > 0) {
        return { project: name, images: [], ok: false, reason: `问不到仓库，没法判断：${unknown.join('；')}`, at }
      }
      return undefined
    }

    this.log('自动更新：发现新版本', { 项目: name, 镜像: changed })
    const output = await this.runCompose(name, project)
    const result: AutoUpdateRunResult = {
      project: name,
      images: changed,
      ok: output.ok,
      reason: output.ok ? '' : output.reason,
      at,
    }
    this.options.onResult?.(result)
    this.log('自动更新：完成', { 项目: name, 镜像: changed, 成功: output.ok, 原因: result.reason || undefined })
    return result
  }

  /** 项目里容器用到的镜像，去重。 */
  private async projectImages(name: string): Promise<string[]> {
    const raw = await this.options.engine.listContainers()
    const seen = new Set<string>()
    for (const c of raw) {
      if (c.Labels?.['com.docker.compose.project'] !== name) continue
      if (c.Image) seen.add(c.Image)
    }
    // 一个容器都没起过的项目（刚建、还没 up）没有镜像可比，跳过
    return [...seen].sort()
  }

  /** pull + up -d。先拉再起 —— 拉失败就不该动在跑的那些。 */
  private async runCompose(name: string, project: { dir: string; configFiles: string[] }): Promise<{ ok: boolean; reason: string }> {
    // 和界面操作共用一把锁：更新在 pull + up 的时候用户点「重启」会被挡下（反过来也一样）。
    // 拿不到锁不算失败 —— 说明用户正在手动动这个项目，这一轮跳过它，下一轮再来。
    if (this.locks.has(name)) return { ok: false, reason: '用户正在手动操作这个项目，这一轮跳过' }
    return this.locks.run(name, () => this.composeProject(name, project))
  }

  private async composeProject(name: string, project: { dir: string; configFiles: string[] }): Promise<{ ok: boolean; reason: string }> {
    const target = { name, dir: project.dir, configFiles: project.configFiles }
    for (const action of ['pull', 'up'] as const) {
      // runCompose 在目录不可达时是**同步抛**的（compose.ts）。这里接住：
      // 一个项目的目录出问题不该冒到 tick()，把同一轮里其余项目也带倒。
      let run: ComposeRun
      try {
        run = this.compose(target, action)
      } catch (error) {
        return { ok: false, reason: `compose ${action} 起不来：${(error as Error).message}` }
      }
      let tail = ''
      run.onOutput((text) => {
        tail = (tail + text).slice(-4000)
      })
      const code = await run.done
      if (code !== 0) {
        const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
        const reason = lines.at(-1) ?? `compose ${action} 退出码 ${code}`
        return { ok: false, reason: `compose ${action} 失败：${reason}` }
      }
    }
    return { ok: true, reason: '' }
  }
}
