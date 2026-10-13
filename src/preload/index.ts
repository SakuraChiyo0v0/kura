import { contextBridge, ipcRenderer } from 'electron'
import { unwrapIpcResponse, type IpcResponse } from '@sakura-ui/electron/shared'
import { exposeSettings, exposeWindowControls } from '@sakura-ui/electron/preload'
import type { LinkModeSetting } from '../core/link.js'
import type { MirrorSnapshot } from '../core/mirror.js'
import {
  kuraChannels as ch,
  type AppInfo,
  type ConnectionForm,
  type ConnectionSummary,
  type ConnectionTestResult,
  type KuraBridge,
} from '../shared/ipc.js'
import type { KuraSettings } from '../shared/settings.js'

exposeWindowControls({ contextBridge, ipcRenderer })
exposeSettings<KuraSettings>({ contextBridge, ipcRenderer })

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrapIpcResponse((await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>)
}

const kura: KuraBridge = {
  appInfo: () => invoke<AppInfo>(ch.appInfo),
  quit: () => invoke<void>(ch.quit),
  connection: {
    get: () => invoke<ConnectionSummary>(ch.connectionGet),
    test: (form: ConnectionForm) => invoke<ConnectionTestResult>(ch.connectionTest, form),
    save: (form: ConnectionForm) => invoke<ConnectionSummary>(ch.connectionSave, form),
    clear: () => invoke<void>(ch.connectionClear),
  },
  mirror: {
    snapshot: () => invoke<MirrorSnapshot | null>(ch.mirrorSnapshot),
    setMode: (mode: LinkModeSetting) => invoke<void>(ch.mirrorSetMode, mode),
    setEnabled: (key: string, enabled: boolean) => invoke<void>(ch.mirrorSetEnabled, key, enabled),
    setPort: (key: string, port: number) => invoke<void>(ch.mirrorSetPort, key, port),
    sync: () => invoke<number>(ch.mirrorSync),
    retry: () => invoke<void>(ch.mirrorRetry),
  },
  openExternal: (url: string) => invoke<void>(ch.openExternal, url),
  copyText: (text: string) => invoke<void>(ch.copyText, text),
}

contextBridge.exposeInMainWorld('kura', kura)
