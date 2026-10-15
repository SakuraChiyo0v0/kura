import { contextBridge, ipcRenderer } from 'electron'
import { unwrapIpcResponse, type IpcResponse } from '@sakura-ui/electron/shared'
import { exposeSettings, exposeUpdater, exposeWindowControls } from '@sakura-ui/electron/preload'
import type { LinkModeSetting } from '../core/link.js'
import type { MirrorSnapshot } from '../core/mirror.js'
import {
  kuraChannels as ch,
  type AppInfo,
  type ConnectionForm,
  type ConnectionSummary,
  type ConnectionTestProgress,
  type ConnectionTestResult,
  type DockerStreamEvent,
  type KuraBootstrap,
  type KuraBridge,
  type TerminalEventView,
} from '../shared/ipc.js'
import type { KuraSettings } from '../shared/settings.js'

exposeWindowControls({ contextBridge, ipcRenderer })
exposeSettings<KuraSettings>({ contextBridge, ipcRenderer })
exposeUpdater({ contextBridge, ipcRenderer })

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrapIpcResponse((await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>)
}

/**
 * 同步取初始状态：preload 在页面脚本之前跑，这里拿到了，React 第一帧就知道该画引导还是主界面，
 * 不会先空白、再等一次异步 IPC。只在加载时取一次（几百字节），之后靠推送更新。
 */
function readBootstrap(): KuraBootstrap | null {
  try {
    return ipcRenderer.sendSync(ch.bootstrap) as KuraBootstrap
  } catch {
    return null
  }
}

const kura: KuraBridge = {
  bootstrap: readBootstrap(),
  appInfo: () => invoke<AppInfo>(ch.appInfo),
  changelog: () => invoke<string>(ch.changelog),
  quit: () => invoke<void>(ch.quit),
  connection: {
    get: () => invoke<ConnectionSummary>(ch.connectionGet),
    test: (form: ConnectionForm) => invoke<ConnectionTestResult>(ch.connectionTest, form),
    onTestProgress: (listener) => {
      const handler = (_event: unknown, progress: ConnectionTestProgress) => listener(progress)
      ipcRenderer.on(ch.connectionTestStep, handler)
      return () => ipcRenderer.off(ch.connectionTestStep, handler)
    },
    save: (form: ConnectionForm) => invoke<ConnectionSummary>(ch.connectionSave, form),
    clear: () => invoke<void>(ch.connectionClear),
  },
  mirror: {
    snapshot: () => invoke<MirrorSnapshot | null>(ch.mirrorSnapshot),
    onChange: (listener) => {
      const handler = (_event: unknown, snapshot: MirrorSnapshot | null) => listener(snapshot)
      ipcRenderer.on(ch.mirrorChanged, handler)
      return () => ipcRenderer.off(ch.mirrorChanged, handler)
    },
    setMode: (mode: LinkModeSetting) => invoke<void>(ch.mirrorSetMode, mode),
    setEnabled: (key: string, enabled: boolean) => invoke<void>(ch.mirrorSetEnabled, key, enabled),
    setPort: (key: string, port: number) => invoke<void>(ch.mirrorSetPort, key, port),
    sync: () => invoke<number>(ch.mirrorSync),
    retry: () => invoke<void>(ch.mirrorRetry),
  },
  openExternal: (url: string) => invoke<void>(ch.openExternal, url),
  copyText: (text: string) => invoke<void>(ch.copyText, text),
  files: {
    list: (path) => invoke(ch.filesList, path),
    mkdir: (path) => invoke(ch.filesMkdir, path),
    rename: (from, to) => invoke(ch.filesRename, from, to),
    remove: (paths) => invoke(ch.filesRemove, paths),
    upload: (dir) => invoke(ch.filesUpload, dir),
    download: (paths) => invoke(ch.filesDownload, paths),
    open: (path) => invoke(ch.filesOpen, path),
    cancel: (id) => invoke(ch.filesCancel, id),
    transfers: () => invoke(ch.filesTransfers),
  },
  dav: {
    get: () => invoke(ch.davGet),
    save: (settings) => invoke(ch.davSave, settings),
    check: (path) => invoke(ch.davCheck, path),
  },
  nasScope: {
    get: () => invoke(ch.nasScopeGet),
    save: (view) => invoke(ch.nasScopeSave, view),
    check: (path) => invoke(ch.nasScopeCheck, path),
  },
  terminal: {
    open: () => invoke(ch.terminalOpen),
    write: (id, data) => invoke(ch.terminalWrite, id, data),
    resize: (id, cols, rows) => invoke(ch.terminalResize, id, cols, rows),
    close: (id) => invoke(ch.terminalClose, id),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: TerminalEventView) => listener(payload)
      ipcRenderer.on(ch.terminalEvent, handler)
      return () => ipcRenderer.off(ch.terminalEvent, handler)
    },
    available: () => invoke(ch.terminalAvailable),
  },
  docker: {
    available: () => invoke(ch.dockerAvailable),
    overview: () => invoke(ch.dockerOverview),
    container: (id) => invoke(ch.dockerContainer, id),
    stats: (id) => invoke(ch.dockerStats, id),
    images: () => invoke(ch.dockerImages),
    activity: () => invoke(ch.dockerActivity),
    containerAction: (id, action) => invoke(ch.dockerContainerAction, id, action),
    removeContainer: (id, force) => invoke(ch.dockerRemoveContainer, id, force),
    removeImage: (id) => invoke(ch.dockerRemoveImage, id),
    pruneImages: (all) => invoke(ch.dockerPruneImages, all),
    saveLogs: (id, name) => invoke(ch.dockerSaveLogs, id, name),
    openStream: (kind, target, action, removeOptions) => invoke(ch.dockerStreamOpen, kind, target, action, removeOptions),
    projectFiles: (name) => invoke(ch.dockerProjectFiles, name),
    volumes: (withSize) => invoke(ch.dockerVolumes, withSize),
    networks: () => invoke(ch.dockerNetworks),
    checkUpdates: (images) => invoke(ch.dockerCheckUpdates, images),
    openShell: (container, cols, rows) => invoke(ch.dockerShellOpen, container, cols, rows),
    shellInput: (id, data) => invoke(ch.dockerShellInput, id, data),
    shellResize: (id, cols, rows) => invoke(ch.dockerShellResize, id, cols, rows),
    saveProjectFiles: (name, next) => invoke(ch.dockerSaveProjectFiles, name, next),
    createProject: (input) => invoke(ch.dockerCreateProject, input),
    closeStream: (id) => invoke(ch.dockerStreamClose, id),
    onStream: (listener) => {
      const handler = (_event: unknown, payload: DockerStreamEvent) => listener(payload)
      ipcRenderer.on(ch.dockerStreamEvent, handler)
      return () => ipcRenderer.off(ch.dockerStreamEvent, handler)
    },
  },
  modules: {
    status: () => invoke(ch.modulesStatus),
    installRclone: () => invoke(ch.modulesInstallRclone),
    uninstallRclone: () => invoke(ch.modulesUninstallRclone),
    mountSettings: () => invoke(ch.modulesMountSettings),
    saveMount: (settings) => invoke(ch.modulesSaveMount, settings),
    mount: () => invoke(ch.modulesMount),
    unmount: () => invoke(ch.modulesUnmount),
    openDrive: () => invoke(ch.modulesOpenDrive),
    pickFolder: () => invoke(ch.modulesPickFolder),
  },
}

contextBridge.exposeInMainWorld('kura', kura)
