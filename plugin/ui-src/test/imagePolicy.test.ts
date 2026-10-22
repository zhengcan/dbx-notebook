import { describe, it, expect } from 'vitest'
import { classifySrc, ALLOWED_DATA, MAX_REL_LEN } from '../src/markdown/imagePolicy'
import { HOSTILE_SRCS, GOOD_SRCS } from './fixtures/hostilePaths'

describe('classifySrc', () => {
  it('blocks every hostile source', () => {
    for (const s of HOSTILE_SRCS) expect(classifySrc(s), JSON.stringify(s.slice(0, 60))).toEqual({ kind: 'blocked' })
  })
  it('accepts good relative paths and returns the decoded rel', () => {
    for (const [src, rel] of GOOD_SRCS) expect(classifySrc(src), src).toEqual({ kind: 'relative', rel })
  })
  it('accepts only png/jpeg/gif/webp base64 data URIs', () => {
    for (const m of ['png', 'jpeg', 'gif', 'webp']) {
      const s = `data:image/${m};base64,iVBORw0KGgo=`
      expect(classifySrc(s)).toEqual({ kind: 'data', src: s })
    }
    expect(ALLOWED_DATA.test('data:image/svg+xml;base64,AAAA')).toBe(false)
  })
  it('caps the length', () => {
    expect(classifySrc('a'.repeat(MAX_REL_LEN) ).kind).toBe('relative')
    expect(classifySrc('a'.repeat(MAX_REL_LEN + 1)).kind).toBe('blocked')
  })
})
