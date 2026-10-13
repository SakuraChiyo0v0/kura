/** Kura 自己的 IPC 通道与 preload 暴露的 window.kura 形状。 */
import type { LinkModeSetting } from '../core/link.js'
import type { MirrorSnapshot } from '../core/mirror.js'

export const kuraChannels = {
  appInfo: 'kura:app-info',
  quit: 'kura:quit',
  connectionGet: 'kura:connection:get',
  connectionTest: 'kura:connection:test',
  connectionSave: 'kura:connection:save',
  connectionClear: 'kura:connection:clear',
  mirrorSnapshot: 'kura:mirror:snapshot',
  mirrorSetMode: 'kura:mirror:set-mode',
  mirrorSetEnabled: 'kura:mirror:set-enabled',
  mirrorSetPort: 'kura:mirror:set-port',
  mirrorSync: 'kura:mirror:sync',
  mirrorRetry: 'kura:mirror:retry',
  openExternal: 'kura:open-external',
  copyText: 'kura:copy-text',
} as const

export interface AppInfo {
  version: string
  /** 用户数据目录（设置、凭据、日志都在这里） */
  userData: string
}

/** 引导页填写的表单。密码字段在「已保存过」时可以留空，表示沿用已保存的值。 */
export interface ConnectionForm {
  base: string
  ugreenUser: string
  ugreenPassword: string
  lanHost: string
  mode: LinkModeSetting
  gatewayPort: number
  gatewayUser: string
  gatewayPassword: string
}

/** 给渲染层看的连接配置：密码只告诉「有没有」，不回传明文。 */
export interface ConnectionSummary {
  configured: boolean
  base: string
  ugreenUser: string
  hasUgreenPassword: boolean
  lanHost: string
  mode: LinkModeSetting
  gatewayPort: number
  gatewayUser: string
  hasGatewayPassword: boolean
}

export interface ConnectionTestStep {
  name: string
  ok: boolean
  detail: string
}

export interface ConnectionTestResult {
  ok: boolean
  steps: ConnectionTestStep[]
}

export interface KuraBridge {
  appInfo(): Promise<AppInfo>
  /** 真正退出程序（托盘常驻时关窗口不会退出） */
  quit(): Promise<void>
  connection: {
    get(): Promise<ConnectionSummary>
    /** 不保存，只按表单实际登录一遍，逐步报告结果 */
    test(form: ConnectionForm): Promise<ConnectionTestResult>
    /** 加密保存并（重新）启动映射 */
    save(form: ConnectionForm): Promise<ConnectionSummary>
    clear(): Promise<void>
  }
  mirror: {
    /** 未配置连接时为 null */
    snapshot(): Promise<MirrorSnapshot | null>
    setMode(mode: LinkModeSetting): Promise<void>
    setEnabled(key: string, enabled: boolean): Promise<void>
    setPort(key: string, port: number): Promise<void>
    sync(): Promise<number>
    retry(): Promise<void>
  }
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
}
