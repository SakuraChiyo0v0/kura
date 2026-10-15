import http from 'node:http'
import type net from 'node:net'
import type { Readable } from 'node:stream'

/**
 * Docker Engine API 的最小客户端（经 unix socket）。
 *
 * **docker.sock 等于宿主 root**，所以这里不提供「随便发一个请求」的口子：
 * 每个能调的接口都是下面一个具名方法，路径在代码里写死、参数逐个校验。
 * 要加用途就在这里加一个方法 —— 别加一个通用的 `request(path)` 出去（compose 里 sock 的 `:ro`
 * 挡不住经 socket 发的写请求，真正的边界只有这张表）。
 *
 * 不跟 dockerode：它是整套 API 的透传，正是这里要避免的形状；我们用到的十来个接口手写更清楚。
 */

/** 容器 / 镜像 id 或名字：Docker 自己的字符集，挡掉路径穿越与查询串注入。 */
const refRe = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,254}$/

export function checkRef(ref: string): string {
  if (!refRe.test(ref) || ref.includes('..')) throw new DockerError(400, `不合法的名字：${JSON.stringify(ref)}`)
  return ref
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface EngineOptions {
  socketPath: string
  /** 单次请求超时；流式接口（日志、拉镜像）不受它限制 */
  timeoutMs?: number
}

/** Docker 返回的原始结构，只声明用到的字段。 */
export interface RawContainer {
  Id: string
  Names?: string[]
  Image: string
  ImageID?: string
  State: string
  Status: string
  Created: number
  Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string; IP?: string }>
  Labels?: Record<string, string>
  Mounts?: Array<{ Type: string; Name?: string; Source?: string; Destination?: string }>
}

export interface RawInspect {
  Id: string
  Name: string
  Created: string
  Path: string
  Args: string[]
  RestartCount: number
  State: { Status: string; Running: boolean; ExitCode: number; StartedAt: string; FinishedAt: string; Health?: { Status: string } }
  Config: { Image: string; Env?: string[]; Labels?: Record<string, string>; Cmd?: string[] | null; Entrypoint?: string[] | null }
  HostConfig: { RestartPolicy?: { Name: string } }
  Mounts?: Array<{ Type: string; Source?: string; Name?: string; Destination: string; RW: boolean }>
  NetworkSettings?: { Networks?: Record<string, unknown>; Ports?: Record<string, Array<{ HostPort: string }> | null> }
}

export interface RawImage {
  Id: string
  RepoTags?: string[] | null
  Size: number
  Created: number
  Containers?: number
}

export interface RawVolume {
  Name: string
  Driver: string
  Mountpoint: string
  CreatedAt?: string
  Labels?: Record<string, string> | null
}

export interface RawNetwork {
  Id: string
  Name: string
  Driver: string
  Scope: string
  Internal?: boolean
  Labels?: Record<string, string> | null
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null }
}

export interface RawNetworkDetail extends RawNetwork {
  Containers?: Record<string, { Name: string; IPv4Address?: string }>
}

export interface RawStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number }
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
  memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } }
}

export class DockerEngine {
  constructor(private readonly options: EngineOptions) {}

  // ---- 只读 ----

  listContainers(): Promise<RawContainer[]> {
    return this.json('GET', '/containers/json?all=1')
  }

  inspectContainer(ref: string): Promise<RawInspect> {
    return this.json('GET', `/containers/${encodeURIComponent(checkRef(ref))}/json`)
  }

  /** 一次性取样（stream=false 时 Docker 会等一个采样周期，约 1–2 秒） */
  containerStats(ref: string): Promise<RawStats> {
    return this.json('GET', `/containers/${encodeURIComponent(checkRef(ref))}/stats?stream=false`)
  }

  listImages(): Promise<RawImage[]> {
    return this.json('GET', '/images/json')
  }

  /**
   * 日志流（原始字节）。容器没开 TTY 时是 Docker 的多路复用帧，调用方用 `demuxLogs` 解开。
   * `follow` 为真时连接一直开着，调用方负责销毁。
   */
  logs(ref: string, options: { tail: number; follow: boolean; timestamps?: boolean }): Promise<Readable> {
    const tail = Math.max(0, Math.min(Math.floor(options.tail), 10_000))
    const q = `stdout=1&stderr=1&tail=${tail}&follow=${options.follow ? 1 : 0}&timestamps=${options.timestamps ? 1 : 0}`
    return this.stream('GET', `/containers/${encodeURIComponent(checkRef(ref))}/logs?${q}`)
  }

  // ---- D4：卷、网络、镜像更新 ----

  listVolumes(): Promise<{ Volumes: RawVolume[] | null }> {
    return this.json('GET', '/volumes')
  }

  /** 卷的占用要另外问（`docker system df -v` 那个接口）；较慢，界面上点了才查 */
  diskUsage(): Promise<{ Volumes?: Array<{ Name: string; UsageData?: { Size: number; RefCount: number } }> }> {
    return this.json('GET', '/system/df?type=volume', 60_000)
  }

  listNetworks(): Promise<RawNetwork[]> {
    return this.json('GET', '/networks')
  }

  inspectNetwork(ref: string): Promise<RawNetworkDetail> {
    return this.json('GET', `/networks/${encodeURIComponent(checkRef(ref))}`)
  }

  inspectImage(ref: string): Promise<{ Id: string; RepoTags?: string[]; RepoDigests?: string[] }> {
    return this.json('GET', `/images/${encodeURIComponent(checkRef(ref))}/json`)
  }

  /**
   * 仓库里这个标签现在的 digest：经 dockerd 去问（`docker buildx imagetools` 那条路），
   * dockerd 自己的仓库凭据、代理都复用，Kura 不碰仓库凭据。
   */
  distribution(image: string): Promise<{ Descriptor: { digest: string } }> {
    // 真机实测一次 26.7 秒（2026-10-15，NAS 配了国内镜像代理，问 Docker Hub 慢）：给 60 秒
    return this.json('GET', `/distribution/${encodeURIComponent(checkRef(image))}/json`, 60_000)
  }

  // ---- D4：进容器 shell ----

  /** 建一个 exec（交互、带 TTY）；返回 exec id。cmd 只能是下面 shellCandidates 里的一个。 */
  async createExec(ref: string, cmd: string[]): Promise<string> {
    const body = JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd })
    const res = await this.withTimeout(this.raw('POST', `/containers/${encodeURIComponent(checkRef(ref))}/exec`, body))
    if ((res.statusCode ?? 500) >= 300) throw await this.failure(res)
    return (JSON.parse(await this.read(res)) as { Id: string }).Id
  }

  /** 启动 exec 并接管连接：返回双向的原始 socket（TTY 模式下没有多路复用帧）。 */
  startExec(execId: string): Promise<net.Socket> {
    const id = checkRef(execId)
    const body = JSON.stringify({ Detach: false, Tty: true })
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.options.socketPath,
        path: `/v1.43/exec/${encodeURIComponent(id)}/start`,
        method: 'POST',
        headers: { host: 'docker', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'Upgrade', upgrade: 'tcp' },
      })
      req.on('upgrade', (_res, socket, head) => {
        if (head.length) socket.unshift(head)
        resolve(socket as net.Socket)
      })
      req.on('response', (res) => {
        void this.failure(res).then(reject)
      })
      req.on('error', (error) => reject(new DockerError(502, `连不上 Docker：${error.message}`)))
      req.end(body)
    })
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    const w = Math.max(1, Math.min(Math.round(cols), 1000))
    const h = Math.max(1, Math.min(Math.round(rows), 1000))
    await this.empty('POST', `/exec/${encodeURIComponent(checkRef(execId))}/resize?h=${h}&w=${w}`, [200, 201])
  }

  inspectExec(execId: string): Promise<{ Running: boolean; ExitCode: number | null }> {
    return this.json('GET', `/exec/${encodeURIComponent(checkRef(execId))}/json`)
  }

  // ---- 写（D2）----

  async start(ref: string): Promise<void> {
    await this.empty('POST', `/containers/${encodeURIComponent(checkRef(ref))}/start`, [204, 304])
  }

  async stop(ref: string): Promise<void> {
    await this.empty('POST', `/containers/${encodeURIComponent(checkRef(ref))}/stop?t=10`, [204, 304])
  }

  async restart(ref: string): Promise<void> {
    await this.empty('POST', `/containers/${encodeURIComponent(checkRef(ref))}/restart?t=10`, [204])
  }

  async removeContainer(ref: string, force: boolean): Promise<void> {
    await this.empty('DELETE', `/containers/${encodeURIComponent(checkRef(ref))}?force=${force ? 1 : 0}`, [204])
  }

  async removeImage(ref: string): Promise<void> {
    // 不 force：被容器用着的镜像 Docker 自己会回 409，正是我们要的「用着的不能删」
    await this.empty('DELETE', `/images/${encodeURIComponent(checkRef(ref))}`, [200])
  }

  /** 清理镜像：只清悬空的，或所有没被用到的。返回回收的字节数。 */
  async pruneImages(all: boolean): Promise<number> {
    const filters = encodeURIComponent(JSON.stringify({ dangling: [all ? 'false' : 'true'] }))
    const result = await this.json<{ SpaceReclaimed?: number }>('POST', `/images/prune?filters=${filters}`)
    return result.SpaceReclaimed ?? 0
  }

  /** 拉镜像：返回 Docker 的进度流（每行一个 JSON）。 */
  pull(image: string): Promise<Readable> {
    const ref = checkRef(image)
    const at = ref.lastIndexOf(':')
    const slash = ref.lastIndexOf('/')
    // 冒号在最后一个斜杠后面才是 tag（registry:5000/repo 里那个冒号是端口）
    const [name, tag] = at > slash ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest']
    return this.stream('POST', `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`)
  }

  // ---- 底层 ----

  private raw(method: string, path: string, body?: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { host: 'docker' }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = Buffer.byteLength(body)
      }
      const req = http.request({ socketPath: this.options.socketPath, path: `/v1.43${path}`, method, headers }, resolve)
      req.on('error', (error) => reject(new DockerError(502, `连不上 Docker：${error.message}`)))
      req.end(body)
    })
  }

  private async read(res: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of res) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  private async failure(res: http.IncomingMessage): Promise<DockerError> {
    const body = await this.read(res)
    let message = body.trim()
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? message
    } catch {
      // 不是 JSON 就原样给
    }
    return new DockerError(res.statusCode ?? 502, message || `Docker 返回 HTTP ${res.statusCode}`)
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs?: number): Promise<T> {
    const ms = timeoutMs ?? this.options.timeoutMs ?? 30_000
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DockerError(504, `Docker 超过 ${ms / 1000} 秒没响应`)), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private json<T>(method: string, path: string, timeoutMs?: number): Promise<T> {
    return this.withTimeout(
      (async () => {
        const res = await this.raw(method, path)
        if ((res.statusCode ?? 500) >= 300) throw await this.failure(res)
        return JSON.parse(await this.read(res)) as T
      })(),
      timeoutMs,
    )
  }

  private empty(method: string, path: string, ok: number[]): Promise<void> {
    return this.withTimeout(
      (async () => {
        const res = await this.raw(method, path)
        if (!ok.includes(res.statusCode ?? 0)) throw await this.failure(res)
        res.resume()
      })(),
    )
  }

  private async stream(method: string, path: string): Promise<Readable> {
    const res = await this.raw(method, path)
    if ((res.statusCode ?? 500) >= 300) throw await this.failure(res)
    return res
  }
}

/**
 * 解 Docker 日志的多路复用帧：每帧 8 字节头（[流, 0, 0, 0, 长度 BE32]）+ 内容。
 * 容器开了 TTY 时没有帧头、是原样字节 —— 头一个字节不是 0/1/2 就按原样处理。
 * 返回一个「喂字节 → 吐文本」的函数，跨块的半帧会留到下一次。
 */
export function createLogDemuxer(): (chunk: Buffer) => string {
  let pending: Buffer = Buffer.alloc(0)
  let raw: boolean | undefined
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    if (raw === undefined && pending.length > 0) raw = pending[0]! > 2 || (pending.length >= 4 && (pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0))
    if (raw) {
      const out = pending.toString('utf8')
      pending = Buffer.alloc(0)
      return out
    }
    let out = ''
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4)
      if (pending.length < 8 + size) break
      out += pending.subarray(8, 8 + size).toString('utf8')
      pending = pending.subarray(8 + size)
    }
    return out
  }
}
