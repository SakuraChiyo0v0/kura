import { describe, expect, it } from 'vitest'
import { buildPastePayload, normalizePasteText, pastesMultipleCommands } from './xterm-clipboard.js'

describe('终端粘贴的换行', () => {
  it('三种换行都归一成 LF', () => {
    expect(normalizePasteText('a\r\nb')).toBe('a\nb')
    expect(normalizePasteText('a\rb')).toBe('a\nb')
    expect(normalizePasteText('a\nb')).toBe('a\nb')
    expect(normalizePasteText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('bracketed 模式里用 LF 包在框内 —— 这正是 ^M 的修复点', () => {
    // 换成 CR 的话，readline 会把它当字面字符插进缓冲，屏幕上就是 ^M、
    // 回车执行时报 bash: $'\r': command not found
    expect(buildPastePayload('echo one\r\necho two\r\n', true)).toBe('\x1b[200~echo one\necho two\n\x1b[201~')
  })

  it('非 bracketed 模式用 CR：等于逐行敲回车', () => {
    expect(buildPastePayload('echo one\r\necho two\r\n', false)).toBe('echo one\recho two\r')
  })

  it('空文本什么都不发', () => {
    expect(buildPastePayload('', true)).toBe('')
    expect(buildPastePayload('', false)).toBe('')
  })

  it('单行不受影响', () => {
    expect(buildPastePayload('ls -la', true)).toBe('\x1b[200~ls -la\x1b[201~')
    expect(buildPastePayload('ls -la', false)).toBe('ls -la')
  })

  it('只有 bracketed 模式能安全地一次粘多行', () => {
    expect(pastesMultipleCommands('a\nb', true)).toBe(false)
    expect(pastesMultipleCommands('a\nb', false)).toBe(true)
    // 末尾多出来的空行不算「多条命令」（复制整行常带一个）
    expect(pastesMultipleCommands('ls\n', false)).toBe(false)
    expect(pastesMultipleCommands('ls', false)).toBe(false)
  })
})
