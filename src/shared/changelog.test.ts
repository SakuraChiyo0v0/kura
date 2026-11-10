import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  compareVersions,
  entriesBetween,
  formatEntry,
  parseChangelog,
  parseInlineMarkdown,
  parseReleaseNotes,
  shouldShowWhatsNew
} from './changelog.js'

const sample = `# 更新日志

说明文字，不属于任何版本。

## 0.3.0 · 2026-10-15

- 第三条
  折行接上
- 第四条

## v0.2.0

* 第二条

## 其他标题

- 不该被并进 0.2.0

## 0.1.0 · 2026-10-14
- 第一条
`

describe('parseChangelog', () => {
  it('按版本标题切节，忽略文件头与非版本标题下的内容', () => {
    expect(parseChangelog(sample)).toEqual([
      { version: '0.3.0', date: '2026-10-15', items: ['第三条 折行接上', '第四条'] },
      { version: '0.2.0', date: '', items: ['第二条'] },
      { version: '0.1.0', date: '2026-10-14', items: ['第一条'] },
    ])
  })

  it('CRLF 也能解析', () => {
    expect(parseChangelog(sample.replace(/\n/g, '\r\n'))[0]?.items).toEqual(['第三条 折行接上', '第四条'])
  })

  it('仓库里的 CHANGELOG.md 有当前版本那一节', () => {
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    const entry = parseChangelog(readFileSync('CHANGELOG.md', 'utf8')).find((e) => e.version === version)
    expect(entry?.items.length).toBeGreaterThan(0)
  })
})

describe('compareVersions / entriesBetween', () => {
  it('按数字比较，不按字符串', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.4.0', '0.5.0')).toBeLessThan(0)
  })

  it('取 (from, to] 区间，新的在前', () => {
    const entries = parseChangelog(sample)
    expect(entriesBetween(entries, '0.1.0', '0.3.0').map((e) => e.version)).toEqual(['0.3.0', '0.2.0'])
    expect(entriesBetween(entries, '', '0.2.0').map((e) => e.version)).toEqual(['0.2.0', '0.1.0'])
    expect(entriesBetween(entries, '0.3.0', '0.3.0')).toEqual([])
  })

  it('formatEntry 输出列表', () => {
    expect(formatEntry({ version: '1.0.0', date: '', items: ['a', 'b'] })).toBe('- a\n- b')
  })
})

describe('shouldShowWhatsNew', () => {
  it('同一版本不弹', () => {
    expect(shouldShowWhatsNew({ lastSeen: '0.5.0', current: '0.5.0', existingUser: true })).toBe(false)
  })
  it('升级了才弹，降级不弹', () => {
    expect(shouldShowWhatsNew({ lastSeen: '0.5.0', current: '0.5.1', existingUser: true })).toBe(true)
    expect(shouldShowWhatsNew({ lastSeen: '0.6.0', current: '0.5.1', existingUser: true })).toBe(false)
  })
  it('没记过：老用户（从 0.4 升上来）弹，全新安装不弹', () => {
    expect(shouldShowWhatsNew({ lastSeen: '', current: '0.5.0', existingUser: true })).toBe(true)
    expect(shouldShowWhatsNew({ lastSeen: '', current: '0.5.0', existingUser: false })).toBe(false)
  })
})

describe('行内 Markdown（更新日志的富文本）', () => {
  it('粗体里套行内代码：0.11.2 那条的实际形状', () => {
    const tokens = parseInlineMarkdown('**修复网关 `/webdav` 前缀模式**：网关只把前缀剥掉了')
    expect(tokens).toEqual([
      {
        kind: 'strong',
        tokens: [
          { kind: 'text', text: '修复网关 ' },
          { kind: 'code', text: '/webdav' },
          { kind: 'text', text: ' 前缀模式' }
        ]
      },
      { kind: 'text', text: '：网关只把前缀剥掉了' }
    ])
  })

  it('纯文本原样返回，不吞字符', () => {
    expect(parseInlineMarkdown('客户端本机 WebDAV（无前缀）行为不变')).toEqual([
      { kind: 'text', text: '客户端本机 WebDAV（无前缀）行为不变' }
    ])
  })

  it('没闭合的标记当普通文本，不吞内容', () => {
    expect(parseInlineMarkdown('**没闭合')).toEqual([{ kind: 'text', text: '**没闭合' }])
    expect(parseInlineMarkdown('没闭合 `')).toEqual([{ kind: 'text', text: '没闭合 `' }])
  })

  it('行内代码里的 ** 不当粗体', () => {
    expect(parseInlineMarkdown('`a**b`')).toEqual([{ kind: 'code', text: 'a**b' }])
  })

  it('多个行内代码混排', () => {
    const tokens = parseInlineMarkdown('`MOVE` / `COPY` 的 `Destination` 反过来剥掉前缀')
    const flat = tokens.map((token) =>
      token.kind === 'code' ? `<${token.text}>` : token.kind === 'text' ? token.text : '?'
    )
    expect(flat).toEqual(['<MOVE>', ' / ', '<COPY>', ' 的 ', '<Destination>', ' 反过来剥掉前缀'])
  })
})

describe('parseReleaseNotes', () => {
  it('把发布正文的列表拆成条目，折行接上', () => {
    expect(parseReleaseNotes('- 第一条\n- 第二条\n  折行接上\n\n')).toEqual(['第一条', '第二条 折行接上'])
  })

  it('不是列表的文字不产生条目', () => {
    expect(parseReleaseNotes('说明文字\n\n- 只有这条')).toEqual(['只有这条'])
    expect(parseReleaseNotes('')).toEqual([])
  })
})
