import { describe, it, expect } from 'vitest'
import { alignDown, alignUp } from '../src/markdown/codePoint'
import { applyMarkdownAction, changedSpan, type MdAction } from '../src/markdown/toolbarActions'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHA = ['a', 'b', ' ', '1', '.', '*', '`', '#', '>', '-', '\\', '\n', '\r\n', '中', '文', '😀', '\t', '```', '```\n', '| a |', '**', '[a](b)']
const NO_BS = ALPHA.filter((c) => c !== '\\')
const ALL: MdAction[] = ['heading', 'bold', 'italic', 'code', 'codeBlock', 'link', 'quote', 'ul', 'ol', 'table']

function gen(r: () => number, alpha = ALPHA) {
  const n = Math.floor(r() * 14)
  let text = ''
  for (let i = 0; i < n; i++) text += alpha[Math.floor(r() * alpha.length)]
  const x = Math.floor(r() * (text.length + 3)) - 1
  const y = Math.floor(r() * (text.length + 3)) - 1
  return { text, from: x, to: y }
}
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const clamp = (n: number, len: number) => Math.max(0, Math.min(len, n))

describe('applyMarkdownAction properties', () => {
  it('never throws, keeps the selection in range, never leaves a lone surrogate', () => {
    const r = rng(1)
    for (let i = 0; i < 1500; i++) {
      const { text, from, to } = gen(r)
      const a = ALL[i % ALL.length]
      const res = applyMarkdownAction(text, { from, to }, a)
      expect(res.from).toBeGreaterThanOrEqual(0)
      expect(res.from).toBeLessThanOrEqual(res.to)
      expect(res.to).toBeLessThanOrEqual(res.text.length)
      expect(lone.test(res.text)).toBe(false)
      expect(res.from === 0 || !/[\ud800-\udbff]/.test(res.text[res.from - 1]) || /[\ud800-\udbff]/.test(res.text[res.from]) === false).toBe(true)
    }
  })

  it('bold, italic and code applied twice restore the text when the first application wrapped', () => {
    const r = rng(2)
    let checked = 0
    for (let i = 0; i < 3000 && checked < 500; i++) {
      const { text, from, to } = gen(r, NO_BS)
      const f = alignDown(text, clamp(Math.min(from, to), text.length))
      const t = alignUp(text, clamp(Math.max(from, to), text.length))
      if (text.slice(f, t).trim() === '') continue
      if (/[*`\\]/.test((text[f - 1] ?? '') + (text[t] ?? '') + text[f] + text[t - 1])) continue
      for (const a of ['bold', 'italic', 'code'] as MdAction[]) {
        const one = applyMarkdownAction(text, { from, to }, a)
        if (one.text.length <= text.length) continue
        const two = applyMarkdownAction(one.text, { from: one.from, to: one.to }, a)
        expect(two.text).toBe(text)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('exclusion ratio of the involution property stays below 30%', () => {
    const r = rng(8)
    const alpha = ['a', 'b', ' ', '1', '中', '😀', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', '*', '`']
    let total = 0
    let excluded = 0
    let checked = 0
    for (let i = 0; i < 1500; i++) {
      const n = 2 + Math.floor(r() * 10)
      let text = ''
      for (let k = 0; k < n; k++) text += alpha[Math.floor(r() * alpha.length)]
      let f = Math.floor(r() * text.length)
      let t = f + 1 + Math.floor(r() * Math.min(3, text.length - f))
      f = alignDown(text, Math.min(f, text.length))
      t = alignUp(text, Math.min(t, text.length))
      total++
      if (f >= t || text.slice(f, t).trim() === '' || /[*`]/.test(text.slice(f, t) + (text[f - 1] ?? '') + (text[t] ?? ''))) {
        excluded++
        continue
      }
      for (const a of ['bold', 'italic', 'code'] as MdAction[]) {
        const one = applyMarkdownAction(text, { from: f, to: t }, a)
        const two = applyMarkdownAction(one.text, one, a)
        expect(two.text).toBe(text)
        checked++
      }
    }
    expect(excluded / total).toBeLessThan(0.3)
    expect(checked).toBeGreaterThan(1500)
  })

  it('bold keeps the parity of the star count and clicking repeatedly cycles (within 2 clicks for star-free text, 4 otherwise)', () => {
    const r = rng(9)
    const stars = (x: string) => (x.match(/\*/g) ?? []).length
    for (let i = 0; i < 2000; i++) {
      const g = gen(r, ['a', 'b', ' ', '*', '**', '*', '中', '\n'])
      const lo = Math.max(0, Math.min(g.from, g.to, g.text.length))
      const hi = Math.min(g.text.length, Math.max(g.from, g.to, 0))
      const sl = g.text.slice(lo, hi).trim()
      const edgeClean = sl !== '' && !/\*/.test((g.text[lo - 1] ?? '') + sl[0] + sl[sl.length - 1] + (g.text[hi] ?? ''))
      let cur = { text: g.text, from: g.from, to: g.to }
      const texts = [cur.text]
      for (let k = 0; k < 8; k++) {
        cur = applyMarkdownAction(cur.text, cur, 'bold')
        texts.push(cur.text)
        expect(stars(cur.text) % 2).toBe(stars(g.text) % 2)
        if (edgeClean) expect(stars(cur.text)).toBeLessThanOrEqual(stars(g.text) + 4)
      }
      const clean = !/\*/.test(g.text)
      const cyc = [2, 3, 4, 5].some((k) => texts[k] === texts[k + 2])
      expect(cyc).toBe(true)
      if (clean) expect(texts[2] === texts[4] || texts[1] === texts[3]).toBe(true)
    }
  })

  it('bold/italic only add or remove star characters', () => {
    const r = rng(11)
    const strip = (x: string) => x.replace(/\*/g, '')
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const g = gen(r, ['a', 'b', ' ', '*', '**', '*', '中', '😀', '\n', '`', '\r\n', 'https://x.y/a*b', '\\'])
      const f = alignDown(g.text, clamp(Math.min(g.from, g.to), g.text.length))
      const t = alignUp(g.text, clamp(Math.max(g.from, g.to), g.text.length))
      if (g.text.slice(f, t).trim() === '') continue
      for (const a of ['bold', 'italic'] as MdAction[]) {
        const res = applyMarkdownAction(g.text, g, a)
        expect(strip(res.text)).toBe(strip(g.text))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1500)
  })

  it('literal stars are kept: whole-selection wrap adds only markers and a second click restores', () => {
    const r = rng(12)
    const frags = ['a * b', '2*3', 'f(a*b)', '`a*b*c`', '`**a**`', '* x', 'https://x.com/a*b*c', 'a', '中', '😀', '2 * 3 * 4']
    const stars = (x: string) => (x.match(/\*/g) ?? []).length
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(r() * 4)
      let text = ''
      for (let k = 0; k < n; k++) text += (k ? (r() < 0.5 ? ' ' : '\n') : '') + frags[Math.floor(r() * frags.length)]
      for (const [a, w] of [['bold', 4], ['italic', 2]] as const) {
        const one = applyMarkdownAction(text, { from: 0, to: text.length }, a)
        expect(stars(one.text)).toBe(stars(text) + w)
        expect(one.text.replace(/\*/g, '')).toBe(text.replace(/\*/g, ''))
        const two = applyMarkdownAction(one.text, one, a)
        expect(two.text).toBe(text)
      }
    }
  })

  it('line prefix actions applied twice restore text without prior prefixes', () => {
    const r = rng(3)
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const { text, from, to } = gen(r, ['a', 'b', ' ', '中', '😀', '\n', '\r\n', '\t', '`'])
      for (const a of ['quote', 'ul', 'ol'] as MdAction[]) {
        const one = applyMarkdownAction(text, { from, to }, a)
        if (one.text === text) continue
        const two = applyMarkdownAction(one.text, { from: one.from, to: one.to }, a)
        expect(two.text).toBe(text)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('line actions do not touch lines outside the selected ones', () => {
    const r = rng(4)
    for (let i = 0; i < 1500; i++) {
      const { text, from, to } = gen(r)
      for (const a of ['heading', 'quote', 'ul', 'ol'] as MdAction[]) {
        const res = applyMarkdownAction(text, { from, to }, a)
        const f = clamp(Math.min(from, to), text.length)
        const t = clamp(Math.max(from, to), text.length)
        const ls = f === 0 ? 0 : text.lastIndexOf('\n', f - 1) + 1
        const endPos = t > f && text[t - 1] === '\n' ? t - 1 : t
        const le = text.indexOf('\n', endPos) < 0 ? text.length : text.indexOf('\n', endPos)
        // a caret inside a CRLF is moved before the CR, which only narrows the line range
        const lsSafe = Math.min(ls, ls)
        expect(res.text.startsWith(text.slice(0, lsSafe))).toBe(true)
        expect(res.text.endsWith(text.slice(le))).toBe(true)
        if (a === 'heading') {
          const fl = text.indexOf('\n', f) < 0 ? text.length : text.indexOf('\n', f)
          expect(res.text.endsWith(text.slice(fl))).toBe(true)
        }
      }
    }
  })

  it('fenced-block shapes keep the selection contract for every action', () => {
    const r = rng(10)
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
    for (let i = 0; i < 2000; i++) {
      const e = pick(['\n', '\r\n'])
      const text =
        pick(['', 'x' + e, e]) + pick(['```', '~~~', '````']) + pick(['', 'sql']) + e + pick(['', 'a' + e, 'a' + e + e + 'b' + e]) + pick(['```', '~~~', '````']) + pick(['', e, e + 'y', 'z'])
      const g = { from: Math.floor(r() * (text.length + 2)) - 1, to: Math.floor(r() * (text.length + 2)) - 1 }
      for (const a of ALL) {
        const res = applyMarkdownAction(text, g, a)
        expect(res.from).toBeGreaterThanOrEqual(0)
        expect(res.from).toBeLessThanOrEqual(res.to)
        expect(res.to).toBeLessThanOrEqual(res.text.length)
        if (e === '\r\n') expect(res.text.replace(/\r\n/g, '')).not.toContain('\n')
      }
    }
  })

  it('CRLF-only input never gains a bare LF', () => {
    const r = rng(5)
    for (let i = 0; i < 1500; i++) {
      const g = gen(r, ['a', '中', '😀', '*', '`', '#', '-', ' ', '\r\n', '\r\n', '```', '```\r\n', '\r\n```', '| a |', '[a](b)'])
      const text = g.text
      for (const a of ALL) {
        if (!text.includes('\r\n')) continue
        const res = applyMarkdownAction(text, { from: g.from, to: g.to }, a)
        expect(res.text.replace(/\r\n/g, '')).not.toContain('\n')
      }
    }
  })

  it('LF-only input never gains a CR', () => {
    const r = rng(6)
    for (let i = 0; i < 1000; i++) {
      const g = gen(r, ['a', '中', '😀', '*', '`', '\n', '\n', ' '])
      for (const a of ALL) expect(applyMarkdownAction(g.text, g, a).text).not.toContain('\r')
    }
  })

  it('changedSpan replays before into after and never splits a pair', () => {
    const r = rng(7)
    for (let i = 0; i < 1500; i++) {
      const a = gen(r).text
      const b = r() < 0.5 ? gen(r).text : applyMarkdownAction(a, gen(r), ALL[i % ALL.length]).text
      const s = changedSpan(a, b)
      expect(s.from).toBeLessThanOrEqual(s.to)
      expect(s.to).toBeLessThanOrEqual(b.length)
      const replay = a.slice(0, s.from) + b.slice(s.from, s.to) + a.slice(a.length - (b.length - s.to))
      expect(replay).toBe(b)
      expect(s.from === 0 || !(/[\ud800-\udbff]/.test(b[s.from - 1]) && /[\udc00-\udfff]/.test(b[s.from] ?? ''))).toBe(true)
      expect(s.to === b.length || !(/[\ud800-\udbff]/.test(b[s.to - 1] ?? '') && /[\udc00-\udfff]/.test(b[s.to]))).toBe(true)
    }
  })
})
