import { useCallback, useEffect, useRef, useState } from 'react'
import type { MirrorSnapshot } from '../core/mirror.js'
import type { ConnectionSummary } from '../shared/ipc.js'

/** 连接配置摘要；kura 桥不存在（在浏览器里直接打开页面）时视为未配置。 */
export function useConnection() {
  const [summary, setSummary] = useState<ConnectionSummary | undefined>(undefined)
  const reload = useCallback(async () => {
    setSummary(window.kura ? await window.kura.connection.get() : undefined)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { summary, reload, setSummary }
}

/**
 * 映射状态轮询。主进程是事实来源，这里只读快照：
 * 页面可见时每 3 秒拉一次，隐藏时停（窗口在托盘里不需要刷新）。
 */
export function useMirrorSnapshot(enabled: boolean, intervalMs = 3_000) {
  const [snapshot, setSnapshot] = useState<MirrorSnapshot | null>(null)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!window.kura) return
    try {
      setSnapshot(await window.kura.mirror.snapshot())
      setError('')
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null)
      return
    }
    void refresh()
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
      clearInterval(timer.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs, refresh])

  return { snapshot, error, refresh }
}
