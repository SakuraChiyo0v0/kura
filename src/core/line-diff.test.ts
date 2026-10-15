import { describe, expect, it } from 'vitest'
import { lineDiff } from './line-diff.js'

describe('lineDiff', () => {
  it('只标出改了的那一行', () => {
    const d = lineDiff('services:\n  app:\n    image: a:1\n', 'services:\n  app:\n    image: a:2\n')
    expect(d.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: '    image: a:1' },
      { kind: 'add', text: '    image: a:2' },
    ])
  })

  it('插入与删除', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd').map((l) => `${l.kind[0]}${l.text}`)).toEqual(['sa', 'db', 'sc', 'ad'])
  })

  it('没改就全是 same', () => {
    expect(lineDiff('x\ny', 'x\ny').every((l) => l.kind === 'same')).toBe(true)
  })
})
