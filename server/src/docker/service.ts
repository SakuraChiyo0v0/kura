import {
  maskEnv,
  projectStatus,
  type ContainerDetail,
  type ContainerStats,
  type ContainerView,
  type DockerOverview,
  type ImageView,
  type NetworkView,
  type ProjectKind,
  type ProjectView,
  type UpdateCheck,
  type VolumeView,
} from '../../../src/core/docker-types.js'
import { scanProjectRoot, within } from './compose.js'
import { DockerError, type DockerEngine, type RawContainer, type RawInspect, type RawNetworkDetail, type RawStats } from './engine.js'

/** Kura 自己的 compose 项目名：只读，动它等于剪掉自己连着的那根线（设计 §四）。 */
export const selfProject = 'kura-server'
export const appstoreRoot = '/volume1/@appstore'

export interface DockerServiceOptions {
  engine: DockerEngine
  /** 项目目录（宿主原路径，容器里按原路径挂进来）；空 = 不扫目录、不允许部署 */
  projectRoot: string
  /** /volume1/@appstore 也按原路径挂进来了没有（默认没有） */
  appstoreMounted?: boolean
}

const label = (labels: Record<string, string> | undefined, key: string): string => labels?.[`com.docker.compose.${key}`] ?? ''

function toContainer(raw: RawContainer): ContainerView {
  const project = label(raw.Labels, 'project')
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(raw.Status)?.[1]
  const seen = new Set<string>()
  const ports = (raw.Ports ?? [])
    .filter((p) => p.PrivatePort)
    // 同一个端口在 IPv4 / IPv6 上各报一条，界面上只要一条
    .filter((p) => {
      const key = `${p.PrivatePort}/${p.PublicPort ?? 0}/${p.Type}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((p) => ({ private: p.PrivatePort!, public: p.PublicPort ?? 0, type: p.Type ?? 'tcp' }))
    .sort((a, b) => a.private - b.private)
  return {
    id: raw.Id,
    name: (raw.Names?.[0] ?? raw.Id.slice(0, 12)).replace(/^\//, ''),
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    health: health === 'health: starting' ? 'starting' : ((health as ContainerView['health']) ?? ''),
    created: raw.Created * 1000,
    ports,
    project,
    service: label(raw.Labels, 'service'),
    protected: project === selfProject,
  }
}

export class DockerService {
  constructor(private readonly options: DockerServiceOptions) {}

  /**
   * 能做什么由目录决定。`appstore` 只在它的目录也按原路径挂进来时才给启停 ——
   * 和项目目录同一个原因：compose 在别的路径下执行，相对路径挂载会变成空目录。
   * 现在的 compose 只挂了 /volume1/docker，所以绿联商店的项目落到 external（只能停止）。
   */
  kindOf(name: string, dir: string): ProjectKind {
    if (name === selfProject) return 'self'
    if (within(dir, this.options.projectRoot)) return 'managed'
    if (within(dir, appstoreRoot)) return this.options.appstoreMounted ? 'appstore' : 'external'
    return 'external'
  }

  async overview(): Promise<DockerOverview> {
    const raw = await this.options.engine.listContainers()
    const containers = raw.map(toContainer).sort((a, b) => a.name.localeCompare(b.name))
    return { containers, projects: this.projectsFrom(containers, raw) }
  }

  async projects(): Promise<ProjectView[]> {
    const raw = await this.options.engine.listContainers()
    return this.projectsFrom(raw.map(toContainer), raw)
  }

  private projectsFrom(containers: ContainerView[], raw: RawContainer[]): ProjectView[] {
    const byName = new Map<string, ProjectView>()
    for (const r of raw) {
      const name = label(r.Labels, 'project')
      if (!name) continue
      const dir = label(r.Labels, 'project.working_dir')
      const files = label(r.Labels, 'project.config_files').split(',').filter(Boolean)
      const p = byName.get(name) ?? { name, status: 'stopped', kind: this.kindOf(name, dir), dir, configFiles: files, containers: 0, running: 0, services: [] }
      if (!p.dir && dir) p.dir = dir
      if (p.configFiles.length === 0) p.configFiles = files
      byName.set(name, p)
    }
    for (const c of containers) {
      const p = c.project ? byName.get(c.project) : undefined
      if (!p) continue
      p.containers += 1
      if (c.state === 'running') p.running += 1
      if (c.service && !p.services.includes(c.service)) p.services.push(c.service)
    }
    // 项目目录里有 compose 文件、但一个容器都没有的：也列出来（能从 Kura 启动）
    for (const d of scanProjectRoot(this.options.projectRoot)) {
      if (byName.has(d.name)) continue
      byName.set(d.name, { name: d.name, status: 'stopped', kind: this.kindOf(d.name, d.dir), dir: d.dir, configFiles: d.configFiles, containers: 0, running: 0, services: [] })
    }
    const projects = [...byName.values()]
    for (const p of projects) {
      p.status = projectStatus(p.running, p.containers)
      p.services.sort()
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name))
  }

  async project(name: string): Promise<ProjectView> {
    const p = (await this.projects()).find((x) => x.name === name)
    if (!p) throw new DockerError(404, `没有「${name}」这个项目`)
    return p
  }

  async container(ref: string): Promise<ContainerDetail> {
    const raw = await this.options.engine.inspectContainer(ref)
    const list = await this.options.engine.listContainers()
    const brief = list.find((c) => c.Id === raw.Id)
    return toDetail(raw, brief ? toContainer(brief) : undefined)
  }

  async stats(ref: string): Promise<ContainerStats> {
    return toStats(await this.options.engine.containerStats(ref))
  }

  async volumes(withSize: boolean): Promise<VolumeView[]> {
    const [{ Volumes }, containers, df] = await Promise.all([
      this.options.engine.listVolumes(),
      this.options.engine.listContainers(),
      withSize ? this.options.engine.diskUsage().catch(() => ({ Volumes: [] })) : Promise.resolve({ Volumes: [] }),
    ])
    // 哪些容器在用哪个卷：listContainers 里没有挂载信息，按名字逐个 inspect 太慢 —— 用 Mounts 字段（Docker 在列表里就给）
    const usedBy = new Map<string, string[]>()
    for (const c of containers) {
      for (const m of c.Mounts ?? []) {
        if (m.Type !== 'volume' || !m.Name) continue
        usedBy.set(m.Name, [...(usedBy.get(m.Name) ?? []), toContainer(c).name])
      }
    }
    const sizes = new Map((df.Volumes ?? []).map((v) => [v.Name, v.UsageData?.Size ?? -1]))
    return (Volumes ?? [])
      .map((v) => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        created: v.CreatedAt ? Date.parse(v.CreatedAt) : 0,
        project: v.Labels?.['com.docker.compose.project'] ?? '',
        usedBy: (usedBy.get(v.Name) ?? []).sort(),
        size: withSize ? (sizes.get(v.Name) ?? -1) : -1,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async networks(): Promise<NetworkView[]> {
    const list = await this.options.engine.listNetworks()
    // 列表里不带容器，逐个 inspect（网络一般十来个）
    const detailed: RawNetworkDetail[] = await Promise.all(list.map((n) => this.options.engine.inspectNetwork(n.Id).catch((): RawNetworkDetail => ({ ...n, Containers: {} }))))
    return detailed
      .map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: Boolean(n.Internal),
        subnet: n.IPAM?.Config?.[0]?.Subnet ?? '',
        gateway: n.IPAM?.Config?.[0]?.Gateway ?? '',
        project: n.Labels?.['com.docker.compose.project'] ?? '',
        containers: Object.values(n.Containers ?? {})
          .map((c) => ({ name: c.Name, ip: (c.IPv4Address ?? '').replace(/\/\d+$/, '') }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        builtin: ['bridge', 'host', 'none'].includes(n.Name),
      }))
      .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name))
  }

  /**
   * 查一个镜像标签有没有更新：本地 RepoDigest vs 仓库当前 digest（经 dockerd 问仓库，复用它的凭据与代理）。
   * 失败不抛：一个仓库连不上不该让整页报错，结果标成 unknown 并给原因。
   */
  async checkUpdate(image: string): Promise<UpdateCheck> {
    const base: UpdateCheck = { image, status: 'unknown', local: '', remote: '', reason: '', checkedAt: Date.now() }
    // 按 ID 起的容器（image 字段是 sha256:… 或 64 位十六进制）没有标签可比
    if (/^sha256:/.test(image) || /^[0-9a-f]{64}$/.test(image)) return { ...base, reason: '按 ID 引用的镜像，没有标签可比' }
    let local: string
    try {
      const info = await this.options.engine.inspectImage(image)
      // RepoDigests 形如 repo@sha256:...；本地 build 的镜像没有
      const repo = image.replace(/:[^/:]+$/, '')
      local = (info.RepoDigests ?? []).find((d) => d.startsWith(`${repo}@`))?.split('@')[1] ?? info.RepoDigests?.[0]?.split('@')[1] ?? ''
      if (!local) return { ...base, reason: '本地构建的镜像（没有仓库 digest），没法比' }
    } catch (error) {
      return { ...base, reason: `读不到本地镜像：${(error as Error).message}` }
    }
    try {
      const remote = (await this.options.engine.distribution(image)).Descriptor.digest
      return { ...base, local, remote, status: remote === local ? 'current' : 'update', reason: '' }
    } catch (error) {
      return { ...base, local, reason: `问不到仓库：${(error as Error).message}` }
    }
  }

  async images(): Promise<ImageView[]> {
    const [images, containers] = await Promise.all([this.options.engine.listImages(), this.options.engine.listContainers()])
    const used = new Map<string, number>()
    for (const c of containers) if (c.ImageID) used.set(c.ImageID, (used.get(c.ImageID) ?? 0) + 1)
    return images
      .map((i) => {
        const tags = (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
        return { id: i.Id, tags, size: i.Size, created: i.Created * 1000, usedBy: used.get(i.Id) ?? 0, dangling: tags.length === 0 }
      })
      // 有标签的按名字排，悬空的放最后
      .sort((a, b) => Number(a.dangling) - Number(b.dangling) || (a.tags[0] ?? a.id).localeCompare(b.tags[0] ?? b.id))
  }

  /** 写操作之前先看是不是 Kura 自己（按 compose 标签判断，不信界面传来的标志）。 */
  async assertMutable(ref: string): Promise<RawInspect> {
    const raw = await this.options.engine.inspectContainer(ref)
    if (raw.Config.Labels?.['com.docker.compose.project'] === selfProject) {
      throw new DockerError(403, '这是 Kura 自己的容器（kura-server / kura-shell），不能从 Kura 里操作；它由 watchtower 更新')
    }
    return raw
  }
}

function toDetail(raw: RawInspect, brief: ContainerView | undefined): ContainerDetail {
  const labels = raw.Config.Labels ?? {}
  const project = labels['com.docker.compose.project'] ?? ''
  const base: ContainerView = brief ?? {
    id: raw.Id,
    name: raw.Name.replace(/^\//, ''),
    image: raw.Config.Image,
    state: raw.State.Status,
    status: raw.State.Status,
    health: (raw.State.Health?.Status as ContainerView['health']) ?? '',
    created: Date.parse(raw.Created),
    ports: [],
    project,
    service: labels['com.docker.compose.service'] ?? '',
    protected: project === selfProject,
  }
  const command = [...(raw.Config.Entrypoint ?? []), ...(raw.Config.Cmd ?? [])].join(' ')
  return {
    ...base,
    command,
    restartPolicy: raw.HostConfig.RestartPolicy?.Name || 'no',
    env: maskEnv(raw.Config.Env ?? []),
    mounts: (raw.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source || m.Name || '', destination: m.Destination, rw: m.RW })),
    networks: Object.keys(raw.NetworkSettings?.Networks ?? {}).sort(),
    labels,
    startedAt: raw.State.StartedAt,
    finishedAt: raw.State.FinishedAt,
    exitCode: raw.State.ExitCode,
    restartCount: raw.RestartCount,
  }
}

/** 和 `docker stats` 同一个算法：CPU 用两次采样的差，内存减掉页缓存。 */
export function toStats(raw: RawStats): ContainerStats {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage
  const systemDelta = (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0)
  const cpus = raw.cpu_stats.online_cpus ?? 1
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0
  const cache = raw.memory_stats.stats?.inactive_file ?? raw.memory_stats.stats?.cache ?? 0
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsage: Math.max(0, (raw.memory_stats.usage ?? 0) - cache),
    memoryLimit: raw.memory_stats.limit ?? 0,
  }
}
