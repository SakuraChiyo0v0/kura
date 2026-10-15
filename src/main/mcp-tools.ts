import { Readable, Writable } from 'node:stream'
import type { DockerClient, ProjectAction } from '../core/docker-client.js'
import type { LinkModeSetting } from '../core/link.js'
import type { Mirror } from '../core/mirror.js'
import type { DavSettingsView, MountSettingsView, NasScopeView } from '../shared/ipc.js'
import type { McpTool, McpAnnotations } from '../core/mcp.js'
import type { ContainerService, FileService, LocalDavService, NasScopeService } from './features.js'
import type { ModuleManager } from './modules.js'

/**
 * MCP 工具表：AI 客户端能做的每一件事。
 *
 * handler 直接调主进程里那些服务实例（与界面走的是同一批对象），所以：
 * - 权限边界不在这里另立一套 —— 文件受 NAS 那份范围裁剪、容器受 kura-server 的具名接口白名单约束，
 *   和界面上手点完全一样；
 * - 不经过 IPC，也就不会把 AI 的操作当成界面事件广播出去（`ContainerService.open()` 会广播，所以流式
 *   操作这里改用 `client` 直接收集，见 `collectStream`）。
 *
 * 注解（annotations）是给客户端的提示，不是强制：`readOnlyHint` 的工具不改任何东西，
 * `destructiveHint` 会删东西 —— Claude Code 会据此向用户提示。
 */

export interface McpToolDeps {
  files: FileService
  containers: ContainerService
  nasScope: NasScopeService
  localDav: LocalDavService
  modules: ModuleManager
  /** 当前连接（没配置 / 没起来时返回 undefined） */
  mirror: () => Mirror | undefined
}

/** 读文件的大小上限：MCP 的返回值是先进模型上下文的文本，别让一个大文件把上下文冲掉。 */
const maxReadBytes = 8 * 1024 * 1024
/** 流式操作（compose up / pull）最多等多久、最多留多少输出。 */
const streamTimeoutMs = 120_000
const maxStreamChars = 200_000

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

const pathProp = { type: 'string', description: 'NAS 上的绝对路径，如 /volume1/docker/foo' }
const ro: McpAnnotations = { readOnlyHint: true, idempotentHint: true }
const destructive: McpAnnotations = { readOnlyHint: false, destructiveHint: true }

function requireMirror(deps: McpToolDeps): Mirror {
  const mirror = deps.mirror()
  if (!mirror) throw new Error('还没有连接 NAS：先在 Kura 的引导页完成设置')
  return mirror
}

/** 取一个字符串参数，空值报错（比让下游拿到空串再报 404 清楚）。 */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`参数 ${key} 必须是非空字符串`)
}

function optionalStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : undefined
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === 'boolean' ? (args[key] as boolean) : fallback
}

/**
 * 把流式操作收集成一段文本（MCP 是请求/响应，没有流）。
 *
 * 不走 `ContainerService.open()`：那条路会往界面推 data/exit 事件，AI 拉个镜像界面上就冒出一个
 * 「进行中的流」。这里直接用 `DockerClient`，输出只回给调用方。
 */
async function collectStream(stream: { onData: (fn: (text: string) => void) => void; done: Promise<number | undefined>; close(): void }): Promise<string> {
  let text = ''
  stream.onData((chunk) => {
    if (text.length < maxStreamChars) text += chunk
  })
  const timer = setTimeout(() => stream.close(), streamTimeoutMs)
  try {
    const code = await stream.done
    const tail = text.length > maxStreamChars ? `${text.slice(0, maxStreamChars)}\n…（输出过长已截断）` : text
    return code === undefined ? `${tail}\n（连接断开，没收到结束帧）` : `${tail}\n（退出码 ${code}）`
  } finally {
    clearTimeout(timer)
  }
}

/** 文件读取的序列化：先看大小，再判二进制。 */
async function readFileText(deps: McpToolDeps, path: string, encoding: 'utf8' | 'base64'): Promise<string> {
  const entry = await deps.files.client.stat(path)
  if (!entry) throw new Error(`文件不存在：${path}`)
  if (entry.isDir) throw new Error(`${path} 是目录，用 kura_files_list 列它`)
  if (entry.size > maxReadBytes) throw new Error(`文件 ${(entry.size / 1024 / 1024).toFixed(1)} MiB 超过上限 ${maxReadBytes / 1024 / 1024} MiB`)
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk)
      done()
    },
  })
  await deps.files.client.download(path, sink)
  const buffer = Buffer.concat(chunks)
  if (encoding === 'base64') return buffer.toString('base64')
  // 含 NUL 基本就是二进制：直接当 utf8 回给模型只会得到一堆乱码
  if (buffer.includes(0)) throw new Error('这看起来是二进制文件，加 "encoding":"base64" 再读')
  return buffer.toString('utf8')
}

export function createMcpTools(deps: McpToolDeps): McpTool[] {
  const docker = (): DockerClient => deps.containers.client

  return [
    // ---------------------------------------------------------------- 状态
    {
      name: 'kura_status',
      title: 'Kura 状态',
      description: '看 Kura 当前状态：链路模式、登录是否正常、服务映射是否在跑、有没有连上 NAS。任何操作之前先调这个确认连接可用。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => {
        const mirror = deps.mirror()
        if (!mirror) return { connected: false, hint: '还没连接 NAS：先在 Kura 的引导页完成设置' }
        const snap = mirror.snapshot()
        return {
          connected: true,
          running: snap.running,
          phase: snap.phase,
          mode: snap.mode,
          auth: snap.auth,
          lanReachable: snap.lanReachable,
          services: snap.services.map((s) => ({ key: s.key, label: s.spec.label, port: s.listener.port, listening: s.listener.running })),
        }
      },
    },
    {
      name: 'kura_services',
      title: '服务映射清单',
      description: '列出所有映射到本机回环地址的 NAS 服务：服务名、本机端口、开关与监听状态、流量。其它程序要连 NAS 时看这里拿本机地址。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => {
        const snap = requireMirror(deps).snapshot()
        return snap.services.map((s) => ({
          key: s.key,
          label: s.spec.label,
          nasPort: s.spec.port,
          localPort: s.listener.port,
          localUrl: s.localUrl,
          enabled: s.listener.enabled,
          listening: s.listener.running,
          lastError: s.listener.lastError,
        }))
      },
    },

    // ---------------------------------------------------------------- 文件
    {
      name: 'kura_files_list',
      title: '列目录',
      description: '列出 NAS 上某个目录的内容。返回的名字、大小、修改时间。受 NAS 上的暴露范围裁剪：范围外的目录会直接报不存在。',
      inputSchema: object({ path: pathProp }, ['path']),
      annotations: ro,
      handler: async (args) => {
        const listing = await deps.files.list(str(args, 'path'))
        return { path: listing.path, entries: listing.entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir, size: e.size, modified: e.modified ? new Date(e.modified).toISOString() : '' })) }
      },
    },
    {
      name: 'kura_files_stat',
      title: '看单个文件/目录',
      description: '查 NAS 上一个路径的信息（是否存在、是不是目录、多大、什么时候改的）。',
      inputSchema: object({ path: pathProp }, ['path']),
      annotations: ro,
      handler: async (args) => {
        const entry = await deps.files.client.stat(str(args, 'path'))
        if (!entry) return { path: str(args, 'path'), exists: false }
        return { path: entry.path, exists: true, isDir: entry.isDir, size: entry.size, modified: entry.modified ? new Date(entry.modified).toISOString() : '', contentType: entry.contentType }
      },
    },
    {
      name: 'kura_files_read',
      title: '读文件',
      description: `读 NAS 上一个文本文件的内容（上限 ${maxReadBytes / 1024 / 1024} MiB）。二进制文件要加 "encoding":"base64"。`,
      inputSchema: object({ path: pathProp, encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8；二进制文件用 base64' } }, ['path']),
      annotations: ro,
      handler: async (args) => readFileText(deps, str(args, 'path'), args.encoding === 'base64' ? 'base64' : 'utf8'),
    },
    {
      name: 'kura_files_write',
      title: '写文件',
      description: '在 NAS 上写入（覆盖）一个文件。文本直接传 content；二进制传 base64 并设 encoding 为 base64。这是**真改 NAS 上的文件**。',
      inputSchema: object(
        { path: pathProp, content: { type: 'string', description: '文件内容' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8' } },
        ['path', 'content'],
      ),
      handler: async (args) => {
        const path = str(args, 'path')
        const raw = typeof args.content === 'string' ? args.content : ''
        const buffer = args.encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
        await deps.files.client.upload(path, Readable.from([buffer]), buffer.length)
        return { path, bytes: buffer.length, written: true }
      },
    },
    {
      name: 'kura_files_mkdir',
      title: '新建文件夹',
      description: '在 NAS 上新建一个目录（父目录要已存在）。',
      inputSchema: object({ path: pathProp }, ['path']),
      handler: async (args) => {
        const path = str(args, 'path')
        await deps.files.mkdir(path)
        return { path, created: true }
      },
    },
    {
      name: 'kura_files_move',
      title: '移动 / 改名',
      description: '把 NAS 上的文件或目录移动、改名。目标已存在时会失败（不覆盖）。',
      inputSchema: object({ from: { type: 'string', description: '源路径' }, to: { type: 'string', description: '目标路径' } }, ['from', 'to']),
      handler: async (args) => {
        const from = str(args, 'from')
        const to = str(args, 'to')
        await deps.files.rename(from, to)
        return { from, to, moved: true }
      },
    },
    {
      name: 'kura_files_remove',
      title: '删除文件 / 目录',
      description: '**永久删除** NAS 上的文件或目录（目录会连内容一起删）。删之前先跟用户确认。',
      inputSchema: object({ paths: { type: 'array', items: { type: 'string' }, description: '要删的路径列表' } }, ['paths']),
      annotations: destructive,
      handler: async (args) => {
        const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
        if (!paths.length) throw new Error('paths 不能为空')
        await deps.files.remove(paths)
        return { removed: paths }
      },
    },

    // ---------------------------------------------------------------- 容器
    {
      name: 'kura_docker_overview',
      title: 'Docker 概览',
      description: '看 NAS 上 Docker 的全貌：compose 项目、容器、镜像数量与状态。要看某个容器的细节用 kura_docker_container。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => docker().overview(),
    },
    {
      name: 'kura_docker_container',
      title: '容器详情',
      description: '看一个容器的详情：状态、端口、挂载、环境变量、所属 compose 项目。',
      inputSchema: object({ id: { type: 'string', description: '容器名或 ID' } }, ['id']),
      annotations: ro,
      handler: async (args) => docker().container(str(args, 'id')),
    },
    {
      name: 'kura_docker_logs',
      title: '容器日志',
      description: '读一个容器最近的日志文本。看服务为什么起不来时先看这个。',
      inputSchema: object({ id: { type: 'string', description: '容器名或 ID' }, tail: { type: 'number', description: '取最后多少行，默认 500' } }, ['id']),
      annotations: ro,
      handler: async (args) => docker().logsText(str(args, 'id'), typeof args.tail === 'number' ? Math.max(1, Math.round(args.tail)) : 500),
    },
    {
      name: 'kura_docker_images',
      title: '镜像列表',
      description: '列出 NAS 上的 Docker 镜像：标签、大小、创建时间。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => docker().images(),
    },
    {
      name: 'kura_docker_volumes',
      title: '数据卷列表',
      description: '列出 Docker 数据卷。withSize 为 true 时会统计占用（慢一些）。',
      inputSchema: object({ withSize: { type: 'boolean', description: '是否统计占用大小，默认 false' } }),
      annotations: ro,
      handler: async (args) => docker().volumes(bool(args, 'withSize', false)),
    },
    {
      name: 'kura_docker_networks',
      title: '网络列表',
      description: '列出 Docker 网络。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => docker().networks(),
    },
    {
      name: 'kura_docker_activity',
      title: '操作审计',
      description: '看 NAS 上最近的操作记录（谁、什么时候、做了什么、退出码）。',
      inputSchema: object({ limit: { type: 'number', description: '最多多少条，默认 50' } }),
      annotations: ro,
      handler: async (args) => docker().activity(typeof args.limit === 'number' ? Math.max(1, Math.round(args.limit)) : 50),
    },
    {
      name: 'kura_docker_check_updates',
      title: '查镜像有没有新版',
      description: '问仓库某个镜像有没有新版本（只查询，不拉取）。会连外网，慢。',
      inputSchema: object({ images: { type: 'array', items: { type: 'string' }, description: '镜像名列表，如 ["nginx:latest"]' } }, ['images']),
      annotations: ro,
      handler: async (args) => {
        const images = Array.isArray(args.images) ? args.images.filter((i): i is string => typeof i === 'string').slice(0, 100) : []
        if (!images.length) throw new Error('images 不能为空')
        return docker().checkUpdates(images)
      },
    },
    {
      name: 'kura_docker_container_action',
      title: '启停 / 重启容器',
      description: '启动、停止或重启一个容器。改的是 NAS 上真实运行的容器。',
      inputSchema: object({ id: { type: 'string', description: '容器名或 ID' }, action: { type: 'string', enum: ['start', 'stop', 'restart'] } }, ['id', 'action']),
      handler: async (args) => {
        const action = str(args, 'action')
        if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new Error(`不支持的操作：${action}`)
        const id = str(args, 'id')
        await docker().containerAction(id, action)
        return { id, action, done: true }
      },
    },
    {
      name: 'kura_docker_remove_container',
      title: '删除容器',
      description: '**永久删除**一个容器。force 为 true 时连运行中的也强删。删之前先跟用户确认。',
      inputSchema: object({ id: { type: 'string', description: '容器名或 ID' }, force: { type: 'boolean', description: '是否强制删除运行中的容器，默认 false' } }, ['id']),
      annotations: destructive,
      handler: async (args) => {
        const id = str(args, 'id')
        await docker().removeContainer(id, bool(args, 'force', false))
        return { id, removed: true }
      },
    },
    {
      name: 'kura_docker_remove_image',
      title: '删除镜像',
      description: '**永久删除**一个 Docker 镜像。删之前先跟用户确认。',
      inputSchema: object({ id: { type: 'string', description: '镜像名:标签 或 ID' } }, ['id']),
      annotations: destructive,
      handler: async (args) => {
        const id = str(args, 'id')
        await docker().removeImage(id)
        return { id, removed: true }
      },
    },
    {
      name: 'kura_docker_prune_images',
      title: '清理无用镜像',
      description: '**永久删除**没被使用的镜像（释放空间）。all 为 true 时连没被容器引用的也清掉，更激进。删之前先跟用户确认。',
      inputSchema: object({ all: { type: 'boolean', description: '是否清掉所有未被引用的镜像，默认 false（只清悬空镜像）' } }),
      annotations: destructive,
      handler: async (args) => ({ reclaimedBytes: await docker().pruneImages(bool(args, 'all', false)) }),
    },
    {
      name: 'kura_docker_project_action',
      title: 'compose 项目操作',
      description: '对一个 compose 项目执行 up / down / restart / pull。down 会停掉项目里所有容器；pull 会拉新镜像。输出收完才返回。',
      inputSchema: object(
        { name: { type: 'string', description: 'compose 项目名' }, action: { type: 'string', enum: ['up', 'down', 'restart', 'pull'] } },
        ['name', 'action'],
      ),
      handler: async (args) => {
        const action = str(args, 'action')
        if (!['up', 'down', 'restart', 'pull'].includes(action)) throw new Error(`不支持的操作：${action}`)
        return collectStream(await docker().project(str(args, 'name'), action as ProjectAction))
      },
    },

    // ---------------------------------------------------------------- 映射 / 链路
    {
      name: 'kura_service_set_enabled',
      title: '开 / 关一个服务映射',
      description: '打开或关掉某个服务到本机的映射。key 从 kura_services 取。',
      inputSchema: object({ key: { type: 'string', description: '服务 key（kura_services 里的 key）' }, enabled: { type: 'boolean' } }, ['key', 'enabled']),
      handler: async (args) => {
        const key = str(args, 'key')
        const enabled = bool(args, 'enabled', true)
        await requireMirror(deps).setServiceEnabled(key, enabled)
        return { key, enabled }
      },
    },
    {
      name: 'kura_service_set_port',
      title: '改服务映射的本机端口',
      description: '改某个服务映射到本机哪个端口。端口被占会失败并退回原端口。',
      inputSchema: object({ key: { type: 'string', description: '服务 key' }, port: { type: 'number', description: '本机端口 1-65535' } }, ['key', 'port']),
      handler: async (args) => {
        const key = str(args, 'key')
        const port = Number(args.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口 ${String(args.port)} 不合法`)
        await requireMirror(deps).setServicePort(key, port)
        return { key, port }
      },
    },
    {
      name: 'kura_set_link_mode',
      title: '切换链路模式',
      description: '切换走局域网直连还是外网中继：lan（只走局域网）、wan（只走外网）、auto（自动择优）。',
      inputSchema: object({ mode: { type: 'string', enum: ['lan', 'wan', 'auto'] } }, ['mode']),
      handler: async (args) => {
        const mode = str(args, 'mode')
        if (mode !== 'lan' && mode !== 'wan' && mode !== 'auto') throw new Error(`不支持的链路模式：${mode}`)
        await requireMirror(deps).setMode(mode as LinkModeSetting)
        return { mode }
      },
    },
    {
      name: 'kura_mirror_sync',
      title: '重新同步服务清单',
      description: '去 NAS 重新拉一次服务清单（新装的服务要在这一步之后才会出现在映射里）。返回清单条目数。',
      inputSchema: object({}),
      handler: async () => ({ entries: await requireMirror(deps).syncNow() }),
    },
    {
      name: 'kura_mirror_retry',
      title: '立刻重试连接',
      description: '登录失败在退避冷却时，用它立刻重试一次，不用等冷却结束。',
      inputSchema: object({}),
      handler: async () => {
        await requireMirror(deps).retryNow()
        return { retried: true }
      },
    },

    // ---------------------------------------------------------------- 暴露范围
    {
      name: 'kura_scope_get',
      title: '看 WebDAV 暴露范围',
      description: '看 NAS 上当前对外暴露的文件范围（哪些目录放行、哪些排除、是否只读）。这是文件页、本机 WebDAV、rclone 挂载共用的**唯一**一份范围。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => deps.nasScope.get(),
    },
    {
      name: 'kura_scope_save',
      title: '改 WebDAV 暴露范围',
      description:
        '整体替换 NAS 上的暴露范围。**include 与 exclude 必须都发全**（这是替换不是合并，漏发等于删掉）；include 不能为空数组（空 = 放行整个文件系统）。改范围会影响本机 WebDAV、rclone 挂载与文件页能看到的内容。',
      inputSchema: object(
        {
          include: { type: 'array', items: { type: 'string' }, description: '放行的目录，至少一条，如 ["/volume1/docker"]' },
          exclude: { type: 'array', items: { type: 'string' }, description: '排除的目录，可以为空数组' },
          readOnly: { type: 'boolean', description: '是否只读' },
        },
        ['include', 'exclude', 'readOnly'],
      ),
      handler: async (args) => {
        const include = Array.isArray(args.include) ? args.include.filter((p): p is string => typeof p === 'string') : []
        const exclude = Array.isArray(args.exclude) ? args.exclude.filter((p): p is string => typeof p === 'string') : []
        if (!include.length) throw new Error('include 不能为空（空等于放行整个文件系统）')
        const view: NasScopeView = { include, exclude, readOnly: bool(args, 'readOnly', false), defaults: (await deps.nasScope.get()).defaults }
        return deps.nasScope.save(view)
      },
    },
    {
      name: 'kura_scope_check',
      title: '查一个路径在不在范围内',
      description: '查某个 NAS 路径对外的可见性：完全可见 / 只是路过（只能列）/ 完全看不到，以及能不能写。',
      inputSchema: object({ path: pathProp }, ['path']),
      annotations: ro,
      handler: async (args) => deps.nasScope.check(str(args, 'path')),
    },

    // ---------------------------------------------------------------- 本机 WebDAV
    {
      name: 'kura_dav_status',
      title: '本机 WebDAV 状态',
      description: '看 Kura 给本机其他程序提供的 WebDAV 服务：开没开、在哪个端口、当前地址、请求与流量统计。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => deps.localDav.view(),
    },
    {
      name: 'kura_dav_save',
      title: '设置本机 WebDAV',
      description: '开关本机 WebDAV、改它的端口。范围不在这里设（只有 NAS 那一份说了算，用 kura_scope_save）。',
      inputSchema: object({ enabled: { type: 'boolean' }, port: { type: 'number', description: '本机端口 1-65535' } }, ['enabled', 'port']),
      handler: async (args) => {
        const port = Number(args.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口 ${String(args.port)} 不合法`)
        const settings: DavSettingsView = { enabled: bool(args, 'enabled', false), port }
        return deps.localDav.save(settings)
      },
    },

    // ---------------------------------------------------------------- 挂载模块
    {
      name: 'kura_module_status',
      title: '挂载模块状态',
      description: '看把 NAS 挂载为本机磁盘所需的东西齐不齐：rclone 装没装、WinFsp 装没装、当前挂没挂上、挂在哪个盘。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => {
        const status = deps.modules.status()
        return { ...status, davRunning: deps.localDav.view().running }
      },
    },
    {
      name: 'kura_module_mount_settings',
      title: '看挂载设置',
      description: '看挂载的设置：模拟成硬盘 / 网络位置 / 挂到文件夹、盘符、卷标、只读、是否开机自动挂载、缓存模式。',
      inputSchema: object({}),
      annotations: ro,
      handler: async () => deps.modules.mountSettings(),
    },
    {
      name: 'kura_module_save_mount_settings',
      title: '改挂载设置',
      description:
        '改挂载设置（字段含义同 kura_module_mount_settings）。改完要调 kura_module_mount 才会生效。folder 模式给一个**已存在的父目录**（如 D:\\），实际挂载点是它下面的 KuraNAS 子目录，由 Kura 拼、rclone 建。',
      inputSchema: object(
        {
          mode: { type: 'string', enum: ['disk', 'network', 'folder'] },
          drive: { type: 'string', description: '盘符，如 N:（disk / network 模式用）' },
          folder: { type: 'string', description: '父目录（folder 模式用），挂载点是它下面的 KuraNAS' },
          volumeName: { type: 'string', description: '卷标' },
          readOnly: { type: 'boolean' },
          autoMount: { type: 'boolean', description: '开机自动挂载' },
          cacheMode: { type: 'string', enum: ['off', 'minimal', 'writes', 'full'] },
        },
        ['mode', 'drive', 'folder', 'volumeName', 'readOnly', 'autoMount', 'cacheMode'],
      ),
      handler: async (args) => {
        const current = deps.modules.mountSettings()
        const settings: MountSettingsView = {
          mode: (['disk', 'network', 'folder'] as const).includes(args.mode as MountSettingsView['mode']) ? (args.mode as MountSettingsView['mode']) : current.mode,
          drive: optionalStr(args, 'drive') ?? current.drive,
          folder: optionalStr(args, 'folder') ?? current.folder,
          volumeName: optionalStr(args, 'volumeName') ?? current.volumeName,
          readOnly: bool(args, 'readOnly', current.readOnly),
          autoMount: bool(args, 'autoMount', current.autoMount),
          cacheMode: (['off', 'minimal', 'writes', 'full'] as const).includes(args.cacheMode as MountSettingsView['cacheMode'])
            ? (args.cacheMode as MountSettingsView['cacheMode'])
            : current.cacheMode,
        }
        return deps.modules.saveMountSettings(settings)
      },
    },
    {
      name: 'kura_module_mount',
      title: '挂载 NAS 为磁盘',
      description: '按当前挂载设置把 NAS 挂上来（需要 rclone 与 WinFsp，且本机 WebDAV 在跑）。已在挂载中会报错。',
      inputSchema: object({}),
      handler: async () => {
        await deps.modules.mount()
        return deps.modules.status().mount
      },
    },
    {
      name: 'kura_module_unmount',
      title: '卸载磁盘',
      description: '把挂载的 NAS 磁盘卸下来。',
      inputSchema: object({}),
      handler: async () => {
        await deps.modules.unmount()
        return deps.modules.status().mount
      },
    },
  ]
}
