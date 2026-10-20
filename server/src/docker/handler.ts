import type http from 'node:http'
import type net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { errorMessage } from '../../../src/core/errors.js'
import { humanBytes } from '../../../src/core/stats.js'
import type { AuditEntry } from '../shell/audit.js'
import { checkProjectName, runCompose, type ComposeAction, type ComposeRun, type ComposeTarget } from './compose.js'
import type { AutoUpdate } from './autoupdate.js'
import { ProjectLocks } from './locks.js'
import type { ProjectFileStore } from './files.js'
import type { UpdateCheck } from '../../../src/core/docker-types.js'
import { DockerError, checkRef, createLogDemuxer, type DockerEngine } from './engine.js'
import type { DockerService } from './service.js'

/**
 * kura-server 内置服务 `docker`：客户端经映射层（`internalEndpoint('docker')`）连进来。
 *
 * HTTP（JSON）：
 *   GET    /api/overview                    容器 + 项目
 *   GET    /api/containers/:id              详情（环境变量里像密码的值遮住）
 *   GET    /api/containers/:id/stats        一次性 CPU / 内存
 *   GET    /api/containers/:id/logs?tail=   最近日志（纯文本，下载用）
 *   GET    /api/images
 *   GET    /api/activity                    最近审计
 *   POST   /api/containers/:id/{start,stop,restart}
 *   DELETE /api/containers/:id?force=1
 *   DELETE /api/images/:id
 *   POST   /api/images/prune?all=1
 * WebSocket（流式，最后一帧是 `{"type":"exit","code":N}`）：
 *   /api/containers/:id/logs?tail=          实时日志（文本帧）
 *   /api/projects/:name/{up,down,restart,pull}
 *   /api/projects/:name/remove?volumes=1&files=1   删除项目（两个都默认不删）
 *   /api/images/pull?image=
 *   /api/images/prune?all=1                 清理镜像（all=1 清所有未使用的，默认只清悬空的）
 * 项目文件（D3，只限项目目录下的项目）：
 *   GET  /api/projects/:name/files      compose 与 .env 的内容、备份列表
 *   PUT  /api/projects/:name/files      {compose:[{path,content}], env?} —— 先校验、再备份、再原子替换
 *   POST /api/projects                  {name, compose, env?} 新建
 * 按项目的自动更新（沿用容器管理那套开关；挂在同一个内置服务下，不新增内置服务名）：
 *   GET  /api/auto                      开了自动更新的项目 + 上一轮结果
 *   POST /api/auto/run                  立刻跑一轮（不开调度也能手动触发）
 *   POST /api/auto/:项目名/{on,off}     开 / 关某个项目的自动更新
 *
 * 每个写操作都进审计；Kura 自己的容器 / 项目一律拒绝写（DockerService.assertMutable）。
 */

export type AuditSink = (entry: Omit<AuditEntry, 'at' | 'id' | 'user' | 'action'> & { action: `docker-${string}` }) => void

export interface DockerHandlerOptions {
  service: DockerService
  engine: DockerEngine
  audit: AuditSink
  activity: (limit: number) => AuditEntry[]
  /** 项目文件读写（D3）；没给就没有编辑功能 */
  files?: ProjectFileStore
  /** 按项目的自动更新；没给就没有这个功能 */
  autoupdate?: AutoUpdate
  /** 项目级 compose 锁；不给就自己造一个（自动更新要传同一个进来，见 locks.ts） */
  locks?: ProjectLocks
  /** 测试注入：换掉真的 docker compose */
  compose?: (target: ComposeTarget, action: ComposeAction) => ComposeRun
  log?: (message: string, fields?: Record<string, unknown>) => void
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const fail = (res: http.ServerResponse, error: unknown): void => {
  // 文件那边（files.ts）的错误也带 status，但不是 DockerError
  const status = error instanceof DockerError ? error.status : Number((error as { status?: unknown })?.status) || 500
  json(res, status >= 400 && status < 600 ? status : 500, { error: errorMessage(error) })
}

const ip = (req: http.IncomingMessage): string => req.socket.remoteAddress ?? ''

async function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new DockerError(413, '请求体过大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new DockerError(400, '请求体不是 JSON')
  }
}

/** 写操作要能识别出「是 Kura 发来的写请求」：浏览器里的跨站表单发不出自定义头。 */
const writeHeader = 'x-kura-docker'

/** 进容器 shell 时只能选这几个；不接受任意命令（exec 任意命令就是另一个终端了） */
export const shellCandidates = ['/bin/bash', '/bin/ash', '/bin/sh', '/bin/zsh']

/**
 * exec 的命令。指定了就直接用；没指定就在容器里挑一个有的（bash → ash → sh）。
 * 挑选用一行**写死的** sh 脚本：不拼任何外部输入，没有注入面；`exec` 换掉 sh 自己，退出码就是那个 shell 的。
 */
export function shellCommand(wanted: string): string[] {
  if (wanted) return [wanted]
  return ['/bin/sh', '-c', 'for s in /bin/bash /bin/ash; do [ -x "$s" ] && exec "$s"; done; exec /bin/sh']
}

export function createDockerHandler(options: DockerHandlerOptions): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void
} {
  const { service, engine } = options
  const compose = options.compose ?? runCompose
  const log = options.log ?? (() => {})
  const wss = new WebSocketServer({ noServer: true })
  // 同一个项目同时只能有一个 compose 动作。这把锁**和自动更新共用**（见 locks.ts）：
  // 自动更新在 pull + up 的时候，用户点「重启」必须被挡住，否则两边动同一批容器。
  const locks = options.locks ?? new ProjectLocks()

  /** 能改文件、能删的项目：只有项目目录下的（managed）。 */
  const editable = async (name: string) => {
    const project = await service.project(name)
    if (project.kind !== 'managed') {
      const why = project.kind === 'self' ? 'kura-server 是 Kura 自己' : project.kind === 'appstore' ? '这是绿联应用商店装的（商店升级会覆盖改动）' : `它不在项目目录里（${project.dir}）`
      throw new DockerError(403, `不能在 Kura 里改这个项目：${why}`)
    }
    return project
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const method = req.method ?? 'GET'
    try {
      if (parts[0] !== 'api') return json(res, 404, { error: 'not found' })
      const [, kind, ref, verb] = parts

      if (method !== 'GET' && req.headers[writeHeader] !== '1') {
        return json(res, 403, { error: `写操作必须带 ${writeHeader}: 1 头` })
      }

      if (method === 'GET' && kind === 'overview') return json(res, 200, await service.overview())
      if (method === 'GET' && kind === 'info') return json(res, 200, await service.info())
      if (method === 'GET' && kind === 'images' && !ref) return json(res, 200, await service.images())
      if (method === 'GET' && kind === 'volumes') return json(res, 200, await service.volumes(url.searchParams.get('size') === '1'))
      if (method === 'GET' && kind === 'networks') return json(res, 200, await service.networks())
      // 更新检查：只读（问仓库，不拉镜像）。POST 是为了带一组镜像名；不算写操作，但要写头 —— 它会让 NAS 去连外网
      if (method === 'POST' && kind === 'updates') {
        const body = parseJson<{ images?: unknown }>(await readBody(req))
        const images = Array.isArray(body.images) ? [...new Set(body.images.filter((i): i is string => typeof i === 'string'))].slice(0, 100) : []
        for (const i of images) checkRef(i)
        // 并发 6 个（一个就要二三十秒，真机实测），但别把仓库的限流打满
        const results = new Array<UpdateCheck>(images.length)
        let next = 0
        const worker = async () => {
          while (next < images.length) {
            const at = next++
            results[at] = await service.checkUpdate(images[at]!)
          }
        }
        await Promise.all(Array.from({ length: Math.min(6, images.length) }, worker))
        return json(res, 200, results)
      }
      if (method === 'GET' && kind === 'activity') {
        return json(res, 200, options.activity(Math.min(200, Number(url.searchParams.get('limit')) || 50)).filter((a) => a.action.startsWith('docker-')).reverse())
      }

      if (kind === 'containers' && ref) {
        checkRef(ref)
        if (method === 'GET' && !verb) return json(res, 200, await service.container(ref))
        if (method === 'GET' && verb === 'stats') return json(res, 200, await service.stats(ref))
        if (method === 'GET' && verb === 'logs') return await sendLogs(res, ref, Number(url.searchParams.get('tail')) || 5000)
        if (method === 'POST' && (verb === 'start' || verb === 'stop' || verb === 'restart')) {
          const raw = await service.assertMutable(ref)
          const target = raw.Name.replace(/^\//, '')
          try {
            await engine[verb](ref)
            options.audit({ action: `docker-${verb}`, detail: target, exitCode: 0, ip: ip(req) })
          } catch (error) {
            options.audit({ action: `docker-${verb}`, detail: `${target}：${errorMessage(error)}`, exitCode: 1, ip: ip(req) })
            throw error
          }
          return json(res, 200, { ok: true })
        }
        if (method === 'DELETE' && !verb) {
          const raw = await service.assertMutable(ref)
          const force = url.searchParams.get('force') === '1'
          if (raw.State.Running && !force) throw new DockerError(409, '容器还在运行：先停止，或勾选「强制删除」')
          await engine.removeContainer(ref, force)
          options.audit({ action: 'docker-remove', detail: `${raw.Name.replace(/^\//, '')}${force ? '（强制）' : ''}`, exitCode: 0, ip: ip(req) })
          return json(res, 200, { ok: true })
        }
      }

      if (kind === 'images') {
        if (method === 'DELETE' && ref) {
          checkRef(ref)
          await engine.removeImage(ref)
          options.audit({ action: 'docker-image-remove', detail: ref, exitCode: 0, ip: ip(req) })
          return json(res, 200, { ok: true })
        }
        if (method === 'POST' && ref === 'prune') {
          const all = url.searchParams.get('all') === '1'
          const reclaimed = await engine.pruneImages(all)
          options.audit({ action: 'docker-image-prune', detail: `${all ? '所有未使用' : '悬空'}，回收 ${reclaimed} 字节`, exitCode: 0, ip: ip(req) })
          return json(res, 200, { reclaimed })
        }
      }

      // ---- 按项目的自动更新 ----
      if (kind === 'auto' && options.autoupdate) {
        const auto = options.autoupdate
        if (method === 'GET' && !ref) return json(res, 200, auto.status())
        // 开关先判：项目名可以是 `run`（checkProjectName 允许），
        // 排在后面前者会把「开关 run 这个项目」误当成「跑一轮」
        if (ref && (verb === 'on' || verb === 'off')) {
          // 项目名要过一遍 compose 的规则：它会进 compose 的 -p 参数
          checkProjectName(ref)
          const status = auto.set(ref, verb === 'on')
          options.audit({ action: 'docker-auto-update', detail: `${verb === 'on' ? '开' : '关'}：${ref}`, exitCode: 0, ip: ip(req) })
          return json(res, 200, status)
        }
        if (method === 'POST' && ref === 'run') return json(res, 200, await auto.tick())
      }

      // ---- 项目文件（D3）----
      if (kind === 'projects' && ref && verb === 'files' && options.files) {
        const project = await editable(ref)
        if (method === 'GET') return json(res, 200, options.files.read(project.dir, project.configFiles))
        if (method === 'PUT') {
          const body = parseJson<{ compose?: Array<{ path?: unknown; content?: unknown }>; env?: unknown }>(await readBody(req))
          const compose = (body.compose ?? []).map((c) => {
            if (typeof c.path !== 'string' || typeof c.content !== 'string') throw new DockerError(400, 'compose 每一项要有 path 与 content')
            return { path: c.path, content: c.content }
          })
          if (body.env !== undefined && typeof body.env !== 'string') throw new DockerError(400, 'env 必须是字符串')
          const saved = await options.files.write(project.dir, project.configFiles, { compose, env: body.env as string | undefined })
          options.audit({ action: 'docker-files-save', detail: `${ref}：${[...compose.map((c) => c.path.split('/').pop()), ...(body.env !== undefined ? ['.env'] : [])].join('、')}`, exitCode: 0, ip: ip(req) })
          return json(res, 200, saved)
        }
      }
      if (kind === 'projects' && !ref && method === 'POST' && options.files) {
        const body = parseJson<{ name?: unknown; compose?: unknown; env?: unknown }>(await readBody(req))
        if (typeof body.name !== 'string' || typeof body.compose !== 'string') throw new DockerError(400, '要有 name 与 compose')
        if (body.env !== undefined && typeof body.env !== 'string') throw new DockerError(400, 'env 必须是字符串')
        const created = await options.files.create(body.name, body.compose, (body.env as string | undefined) ?? '')
        options.audit({ action: 'docker-project-create', detail: body.name, exitCode: 0, ip: ip(req) })
        return json(res, 200, created)
      }

      json(res, 404, { error: 'not found' })
    } catch (error) {
      fail(res, error)
    }
  }


  const sendLogs = async (res: http.ServerResponse, ref: string, tail: number): Promise<void> => {
    const stream = await engine.logs(ref, { tail, follow: false, timestamps: true })
    const demux = createLogDemuxer()
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    stream.on('data', (chunk: Buffer) => res.write(demux(chunk)))
    stream.on('end', () => res.end())
    stream.on('error', () => res.end())
    res.on('close', () => stream.destroy())
  }

  /** 把一个 WebSocket 接到「先发输出、最后发退出码」的约定上。 */
  const finish = (ws: WebSocket, code: number, message?: string): void => {
    if (message) ws.send(message)
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code }))
    ws.close()
  }

  const streamLogs = async (ws: WebSocket, ref: string, tail: number): Promise<void> => {
    const stream = await engine.logs(ref, { tail, follow: true })
    const demux = createLogDemuxer()
    stream.on('data', (chunk: Buffer) => {
      const text = demux(chunk)
      if (text && ws.readyState === ws.OPEN) ws.send(text)
    })
    stream.on('end', () => finish(ws, 0))
    stream.on('error', (error) => finish(ws, 1, `\n[日志流断开：${error.message}]\n`))
    ws.on('close', () => stream.destroy())
  }

  const streamCompose = async (ws: WebSocket, req: http.IncomingMessage, name: string, action: ComposeAction): Promise<void> => {
    const project = await service.project(name)
    if (project.kind === 'self') throw new DockerError(403, 'kura-server 是 Kura 自己，不能从 Kura 里操作；它由 watchtower 更新')
    if (project.kind === 'external' && action !== 'down') throw new DockerError(403, `这个项目不在项目目录里（${project.dir}），Kura 只能停止它`)
    if (project.configFiles.length === 0) throw new DockerError(409, '找不到这个项目的 compose 文件')
    const code = await exclusive(name, () => runOne(ws, req, project, action))
    finish(ws, code)
  }

  /** 同一个项目同时只跑一个 compose；出什么事都要把占位放掉 */
  const exclusive = <T>(name: string, work: () => Promise<T>): Promise<T> => locks.run(name, work)

  const runOne = async (ws: WebSocket, req: http.IncomingMessage, project: { name: string; dir: string; configFiles: string[] }, action: ComposeAction): Promise<number> => {
    const startedAt = Date.now()
    const run = compose({ name: project.name, dir: project.dir, configFiles: project.configFiles }, action)
    run.onOutput((text) => ws.readyState === ws.OPEN && ws.send(text))
    // 用户关了输出面板不等于要取消：compose 跑到一半被杀，项目会停在半新半旧的状态
    const code = await run.done
    options.audit({ action: `docker-compose-${action}`, detail: project.name, exitCode: code, durationMs: Date.now() - startedAt, ip: ip(req) })
    log('compose 执行完毕', { 项目: project.name, 动作: action, 退出码: code })
    return code
  }

  /**
   * 删除项目：先 down（勾了才带 -v 删卷），成功了再按勾选删文件。两个勾默认都不勾 —— 默认只是「停掉并移除容器」。
   * 文件只删 Kura 认得的（compose、.env、备份），目录里有别的东西就整个留着。
   */
  const streamRemove = async (ws: WebSocket, req: http.IncomingMessage, name: string, volumes: boolean, files: boolean): Promise<void> => {
    const project = await editable(name)
    const code = await exclusive(name, async () => {
      let c = 0
      if (project.containers > 0) c = await runOne(ws, req, project, volumes ? 'down-volumes' : 'down')
      if (c !== 0) return c
      if (files) {
        if (!options.files) throw new DockerError(409, '没有开项目文件管理')
        const { removed, kept } = options.files.removeFiles(project.dir, project.configFiles)
        ws.send(`已删除 ${removed.length} 个文件${kept.length ? `；目录里还有 ${kept.length} 项（${kept.slice(0, 5).join('、')}${kept.length > 5 ? '…' : ''}），整个目录保留` : '，空目录已删除'}\n`)
      }
      options.audit({ action: 'docker-project-remove', detail: `${name}${volumes ? ' · 删卷' : ''}${files ? ' · 删文件' : ''}`, exitCode: 0, ip: ip(req) })
      return 0
    })
    finish(ws, code)
  }

  /**
   * 进容器的 shell（docker exec -it）。上行：文本帧 = 键盘输入，`{"type":"resize",cols,rows}` = 改尺寸
   * （和终端页同一个协议）；下行：输出。
   *
   * 要的 shell 只能从固定的几个里选，不接受任意命令；不指定就按 bash → ash → sh 试。
   * Kura 自己的容器不给进（里面挂着 docker.sock 与宿主根）。开关都进审计。
   */
  const streamShell = async (ws: WebSocket, req: http.IncomingMessage, ref: string, wanted: string, cols: number, rows: number): Promise<void> => {
    const raw = await service.assertMutable(ref)
    if (!raw.State.Running) throw new DockerError(409, '容器没在运行，进不去 shell')
    const name = raw.Name.replace(/^\//, '')
    if (wanted && !shellCandidates.includes(wanted)) throw new DockerError(400, `只能用这些 shell：${shellCandidates.join('、')}`)
    const execId = await engine.createExec(ref, shellCommand(wanted))
    const socket = await engine.startExec(execId)
    const startedAt = Date.now()
    options.audit({ action: 'docker-exec-open', detail: `${name} ${wanted || '自动'}`, ip: ip(req) })
    void engine.resizeExec(execId, cols, rows).catch(() => {})
    socket.on('data', (chunk: Buffer) => ws.readyState === ws.OPEN && ws.send(chunk.toString('utf8')))
    socket.on('close', () => ws.close())
    socket.on('error', () => ws.close())
    ws.on('message', (data) => {
      const text = data.toString()
      if (/^\s*\{\s*"type"\s*:\s*"resize"/.test(text)) {
        try {
          const { cols: c, rows: r } = JSON.parse(text) as { cols: number; rows: number }
          void engine.resizeExec(execId, c, r).catch(() => {})
          return
        } catch {
          // 不是合法 JSON 就当输入
        }
      }
      socket!.write(text)
    })
    ws.on('close', () => {
      socket!.destroy()
      options.audit({ action: 'docker-exec-close', detail: name, durationMs: Date.now() - startedAt, ip: ip(req) })
    })
  }

  /**
   * 清理镜像：跟其它长任务一个形状，输出走流、结束发退出码。
   *
   * 以前只有一次性 JSON 的 POST /api/images/prune，客户端只能「点了按钮就干等」——
   * ConfirmDialog 要等 onConfirm 返回才关，于是清理期间那个对话框一直占着前台。
   * 清理本身是几秒到几十秒，但用户看着一个不动的「正在处理…」就是被堵住了。
   */
  const streamPrune = async (ws: WebSocket, req: http.IncomingMessage, all: boolean): Promise<void> => {
    const what = all ? '没有被用到的镜像' : '悬空镜像'
    if (ws.readyState === ws.OPEN) ws.send(`正在清理${what}…\n`)
    const startedAt = Date.now()
    const reclaimed = await engine.pruneImages(all)
    /**
     * 结果如实说，尤其是**什么都没清掉**那种。
     *
     * 以前不管清没清到都写「回收 X」，于是 0 的时候也是绿油油的「完成」——
     * 用户看到的是「清理成功」，可磁盘一点没变，接着就会怀疑是把界面做了个假动作。
     * 0 本身完全正常：`dangling` 这一档只认没有标签的镜像，而更新留下的旧版本通常**有标签**，
     * 得走「清理未使用」那档才清得掉（客户端界面对此有说明）。
     */
    // 「正在清理…」那行会留在面板里（输出是累积的），所以完成这行要自带结果，
    // 读起来才不矛盾 —— 光秃秃写「回收 0 B」配着上面那句「正在清理」很像卡住了。
    const text =
      reclaimed > 0
        ? `清理完成，回收 ${humanBytes(reclaimed)}\n`
        : `清理完成，没有可清理的${what}，磁盘占用没有变化。\n` +
          (all ? '' : '（「悬空」只包括连标签都没有的镜像；更新留下的旧版本一般还有标签，用「清理未使用镜像」。）\n')
    if (ws.readyState === ws.OPEN) ws.send(text)
    options.audit({ action: 'docker-image-prune', detail: `${all ? '所有未使用' : '悬空'}，回收 ${reclaimed} 字节`, exitCode: 0, durationMs: Date.now() - startedAt, ip: ip(req) })
    finish(ws, 0)
  }

  const streamPull = async (ws: WebSocket, req: http.IncomingMessage, image: string): Promise<void> => {
    const stream = await engine.pull(image)
    let buffer = ''
    let failed = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line) as { status?: string; id?: string; progress?: string; error?: string }
          if (event.error) failed = event.error
          const text = event.error ?? [event.id, event.status, event.progress].filter(Boolean).join(' ')
          if (text && ws.readyState === ws.OPEN) ws.send(text + '\n')
        } catch {
          // 不是 JSON 的行原样转
          if (ws.readyState === ws.OPEN) ws.send(line + '\n')
        }
      }
    })
    stream.on('end', () => {
      options.audit({ action: 'docker-image-pull', detail: failed ? `${image}：${failed}` : image, exitCode: failed ? 1 : 0, ip: ip(req) })
      finish(ws, failed ? 1 : 0)
    })
    stream.on('error', (error) => finish(ws, 1, `\n${error.message}\n`))
  }

  const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://kura-server')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const [, kind, ref, verb] = parts
    const isLogs = kind === 'containers' && ref && verb === 'logs'
    // down-volumes 不对外：只能经 remove?volumes=1 走（要显式勾选）
    const isCompose = kind === 'projects' && ref && ['up', 'down', 'restart', 'pull'].includes(verb ?? '')
    const isRemove = kind === 'projects' && ref && verb === 'remove'
    const isPull = kind === 'images' && ref === 'pull'
    const isPrune = kind === 'images' && ref === 'prune'
    const isShell = kind === 'containers' && ref && verb === 'shell'
    if (parts[0] !== 'api' || !(isLogs || isCompose || isRemove || isPull || isPrune || isShell)) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    // 只读的日志流不要求写头；会改东西的（compose、拉镜像）要
    if (!isLogs && req.headers[writeHeader] !== '1') {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isShell) {
        // shell 不走「先发输出、最后 exit 帧」那套：它是双向的，断开就是结束
        streamShell(ws, req, checkRef(ref!), url.searchParams.get('shell') ?? '', Number(url.searchParams.get('cols')) || 80, Number(url.searchParams.get('rows')) || 24).catch((error) => {
          if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m${errorMessage(error)}\x1b[0m\r\n`)
          ws.close()
        })
        return
      }
      const work = isLogs
        ? streamLogs(ws, checkRef(ref!), Math.min(10_000, Number(url.searchParams.get('tail')) || 500))
        : isCompose
          ? streamCompose(ws, req, ref!, verb as ComposeAction)
          : isRemove
            ? streamRemove(ws, req, ref!, url.searchParams.get('volumes') === '1', url.searchParams.get('files') === '1')
            : isPrune
              ? streamPrune(ws, req, url.searchParams.get('all') === '1')
              : streamPull(ws, req, url.searchParams.get('image') ?? '')
      work.catch((error) => finish(ws, 1, `${errorMessage(error)}\n`))
    })
  }

  return { handle, upgrade }
}
