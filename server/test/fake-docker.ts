import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawContainer, RawImage, RawInspect, RawNetworkDetail, RawVolume } from '../src/docker/engine.js'

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * 假 dockerd：在 unix socket（Windows 上是命名管道）上应答 Engine API 的那十来个接口。
 * 状态都在内存里，测试直接改字段；`calls` 记下每个请求，好断言「没调不该调的」。
 */
export class FakeDocker {
  readonly server = http.createServer((req, res) => this.handle(req, res))
  socketPath = ''
  calls: string[] = []
  containers: Array<RawContainer & { env?: string[]; running?: boolean }> = []
  images: RawImage[] = []
  /** 日志内容（多路复用帧格式由 frame() 生成） */
  logs = new Map<string, Buffer>()
  pullLines: string[] = []

  volumes: RawVolume[] = []
  networks: RawNetworkDetail[] = []
  /** 镜像标签 → 本地 RepoDigests */
  repoDigests = new Map<string, string[]>()
  /** 镜像标签 → 仓库里现在的 digest（没有就模拟仓库要认证） */
  remoteDigests = new Map<string, string>()
  execs = new Map<string, { container: string; cmd: string[]; resized: string[]; tty: boolean; exitCode: number }>()
  /** 非 TTY exec 启动时要吐出的分帧输出（数据库命令执行用）。键是 exec id。 */
  execOutput = new Map<string, Buffer>()
  /** 测试注入：非 TTY exec 起来后自己接管（用于「不结束，等超时」这类用例）。 */
  onExecStart?: (exec: { container: string; cmd: string[]; resized: string[]; tty: boolean; exitCode: number }, socket: import('node:stream').Duplex) => void

  async start(): Promise<this> {
    // exec start 是协议升级（Docker 用 `Upgrade: tcp` 接管连接）：接管后回显输入，像一个 shell
    this.server.on('upgrade', (req, socket) => {
      // 接管后的连接不归 closeAllConnections 管：记下来，stop() 时自己关，否则 close 永远等不到
      this.upgraded.add(socket)
      socket.on('close', () => this.upgraded.delete(socket))
      const m = /^\/v1\.\d+\/exec\/([^/]+)\/start$/.exec(req.url ?? '')
      const exec = m ? this.execs.get(m[1]!) : undefined
      this.calls.push(`UPGRADE ${req.url}`)
      if (!exec) {
        socket.end('HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"No such exec instance"}')
        return
      }
      socket.write('HTTP/1.1 101 UPGRADED\r\ncontent-type: application/vnd.docker.raw-stream\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n')
      // 非 TTY：吐调用方预置的分帧输出（stdout/stderr 各一帧），然后结束。
      // 需要接输入才吐的测试（超时用例）用 onStart 钩子自己写。
      if (!exec.tty) {
        if (this.onExecStart) this.onExecStart(exec, socket)
        else {
          socket.write(this.execOutput.get(m![1]!) ?? Buffer.alloc(0))
          socket.end()
        }
        socket.on('error', () => {})
        return
      }
      socket.write(`${exec.container}:/# `)
      socket.on('data', (d: Buffer) => {
        const text = d.toString()
        if (text.trim() === 'exit') return socket.end()
        socket.write(text)
      })
    })
    this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\kura-fake-docker-${randomBytes(6).toString('hex')}` : join(tmpdir(), `kura-fake-docker-${randomBytes(6).toString('hex')}.sock`)
    await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve))
    return this
  }

  private readonly upgraded = new Set<import('node:stream').Duplex>()

  stop(): Promise<void> {
    for (const s of this.upgraded) s.destroy()
    this.server.closeAllConnections()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  addContainer(name: string, options: { project?: string; service?: string; dir?: string; files?: string; state?: string; image?: string; env?: string[]; ports?: RawContainer['Ports'] } = {}): RawContainer {
    const labels: Record<string, string> = {}
    if (options.project) {
      labels['com.docker.compose.project'] = options.project
      labels['com.docker.compose.service'] = options.service ?? name
      labels['com.docker.compose.project.working_dir'] = options.dir ?? `/volume1/docker/${options.project}`
      labels['com.docker.compose.project.config_files'] = options.files ?? `${options.dir ?? `/volume1/docker/${options.project}`}/docker-compose.yaml`
    }
    const state = options.state ?? 'running'
    const c = {
      Id: randomBytes(32).toString('hex'),
      Names: [`/${name}`],
      Image: options.image ?? `${name}:latest`,
      ImageID: `sha256:${name}`,
      State: state,
      Status: state === 'running' ? 'Up 2 hours (healthy)' : 'Exited (0) 3 minutes ago',
      Created: 1_700_000_000,
      Ports: options.ports ?? [],
      Labels: labels,
      env: options.env ?? [],
    }
    this.containers.push(c)
    return c
  }

  private find(ref: string) {
    return this.containers.find((c) => c.Id === ref || c.Id.startsWith(ref) || c.Names?.[0] === `/${ref}`)
  }

  private inspect(c: (typeof this.containers)[number]): RawInspect {
    return {
      Id: c.Id,
      Name: c.Names![0]!,
      Created: new Date(c.Created * 1000).toISOString(),
      Path: '/bin/app',
      Args: [],
      RestartCount: 0,
      State: { Status: c.State, Running: c.State === 'running', ExitCode: 0, StartedAt: '2026-10-15T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' },
      Config: { Image: c.Image, Env: c.env, Labels: c.Labels, Cmd: ['serve'], Entrypoint: ['/bin/app'] },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Mounts: [{ Type: 'bind', Source: '/volume1/docker/x/data', Destination: '/data', RW: true }],
      NetworkSettings: { Networks: { 'sso-net': {} } },
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://docker')
    const path = url.pathname.replace(/^\/v1\.\d+/, '')
    this.calls.push(`${req.method} ${path}${url.search}`)
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const m = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(path)

    if (req.method === 'GET' && path === '/containers/json') return send(200, this.containers.map(({ env: _env, running: _r, ...c }) => c))
    if (req.method === 'GET' && path === '/images/json') return send(200, this.images)
    if (m) {
      const c = this.find(decodeURIComponent(m[1]!))
      if (!c) return send(404, { message: `No such container: ${m[1]}` })
      const verb = m[2]
      if (req.method === 'GET' && verb === 'json') return send(200, this.inspect(c))
      if (req.method === 'GET' && verb === 'stats') {
        return send(200, {
          cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
          memory_stats: { usage: 150 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { inactive_file: 50 * 1024 * 1024 } },
        })
      }
      if (req.method === 'GET' && verb === 'logs') {
        res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' })
        res.write(this.logs.get(c.Names![0]!.slice(1)) ?? Buffer.alloc(0))
        if (url.searchParams.get('follow') !== '1') res.end() // follow 时保持连接，等客户端断
        return
      }
      if (req.method === 'POST' && verb === 'start') {
        if (c.State === 'running') return send(304)
        c.State = 'running'
        return send(204)
      }
      if (req.method === 'POST' && verb === 'stop') {
        if (c.State !== 'running') return send(304)
        c.State = 'exited'
        return send(204)
      }
      if (req.method === 'POST' && verb === 'restart') {
        c.State = 'running'
        return send(204)
      }
      if (req.method === 'DELETE' && !verb) {
        if (c.State === 'running' && url.searchParams.get('force') !== '1') return send(409, { message: 'cannot remove a running container' })
        this.containers = this.containers.filter((x) => x !== c)
        return send(204)
      }
    }
    const img = /^\/images\/([^/]+)$/.exec(path)
    if (req.method === 'DELETE' && img) {
      const ref = decodeURIComponent(img[1]!)
      const image = this.images.find((i) => i.Id === ref || i.RepoTags?.includes(ref))
      if (!image) return send(404, { message: `No such image: ${ref}` })
      if (this.containers.some((c) => c.ImageID === image.Id)) return send(409, { message: 'image is being used by running container' })
      this.images = this.images.filter((i) => i !== image)
      return send(200, [{ Deleted: image.Id }])
    }
    if (req.method === 'POST' && path === '/images/prune') return send(200, { SpaceReclaimed: 1234 })
    if (req.method === 'GET' && path === '/volumes') return send(200, { Volumes: this.volumes })
    if (req.method === 'GET' && path === '/system/df') return send(200, { Volumes: this.volumes.map((v) => ({ Name: v.Name, UsageData: { Size: 4096, RefCount: 1 } })) })
    if (req.method === 'GET' && path === '/networks') return send(200, this.networks)
    const netm = /^\/networks\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && netm) {
      const n = this.networks.find((x) => x.Id === decodeURIComponent(netm[1]!))
      return n ? send(200, n) : send(404, { message: 'network not found' })
    }
    const imgJson = /^\/images\/(.+)\/json$/.exec(path)
    if (req.method === 'GET' && imgJson) {
      const ref = decodeURIComponent(imgJson[1]!)
      const image = this.images.find((i) => i.Id === ref || i.RepoTags?.includes(ref))
      return image ? send(200, { Id: image.Id, RepoTags: image.RepoTags, RepoDigests: this.repoDigests.get(ref) ?? [] }) : send(404, { message: `No such image: ${ref}` })
    }
    const dist = /^\/distribution\/(.+)\/json$/.exec(path)
    if (req.method === 'GET' && dist) {
      const ref = decodeURIComponent(dist[1]!)
      const digest = this.remoteDigests.get(ref)
      return digest ? send(200, { Descriptor: { digest } }) : send(401, { message: 'unauthorized: authentication required' })
    }
    const execCreate = /^\/containers\/([^/]+)\/exec$/.exec(path)
    if (req.method === 'POST' && execCreate) {
      const c = this.find(decodeURIComponent(execCreate[1]!))
      if (!c) return send(404, { message: 'No such container' })
      void readJson(req).then((body) => {
        const spec = body as { Cmd: string[]; Tty?: boolean }
        const id = randomBytes(32).toString('hex')
        this.execs.set(id, { container: c.Names![0]!.slice(1), cmd: spec.Cmd, resized: [], tty: spec.Tty !== false, exitCode: 0 })
        send(201, { Id: id })
      })
      return
    }
    const execJson = /^\/exec\/([^/]+)\/json$/.exec(path)
    if (req.method === 'GET' && execJson) {
      const exec = this.execs.get(execJson[1]!)
      return exec ? send(200, { Running: false, ExitCode: exec.exitCode }) : send(404, { message: 'No such exec instance' })
    }
    const execResize = /^\/exec\/([^/]+)\/resize$/.exec(path)
    if (req.method === 'POST' && execResize) {
      this.execs.get(execResize[1]!)?.resized.push(`${url.searchParams.get('w')}x${url.searchParams.get('h')}`)
      return send(201)
    }
    if (req.method === 'POST' && path === '/images/create') {
      res.writeHead(200, { 'content-type': 'application/json' })
      for (const line of this.pullLines) res.write(line + '\n')
      res.end()
      return
    }
    send(404, { message: `page not found: ${req.method} ${path}` })
  }
}

/** 拼一帧 Docker 多路复用日志（1 = stdout，2 = stderr）。 */
export function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(8)
  head[0] = stream
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}
