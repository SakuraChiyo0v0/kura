import { useMemo, useState } from 'react'
import { ChevronDown, Copy, ExternalLink, Pencil, RefreshCw, Search } from 'lucide-react'
import { Banner, Button, EmptyState, FluidSegmented, StatusBadge, SwitchField, TextField, useToast, type StatusTone } from '@sakura-ui/react'
import type { LinkModeSetting } from '../shared/labels.js'
import type { MirrorSnapshot, ServiceContainerView, ServiceView } from '../core/mirror.js'
import { humanBytes, type TrendPoint } from '../core/stats.js'

type Filter = 'all' | 'running' | 'off' | 'problem'

/** 一个服务的状态：开关意图 × 是否在监听 × 探测结果。 */
export function serviceState(view: ServiceView): { tone: StatusTone; label: string } {
  if (!view.listener.enabled) return { tone: 'neutral', label: '已关闭' }
  if (!view.listener.running) return { tone: 'danger', label: '监听失败' }
  if (view.probe && !view.probe.ok) return { tone: 'warning', label: `探测失败 ×${view.probe.failStreak}` }
  return { tone: 'success', label: '监听中' }
}

/** 容器状态由入口聚合：有坏入口就是问题，全关才是已关闭。 */
export function containerState(view: ServiceContainerView): { tone: StatusTone; label: string } {
  const enabledPorts = view.ports.filter((port) => port.listener.enabled)
  if (enabledPorts.length === 0) return { tone: 'neutral', label: '已关闭' }
  const states = enabledPorts.map(serviceState)
  const problems = states.filter((state) => state.tone === 'danger' || state.tone === 'warning').length
  const running = states.filter((state) => state.tone === 'success').length
  if (problems > 0) return { tone: 'warning', label: `${problems} 个入口异常` }
  if (running === enabledPorts.length) return { tone: 'success', label: `${running} 个入口监听中` }
  return { tone: 'neutral', label: `${running}/${enabledPorts.length} 个入口监听中` }
}

/** 最近 30 分钟每分钟一柱：按窗口内峰值归一，失败叠在柱顶。纯 SVG，几何在这里算好。 */
function Sparkline({ trend }: { trend: TrendPoint[] }) {
  const peak = Math.max(1, ...trend.map((p) => p.requests))
  const w = 4
  const gap = 2
  const h = 28
  const width = trend.length * (w + gap) - gap
  const total = trend.reduce((sum, p) => sum + p.requests, 0)
  return (
    <svg className="kura-spark" viewBox={`0 0 ${width} ${h}`} width={width} height={h} role="img" aria-label={`最近 30 分钟共 ${total} 次请求`}>
      {trend.map((p, i) => {
        const reqH = p.requests ? Math.max(2, (p.requests / peak) * h) : 1
        const errH = p.errors ? Math.max(2, (Math.min(p.errors, p.requests || p.errors) / peak) * h) : 0
        const x = i * (w + gap)
        const time = new Date(p.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        return (
          <g key={p.at}>
            <title>{`${time} · 请求 ${p.requests}${p.errors ? ` · 失败 ${p.errors}` : ''}`}</title>
            <rect className={p.requests ? 'kura-spark__bar' : 'kura-spark__idle'} x={x} y={h - reqH} width={w} height={reqH} rx={1} />
            {errH > 0 && <rect className="kura-spark__err" x={x} y={h - reqH} width={w} height={errH} rx={1} />}
          </g>
        )
      })}
    </svg>
  )
}

/** 行内改本机端口：平时只显示地址，点铅笔才换成一个小输入框；回车应用，Esc 或失焦放弃。 */
function PortEditor({ view, onSave, onDone }: { view: ServiceView; onSave: (port: number) => Promise<void>; onDone: () => void }) {
  const [draft, setDraft] = useState(String(view.listener.port))
  const [busy, setBusy] = useState(false)
  const submit = () => {
    const port = Number(draft)
    if (busy) return
    if (draft === String(view.listener.port) || !port) return onDone()
    setBusy(true)
    void onSave(port)
      .then(onDone)
      .catch(() => setDraft(String(view.listener.port)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      className="kura-entry__editor"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <span className="kura-entry__host">127.0.0.1:</span>
      <input
        className="kura-entry__port-input"
        aria-label="本机端口"
        inputMode="numeric"
        autoFocus
        disabled={busy}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
        }}
        onBlur={() => {
          if (!busy && draft === String(view.listener.port)) onDone()
        }}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={busy}>
        {busy ? '应用中…' : '应用'}
      </Button>
    </form>
  )
}

/** 卡片默认露出的入口数；超过的收进「还有 N 个入口」。 */
const COLLAPSED_ENTRIES = 5

function isProblem(port: ServiceView): boolean {
  const tone = serviceState(port).tone
  return tone === 'danger' || tone === 'warning'
}

function ServiceCard({ view, refresh }: { view: ServiceContainerView; refresh: () => Promise<void> }) {
  const toast = useToast()
  const state = containerState(view)
  const [expanded, setExpanded] = useState(false)
  // 入口多时只露前几个；有问题的入口永远显示，别让故障藏在折叠里。
  // 只多出一个时直接全显示，免得为一行加一个「还有 1 个」。
  const collapsible = view.ports.length > COLLAPSED_ENTRIES + 1
  const shownPorts =
    collapsible && !expanded
      ? view.ports.filter((port, index) => index < COLLAPSED_ENTRIES || isProblem(port))
      : view.ports
  const hiddenCount = view.ports.length - shownPorts.length

  const run = async (label: string, action: () => Promise<void>) => {
    try {
      await action()
      void refresh() // 主进程已经改完，立刻拉一次，别等下一轮轮询
    } catch (caught) {
      toast.notify({ title: label, description: (caught as Error).message, tone: 'error', duration: 0 })
      throw caught
    }
  }

  return (
    <article
      className="kura-card kura-card--container"
      data-testid="service-card"
      data-container={view.label}
      {...(view.ports.length === 1 ? { 'data-service': view.ports[0]!.key } : {})}
    >
      {/* data-container 给冒烟脚本找；入口 key 仍保留在 data-service，供开关与改端口定位。 */}
      <header className="kura-card__head">
        <div className="kura-card__title">
          <h3>{view.label}</h3>
          <StatusBadge tone={state.tone} dot size="sm">
            {state.label}
          </StatusBadge>
        </div>
      </header>

      <ul className="kura-entries" aria-label={`${view.label} 的入口`}>
        {shownPorts.map((port) => (
          <ServicePortRow key={port.key} view={port} onRun={run} />
        ))}
        {collapsible && (
          <li className="kura-entries__more">
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : `还有 ${hiddenCount} 个入口`}
              <ChevronDown size={13} aria-hidden data-open={expanded} />
            </button>
          </li>
        )}
      </ul>

      {/* 上排是近一天（和概览同一口径），下排才是装机以来的累计 —— 两排数字不同，
          不写清楚会让人以为其中一个是错的 */}
      <dl className="kura-card__stats">
        <div>
          <dt>近一天请求</dt>
          <dd>{view.stats.recent.requests}</dd>
        </div>
        <div>
          <dt>近一天失败</dt>
          <dd data-bad={view.stats.recent.errors > 0}>{view.stats.recent.errors}</dd>
        </div>
        <div>
          <dt>↑ 近一天</dt>
          <dd>{humanBytes(view.stats.recent.bytesUp)}</dd>
        </div>
        <div>
          <dt>↓ 近一天</dt>
          <dd>{humanBytes(view.stats.recent.bytesDown)}</dd>
        </div>
      </dl>
      <dl className="kura-card__stats kura-card__stats--total">
        <div>
          <dt>累计请求</dt>
          <dd>{view.stats.requests}</dd>
        </div>
        <div>
          <dt>累计失败</dt>
          <dd data-bad={view.stats.errors > 0}>{view.stats.errors}</dd>
        </div>
        <div>
          <dt>↑ 累计</dt>
          <dd>{humanBytes(view.stats.bytesUp)}</dd>
        </div>
        <div>
          <dt>↓ 累计</dt>
          <dd>{humanBytes(view.stats.bytesDown)}</dd>
        </div>
      </dl>
      <Sparkline trend={view.stats.trend} />
      {view.ports.length > 1 && <EntryStats ports={view.ports} />}

      <span className="kura-card__meta">
        {view.ports.length > 1 ? `${view.ports.length} 个入口` : '1 个入口'}
        {view.ports[0]?.spec.source === 'discovered' ? ' · 服务端发现' : ' · 本地配置'}
      </span>
    </article>
  )
}

/** 多入口时，各入口的流量放在卡片底部一张小表里，不在每一行重复四格数字。 */
function EntryStats({ ports }: { ports: ServiceView[] }) {
  return (
    <details className="kura-entry-stats">
      <summary>按入口查看流量</summary>
      <table>
        <thead>
          <tr>
            <th>入口</th>
            <th>近一天请求</th>
            <th>失败</th>
            <th>↑ / ↓ 近一天</th>
            <th>累计请求</th>
          </tr>
        </thead>
        <tbody>
          {ports.map((port) => (
            <tr key={port.key}>
              <td>{port.listener.port}</td>
              <td>{port.stats.recent.requests}</td>
              <td data-bad={port.stats.recent.errors > 0}>{port.stats.recent.errors}</td>
              <td>
                {humanBytes(port.stats.recent.bytesUp)} / {humanBytes(port.stats.recent.bytesDown)}
              </td>
              <td>{port.stats.requests}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/** 一个入口一行：状态点 · 本机地址 · 操作 · 开关。正常时只给圆点，出问题才显示文字。 */
function ServicePortRow({
  view,
  onRun,
}: {
  view: ServiceView
  onRun: (label: string, action: () => Promise<void>) => Promise<void>
}) {
  const toast = useToast()
  const state = serviceState(view)
  const [toggling, setToggling] = useState(false)
  const [editing, setEditing] = useState(false)
  const error = view.listener.enabled && !view.listener.running ? view.listener.lastError : ''
  const probeError = view.probe && !view.probe.ok ? view.probe.error : ''
  const route = `NAS ${view.spec.port}${view.spec.service ? ` · 网关 ${view.spec.service}` : ' · 直连'}`
  const remapped = view.listener.port !== view.spec.port
  const problem = state.tone === 'danger' || state.tone === 'warning'
  return (
    <li className="kura-entry" data-entry={view.key} data-off={!view.listener.enabled}>
      <span className="kura-entry__dot" data-tone={state.tone} title={state.label} aria-label={state.label} role="img" />
      <div className="kura-entry__main" title={route}>
        {editing ? (
          <PortEditor
            view={view}
            onSave={(port) => onRun('改端口失败', () => window.kura!.mirror.setPort(view.key, port))}
            onDone={() => setEditing(false)}
          />
        ) : (
          <a className="kura-card__local kura-entry__addr" href={view.localUrl} target="_blank" rel="noreferrer">
            {view.localUrl.replace('http://', '')}
          </a>
        )}
        {(remapped || problem) && (
          <span className="kura-entry__sub">
            {problem && (
              <StatusBadge tone={state.tone} size="sm">
                {state.label}
              </StatusBadge>
            )}
            {remapped && <span>→ NAS {view.spec.port}</span>}
          </span>
        )}
      </div>
      <div className="kura-entry__actions">
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy size={14} aria-hidden />}
          aria-label={`复制 ${view.spec.label} 的本机地址`}
          title="复制本机地址"
          onClick={() =>
            void window.kura
              ?.copyText(view.localUrl)
              .then(() => toast.notify({ title: '已复制', description: view.localUrl, tone: 'success' }))
              .catch((caught: Error) => toast.notify({ title: '复制失败', description: caught.message, tone: 'error' }))
          }
        />
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil size={14} aria-hidden />}
            aria-label={`改 ${view.spec.label} 的本机端口`}
            title="改本机端口"
            onClick={() => setEditing(true)}
          />
        )}
        {view.externalUrl && (
          <a
            className="kura-entry__icon-link"
            href={view.externalUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="绿联外链"
            title="绿联外链：绿联登录后可达（未验证该端口是否已发布）"
          >
            <ExternalLink size={14} aria-hidden />
          </a>
        )}
      </div>
      <SwitchField
        className="kura-entry__switch"
        label={`映射 ${view.spec.port}`}
        checked={view.listener.enabled}
        disabled={toggling}
        onCheckedChange={(checked) => {
          setToggling(true)
          void onRun('切换失败', () => window.kura!.mirror.setEnabled(view.key, checked))
            .catch(() => {})
            .finally(() => setToggling(false))
        }}
      />
      {(error || probeError || view.stats.lastError) && <p className="kura-card__error kura-entry__error">{error || probeError || `最近一次失败：${view.stats.lastError}`}</p>}
    </li>
  )
}

const modeOptions = [
  { value: 'auto', label: '自动' },
  { value: 'lan', label: '局域网' },
  { value: 'wan', label: '外网' },
] as const

const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '在用' },
  { value: 'problem', label: '有问题' },
  { value: 'off', label: '已关闭' },
] as const

export function MirrorView({ snapshot, refresh }: { snapshot: MirrorSnapshot; refresh: () => Promise<void> }) {
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [syncing, setSyncing] = useState(false)
  /** 「立即同步」；两处按钮共用（空白页那处原来没接失败处理） */
  const syncNow = async () => {
    setSyncing(true)
    try {
      const added = await window.kura!.mirror.sync()
      toast.notify({ title: '已同步服务端清单', description: added ? `新挂上 ${added} 个服务` : '没有新服务', tone: 'success' })
    } catch (error) {
      toast.notify({ title: '同步失败', description: (error as Error).message, tone: 'error' })
    } finally {
      setSyncing(false)
      void refresh()
    }
  }

  const services = useMemo(() => {
    const q = query.trim().toLowerCase()
    return snapshot.containers.filter((view) => {
      const search = `${view.label} ${view.ports.map((port) => `${port.spec.port} ${port.listener.port}`).join(' ')}`.toLowerCase()
      if (q && !search.includes(q)) return false
      if (filter === 'running') return containerState(view).tone === 'success'
      if (filter === 'off') return view.ports.every((port) => !port.listener.enabled)
      if (filter === 'problem') return containerState(view).tone === 'warning'
      return true
    })
  }, [snapshot.containers, filter, query])

  return (
    <div className="kura-mirror">
      <div className="kura-toolbar">
        <FluidSegmented
          label="链路模式"
          options={modeOptions}
          value={snapshot.modeSetting}
          onValueChange={(value) =>
            void window
              .kura!.mirror.setMode(value as LinkModeSetting)
              .then(refresh)
              .catch((error: Error) => toast.notify({ title: '切换失败', description: error.message, tone: 'error' }))
          }
        />
        <div className="kura-toolbar__search">
          <TextField
            label="搜索服务"
            prefix={<Search size={14} aria-hidden />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称或端口"
          />
        </div>
        <FluidSegmented label="筛选" options={filterOptions} value={filter} onValueChange={(value) => setFilter(value as Filter)} />
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} aria-hidden />}
          disabled={syncing}
          onClick={() => void syncNow()}
        >
          {syncing ? '同步中…' : '立即同步'}
        </Button>
      </div>

      {snapshot.fromCache && snapshot.phase === 'syncing' && (
        <Banner
          tone="neutral"
          data-testid="syncing-banner"
          description="正在同步服务端清单…（先按上次的清单运行，本机端口已经可以用）"
        />
      )}
      {snapshot.discovery.lastError && (
        <Banner tone="warning" description={`服务端清单同步失败：${snapshot.discovery.lastError}（当前按上次的清单运行）`} />
      )}
      {snapshot.discovery.skipped.length > 0 && (
        <Banner tone="neutral" description={`跳过 ${snapshot.discovery.skipped.length} 个服务：${snapshot.discovery.skipped.join('；')}`} />
      )}

      {snapshot.containers.length === 0 ? (
        <div className="kura-placeholder">
          <EmptyState
            title="还没有服务"
            description={
              snapshot.discovery.lastSync
                ? '服务端清单里没有可映射的服务'
                : '正在从服务端拉取服务清单；如果一直没有，检查网关端口是否正确、kura-server 是否在跑'
            }
            action={<Button onClick={() => void syncNow()}>立即同步</Button>}
          />
        </div>
      ) : services.length === 0 ? (
        <div className="kura-placeholder">
          <EmptyState title="没有符合条件的服务" description="换个筛选条件或清空搜索" action={<Button variant="secondary" onClick={() => { setFilter('all'); setQuery('') }}>清除筛选</Button>} />
        </div>
      ) : (
        <div className="kura-grid">
          {services.map((view) => (
            <ServiceCard key={view.key} view={view} refresh={refresh} />
          ))}
        </div>
      )}
    </div>
  )
}