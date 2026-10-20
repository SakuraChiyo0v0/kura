import type { Terminal } from '@xterm/xterm'

/**
 * 终端的复制粘贴。**纯逻辑与 DOM 接线分开放**，前者可单测。
 *
 * 这里踩过的坑（2026-10-21）：粘贴多行时 NAS 上 bash 报
 * `bash: $'\r': command not found`，屏幕上是一串 `^M`。
 *
 * 不是 NAS 的问题。bash 5.1+ 默认开 bracketed paste（`\x1b[200~ … \x1b[201~`），
 * 此时 readline **不按键盘映射处理**，把框内的字节原样插进编辑缓冲；而 xterm 自带的
 * 粘贴处理（`prepareTextForTerminal`）把换行一律换成 **CR**。
 * 框外 CR 是回车键，框内就只是一个字面控制字符 —— 于是既不能分行执行，也去不掉。
 *
 * 所以换行要按模式选：
 * - bracketed（shell 明确说要整段）：用 **LF** 包在框里，粘成可编辑的多行，确认后才执行；
 * - 非 bracketed：用 **CR**，等于逐行敲回车。
 */

/** 剪贴板里的换行五花八门，先统一成 LF 再按模式决定。 */
export function normalizePasteText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 粘进终端的实际字节。空文本返回空串（调用方据此不发）。 */
export function buildPastePayload(text: string, bracketed: boolean): string {
  const normalized = normalizePasteText(text)
  if (!normalized) return ''
  // 末尾的换行用户通常不是故意的（复制整行会带上），但也不能替他删 —— 保留原样，由调用方决定是否要去
  if (bracketed) return `\x1b[200~${normalized}\x1b[201~`
  return normalized.replace(/\n/g, '\r')
}

/** 这段文本粘下去会不会直接执行多条命令（非 bracketed 下每行都会）。 */
export function pastesMultipleCommands(text: string, bracketed: boolean): boolean {
  if (bracketed) return false
  return normalizePasteText(text).replace(/\n+$/, '').includes('\n')
}

export interface ClipboardDeps {
  /** 把字节发给远端 PTY */
  write: (data: string) => void
  /** 写系统剪贴板 */
  copy: (text: string) => Promise<unknown>
  /** 读系统剪贴板 */
  read: () => Promise<string>
  /** 需要用户确认时弹一次（多行会被逐条执行）；返回 true 表示继续粘贴 */
  confirm: (lines: number) => Promise<boolean>
}

/**
 * 挂上粘贴拦截与快捷键，返回卸载函数。
 *
 * 粘贴走**捕获阶段**：xterm 自己在 textarea 与 element 上各挂了一个 paste 监听，
 * 捕获阶段先跑到，拦得住。不能只用快捷键 —— 用户按 Ctrl+V 时浏览器自己会派发 paste 事件，
 * 拦截这一个入口就同时覆盖了 Ctrl+V、Shift+Insert 与右键「粘贴」菜单。
 */
export function installTerminalClipboard(terminal: Terminal, host: HTMLElement, deps: ClipboardDeps): () => void {
  const paste = async (text: string) => {
    const bracketed = terminal.modes.bracketedPasteMode
    if (!text) return
    if (pastesMultipleCommands(text, bracketed)) {
      const lines = normalizePasteText(text).replace(/\n+$/, '').split('\n').length
      if (!(await deps.confirm(lines))) return
    }
    deps.write(buildPastePayload(text, bracketed))
  }

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain')
    // 没有 clipboardData 就不插手：让 xterm 走它自己的路径，总比什么都不发生好
    if (text == null) return
    event.preventDefault()
    event.stopPropagation()
    void paste(text)
  }
  host.addEventListener('paste', onPaste, true)

  const copySelection = async () => {
    const selection = terminal.getSelection()
    if (!selection) return false
    await deps.copy(selection)
    terminal.clearSelection()
    return true
  }

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey
    const shift = event.shiftKey

    // Ctrl+C：**有选区时复制**，没选区才是中断信号（Windows Terminal 的约定）。
    // 想给正在跑的东西发 ^C，先按一下 Esc 清掉选区即可。
    if (ctrl && !shift && event.code === 'KeyC' && terminal.hasSelection()) {
      void copySelection()
      return false
    }
    // Ctrl+Shift+C / Ctrl+Insert：不管有没有选区都只做复制（有选区时才有意义）
    if ((ctrl && shift && event.code === 'KeyC') || (ctrl && event.code === 'Insert')) {
      void copySelection()
      return false
    }
    // Ctrl+V：交给浏览器派发原生 paste 事件，由上面的拦截统一处理
    if (ctrl && !shift && event.code === 'KeyV') return true
    // Ctrl+Shift+V / Shift+Insert：直接读剪贴板（这些组合不会派发 paste 事件）
    if ((ctrl && shift && event.code === 'KeyV') || (shift && event.code === 'Insert')) {
      void deps.read().then(paste, () => {})
      return false
    }
    return true
  })

  return () => host.removeEventListener('paste', onPaste, true)
}

/** 页面里已有的 textarea 上粘（容器 shell 与终端页共用同一套）。 */
export function clipboardKeyHint(): string {
  return 'Ctrl+V 粘贴 · Ctrl+C 复制选中 · Ctrl+Shift+V 也可粘贴'
}
