import type { KuraBridge } from '../shared/ipc.js'

declare global {
  interface Window {
    /** preload 注入；在浏览器里直接打开页面（没有 Electron）时不存在 */
    kura?: KuraBridge
  }
}
