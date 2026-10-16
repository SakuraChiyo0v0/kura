import http from 'node:http'
import { WebSocket } from 'ws'
import type { AutoUpdateRunResult, AutoUpdateStatus, ContainerDetail, ContainerStats, DockerOverview, ImageView, NetworkView, UpdateCheck, VolumeView } from './docker-types.js'

/**
 * 客户端这一侧的容器管理：连 kura-server 的内置服务 `docker`。
 *
 * 地址来自 `Mirror.internalEndpoint('docker')`（本机回环），和文件、终端同一条路：
 * 链路切换、会话续期都在映射层，这里只认一个 http://127.0.0.1:<端口>。
 */

/** kura-server 要求写操作带这个头（挡浏览器里的跨站表单，见 server/src/docker/handler.ts）。 */
const writeHeaders = { 'x-kura-docker': '1' }

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 审计里的一条（kura-server 的 AuditEntry 形状，只用到这些）。 */
export interface DockerActivity {
  at: string
  action: string
  detail: string
  exitCode?: number
  durationMs?: number
}

export type ProjectAction = 'up' | 'down' | 'restart' | 'pull'

/** 流式操作（日志、compose、拉镜像）：输出一段段来，最后给退出码。 */
export interface DockerStream {
  onData(listener: (text: string) => void): void
  /** 退出码；连接被关掉而没收到结束帧时是 undefined */
  done: Promise<number | undefined>
  close(): void
}

export class DockerClient {
  constructor(private readonly endpoint: () => Promise<string>) {}

  private async request(method: string, path: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
    const base = new URL(await this.endpoint())
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: base.hostname, port: base.port, method, path, agent: false, headers: method === 'GET' ? {} : writeHeaders },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        },
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${method} ${path}）`)))
      req.on('error', reject)
      req.end()
    })
  }

  private async json<T>(method: string, path: string, timeoutMs?: number): Promise<T> {
    const { status, body } = await this.request(method, path, timeoutMs)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new DockerApiError(status, status === 404 ? 'NAS 上的 kura-server 还没有容器管理（镜像太旧，等 watchtower 换新）' : `kura-server 返回的不是 JSON（HTTP ${status}）`)
    }
    if (status >= 400) throw new DockerApiError(status, (parsed as { error?: string }).error ?? `HTTP ${status}`)
    return parsed as T
  }

  overview(): Promise<DockerOverview> {
    return this.json('GET', '/api/overview')
  }

  container(id: string): Promise<ContainerDetail> {
    return this.json('GET', `/api/containers/${encodeURIComponent(id)}`)
  }

  /** Docker 的 stats 要等一个采样周期，给宽一点 */
  stats(id: string): Promise<ContainerStats> {
    return this.json('GET', `/api/containers/${encodeURIComponent(id)}/stats`, 15_000)
  }

  images(): Promise<ImageView[]> {
    return this.json('GET', '/api/images')
  }

  activity(limit = 50): Promise<DockerActivity[]> {
    return this.json('GET', `/api/activity?limit=${limit}`)
  }

  async logsText(id: string, tail = 5000): Promise<string> {
    const { status, body } = await this.request('GET', `/api/containers/${encodeURIComponent(id)}/logs?tail=${tail}`, 60_000)
    if (status >= 400) {
      let message = `HTTP ${status}`
      try {
        message = (JSON.parse(body) as { error?: string }).error ?? message
      } catch {
        // 纯文本错误
      }
      throw new DockerApiError(status, message)
    }
    return body
  }

  async containerAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    await this.json('POST', `/api/containers/${encodeURIComponent(id)}/${action}`, 60_000)
  }

  async removeContainer(id: string, force: boolean): Promise<void> {
    await this.json('DELETE', `/api/containers/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, 60_000)
  }

  async removeImage(id: string): Promise<void> {
    await this.json('DELETE', `/api/images/${encodeURIComponent(id)}`, 60_000)
  }

  async pruneImages(all: boolean): Promise<number> {
    return (await this.json<{ reclaimed: number }>('POST', `/api/images/prune${all ? '?all=1' : ''}`, 120_000)).reclaimed
  }

  // ---- 流式 ----

  private async stream(path: string, write: boolean): Promise<DockerStream> {
    const base = (await this.endpoint()).replace(/^http/, 'ws')
    const ws = new WebSocket(base + path, { headers: write ? writeHeaders : {}, handshakeTimeout: 20_000 })
    const listeners: Array<(text: string) => void> = []
    let code: number | undefined
    const done = new Promise<number | undefined>((resolve) => {
      ws.on('message', (data) => {
        const text = data.toString()
        // 结束帧是一个 JSON 对象；输出本身也可能是 JSON（日志常见），所以只认这一种精确形状
        if (text.startsWith('{"type":"exit"')) {
          try {
            code = (JSON.parse(text) as { code: number }).code
            return
          } catch {
            // 不是结束帧，当输出
          }
        }
        for (const l of listeners) l(text)
      })
      ws.on('unexpected-response', (_req, res) => {
        res.resume()
        for (const l of listeners) l(res.statusCode === 404 ? 'NAS 上的 kura-server 还没有这个功能（镜像太旧）\n' : `连接被拒绝：HTTP ${res.statusCode}\n`)
        resolve(undefined)
      })
      ws.on('error', (error) => {
        for (const l of listeners) l(`\n${error.message}\n`)
      })
      ws.on('close', () => resolve(code))
    })
    return { onData: (l) => listeners.push(l), done, close: () => ws.close() }
  }

  logs(id: string, tail = 500): Promise<DockerStream> {
    return this.stream(`/api/containers/${encodeURIComponent(id)}/logs?tail=${tail}`, false)
  }

  project(name: string, action: ProjectAction): Promise<DockerStream> {
    return this.stream(`/api/projects/${encodeURIComponent(name)}/${action}`, true)
  }

  pull(image: string): Promise<DockerStream> {
    return this.stream(`/api/images/pull?image=${encodeURIComponent(image)}`, true)
  }

  // ---- D4 ----

  volumes(withSize = false): Promise<VolumeView[]> {
    return this.json('GET', `/api/volumes${withSize ? '?size=1' : ''}`, 90_000)
  }

  networks(): Promise<NetworkView[]> {
    return this.json('GET', '/api/networks')
  }

  /** 问仓库这些镜像标签有没有新版（不拉镜像）。仓库慢，给宽一点。 */
  checkUpdates(images: string[]): Promise<UpdateCheck[]> {
    // 真机上问一个镜像要二三十秒（服务端 4 个并发）：十几个镜像得几分钟
    return this.send('POST', '/api/updates', { images }, 600_000)
  }

  // ---- 按项目的自动更新 ----

  /** 开了自动更新的项目 + 上一轮结果。 */
  autoUpdate(): Promise<AutoUpdateStatus> {
    return this.json('GET', '/api/auto')
  }

  /** 开 / 关某个项目的自动更新；返回改完的状态。 */
  setAutoUpdate(name: string, on: boolean): Promise<AutoUpdateStatus> {
    return this.send('POST', `/api/auto/${encodeURIComponent(name)}/${on ? 'on' : 'off'}`, {})
  }

  /** 立刻跑一轮。真机上 pull 要几分钟，给宽一点。所有开了开关的项目一起跑。 */
  runAutoUpdate(): Promise<AutoUpdateRunResult[]> {
    return this.send('POST', '/api/auto/run', {}, 1_800_000)
  }

  /**
   * 进容器 shell：一条双向 WebSocket。上行文本 = 键盘输入，`{"type":"resize"}` = 改尺寸；下行 = 输出。
   * 和 nas-console 终端同一个协议，界面可以复用 xterm 那套。
   */
  async shell(id: string, cols: number, rows: number): Promise<WebSocket> {
    const base = (await this.endpoint()).replace(/^http/, 'ws')
    return new WebSocket(`${base}/api/containers/${encodeURIComponent(id)}/shell?cols=${Math.round(cols)}&rows=${Math.round(rows)}`, { headers: writeHeaders, handshakeTimeout: 20_000 })
  }

  /** 删除项目：两个勾默认都不勾 = 只停掉并移除容器 */
  removeProject(name: string, options: { volumes: boolean; files: boolean }): Promise<DockerStream> {
    return this.stream(`/api/projects/${encodeURIComponent(name)}/remove?volumes=${options.volumes ? 1 : 0}&files=${options.files ? 1 : 0}`, true)
  }

  // ---- 项目文件（D3）----

  projectFiles(name: string): Promise<ProjectFilesView> {
    return this.json('GET', `/api/projects/${encodeURIComponent(name)}/files`)
  }

  saveProjectFiles(name: string, next: { compose: Array<{ path: string; content: string }>; env?: string }): Promise<ProjectFilesView> {
    return this.send('PUT', `/api/projects/${encodeURIComponent(name)}/files`, next)
  }

  createProject(input: { name: string; compose: string; env?: string }): Promise<{ dir: string; configFiles: string[] }> {
    return this.send('POST', '/api/projects', input)
  }

  private async send<T>(method: string, path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
    const base = new URL(await this.endpoint())
    const payload = JSON.stringify(body)
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: base.hostname, port: base.port, method, path, agent: false, headers: { ...writeHeaders, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        },
      )
      // compose config 校验、问仓库都要跑一会
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${method} ${path}）`)))
      req.on('error', reject)
      req.end(payload)
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new DockerApiError(status, status === 404 ? 'NAS 上的 kura-server 还没有这个功能（镜像太旧）' : `kura-server 返回的不是 JSON（HTTP ${status}）`)
    }
    if (status >= 400) throw new DockerApiError(status, (parsed as { error?: string }).error ?? `HTTP ${status}`)
    return parsed as T
  }
}

export interface ProjectFilesView {
  compose: Array<{ path: string; content: string }>
  env: { path: string; content: string; exists: boolean }
  backups: string[]
}
