import { useCallback, useEffect, useRef, useState } from 'react'
import type { MirrorSnapshot } from '../core/mirror.js'
import type { ConnectionSummary } from '../shared/ipc.js'

/**
 * 连接配置摘要。第一帧直接用 preload 同步取好的那份（window.kura.bootstrap），
 * 不再「先渲染空白、等一次 IPC 再决定画引导还是主界面」。
 * kura 桥不存在（在浏览器里直接打开页面）时视为未配置。
 */
export function useConnection() {
  const [summary, setSummary] = useState<ConnectionSummary | undefined>(() => window.kura?.bootstrap?.connection)
  const reload = useCallback(async () => {
    setSummary(window.kura ? await window.kura.connection.get() : undefined)
  }, [])
  useEffect(() => {
    // bootstrap 拿到了就不用再问一次；拿不到（同步通道失败）才退回异步
    if (!window.kura?.bootstrap) void reload()
  }, [reload])
  return { summary, reload, setSummary }
}

/**
 * 映射状态。主进程是事实来源，两条路进来：
 * 1. **推送**（kura:mirror:changed）：服务挂上、开关、同步结果、链路切换 —— 立即生效；
 * 2. **轮询**：只为刷新流量计数与趋势，页面可见时每 3 秒一次，隐藏时停。
 * 初值用 bootstrap 里的快照，第一帧就有内容。
 */
export function useMirrorSnapshot(enabled: boolean, intervalMs = 3_000) {
  const [snapshot, setSnapshot] = useState<MirrorSnapshot | null>(() => window.kura?.bootstrap?.snapshot ?? null)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  // 每次快照请求领一个自增号；只有仍是「最新那次」的响应才写进 state。
  // 轮询的旧请求可能晚于推送（或更新的一次轮询）返回，不挡的话会用过期数据把新状态覆盖回去，界面看起来在倒退。
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    if (!window.kura) return
    const mine = ++seq.current
    try {
      const next = await window.kura.mirror.snapshot()
      if (seq.current !== mine) return
      setSnapshot(next)
      setError('')
    } catch (caught) {
      if (seq.current !== mine) return
      setError((caught as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      return
    }
    void refresh()
    // 推送优先级最高：收到就作废所有在途轮询（自增号让它们回来后自己丢弃）
    const off = window.kura?.mirror.onChange((next) => {
      seq.current += 1
      setSnapshot(next)
    })
    const start = () => {
      clearInterval(timer.current)
      timer.current = setInterval(() => void refresh(), intervalMs)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
        start()
      } else {
        clearInterval(timer.current)
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      off?.()
      clearInterval(timer.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs, refresh])

  return { snapshot, error, refresh }
}
