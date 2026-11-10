/**
 * 更新日志（仓库根的 CHANGELOG.md）的解析。主进程、渲染层与发布脚本共用：
 * 发布时取当前版本那一节写进 Release 正文与 latest.yml，应用里按「上次看过的版本」取出新增的几节。
 */

export interface ChangelogEntry {
  version: string
  /** 标题里 `·` 后面的日期，原样保留；没写就是空串 */
  date: string
  /** 这一节的条目（`- ` 开头的行，去掉前缀） */
  items: string[]
}

const headingPattern = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:·\s*(.*))?$/

/** 按 `## <版本> · <日期>` 切节；节外的文字（文件头说明）忽略。顺序与文件一致（新的在前）。 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | undefined
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = headingPattern.exec(line)
    if (heading) {
      current = { version: heading[1]!, date: (heading[2] ?? '').trim(), items: [] }
      entries.push(current)
      continue
    }
    if (line.startsWith('## ')) {
      // 不是版本标题的二级标题：结束当前节，免得把别的内容并进去
      current = undefined
      continue
    }
    if (!current) continue
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) current.items.push(item[1]!.trim())
    else if (line.trim() && current.items.length > 0) {
      // 列表项折行：接到上一条后面
      current.items[current.items.length - 1] += ` ${line.trim()}`
    }
  }
  return entries
}

/** 比较 x.y.z；只认数字三段（不做预发布标签，Kura 不发预发布）。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 取 (from, to] 之间的几节，新的在前。from 为空串表示不限下界。 */
export function entriesBetween(entries: ChangelogEntry[], from: string, to: string): ChangelogEntry[] {
  return entries
    .filter((entry) => compareVersions(entry.version, to) <= 0 && (!from || compareVersions(entry.version, from) > 0))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** 渲染成发布用的 Markdown（Release 正文 / latest.yml 的 releaseNotes） */
export function formatEntry(entry: ChangelogEntry): string {
  return entry.items.map((item) => `- ${item}`).join('\n')
}

/**
 * 升级后要不要弹「本次更新内容」。
 * - 上次看过的版本就是当前版本：不弹
 * - 从没记过（全新安装，或从还没有这个字段的 0.4 升上来）：只有已经连过 NAS 的老用户才弹 ——
 *   全新安装的人要先走引导，没必要先看一堆更新说明
 */
export function shouldShowWhatsNew(input: { lastSeen: string; current: string; existingUser: boolean }): boolean {
  if (input.lastSeen === input.current) return false
  if (!input.lastSeen) return input.existingUser
  return compareVersions(input.current, input.lastSeen) > 0
}

/**
 * 更新日志里用到的**行内 Markdown 子集**：粗体与行内代码。
 *
 * 为什么不在界面上直接显示原文：CHANGELOG 是给 GitHub Release 用的 Markdown，
 * 应用里如果整段当纯文本渲染，用户看到的是 `**修复……**` 和一串反引号（0.11.2 就是这样）。
 * 这里只认发布正文实际会用到的两种标记，不引入 Markdown 引擎：
 * - 反引号包住的行内代码不参与其它标记（代码里的 `**` 不会被当成粗体）；
 * - 粗体里面还能套行内代码（"**修复 `/webdav` 前缀模式……**" 这种）。
 * 认不出来的标记原样留作文本，不吞字符。
 */
export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly tokens: readonly InlineToken[] }

export function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      tokens.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }

  let index = 0
  while (index < text.length) {
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index + 1) {
        flush()
        tokens.push({ kind: 'code', text: text.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2)
      if (end > index + 2) {
        flush()
        tokens.push({ kind: 'strong', tokens: parseInlineMarkdown(text.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    buffer += text[index]
    index += 1
  }
  flush()
  return tokens
}

/**
 * 更新源（latest.yml 的 releaseNotes）给的正文是 `- 条目` 形式的 Markdown 列表，
 * 应用里要按列表渲染而不是整段塞进 `<pre>`。规则与 parseChangelog 收集条目一致。
 */
export function parseReleaseNotes(markdown: string): string[] {
  const items: string[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) {
      items.push(item[1]!.trim())
      continue
    }
    if (line.trim().length > 0 && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`
    }
  }
  return items
}
