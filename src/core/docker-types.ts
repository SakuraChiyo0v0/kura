/**
 * 容器管理的数据形状：kura-server 的 `docker` 内置服务产出、客户端「容器」页消费，两边共用这一份。
 * 只放类型与纯函数，不碰网络（server/ 也会打包它）。设计见 docs/容器管理 设计.md。
 */

export type ContainerState = 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing'

export interface PortView {
  /** 容器内端口 */
  private: number
  /** 发布到宿主的端口；0 = 没发布 */
  public: number
  type: 'tcp' | 'udp' | string
}

export interface ContainerView {
  id: string
  name: string
  image: string
  state: ContainerState | string
  /** Docker 给的人话状态，如 "Up 3 hours (healthy)" */
  status: string
  /** 健康检查：没配就是空 */
  health: 'healthy' | 'unhealthy' | 'starting' | ''
  created: number
  ports: PortView[]
  /** 所属 compose 项目；单独起的容器为空 */
  project: string
  service: string
  /** Kura 自己（kura-server / kura-shell）：只读，界面不给操作按钮 */
  protected: boolean
}

export type ProjectStatus = 'running' | 'partial' | 'stopped'

/** 项目能做什么，由它在哪个目录决定（见设计 §七）。 */
export type ProjectKind =
  /** 在项目目录（/volume1/docker）下：能启停、能编辑 */
  | 'managed'
  /** 绿联应用商店装的：能启停，不能改 compose（商店升级会覆盖） */
  | 'appstore'
  /** 别处的（/tmp 之类）：只读，最多停止并移除 */
  | 'external'
  /** Kura 自己：只读 */
  | 'self'

export interface ProjectView {
  name: string
  status: ProjectStatus
  kind: ProjectKind
  /** 项目目录（宿主路径）；只在目录里发现、还没起过的项目也有 */
  dir: string
  configFiles: string[]
  /** 已有容器数（含停止的） */
  containers: number
  running: number
  services: string[]
}

export interface ImageView {
  id: string
  tags: string[]
  size: number
  created: number
  /** 被几个容器用着（含停止的）；>0 时不能删 */
  usedBy: number
  /** 没有标签的悬空镜像 */
  dangling: boolean
}

export interface MountView {
  type: string
  source: string
  destination: string
  rw: boolean
}

export interface ContainerDetail extends ContainerView {
  command: string
  restartPolicy: string
  /** 只给变量名与「值是否被遮住」：值默认不出 NAS（里面常有密码） */
  env: Array<{ name: string; value: string; masked: boolean }>
  mounts: MountView[]
  networks: string[]
  labels: Record<string, string>
  startedAt: string
  finishedAt: string
  exitCode: number
  restartCount: number
}

export interface ContainerStats {
  /** 0–100 * 核数，和 docker stats 一样 */
  cpuPercent: number
  memoryUsage: number
  memoryLimit: number
}

export interface VolumeView {
  name: string
  driver: string
  mountpoint: string
  created: number
  /** 属于哪个 compose 项目（卷上的 com.docker.compose.project 标签） */
  project: string
  /** 正在用它的容器名 */
  usedBy: string[]
  /** 占用字节数；-1 = 没查（要点「计算占用」才查，较慢） */
  size: number
}

export interface NetworkView {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  subnet: string
  gateway: string
  project: string
  containers: Array<{ name: string; ip: string }>
  /** bridge / host / none：Docker 自带的，不显示删除之类的东西 */
  builtin: boolean
}

/**
 * 镜像有没有更新（借 Arcane 的「digest 更新」）：拿本地镜像的 RepoDigest 和仓库里同一个标签现在的 digest 比。
 * 只做提示，不自动更新（NAS 上已经有 watchtower）。
 */
export interface UpdateCheck {
  image: string
  /** 'update' 有新版；'current' 已是最新；'unknown' 查不了（本地构建的、没有 RepoDigest、仓库连不上） */
  status: 'update' | 'current' | 'unknown'
  local: string
  remote: string
  reason: string
  checkedAt: number
}

export interface DockerOverview {
  containers: ContainerView[]
  projects: ProjectView[]
}

/** 名字里像是放密码的环境变量：值默认遮住。 */
const secretName = /(pass|secret|token|key|credential|auth|private|cookie|session)/i

export function maskEnv(entries: string[]): ContainerDetail['env'] {
  return entries.map((entry) => {
    const at = entry.indexOf('=')
    const name = at < 0 ? entry : entry.slice(0, at)
    const value = at < 0 ? '' : entry.slice(at + 1)
    const masked = secretName.test(name)
    return { name, value: masked ? '' : value, masked }
  })
}

/** 项目整体状态：全跑 / 部分跑 / 全停。 */
export function projectStatus(running: number, total: number): ProjectStatus {
  if (total > 0 && running === total) return 'running'
  if (running > 0) return 'partial'
  return 'stopped'
}
