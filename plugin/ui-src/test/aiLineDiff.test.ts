import { describe, it, expect } from 'vitest'
import { lineDiff } from '../src/ai/lineDiff'

const k = (a: string, b: string) => lineDiff(a, b).map((d) => `${d.kind[0]}:${d.text}`)

describe('lineDiff', () => {
  it('identical', () => expect(k('a\nb', 'a\nb')).toEqual(['s:a', 's:b']))
  it('addition', () => expect(k('a', 'a\nb')).toEqual(['s:a', 'a:b']))
  it('deletion', () => expect(k('a\nb', 'a')).toEqual(['s:a', 'd:b']))
  it('replacement', () => expect(k('a\nb\nc', 'a\nX\nc')).toEqual(['s:a', 'd:b', 'a:X', 's:c']))
  it('empty strings', () => {
    expect(lineDiff('', '')).toEqual([])
    expect(k('', 'a')).toEqual(['a:a'])
    expect(k('a', '')).toEqual(['d:a'])
  })
  it('CRLF equals LF', () => expect(k('a\r\nb', 'a\nb')).toEqual(['s:a', 's:b']))
  it('degrades to whole-block replacement above 2000 lines', () => {
    const a = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')
    const d = lineDiff(a, `${a}\nx`)
    expect(d.filter((x) => x.kind === 'same')).toHaveLength(0)
    expect(d.filter((x) => x.kind === 'del')).toHaveLength(2001)
    expect(d.filter((x) => x.kind === 'add')).toHaveLength(2002)
  })
  it('exactly 2000 lines still diffs', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n')
    expect(lineDiff(a, a).every((x) => x.kind === 'same')).toBe(true)
  })
})
