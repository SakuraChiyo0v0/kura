import { useMemo, useState } from 'react'
import { Copy, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { Banner, Button, EmptyState, FluidSegmented, StatusBadge, SwitchField, TextField, useToast, type StatusTone } from '@sakura-ui/react'
import type { LinkModeSetting } from '../shared/labels.js'
import type { MirrorSnapshot, ServiceView } from '../core/mirror.js'
import { humanBytes, type TrendPoint } from '../core/stats.js'

type Filter = 'all' | 'running' | 'off' | 'problem'

/** 一个服务的状态：开关意图 × 是否在监听 × 探测结果。 */
export function serviceState(view: ServiceView): { tone: StatusTone; label: string } {
  if (!view.listener.enabled) return { tone: 'neutral', label: '已关闭' }
  if (!view.listener.running) return { tone: 'danger', label: '监听失败' }
  if (view.probe && !view.probe.ok) return { tone: 'warning', label: `探测失败 ×${view.probe.failStreak}` }
  return { tone: 'success', label: '监听中' }
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

function PortEditor({ view, onSave }: { view: ServiceView; onSave: (port: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(view.listener.port))
  const [busy, setBusy] = useState(false)
  const dirty = draft !== String(view.listener.port)
  return (
    <form
      className="kura-card__port"
      onSubmit={(event) => {
        event.preventDefault()
        const port = Number(draft)
        if (!dirty || busy) return
        setBusy(true)
        void onSave(port)
          .catch(() => setDraft(String(view.listener.port)))
          .finally(() => setBusy(false))
      }}
    >
      <TextField
        label="本机端口"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
      />
      {dirty && (
        <Button type="submit" size="sm" variant="secondary" disabled={busy}>
          {busy ? '应用中…' : '应用'}
        </Button>
      )}
    </form>
  )
}

function ServiceCard({ view, refresh }: { view: ServiceView; refresh: () => Promise<void> }) {
  const toast = useToast()
  const state = serviceState(view)
  const [toggling, setToggling] = useState(false)
  const error = view.listener.enabled && !view.listener.running ? view.listener.lastError : ''
  const probeError = view.probe && !view.probe.ok ? view.probe.error : ''

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
    <article className="kura-card" data-testid="service-card" data-service={view.key}>
      <header className="kura-card__head">
        <div className="kura-card__title">
          <h3>{view.spec.label}</h3>
          <StatusBadge tone={state.tone} dot size="sm">
            {state.label}
          </StatusBadge>
        </div>
        <SwitchField
          className="kura-card__switch"
          label="映射"
          checked={view.listener.enabled}
          disabled={toggling}
          onCheckedChange={(checked) => {
            setToggling(true)
            void run('切换失败', () => window.kura!.mirror.setEnabled(view.key, checked))
              .catch(() => {})
              .finally(() => setToggling(false))
          }}
        />
      </header>

      <div className="kura-card__addr">
        <a className="kura-card__local" href={view.localUrl} target="_blank" rel="noreferrer">
          {view.localUrl.replace('http://', '')}
        </a>
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy size={14} aria-hidden />}
          aria-label={`复制 ${view.spec.label} 的本机地址`}
          onClick={() =>
            void window.kura
              ?.copyText(view.localUrl)
              .then(() => toast.notify({ title: '已复制', description: view.localUrl, tone: 'success' }))
              .catch((caught: Error) => toast.notify({ title: '复制失败', description: caught.message, tone: 'error' }))
          }
        />
      </div>
      {view.externalUrl && (
        <a className="kura-card__external" href={view.externalUrl} target="_blank" rel="noreferrer" title="绿联登录后可达（未验证该端口是否已发布）">
          <ExternalLink size={12} aria-hidden /> 绿联外链
        </a>
      )}

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

      {(error || probeError || view.stats.lastError) && (
        <p className="kura-card__error">{error || probeError || `最近一次失败：${view.stats.lastError}`}</p>
      )}

      <footer className="kura-card__foot">
        <PortEditor key={view.listener.port} view={view} onSave={(port) => run('改端口失败', () => window.kura!.mirror.setPort(view.key, port))} />
        <span className="kura-card__meta">
          NAS {view.spec.port}
          {view.spec.service ? ` · 网关 ${view.spec.service}` : ' · 直连'}
          {view.spec.source === 'discovered' ? ' · 服务端发现' : ' · 本地配置'}
        </span>
      </footer>
    </article>
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
    return snapshot.services.filter((view) => {
      if (q && !`${view.spec.label} ${view.spec.port} ${view.listener.port}`.toLowerCase().includes(q)) return false
      const state = serviceState(view)
      if (filter === 'running') return state.tone === 'success'
      if (filter === 'off') return !view.listener.enabled
      if (filter === 'problem') return state.tone === 'danger' || state.tone === 'warning'
      return true
    })
  }, [snapshot.services, filter, query])

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

      {snapshot.services.length === 0 ? (
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
