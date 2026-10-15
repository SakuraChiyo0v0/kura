/**
 * 托盘常驻的生命周期策略。
 *
 * 映射服务跑在主进程里，关掉窗口不能连带停掉服务：所以「关窗口」默认只是隐藏，
 * 只有托盘菜单的「退出」、渲染层的 quit 或系统关机才真正退出。
 * 这里只做判断，不碰 Electron，方便单测。
 */

export interface CloseDecisionInput {
  /** 是否已进入退出流程（app 'before-quit' 之后为 true） */
  quitting: boolean
  /** 设置项：关闭时退到托盘 */
  closeToTray: boolean
  /** 托盘是否已创建；没有托盘时隐藏窗口等于让程序消失，必须真关 */
  trayAvailable: boolean
}

/** 'hide'：拦下关闭事件只隐藏窗口；'close'：放行。 */
export function decideWindowClose(input: CloseDecisionInput): 'hide' | 'close' {
  if (input.quitting) return 'close'
  if (input.closeToTray && input.trayAvailable) return 'hide'
  return 'close'
}

/** 开机自启时带上的参数：带它启动只进托盘，不弹主窗口。 */
export const hiddenLaunchFlag = '--hidden'

export interface LoginItemInput {
  openAtLogin: boolean
  /** app.isPackaged：开发态下注册表里记的是 electron.exe，得把应用目录也作为参数带上 */
  packaged: boolean
  appPath: string
}

/** 交给 app.setLoginItemSettings 的参数（Windows 写 HKCU\…\Run）。 */
export function loginItemSettings(input: LoginItemInput): { openAtLogin: boolean; args: string[] } {
  const args = input.packaged ? [hiddenLaunchFlag] : [input.appPath, hiddenLaunchFlag]
  return { openAtLogin: input.openAtLogin, args }
}

/** 这次启动是不是开机自启拉起来的（是就不弹窗口）。 */
export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(hiddenLaunchFlag)
}
