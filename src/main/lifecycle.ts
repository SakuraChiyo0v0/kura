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
