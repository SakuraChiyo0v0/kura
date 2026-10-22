import { Activity, ArrowDownUp, Network, ShieldAlert } from 'lucide-react'
import { Banner, Button, Section, StatCard, StatusBadge } from '@sakura-ui/react'
import { linkModeLabel } from '../shared/labels.js'
import type { MirrorSnapshot } from '../core/mirror.js'
import { humanBytes } from '../core/stats.js'
import { serviceState } from './MirrorView.js'

const icon = { size: 18, strokeWidth: 1.65, 'aria-hidden': true } as const

function relative(ms: number): string {
  if (!ms) return '还没有同步过'
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function OverviewView({ snapshot, onOpenMirror }: { snapshot: MirrorSnapshot; onOpenMirror: () => void }) {
  const states = snapshot.services.map(serviceState)
  const running = states.filter((s) => s.tone === 'success').length
  const problems = states.filter((s) => s.tone === 'danger' || s.tone === 'warning').length
  // 概览读**近一天**（最近 24 个小时格），不是装机以来的累计：
  // 累计数只增不减，涨到几 GB 之后再看就不动了，看不出「现在忙不忙」。
  const recent = snapshot.services.reduce(
    (sum, s) => ({
      requests: sum.requests + s.stats.recent.requests,
      errors: sum.errors + s.stats.recent.errors,
      bytesUp: sum.bytesUp + s.stats.recent.bytesUp,
      bytesDown: sum.bytesDown + s.stats.recent.bytesDown,
    }),
    { requests: 0, errors: 0, bytesUp: 0, bytesDown: 0 },
  )
  const { requests, errors } = recent

  const lan =
    snapshot.lanHost === ''
      ? '未配置局域网地址'
      : snapshot.lanReachable === undefined
        ? '正在探测局域网'
        : snapshot.lanReachable
          ? '局域网可达'
          : '局域网不可达'

  return (
    <div className="kura-overview">
      {snapshot.auth.blocked && (
        <Banner
          tone="warning"
          icon={<ShieldAlert {...icon} />}
          title="连接 NAS 失败，正在退避重试"
          description={
            <>
              {snapshot.auth.reason}
              {snapshot.auth.retryAt ? ` · 下次重试 ${new Date(snapshot.auth.retryAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
            </>
          }
          action={
            <Button size="sm" variant="secondary" onClick={() => void window.kura?.mirror.retry()}>
              立即重试
            </Button>
          }
        />
      )}

      <div className="kura-stats">
        <StatCard
          label="链路"
          icon={<Network {...icon} />}
          value={linkModeLabel[snapshot.mode]}
          description={`${snapshot.modeSetting === 'auto' ? '自动' : '手动'} · ${lan}`}
        />
        <StatCard
          label="服务"
          icon={<Activity {...icon} />}
          value={`${running} / ${snapshot.services.length}`}
          unit="在监听"
          description={problems ? `${problems} 个有问题` : '全部正常'}
          trend={problems ? { label: `${problems} 个异常`, direction: 'down', tone: 'danger' } : undefined}
        />
        <StatCard
          label="近一天请求"
          icon={<ArrowDownUp {...icon} />}
          value={requests}
          description={errors ? `失败 ${errors}` : '没有失败'}
        />
        <StatCard
          label="近一天流量"
          value={humanBytes(recent.bytesDown)}
          unit="下行"
          description={`上行 ${humanBytes(recent.bytesUp)}`}
        />
      </div>

      <Section
        title="服务"
        actions={
          <Button size="sm" variant="ghost" onClick={onOpenMirror}>
            管理映射
          </Button>
        }
        footer={
          <span data-testid="sync-status">
            服务端清单：
            {snapshot.phase === 'syncing'
              ? '正在同步…（先按上次的清单运行）'
              : snapshot.phase === 'failed'
                ? `同步失败，按上次的清单运行（${snapshot.discovery.lastError}）`
                : relative(snapshot.discovery.lastSync)}{' '}
            · 当前 {snapshot.sessions} 份会话
          </span>
        }
      >
        <ul className="kura-service-list">
          {snapshot.services.map((view, i) => (
            <li key={view.key}>
              <span className="kura-service-list__name">{view.spec.label}</span>
              {/* 只在确实在监听时可点：没起来的服务点开也是打不开，不如让它就是一行地址 */}
              {states[i]!.tone === 'success' ? (
                <button
                  type="button"
                  className="kura-service-list__addr kura-service-list__addr--open"
                  title="在浏览器打开"
                  onClick={() => void window.kura?.openExternal(view.localUrl)}
                >
                  {view.localUrl.replace('http://', '')}
                </button>
              ) : (
                <span className="kura-service-list__addr">{view.localUrl.replace('http://', '')}</span>
              )}
              <StatusBadge tone={states[i]!.tone} dot size="sm">
                {states[i]!.label}
              </StatusBadge>
            </li>
          ))}
          {snapshot.services.length === 0 && <li className="kura-service-list__empty">还没有服务，正在等服务端清单</li>}
        </ul>
      </Section>
    </div>
  )
}
