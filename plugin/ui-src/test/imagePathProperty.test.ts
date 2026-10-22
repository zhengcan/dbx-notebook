import { describe, it, expect } from 'vitest'
import { classifySrc } from '../src/markdown/imagePolicy'

function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

describe('classifySrc property', () => {
  it('never yields an unsafe relative path for hostile random strings', () => {
    const alpha = ['.', '/', '\\', '%', ':', '~', '\0', 'C', 'CON', '2e', '2f', 'a', ' ', '?', '#', '..', '%2e', '%2F', 'x.png']
    const r = rng(20261027)
    let rel = 0
    for (let i = 0; i < 2000; i++) {
      let s = ''
      const n = 1 + Math.floor(r() * 8)
      for (let j = 0; j < n; j++) s += alpha[Math.floor(r() * alpha.length)]
      const c = classifySrc(s)
      if (c.kind !== 'relative') continue
      rel++
      const p = c.rel
      expect(p.split('/').includes('..'), s).toBe(false)
      expect(p.startsWith('/') || p.startsWith('\\') || p.startsWith('~'), s).toBe(false)
      expect(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) || /^[A-Za-z]:/.test(p) || p.includes(':'), s).toBe(false)
      expect(p.includes('%') || p.includes('\\') || /[\u0000-\u001f]/.test(p), s).toBe(false)
      expect(p.split('/').some((x) => x === ''), s).toBe(false)
    }
    expect(rel).toBeGreaterThan(20)
  })
})
