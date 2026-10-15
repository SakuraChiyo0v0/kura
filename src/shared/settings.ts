/** 主进程与渲染层共用的设置结构。 */

export type ThemePreference = 'system' | 'light' | 'dark'

export interface KuraSettings {
  theme: ThemePreference
  /** 关闭主窗口时退到托盘（服务继续运行），而不是退出程序 */
  closeToTray: boolean
  /** 登录 Windows 时自动启动（只进托盘，不弹窗口） */
  openAtLogin: boolean
  /** 侧栏是否折叠 */
  sidebarCollapsed: boolean
}

export const kuraSettingsDefaults: KuraSettings = {
  theme: 'system',
  closeToTray: true,
  openAtLogin: false,
  sidebarCollapsed: false,
}
