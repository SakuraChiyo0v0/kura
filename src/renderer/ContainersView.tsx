import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleArrowUp, Boxes, CircleStop, Container, Download, Ellipsis, FileText, HardDrive, Layers, Network, Pencil, Play, Plus, RefreshCw, RotateCcw, Settings2, X } from 'lucide-react'
import {
  ActionMenu,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FluidSegmented,
  MotionTabs,
  Banner,
  Section,
  StatusBadge,
  SwitchField,
  TextField,
  useToast,
  type DataTableColumn,
  type StatusTone,
} from '@sakura-ui/react'
import type { AutoUpdateStatus, ContainerDetail, ContainerStats, ContainerView, DockerOverview, ImageView, NetworkView, ProjectView, UpdateCheck, VolumeView } from '../core/docker-types.js'
import { humanBytes } from '../core/stats.js'
import type { DockerActivity, DockerStreamEvent, PruneScope, ProjectAction } from '../shared/ipc.js'
import type { ServiceView } from '../core/mirror.js'
import { ContainerShell } from './ContainerShell.js'
import { DockerConfigTab } from './DockerConfigTab.js'
import { NewProject, ProjectEditor } from './ProjectEditor.js'

/**
 * 「容器」页（docs/容器管理 设计.md）：项目为主、容器为辅、镜像第三，最近操作放最后。
 * 形态借 Arcane：项目一行一个、状态点 + 服务数 + 目录；写操作的输出实时流在面板里，失败时停在原因上。
 */

const icon = { size: 16, strokeWidth: 1.7, 'aria-hidden': true } as const

function containerTone(c: Pick<ContainerView, 'state' | 'health'>): { tone: StatusTone; label: string } {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return { tone: 'danger', label: '运行中 · 不健康' }
    if (c.health === 'starting') return { tone: 'accent', label: '启动中' }
    return { tone: 'success', label: '运行中' }
  }
  if (c.state === 'restarting') return { tone: 'warning', label: '反复重启' }
  if (c.state === 'paused') return { tone: 'warning', label: '已暂停' }
  if (c.state === 'dead') return { tone: 'danger', label: '异常' }
  if (c.state === 'created') return { tone: 'neutral', label: '已创建' }
  return { tone: 'neutral', label: '已停止' }
}

const projectTone: Record<ProjectView['status'], { tone: StatusTone; label: string }> = {
  running: { tone: 'success', label: '运行中' },
  partial: { tone: 'warning', label: '部分运行' },
  stopped: { tone: 'neutral', label: '已停止' },
}

const kindLabel: Record<ProjectView['kind'], string> = {
  managed: '',
  appstore: '绿联应用',
  external: '目录外',
  self: 'Kura 自己',
}

const actionLabel: Record<ProjectAction, string> = { up: '启动', down: '停止并移除', restart: '重启', pull: '拉取镜像' }

function formatTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : ''
}

function portText(c: ContainerView): string {
  return c.ports
    .filter((p) => p.public)
    .map((p) => (p.public === p.private ? `${p.public}` : `${p.public}→${p.private}`))
    .join('、')
}

// ---------------------------------------------------------------- 流式输出

/**
 * 一个流（日志 / compose / 拉镜像）的输出。主进程推来的事件统一在这里分发，
 * 同一份事件订阅给整页用（比每个面板各订一次省，也不会漏掉面板挂上前就到的那几帧）。
 */
const streamListeners = new Map<string, Set<(event: DockerStreamEvent) => void>>()
/** 还没人订阅时到的事件先存着（流往往在面板挂上之前就开始吐了） */
const streamPending = new Map<string, DockerStreamEvent[]>()
let streamSubscribed = false

function ensureStreamSubscription(): void {
  if (streamSubscribed || !window.kura) return
  streamSubscribed = true
  window.kura.docker.onStream((event) => {
    const set = streamListeners.get(event.id)
    if (set?.size) for (const l of set) l(event)
    else streamPending.set(event.id, [...(streamPending.get(event.id) ?? []), event].slice(-2000))
  })
}

/**
 * 订阅一个流：先补发已缓存的事件，再接后续的。返回退订函数。
 *
 * 补发**不消耗**缓冲：输出面板和「失败提示」是先后挂上的（面板在子组件里、它的 effect 先跑），
 * 谁先订阅都该看到已经吐出来的那几帧。只有补发到结束帧时才清 —— 流已终结，不会再有新事件。
 */
function listenStream(id: string, listener: (event: DockerStreamEvent) => void): () => void {
  ensureStreamSubscription()
  const held = streamPending.get(id)
  for (const e of held ?? []) listener(e)
  const set = streamListeners.get(id) ?? new Set()
  set.add(listener)
  streamListeners.set(id, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      streamListeners.delete(id)
      // 最后一个订阅者走了、流也结束了：缓冲没用了，放掉
      if (streamPending.get(id)?.some((e) => e.type === 'exit')) streamPending.delete(id)
    }
  }
}

/** 输出里最后一行有内容的（compose 的报错都在最后），拿来当提示的正文。 */
function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 300)
}

/**
 * 长任务（compose / 拉镜像 / 删项目）跑完后在右下角报一声，成败都报。
 *
 * 成也要弹：输出的那块面板在页面顶部、又会自己滚，跑完一件事回头什么也看不到，
 * 「发生啥都不知道」（成功本来不弹，用户提了才补上）。正文取输出的最后一行 ——
 * compose 的「Network envtest_default Removed」正好说明刚才干了什么。
 *
 * 失败留到手动关（duration: 0）：报错要能反复看；成功按默认时长自己消失，不占屏幕。
 */
function useStreamOutcome(title: string, id: string | undefined): void {
  const toast = useToast()
  // toast 每次渲染都是新对象，放进依赖会让 effect 反复重订（同上面 ContainerDrawer 那条注释）
  const notify = useRef(toast.notify)
  notify.current = toast.notify
  const notified = useRef('')
  useEffect(() => {
    if (!id) return
    let text = ''
    return listenStream(id, (event) => {
      if (event.type === 'data') {
        text = (text + event.data).slice(-8000)
        return
      }
      if (notified.current === id) return
      notified.current = id
      const tail = lastLine(text)
      if (event.code === 0) {
        notify.current({ title: `${title}：完成`, description: tail || undefined, tone: 'success' })
        return
      }
      notify.current({
        title: `${title}失败`,
        description: tail || (event.code === null ? '连接断了，没收到结束帧' : `退出码 ${event.code}`),
        tone: 'error',
        duration: 0,
      })
    })
  }, [id, title])
}

/** 等某个流结束（「拉取并重建」要在 pull 成功后才 up）。 */
function onStreamExit(id: string, handler: (code: number | null) => void): () => void {
  const off = listenStream(id, (event) => {
    if (event.type !== 'exit') return
    off()
    handler(event.code)
  })
  return off
}

/** 输出最多留多少字符：长时间跟着的日志不能把渲染进程撑爆 */
const maxOutput = 400_000

function useStream(id: string | undefined): { text: string; code: number | null | undefined } {
  const [text, setText] = useState('')
  const [code, setCode] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    if (!id) return
    setText('')
    setCode(undefined)
    const apply = (event: DockerStreamEvent) => {
      if (event.type === 'data') setText((prev) => (prev + event.data).slice(-maxOutput))
      else setCode(event.code)
    }
    return listenStream(id, apply)
  }, [id])
  return { text, code }
}

/**
 * 输出面板：右下角的浮窗。
 *
 * 原来它排在页头下面、撑满整行，跑完还赖在最上面，跟页头挤在一起像块补丁（用户提的「位置很奇怪」）。
 *
 * 用 portal 挂到 body，不走原地渲染：它嵌在 PageTransition 里，切页动画会给祖先加 transform，
 * 而 transform 会把 `position: fixed` 的参照系从视口改成那个祖先 —— 浮窗会跟着页面飘。
 */
function OutputPanel({
  title,
  streamId,
  onClose,
  follow = true,
  failTitle,
  wasPrune = false,
}: {
  title: string
  streamId: string
  onClose: () => void
  follow?: boolean
  failTitle?: string
  /** 这是清理镜像的流：收 0 字节时把「完成」换成中性的「无可清理」（见下面的注释） */
  wasPrune?: boolean
}) {
  const { text, code } = useStream(streamId)
  // 「失败提示」用动作名（「停止并移除失败」），不用面板标题 —— 后者是「项目名 · 动作」拼的，接上「失败」读着别扭
  useStreamOutcome(failTitle ?? title, streamId)
  const pre = useRef<HTMLPreElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text, follow])
  // 右下角还有 toast（同一个角）。量一下浮窗多高，把 toast 抬到它上面去 —— 输出长短不一，
  // 写死一个抬升量会在输出很短时留一大块空白。关掉浮窗时把变量摘掉，toast 落回原位。
  useEffect(() => {
    const el = box.current
    if (!el) return
    const root = document.documentElement
    const push = () => root.style.setProperty('--kura-output-lift', `${Math.round(el.getBoundingClientRect().height) + 12}px`)
    push()
    const observer = new ResizeObserver(push)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--kura-output-lift')
    }
  }, [])
  /**
   * 「跑完了但什么都没发生」要说成中性，不能说成成功。
   *
   * 清理镜像最容易撞上：`dangling` 那档只认没有标签的镜像，很多时候本来就是 0 个，
   * 于是执行完是绿的「完成」+「回收 0 B」—— 用户会以为清出了空间，去看磁盘却没变。
   * 服务端会输出「没有可清理…」这句，这里据此换成灰色的「无可清理」。
   *
   * `wasPrune` 由调用方显式给出，不靠匹配文本去猜：日志流的内容是 NAS 上任意程序打出来的，
   * 里面完全可能出现同样几个字，那样就会把一条正常的日志显示成「无可清理」。
   */
  const nothingDone = wasPrune && code === 0 && text.includes('没有可清理')
  const tone: StatusTone = code === undefined ? 'accent' : code !== 0 ? 'danger' : nothingDone ? 'neutral' : 'success'
  const label =
    code === undefined ? '进行中…' : code === null ? '连接断开' : code !== 0 ? `失败（退出码 ${code}）` : nothingDone ? '无可清理' : '完成'
  return createPortal(
    <div className="kura-docker-output__float" ref={box} data-testid="docker-output" data-state={code === undefined ? 'running' : code === 0 ? 'ok' : 'error'}>
      <Section
        className="kura-docker-output"
        title={title}
        actions={
          <>
            <StatusBadge tone={tone} dot size="sm">
              {label}
            </StatusBadge>
            <Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label="关闭输出" onClick={onClose} />
          </>
        }
      >
        <pre ref={pre} className="kura-docker-output__text">{text || (code === undefined ? '等待输出…' : '（没有输出）')}</pre>
      </Section>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- 项目

interface UpdatesState {
  byImage: Map<string, UpdateCheck>
  checking: boolean
  checkedAt: number
  check: () => void
}

/**
 * 「有没有新版」：借 Arcane 的 digest 更新提示。只在用户点了才去问仓库（NAS 要连外网、仓库有限流），
 * 结果留在这一页的内存里。这是手动那一路；按项目的自动更新见 useAutoUpdate。
 */
function useUpdateChecks(overview: DockerOverview | null): UpdatesState {
  const toast = useToast()
  const [byImage, setByImage] = useState(new Map<string, UpdateCheck>())
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState(0)
  const check = useCallback(() => {
    if (!overview || !window.kura) return
    // Kura 自己的镜像不问：它由 watchtower 管
    const images = [...new Set(overview.containers.filter((c) => !c.protected).map((c) => c.image))]
    setChecking(true)
    void window.kura.docker
      .checkUpdates(images)
      .then((results) => {
        setByImage(new Map(results.map((r) => [r.image, r])))
        setCheckedAt(Date.now())
        const n = results.filter((r) => r.status === 'update').length
        const unknown = results.filter((r) => r.status === 'unknown').length
        toast.notify({ title: n ? `${n} 个镜像有新版` : '都是最新的', description: unknown ? `${unknown} 个查不了（本地构建或仓库要认证），悬停项目上的标记看原因` : undefined, tone: n ? 'info' : 'success' })
      })
      .catch((e: Error) => toast.notify({ title: '检查更新失败', description: e.message, tone: 'error' }))
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview])
  return { byImage, checking, checkedAt, check }
}

interface AutoUpdateState {
  status: AutoUpdateStatus | null
  busy: string
  toggle: (name: string, on: boolean) => void
  runNow: () => void
}

/**
 * 按项目的自动更新（服务端在 kura-server 里跑，见 server/src/docker/autoupdate.ts）。
 * 这里是它的开关与状态显示 —— 调度不依赖这个窗口开着。
 */
function useAutoUpdate(): AutoUpdateState {
  const toast = useToast()
  const [status, setStatus] = useState<AutoUpdateStatus | null>(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    if (!window.kura) return
    let alive = true
    const load = () =>
      void window.kura!.docker
        .autoUpdate()
        .then((next) => {
          if (alive) setStatus(next)
        })
        // 老镜像没有这个接口（404），静默即可 —— 页面照常能用，只是没有自动更新这一节
        .catch(() => {})
    load()
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 10_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const toggle = useCallback((name: string, on: boolean) => {
    if (!window.kura) return
    setBusy(name)
    void window.kura.docker
      .setAutoUpdate(name, on)
      .then(setStatus)
      .catch((e: Error) => toast.notify({ title: on ? `没能给 ${name} 开自动更新` : `没能给 ${name} 关自动更新`, description: e.message, tone: 'error' }))
      .finally(() => setBusy(''))
  }, [toast])

  const runNow = useCallback(() => {
    if (!window.kura) return
    setBusy('*')
    void window.kura.docker
      .runAutoUpdate()
      .then((results) => {
        // 空结果有两种意思：真的一轮没变化，或者上一轮还在跑、这次被跳过了（服务端 returning []）
        // —— 拿状态里的 running 区分，别把「没跑成」说成「都是最新的」
        return window.kura!.docker.autoUpdate().then((next) => {
          setStatus(next)
          if (next.running) {
            toast.notify({ title: '上一轮还在跑', description: '等它跑完再来（自动更新同一时间只跑一轮）', tone: 'info' })
            return
          }
          const changed = results.filter((r) => r.ok)
          const failed = results.filter((r) => !r.ok)
          toast.notify({
            title: changed.length ? `更新了 ${changed.length} 个项目` : '都是最新的',
            description: failed.length ? `${failed.length} 个失败：${failed[0]!.project} · ${failed[0]!.reason}` : undefined,
            tone: failed.length ? 'error' : 'success',
          })
        })
      })
      .catch((e: Error) => toast.notify({ title: '自动更新失败', description: e.message, tone: 'error' }))
      .finally(() => setBusy(''))
  }, [toast])

  return { status, busy, toggle, runNow }
}

/** 删除项目：两个勾默认都不勾 —— 默认只停掉并移除容器，卷和文件都留着（借 Arcane 的 Destroy）。 */
function RemoveProject({ project, onRemove, disabled }: { project: ProjectView; onRemove: (options: { volumes: boolean; files: boolean }) => void; disabled: boolean }) {
  const [volumes, setVolumes] = useState(false)
  const [files, setFiles] = useState(false)
  return (
    <ConfirmDialog
      triggerLabel="删除项目"
      title={`删除项目 ${project.name}？`}
      description="默认只停掉并移除它的容器，卷与项目文件都保留 —— 之后点「启动」能原样建回来。下面两项会真的删数据，勾了才删。"
      confirmLabel={volumes || files ? '删除（含勾选项）' : '停止并移除容器'}
      tone="danger"
      disabled={disabled}
      confirmationText={volumes ? project.name : undefined}
      onConfirm={() => {
        onRemove({ volumes, files })
        setVolumes(false)
        setFiles(false)
      }}
    >
      <SwitchField label="同时删除卷（数据库、上传的文件等会丢失）" description="compose 里声明的命名卷；绑定挂载的目录不受影响" checked={volumes} onCheckedChange={setVolumes} />
      <SwitchField label="同时删除项目文件" description="只删 compose 文件、.env 和备份；目录里还有别的东西就整个留着" checked={files} onCheckedChange={setFiles} />
    </ConfirmDialog>
  )
}

function ProjectsTab({
  overview,
  onRun,
  busy,
  onOpenContainer,
  onEdit,
  onRemove,
  onNew,
  mapped,
  onOpenMirror,
  updates,
  auto,
}: {
  overview: DockerOverview
  onRun: (project: ProjectView, action: ProjectAction) => void
  busy: string
  onOpenContainer: (c: ContainerView) => void
  onEdit: (project: ProjectView) => void
  onRemove: (project: ProjectView, options: { volumes: boolean; files: boolean }) => void
  onNew: () => void
  mapped: ServiceView[]
  onOpenMirror?: () => void
  updates: UpdatesState
  auto: AutoUpdateState
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const projects = overview.projects.filter((p) => !q || p.name.includes(q) || p.dir.toLowerCase().includes(q))
  if (overview.projects.length === 0) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Layers size={22} aria-hidden />}
          title="没有 compose 项目"
          description="NAS 上还没有用 docker compose 起过的应用，项目目录里也没有 compose 文件。"
          action={
            <Button variant="secondary" icon={<Plus {...icon} />} onClick={onNew}>
              新建项目
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className="kura-docker-projects">
      <div className="kura-toolbar">
        <Button size="sm" variant="secondary" icon={<Plus {...icon} />} onClick={onNew}>
          新建项目
        </Button>
        <Button size="sm" variant="ghost" icon={<CircleArrowUp {...icon} />} disabled={updates.checking} onClick={updates.check} title="问镜像仓库有没有新版（不拉镜像）">
          {updates.checking ? '检查中…' : updates.checkedAt ? `检查更新（${new Date(updates.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}）` : '检查更新'}
        </Button>
        {auto.status && auto.status.projects.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw {...icon} />}
            disabled={Boolean(auto.busy)}
            onClick={auto.runNow}
            title={`立即对开了自动更新的 ${auto.status.projects.length} 个项目跑一轮（平时每 6 小时自己跑）`}
            data-testid="auto-run"
          >
            {auto.busy === '*' ? '更新中…' : '立即跑一轮'}
          </Button>
        )}
        <div className="kura-toolbar__search">
          <TextField label="筛选项目" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="名字或目录" />
        </div>
      </div>
      <ul className="kura-docker-list" data-testid="project-list">
        {projects.map((p) => {
          const status = projectTone[p.status]
          const members = overview.containers.filter((c) => c.project === p.name)
          const readOnly = p.kind === 'self'
          const canStart = p.kind === 'managed' || p.kind === 'appstore'
          const running = busy === p.name
          return (
            <li key={p.name} className="kura-docker-project" data-project={p.name} data-kind={p.kind}>
              <div className="kura-docker-project__head">
                <StatusBadge tone={status.tone} dot size="sm">
                  {status.label}
                </StatusBadge>
                <h3>{p.name}</h3>
                {kindLabel[p.kind] && <span className="kura-docker-tag">{kindLabel[p.kind]}</span>}
                {(() => {
                  const pending = members.map((m) => updates.byImage.get(m.image)).filter((u): u is UpdateCheck => u?.status === 'update')
                  if (pending.length === 0) return null
                  return (
                    <StatusBadge tone="accent" size="sm">
                      <span title={pending.map((u) => u.image).join('\n')} data-testid="project-update">
                        有更新
                      </span>
                    </StatusBadge>
                  )
                })()}
                <span className="kura-term__spacer" />
                {readOnly ? (
                  // Kura 自己：不能在这里启停 / 删除（会剪断自己连着的那根线），
                  // 但**能给自动更新开关** —— 它是 Kura 更新自己的能力，不再依赖 watchtower
                  <div className="kura-docker-actions">
                    <SwitchField
                      label="自动更新"
                      className="kura-docker-auto"
                      checked={Boolean(auto.status?.projects.includes(p.name))}
                      disabled={Boolean(auto.busy)}
                      onCheckedChange={(on) => auto.toggle(p.name, on)}
                    />
                    <span className="kura-form__note" title="Kura 更新自己：换新镜像后自己重建，终端会话会断一下">
                      自己更新自己 · 不能在这里启停
                    </span>
                  </div>
                ) : (
                  <div className="kura-docker-actions">
                    {canStart && (
                      <SwitchField
                        label="自动更新"
                        className="kura-docker-auto"
                        checked={Boolean(auto.status?.projects.includes(p.name))}
                        disabled={Boolean(auto.busy)}
                        onCheckedChange={(on) => auto.toggle(p.name, on)}
                      />
                    )}
                    {canStart && auto.status?.projects.includes(p.name) && (
                      <span className="kura-form__note" title="同一个项目别在 Kura 和 NAS 上的 watchtower 两边都开">
                        每 6 小时问一次，有新版本就拉取并重建
                      </span>
                    )}
                    {canStart && p.status !== 'running' && (
                      <Button size="sm" variant="secondary" icon={<Play {...icon} />} disabled={Boolean(busy)} onClick={() => onRun(p, 'up')}>
                        {running ? '执行中…' : '启动'}
                      </Button>
                    )}
                    {canStart && p.containers > 0 && (
                      <Button size="sm" variant="ghost" icon={<RotateCcw {...icon} />} disabled={Boolean(busy)} onClick={() => onRun(p, 'restart')}>
                        {running ? '执行中…' : '重启'}
                      </Button>
                    )}
                    {p.kind === 'managed' && (
                      <Button size="sm" variant="ghost" icon={<Pencil {...icon} />} disabled={Boolean(busy)} onClick={() => onEdit(p)}>
                        编辑
                      </Button>
                    )}
                    <ActionMenu
                      label={`${p.name} 的更多操作`}
                      icon={<Ellipsis {...icon} />}
                      items={[
                        ...(canStart ? [{ id: 'pull', label: '拉取最新镜像并重建', icon: <Download {...icon} /> }] : []),
                        { id: 'down', label: '停止并移除容器', icon: <CircleStop {...icon} />, tone: 'danger' as const, disabled: p.containers === 0, separatorBefore: canStart },
                      ]}
                      onAction={(id) => onRun(p, id as ProjectAction)}
                    />
                    {p.kind === 'managed' && <RemoveProject project={p} disabled={Boolean(busy)} onRemove={(o) => onRemove(p, o)} />}
                  </div>
                )}
              </div>
              <p className="kura-docker-project__dir">
                <code>{p.dir || '（目录未知）'}</code>
                <span>
                  {p.running}/{p.containers} 个容器在跑
                </span>
              </p>
              {(() => {
                // Kura 独有：项目里的服务（或项目名）在服务映射里有卡片，就给出本机地址
                const names = new Set([p.name, ...p.services, ...members.map((m) => m.name)])
                const links = mapped.filter((s) => s.spec.service && names.has(s.spec.service) && s.listener.enabled)
                if (links.length === 0) return null
                return (
                  <p className="kura-docker-project__links" data-testid="project-mapped">
                    映射到本机：
                    {links.map((s) => (
                      <button key={s.key} type="button" className="kura-card__local" title="在浏览器打开" onClick={() => void window.kura?.openExternal(s.localUrl)}>
                        {s.localUrl.replace(/^http:\/\//, '')}
                      </button>
                    ))}
                    {onOpenMirror && (
                      <Button size="sm" variant="ghost" onClick={onOpenMirror}>
                        去服务映射
                      </Button>
                    )}
                  </p>
                )
              })()}
              {members.length > 0 && (
                <ul className="kura-docker-members">
                  {members.map((c) => {
                    const t = containerTone(c)
                    return (
                      <li key={c.id}>
                        <button type="button" onClick={() => onOpenContainer(c)} title="查看详情与日志">
                          <span className="kura-docker-dot" data-tone={t.tone} aria-hidden />
                          {c.service || c.name}
                        </button>
                        {portText(c) && <code>{portText(c)}</code>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- 容器

function ContainersTab({ overview, onOpen }: { overview: DockerOverview; onOpen: (c: ContainerView) => void }) {
  const [filter, setFilter] = useState('all')
  const rows = overview.containers.filter((c) => filter === 'all' || (filter === 'running' ? c.state === 'running' : c.state !== 'running'))
  const columns: DataTableColumn<ContainerView>[] = [
    {
      id: 'name',
      header: '名称',
      cell: (c) => (
        <button type="button" className="kura-files__name" onClick={() => onOpen(c)}>
          <Container {...icon} />
          <span>{c.name}</span>
        </button>
      ),
      sortValue: (c) => c.name,
    },
    {
      id: 'state',
      header: '状态',
      cell: (c) => {
        const t = containerTone(c)
        return (
          <StatusBadge tone={t.tone} dot size="sm">
            {t.label}
          </StatusBadge>
        )
      },
      sortValue: (c) => c.state,
    },
    { id: 'project', header: '项目', cell: (c) => c.project || <span className="kura-form__note">（单独）</span>, sortValue: (c) => c.project },
    { id: 'image', header: '镜像', cell: (c) => <code className="kura-docker-image">{c.image}</code>, sortValue: (c) => c.image },
    { id: 'ports', header: '端口', cell: (c) => portText(c) },
  ]
  return (
    <DataTable
      label="容器"
      rows={rows}
      columns={columns}
      getRowId={(c) => c.id}
      getRowLabel={(c) => c.name}
      searchText={(c) => `${c.name} ${c.image} ${c.project}`}
      searchPlaceholder="名称、镜像、项目"
      defaultSort={{ columnId: 'name', direction: 'asc' }}
      pageSize={50}
      toolbar={
        <FluidSegmented
          label="按状态筛选"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: 'all', label: `全部 ${overview.containers.length}` },
            { value: 'running', label: `运行中 ${overview.containers.filter((c) => c.state === 'running').length}` },
            { value: 'stopped', label: '已停止' },
          ]}
        />
      }
      emptyLabel="没有容器"
    />
  )
}

function ContainerDrawer({ container, onClose, onChanged }: { container: ContainerView; onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const [detail, setDetail] = useState<ContainerDetail | null>(null)
  const [stats, setStats] = useState<ContainerStats | null>(null)
  const [logStream, setLogStream] = useState<string>()
  const [busy, setBusy] = useState('')
  const [force, setForce] = useState(false)

  useEffect(() => {
    let alive = true
    void window.kura?.docker.container(container.id).then((d) => alive && setDetail(d)).catch((e: Error) => toast.notify({ title: '读不到详情', description: e.message, tone: 'error' }))
    if (container.state === 'running') void window.kura?.docker.stats(container.id).then((s) => alive && setStats(s)).catch(() => {})
    // 打开就跟着最近的日志；开不起来也要说一声，否则日志区一直停在「正在连接日志…」
    let opened: string | undefined
    void window.kura?.docker
      .openStream('logs', container.id)
      .then((id) => {
        opened = id
        if (alive) setLogStream(id)
        else void window.kura?.docker.closeStream(id)
      })
      .catch((e: Error) => toast.notify({ title: '连不上日志', description: e.message, tone: 'error' }))
    return () => {
      alive = false
      if (opened) void window.kura?.docker.closeStream(opened)
    }
    // container.id 变了才重开；toast 每次渲染是新对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container.id])

  const act = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await work()
      toast.notify({ title: `${label}：完成`, tone: 'success' })
      onChanged()
    } catch (caught) {
      toast.notify({ title: `${label}失败`, description: (caught as Error).message, tone: 'error', duration: 0 })
    } finally {
      setBusy('')
    }
  }

  const t = containerTone(container)
  const running = container.state === 'running'
  return (
    <aside className="kura-docker-drawer" data-testid="container-drawer" aria-label={`${container.name} 详情`}>
      <header className="kura-section__head">
        <h2>{container.name}</h2>
        <StatusBadge tone={t.tone} dot size="sm">
          {t.label}
        </StatusBadge>
        <span className="kura-term__spacer" />
        <Button size="sm" variant="ghost" icon={<X {...icon} />} aria-label="关闭详情" onClick={onClose} />
      </header>

      {container.protected ? (
        <p className="kura-form__note">这是 Kura 自己的容器，只读；它由 NAS 上的 watchtower 更新。</p>
      ) : (
        <div className="kura-docker-actions">
          {running ? (
            <>
              <Button size="sm" variant="secondary" icon={<RotateCcw {...icon} />} disabled={Boolean(busy)} onClick={() => void act('重启', () => window.kura!.docker.containerAction(container.id, 'restart'))}>
                {busy === '重启' ? '重启中…' : '重启'}
              </Button>
              <Button size="sm" variant="ghost" icon={<CircleStop {...icon} />} disabled={Boolean(busy)} onClick={() => void act('停止', () => window.kura!.docker.containerAction(container.id, 'stop'))}>
                {busy === '停止' ? '停止中…' : '停止'}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" icon={<Play {...icon} />} disabled={Boolean(busy)} onClick={() => void act('启动', () => window.kura!.docker.containerAction(container.id, 'start'))}>
              {busy === '启动' ? '启动中…' : '启动'}
            </Button>
          )}
          <ConfirmDialog
            triggerLabel="删除容器"
            title={`删除容器 ${container.name}？`}
            description={
              container.project
                ? `它属于项目「${container.project}」，下次在项目上点「启动」会按 compose 重新建出来。挂载的数据不会被删。`
                : '单独起的容器删掉就没了（挂载的数据不会被删）。'
            }
            confirmLabel="删除"
            tone="danger"
            disabled={Boolean(busy)}
            onConfirm={async () => {
              if (running && !force) {
                toast.notify({ title: '容器还在运行', description: '先停止它，或打开「强制删除」', tone: 'warning' })
                return
              }
              await act('删除', () => window.kura!.docker.removeContainer(container.id, running && force))
              onClose()
            }}
          >
            {running && <SwitchField label="强制删除（容器正在运行）" description="会先强行停掉它；正在写的数据可能不完整" checked={force} onCheckedChange={setForce} />}
          </ConfirmDialog>
        </div>
      )}

      {detail && (
        <dl className="kura-docker-facts">
          <div>
            <dt>镜像</dt>
            <dd>
              <code>{detail.image}</code>
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{container.status}</dd>
          </div>
          {stats && (
            <div>
              <dt>资源</dt>
              <dd>
                CPU {stats.cpuPercent}% · 内存 {humanBytes(stats.memoryUsage)}
                {stats.memoryLimit ? ` / ${humanBytes(stats.memoryLimit)}` : ''}
              </dd>
            </div>
          )}
          <div>
            <dt>重启策略</dt>
            <dd>
              {detail.restartPolicy}
              {detail.restartCount > 0 ? ` · 已重启 ${detail.restartCount} 次` : ''}
            </dd>
          </div>
          {portText(container) && (
            <div>
              <dt>端口</dt>
              <dd>{portText(container)}</dd>
            </div>
          )}
          <div>
            <dt>网络</dt>
            <dd>{detail.networks.join('、') || '—'}</dd>
          </div>
          <div>
            <dt>命令</dt>
            <dd>
              <code>{detail.command || '—'}</code>
            </dd>
          </div>
          {detail.mounts.length > 0 && (
            <div>
              <dt>挂载</dt>
              <dd>
                <ul className="kura-docker-mounts">
                  {detail.mounts.map((m) => (
                    <li key={m.destination}>
                      <code>{m.source}</code> → <code>{m.destination}</code>
                      {!m.rw && <span className="kura-docker-tag">只读</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {detail.env.length > 0 && (
            <div>
              <dt>环境变量</dt>
              <dd>
                <ul className="kura-docker-env">
                  {detail.env.map((e) => (
                    <li key={e.name}>
                      <code>{e.name}</code>={e.masked ? <span className="kura-form__note">（已隐藏）</span> : <code>{e.value}</code>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      )}

      {running && !container.protected && (
        <section className="kura-docker-logs">
          <header className="kura-section__head">
            <h3>Shell</h3>
          </header>
          <ContainerShell container={container.id} subscribe={listenStream} />
        </section>
      )}

      <section className="kura-docker-logs">
        <header className="kura-section__head">
          <h3>日志</h3>
          <span className="kura-term__spacer" />
          <Button
            size="sm"
            variant="ghost"
            icon={<FileText {...icon} />}
            onClick={() =>
              void window.kura?.docker
                .saveLogs(container.id, container.name)
                .then((path) => path && toast.notify({ title: '日志已保存', description: path, tone: 'success' }))
                .catch((e: Error) => toast.notify({ title: '保存失败', description: e.message, tone: 'error' }))
            }
          >
            下载完整日志
          </Button>
        </header>
        {logStream ? <LogView streamId={logStream} /> : <p className="kura-form__note">正在连接日志…</p>}
      </section>
    </aside>
  )
}

function LogView({ streamId }: { streamId: string }) {
  const { text, code } = useStream(streamId)
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text])
  return (
    <pre
      ref={pre}
      className="kura-docker-output__text"
      data-testid="container-logs"
      onScroll={(e) => {
        const el = e.currentTarget
        // 用户往上翻了就别再自动滚到底
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {text || (code === undefined ? '（还没有日志）' : '（日志流已结束）')}
    </pre>
  )
}

// ---------------------------------------------------------------- 镜像

function ImagesTab({ onPull, onPrune, refreshKey }: { onPull: (image: string) => void; onPrune: (scope: PruneScope) => void; refreshKey: number }) {
  const toast = useToast()
  const [images, setImages] = useState<ImageView[] | null>(null)
  const [pull, setPull] = useState('')
  const load = useCallback(() => {
    void window.kura?.docker.images().then(setImages).catch((e: Error) => toast.notify({ title: '读不到镜像', description: e.message, tone: 'error' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 清理是后台跑的，跑完得重新读一次列表，否则被清掉的镜像还挂在表里。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [load, refreshKey])

  if (!images) return null
  const total = images.reduce((s, i) => s + i.size, 0)
  const dangling = images.filter((i) => i.dangling)
  /**
   * 有标签、但没有任何容器在用 —— Docker 不把它算作「悬空」，`dangling=true` 一个也清不掉。
   * 更新留下的旧版本标签正是这一类，所以单独给一个入口。
   *
   * **要把悬空的也算进来**：`prune?all=1` 清的是「所有没被用到的」，其中包含悬空的。
   * 只按 `!dangling` 算会少报，用户点下去清掉的比看到的说明多 —— 那是最不该发生的一种。
   */
  const unused = images.filter((i) => i.usedBy === 0)
  const columns: DataTableColumn<ImageView>[] = [
    { id: 'tag', header: '标签', cell: (i) => (i.tags.length ? i.tags.map((t) => <code key={t} className="kura-docker-image">{t}</code>) : <span className="kura-form__note">（悬空）</span>), sortValue: (i) => i.tags[0] ?? '' },
    { id: 'size', header: '大小', cell: (i) => humanBytes(i.size), sortValue: (i) => i.size, align: 'end' },
    { id: 'used', header: '使用中', cell: (i) => (i.usedBy ? `${i.usedBy} 个容器` : ''), sortValue: (i) => i.usedBy, align: 'end' },
    { id: 'created', header: '创建', cell: (i) => formatTime(i.created), sortValue: (i) => i.created },
  ]
  return (
    <div className="kura-docker-images">
      <form
        className="kura-rules__add"
        onSubmit={(e) => {
          e.preventDefault()
          if (pull.trim()) onPull(pull.trim())
        }}
      >
        <TextField label="拉取镜像" placeholder="redis:7、ghcr.io/owner/app:latest" value={pull} onChange={(e) => setPull(e.target.value)} spellCheck={false} />
        <Button type="submit" size="sm" variant="secondary" icon={<Download {...icon} />} disabled={!pull.trim()}>
          拉取
        </Button>
      </form>
      <DataTable
        label="镜像"
        rows={images}
        columns={columns}
        getRowId={(i) => i.id}
        getRowLabel={(i) => i.tags[0] ?? i.id.slice(7, 19)}
        searchText={(i) => i.tags.join(' ')}
        searchPlaceholder="标签"
        pageSize={50}
        rowActions={(i) =>
          i.usedBy === 0 ? (
            <ConfirmDialog
              triggerLabel="删除"
              title={`删除镜像 ${i.tags[0] ?? i.id.slice(7, 19)}？`}
              description="没有容器在用它。删掉之后再要就得重新拉取。"
              confirmLabel="删除"
              tone="danger"
              onConfirm={async () => {
                try {
                  await window.kura!.docker.removeImage(i.id)
                  load()
                } catch (e) {
                  toast.notify({ title: '删除失败', description: (e as Error).message, tone: 'error', duration: 0 })
                }
              }}
            />
          ) : null
        }
        toolbar={
          <div className="kura-docker-actions">
            <span className="kura-form__note">
              共 {images.length} 个 · {humanBytes(total)}
            </span>
            {/* 「悬空」= 连标签都没有（`<none>`），Docker 的 dangling 就是这个定义。
                它清不掉「有标签但没人用」的旧版本 —— 那是更常见的一类，所以下面还有一个入口。 */}
            <ConfirmDialog
              triggerLabel={`清理悬空镜像（${dangling.length}）`}
              title="清理悬空镜像？"
              description={`删除 ${dangling.length} 个没有标签的镜像，约 ${humanBytes(dangling.reduce((s, i) => s + i.size, 0))}。正在用的不会动。`}
              confirmLabel="清理"
              disabled={dangling.length === 0}
              // 点确认就不用守在这儿了：清理转到后台跑，进度在右下角浮窗里看。
              // 以前这里是 await 到清理完成才返回，ConfirmDialog 要等 onConfirm 落地才关，
              // 于是清理那几十秒里对话框一直占着前台、挡住别的操作。
              onConfirm={() => onPrune('dangling')}
            />
            {/*
              有标签、没容器在用的镜像。**这是危险的一档**：它会把「拉了留着以后用」的基础镜像
              （截图里的 busybox 那种）一并清掉，所以除了红色按钮还要用户手打一句确认。
              数字用 unused（含悬空），与服务端 `prune?all=1` 真正会清的范围对齐 ——
              只按 `!dangling` 算会少报，点下去删掉的比说好的多。
            */}
            <ConfirmDialog
              triggerLabel={`清理未使用镜像（${unused.length}）`}
              title="清理未使用的镜像？"
              description={`删除 ${unused.length} 个没有任何容器在用的镜像（含 ${dangling.length} 个悬空），约 ${humanBytes(unused.reduce((s, i) => s + i.size, 0))}。更新留下的旧版本在这一档里；但你手动拉来备用、暂时没跑的镜像也会一起没。正在用的不会动。`}
              confirmLabel="清理"
              tone="danger"
              confirmationText="清理未使用"
              disabled={unused.length === 0}
              onConfirm={() => onPrune('all')}
            />
          </div>
        }
        emptyLabel="没有镜像"
      />
    </div>
  )
}

// ---------------------------------------------------------------- 卷与网络（只读）

function VolumesTab() {
  const toast = useToast()
  const [volumes, setVolumes] = useState<VolumeView[] | null>(null)
  const [sizing, setSizing] = useState(false)
  const load = useCallback((withSize: boolean) => {
    if (withSize) setSizing(true)
    void window.kura?.docker
      .volumes(withSize)
      .then(setVolumes)
      .catch((e: Error) => toast.notify({ title: '读不到卷', description: e.message, tone: 'error' }))
      .finally(() => setSizing(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => load(false), [load])
  if (!volumes) return null
  const sized = volumes.some((v) => v.size >= 0)
  const columns: DataTableColumn<VolumeView>[] = [
    { id: 'name', header: '名称', cell: (v) => <code className="kura-docker-image">{v.name}</code>, sortValue: (v) => v.name },
    { id: 'project', header: '项目', cell: (v) => v.project || <span className="kura-form__note">（无）</span>, sortValue: (v) => v.project },
    {
      id: 'used',
      header: '使用中',
      cell: (v) => (v.usedBy.length ? v.usedBy.join('、') : <span className="kura-form__note">没有容器在用</span>),
      sortValue: (v) => v.usedBy.length,
    },
    { id: 'size', header: '占用', cell: (v) => (v.size >= 0 ? humanBytes(v.size) : '—'), sortValue: (v) => v.size, align: 'end' },
    { id: 'created', header: '创建', cell: (v) => formatTime(v.created), sortValue: (v) => v.created },
  ]
  return (
    <DataTable
      label="卷"
      rows={volumes}
      columns={columns}
      getRowId={(v) => v.name}
      getRowLabel={(v) => v.name}
      searchText={(v) => `${v.name} ${v.project}`}
      searchPlaceholder="名称、项目"
      pageSize={50}
      toolbar={
        <div className="kura-docker-actions">
          <span className="kura-form__note">
            {volumes.length} 个卷 · {volumes.filter((v) => v.usedBy.length === 0).length} 个没有容器在用
          </span>
          <Button size="sm" variant="ghost" icon={<RefreshCw {...icon} />} disabled={sizing} onClick={() => load(true)}>
            {sizing ? '计算中…' : sized ? '重新计算占用' : '计算占用'}
          </Button>
        </div>
      }
      emptyLabel="没有卷"
    />
  )
}

function NetworksTab() {
  const toast = useToast()
  const [networks, setNetworks] = useState<NetworkView[] | null>(null)
  useEffect(() => {
    void window.kura?.docker
      .networks()
      .then(setNetworks)
      .catch((e: Error) => toast.notify({ title: '读不到网络', description: e.message, tone: 'error' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!networks) return null
  return (
    <ul className="kura-docker-list" data-testid="network-list">
      {networks.map((n) => (
        <li key={n.id} className="kura-docker-project" data-network={n.name}>
          <div className="kura-docker-project__head">
            <h3>{n.name}</h3>
            <span className="kura-docker-tag">{n.driver}</span>
            {n.internal && <span className="kura-docker-tag">内部（不通外网）</span>}
            {n.builtin && <span className="kura-docker-tag">Docker 自带</span>}
            {n.project && <span className="kura-form__note">项目 {n.project}</span>}
          </div>
          {(n.subnet || n.gateway) && (
            <p className="kura-docker-project__dir">
              {n.subnet && <code>{n.subnet}</code>}
              {n.gateway && <span>网关 {n.gateway}</span>}
            </p>
          )}
          {n.containers.length > 0 ? (
            <ul className="kura-docker-members">
              {n.containers.map((c) => (
                <li key={c.name}>
                  <span className="kura-docker-dot" data-tone="success" aria-hidden />
                  {c.name}
                  {c.ip && <code>{c.ip}</code>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="kura-form__note">没有容器连在上面</p>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- 最近操作

const activityLabel: Record<string, string> = {
  'docker-start': '启动容器',
  'docker-stop': '停止容器',
  'docker-restart': '重启容器',
  'docker-remove': '删除容器',
  'docker-image-remove': '删除镜像',
  'docker-image-prune': '清理镜像',
  'docker-image-pull': '拉取镜像',
  'docker-compose-up': '启动项目',
  'docker-compose-down': '停止并移除项目',
  'docker-compose-restart': '重启项目',
  'docker-compose-pull': '拉取项目镜像',
}

function ActivityTab() {
  const [items, setItems] = useState<DockerActivity[] | null>(null)
  useEffect(() => {
    void window.kura?.docker.activity().then(setItems).catch(() => setItems([]))
  }, [])
  if (!items) return null
  if (items.length === 0) return <div className="kura-placeholder"><EmptyState title="还没有操作记录" description="在 Kura 里对容器做的每个改动都会记在这里（存在 NAS 的审计日志里）。" /></div>
  return (
    <ul className="kura-docker-activity" data-testid="docker-activity">
      {items.map((a, i) => (
        <li key={`${a.at}-${i}`} data-ok={a.exitCode === 0 || a.exitCode === undefined}>
          <time>{new Date(a.at).toLocaleString('zh-CN', { hour12: false })}</time>
          <strong>{activityLabel[a.action] ?? a.action}</strong>
          <code>{a.detail}</code>
          {a.exitCode !== undefined && a.exitCode !== 0 && <StatusBadge tone="danger" size="sm">失败</StatusBadge>}
          {a.durationMs !== undefined && <span className="kura-form__note">{(a.durationMs / 1000).toFixed(1)} 秒</span>}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- 页面

export function ContainersView({ mapped = [], onOpenMirror }: { mapped?: ServiceView[]; onOpenMirror?: () => void }) {
  const toast = useToast()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [overview, setOverview] = useState<DockerOverview | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('projects')
  const [selected, setSelected] = useState<ContainerView | null>(null)
  const [output, setOutput] = useState<{ title: string; id: string; project?: string; failTitle: string; wasPrune?: boolean } | null>(null)
  /** 清理跑完（成功或失败）就 +1，让镜像表重读一次 */
  const [prunedAt, setPrunedAt] = useState(0)
  /** 正在编辑哪个项目；'new' = 新建 */
  const [editing, setEditing] = useState<string | null>(null)
  const seq = useRef(0)
  const updates = useUpdateChecks(overview)
  const auto = useAutoUpdate()

  useEffect(ensureStreamSubscription, [])

  const refresh = useCallback(async () => {
    if (!window.kura) return
    const mine = ++seq.current
    try {
      const ok = await window.kura.docker.available()
      if (mine !== seq.current) return
      setAvailable(ok)
      if (!ok) return
      const next = await window.kura.docker.overview()
      if (mine !== seq.current) return
      setOverview(next)
      setError('')
    } catch (caught) {
      if (mine === seq.current) setError((caught as Error).message)
    }
  }, [])

  // 页面可见时每 5 秒刷一次状态（和映射页同一个规矩：看不见就不刷）
  useEffect(() => {
    void refresh()
    const tick = () => document.visibilityState === 'visible' && void refresh()
    const timer = setInterval(tick, 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  // 详情抽屉里的容器跟着刷新后的数据走（状态变了，按钮要跟着变）
  const current = useMemo(() => (selected ? (overview?.containers.find((c) => c.id === selected.id) ?? selected) : null), [selected, overview])

  // 流结束后立刻刷新一次，不等轮询
  const { code: outputCode } = useStream(output?.id)
  useEffect(() => {
    if (outputCode !== undefined) void refresh()
  }, [outputCode, refresh])

  const run = async (project: ProjectView, action: ProjectAction) => {
    try {
      if (action === 'pull') {
        // 「拉取并重建」= 先 pull 再 up：两步分开跑，第二步只在第一步成功时跑
        const id = await window.kura!.docker.openStream('project', project.name, 'pull')
        setOutput({ title: `${project.name} · 拉取最新镜像`, id, project: project.name, failTitle: `拉取 ${project.name} 的镜像` })
        onStreamExit(id, (code) => {
          if (code !== 0) return
          void window.kura!.docker
            .openStream('project', project.name, 'up')
            .then((upId) => setOutput({ title: `${project.name} · 按新镜像重建`, id: upId, project: project.name, failTitle: `重建 ${project.name}` }))
            // 拉取成功了但重建这一步没能开起来：不接住就是静默失败，用户只看到一个「完成」的面板
            .catch((caught: Error) => toast.notify({ title: `重建 ${project.name} 没起来`, description: caught.message, tone: 'error', duration: 0 }))
        })
        return
      }
      const id = await window.kura!.docker.openStream('project', project.name, action)
      setOutput({ title: `${project.name} · ${actionLabel[action]}`, id, project: project.name, failTitle: `${actionLabel[action]} ${project.name}` })
    } catch (caught) {
      toast.notify({ title: `${actionLabel[action]}失败`, description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  const removeProject = async (project: ProjectView, options: { volumes: boolean; files: boolean }) => {
    try {
      const id = await window.kura!.docker.openStream('remove', project.name, undefined, options)
      const what = [options.volumes && '卷', options.files && '文件'].filter(Boolean).join('、')
      setOutput({ title: `${project.name} · 删除${what ? `（含${what}）` : '（只移除容器）'}`, id, project: project.name, failTitle: `删除 ${project.name}` })
      if (editing === project.name) setEditing(null)
    } catch (caught) {
      toast.notify({ title: '删除失败', description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  const pullImage = async (image: string) => {
    try {
      const id = await window.kura!.docker.openStream('pull', image)
      setOutput({ title: `拉取 ${image}`, id, failTitle: `拉取 ${image}` })
    } catch (caught) {
      toast.notify({ title: '拉取失败', description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  const pruneImages = async (scope: PruneScope) => {
    const what = scope === 'all' ? '未使用镜像' : '悬空镜像'
    try {
      const id = await window.kura!.docker.openStream('prune', scope)
      setOutput({ title: `清理${what}`, id, failTitle: `清理${what}`, wasPrune: true })
      onStreamExit(id, () => setPrunedAt((n) => n + 1))
    } catch (caught) {
      toast.notify({ title: `清理${what}失败`, description: (caught as Error).message, tone: 'error', duration: 0 })
    }
  }

  if (available === null) return null
  if (!available) {
    return (
      <div className="kura-placeholder">
        <EmptyState
          icon={<Boxes size={22} aria-hidden />}
          title="NAS 上还没有开容器管理"
          description="kura-server 需要挂上 docker.sock 并升级到带容器管理的版本（服务端清单里出现 docker 服务后这里就能用）。"
          action={
            <Button variant="secondary" icon={<RefreshCw {...icon} />} onClick={() => void refresh()}>
              重新检测
            </Button>
          }
        />
      </div>
    )
  }
  if (!overview) {
    return error ? (
      <div className="kura-placeholder">
        <EmptyState title="读不到容器" description={error} action={<Button variant="secondary" onClick={() => void refresh()}>重试</Button>} />
      </div>
    ) : (
      <div className="kura-placeholder">
        <EmptyState title="正在读取" description="经映射层连接 NAS 上的 Docker" />
      </div>
    )
  }

  const busyProject = output && outputCode === undefined ? (output.project ?? '') : ''
  const running = overview.containers.filter((c) => c.state === 'running').length

  return (
    <div className="kura-docker" data-testid="docker-page">
      {error && <Banner tone="warning" description={`刷新失败：${error}（显示的是上一次的状态）`} />}
      {/* 项目目录没按原路径挂进来：项目列得出来、看得见，但都不能部署。
          这条来自服务端按 inode 做的真实判定，不是字符串匹配 —— 提前说清楚，
          好过让用户点了「部署」才看到一个 compose 的报错。 */}
      {overview.projectRootHint ? (
        <Banner
          tone="warning"
          title="项目目录没挂进 kura-server：能看，不能部署"
          description={
            <>
              {overview.projectRootHint}
              <br />
              这条限制是有原因的：compose 里的相对路径（<code>./data</code>）按<strong>执行目录</strong>解析，
              在错的路径下跑会让 Docker 在 NAS 上建一个空目录挂进去 —— 看起来就像数据全丢了。
            </>
          }
        />
      ) : null}
      {output && <OutputPanel title={output.title} streamId={output.id} failTitle={output.failTitle} wasPrune={output.wasPrune} onClose={() => setOutput(null)} />}
      {editing === 'new' && (
        <NewProject
          onClose={() => setEditing(null)}
          onCreated={(name, start) => {
            setEditing(null)
            toast.notify({ title: `已创建 ${name}`, tone: 'success' })
            void refresh().then(() => {
              if (start) void run({ name, status: 'stopped', kind: 'managed', dir: '', configFiles: [], containers: 0, running: 0, services: [] }, 'up')
            })
          }}
        />
      )}
      {editing && editing !== 'new' && (
        <ProjectEditor
          key={editing}
          name={editing}
          onClose={() => setEditing(null)}
          onApply={() => {
            const p = overview.projects.find((x) => x.name === editing)
            if (p) void run(p, 'up')
          }}
        />
      )}
      <div className="kura-docker__body" data-drawer={current ? 'open' : undefined}>
        <MotionTabs
          label="容器管理"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'projects', label: `项目 ${overview.projects.length}`, icon: <Layers {...icon} />, content: (
                <ProjectsTab
                  overview={overview}
                  onRun={(p, a) => void run(p, a)}
                  busy={busyProject}
                  onOpenContainer={setSelected}
                  onEdit={(p) => setEditing(p.name)}
                  onRemove={(p, o) => void removeProject(p, o)}
                  onNew={() => setEditing('new')}
                  mapped={mapped}
                  onOpenMirror={onOpenMirror}
                  updates={updates}
                  auto={auto}
                />
              ),
            },
            { value: 'containers', label: `容器 ${running}/${overview.containers.length}`, icon: <Container {...icon} />, content: <ContainersTab overview={overview} onOpen={setSelected} /> },
            { value: 'images', label: '镜像', icon: <Download {...icon} />, content: <ImagesTab onPull={(image) => void pullImage(image)} onPrune={(scope) => void pruneImages(scope)} refreshKey={prunedAt} /> },
            { value: 'volumes', label: '卷', icon: <HardDrive {...icon} />, content: <VolumesTab /> },
            { value: 'networks', label: '网络', icon: <Network {...icon} />, content: <NetworksTab /> },
            { value: 'activity', label: '最近操作', icon: <FileText {...icon} />, content: <ActivityTab /> },
            { value: 'config', label: '配置', icon: <Settings2 {...icon} />, content: <DockerConfigTab /> },
          ]}
        />
        {current && <ContainerDrawer key={current.id} container={current} onClose={() => setSelected(null)} onChanged={() => void refresh()} />}
      </div>
    </div>
  )
}

