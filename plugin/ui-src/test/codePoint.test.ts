import { describe, it, expect } from 'vitest'
import { alignDown, alignUp } from '../src/markdown/codePoint'
import { mkStore } from './undoHelpers'

describe('code point alignment', () => {
  const t = 'a😀b😀'
  it('alignDown moves into the boundary before the pair, alignUp after', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => alignDown(t, i))).toEqual([0, 1, 1, 3, 4, 4, 6])
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => alignUp(t, i))).toEqual([0, 1, 3, 3, 4, 6, 6])
  })
  it('clamps; lone surrogates and plain text are untouched', () => {
    expect(alignDown(t, -3)).toBe(0)
    expect(alignDown(t, 99)).toBe(t.length)
    expect(alignDown('a\ud83d', 2)).toBe(2)
    expect(alignDown('abc', 2)).toBe(2)
    expect(alignUp('\ude00x', 1)).toBe(1)
  })
  it('store insert never splits a pair (from down, to up)', () => {
    const { s, blk } = mkStore([{ id: 'm1', type: 'markdown', content: 'a😀b😀c' }])
    s.insertMarkdownImages('m1', ['p.png'], { from: 2, to: 2 })
    expect(blk('m1').content).toBe('a![](p.png)😀b😀c')
    s.undo()
    s.insertMarkdownImages('m1', ['p.png'], { from: 2, to: 5 })
    expect(blk('m1').content).toBe('a![](p.png)c')
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(blk('m1').content)).toBe(false)
  })
})
