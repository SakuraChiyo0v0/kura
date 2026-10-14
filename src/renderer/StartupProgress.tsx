import { CheckCircle2, CircleAlert, CircleDashed, Loader2 } from 'lucide-react'
import { Button } from '@sakura-ui/react'
import type { MirrorSnapshot } from '../core/mirror.js'

type StepState = 'done' | 'active' | 'waiting' | 'failed'

interface Step {
  name: string
  state: StepState
  detail: string
}

/**
 * 映射启动到哪了：替代原来那句「映射正在启动」的空白页。
 *
 * 三步对着主进程的真实状态（MirrorSnapshot.phase / auth / discovery），不是按时间假装在走：
 *   ① 启动映射核心  ② 登录 NAS（绿联 + 网关）  ③ 拉取服务清单
 */
export function startupSteps(snapshot: MirrorSnapshot | null): Step[] {
  if (!snapshot) {
    return [
      { name: '启动映射核心', state: 'active', detail: '读取已保存的连接' },
      { name: '登录 NAS', state: 'waiting', detail: '' },
      { name: '拉取服务清单', state: 'waiting', detail: '' },
    ]
  }
  const authFailed = snapshot.auth.blocked
  const loggedIn = snapshot.sessions > 0
  const synced = snapshot.phase === 'ready'
  const syncFailed = snapshot.phase === 'failed'
  return [
    { name: '启动映射核心', state: 'done', detail: snapshot.fromCache ? `已按上次的清单挂上 ${snapshot.services.length} 个服务` : '已启动' },
    {
      name: '登录 NAS',
      state: authFailed ? 'failed' : loggedIn || synced ? 'done' : 'active',
      detail: authFailed ? snapshot.auth.reason : loggedIn || synced ? '绿联与网关会话已建立' : '登录绿联账号、建立网关会话',
    },
    {
      name: '拉取服务清单',
      state: synced ? 'done' : syncFailed ? 'failed' : authFailed ? 'waiting' : loggedIn ? 'active' : 'waiting',
      detail: synced
        ? `清单里有 ${snapshot.discovery.entries} 个服务`
        : syncFailed
          ? snapshot.discovery.lastError
          : '从网关取 /__services',
    },
  ]
}

const icons: Record<StepState, React.ReactNode> = {
  done: <CheckCircle2 size={16} aria-hidden />,
  active: <Loader2 className="kura-test__spinner" size={16} aria-hidden />,
  waiting: <CircleDashed size={16} aria-hidden />,
  failed: <CircleAlert size={16} aria-hidden />,
}

export function StartupProgress({ snapshot, onRetry }: { snapshot: MirrorSnapshot | null; onRetry?: () => void }) {
  const steps = startupSteps(snapshot)
  const failed = steps.some((s) => s.state === 'failed')
  return (
    <section className="kura-startup" aria-live="polite" data-testid="startup-progress">
      <h2>{failed ? '连接 NAS 遇到问题' : '正在连接 NAS'}</h2>
      <ul className="kura-test">
        {steps.map((step) => (
          <li
            key={step.name}
            className="kura-test__step"
            data-ok={step.state === 'done' ? true : step.state === 'failed' ? false : undefined}
            data-pending={step.state === 'active' || step.state === 'waiting' ? 'true' : undefined}
            data-step={step.state}
          >
            {icons[step.state]}
            <span className="kura-test__name">{step.name}</span>
            <span className="kura-test__detail">{step.detail}</span>
          </li>
        ))}
      </ul>
      {failed && onRetry && (
        <div className="kura-form__actions">
          <Button variant="secondary" onClick={onRetry}>
            立即重试
          </Button>
        </div>
      )}
    </section>
  )
}
