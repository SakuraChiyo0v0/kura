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
  /** 定时检查更新，发现新版本自动在后台下载 */
  autoCheckUpdates: boolean
  /** 上次看过「更新内容」的版本；升级后与当前版本不同就弹一次 */
  lastSeenVersion: string
  /** 给 AI 客户端（Claude Code 等）连的 MCP 服务器。默认关：新增的对外接口不该默认开着 */
  mcpEnabled: boolean
  /** MCP 监听的回环端口 */
  mcpPort: number
}

export const kuraSettingsDefaults: KuraSettings = {
  theme: 'system',
  closeToTray: true,
  openAtLogin: false,
  sidebarCollapsed: false,
  autoCheckUpdates: true,
  lastSeenVersion: '',
  mcpEnabled: false,
  mcpPort: 18007,
}
