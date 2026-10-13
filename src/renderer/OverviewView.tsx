import { Activity, ArrowDownUp, Network, ShieldAlert } from 'lucide-react'
import { Button, StatCard, StatusBadge } from '@sakura-ui/react'
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
  const requests = snapshot.services.reduce((sum, s) => sum + s.stats.requests, 0)
  const errors = snapshot.services.reduce((sum, s) => sum + s.stats.errors, 0)
  const up = snapshot.services.reduce((sum, s) => sum + s.stats.bytesUp, 0)
  const down = snapshot.services.reduce((sum, s) => sum + s.stats.bytesDown, 0)

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
        <div className="kura-banner" data-tone={snapshot.auth.credential ? 'danger' : 'warning'} role="alert">
          <ShieldAlert {...icon} />
          <div>
            <strong>{snapshot.auth.credential ? '凭据被 NAS 拒绝，已停止自动重试' : '连接 NAS 失败，正在退避重试'}</strong>
            <p>
              {snapshot.auth.reason}
              {snapshot.auth.retryAt ? ` · 下次重试 ${new Date(snapshot.auth.retryAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void window.kura?.mirror.retry()}>
            立即重试
          </Button>
        </div>
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
          label="请求"
          icon={<ArrowDownUp {...icon} />}
          value={requests}
          description={errors ? `失败 ${errors}` : '没有失败'}
        />
        <StatCard label="流量" value={humanBytes(down)} unit="下行" description={`上行 ${humanBytes(up)}`} />
      </div>

      <section className="kura-section">
        <header className="kura-section__head">
          <h2>服务</h2>
          <Button size="sm" variant="ghost" onClick={onOpenMirror}>
            管理映射
          </Button>
        </header>
        <ul className="kura-service-list">
          {snapshot.services.map((view, i) => (
            <li key={view.key}>
              <span className="kura-service-list__name">{view.spec.label}</span>
              <span className="kura-service-list__addr">{view.localUrl.replace('http://', '')}</span>
              <StatusBadge tone={states[i]!.tone} dot size="sm">
                {states[i]!.label}
              </StatusBadge>
            </li>
          ))}
          {snapshot.services.length === 0 && <li className="kura-service-list__empty">还没有服务，正在等服务端清单</li>}
        </ul>
        <p className="kura-section__foot">
          服务端清单：{relative(snapshot.discovery.lastSync)} · 当前 {snapshot.sessions} 份会话
        </p>
      </section>
    </div>
  )
}
