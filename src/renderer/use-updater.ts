import { useMemo } from 'react'
import { useUpdater } from '@sakura-ui/electron-react'
import { getUpdaterApi, type UpdaterApi } from '@sakura-ui/electron/shared'

/** 没接更新源时的空实现：恒为 idle，不发 IPC（主进程那边根本没注册更新通道） */
const inert: UpdaterApi = {
  getStatus: async () => ({ state: 'idle' }),
  check: async () => ({ state: 'idle' }),
  download: async () => ({ state: 'idle' }),
  install: async () => {},
  onChange: () => () => {},
}

/**
 * useUpdater 的包装：开发构建与冒烟不接更新源，主进程不注册 sakura:updater:* 通道，
 * 直接用 preload 的那份会每次都报「No handler registered」。enabled 来自 appInfo().updatesEnabled。
 */
export function useKuraUpdater(enabled: boolean) {
  const api = useMemo(() => (enabled ? getUpdaterApi() : undefined) ?? inert, [enabled])
  return useUpdater(api)
}
