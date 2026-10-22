import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { autoColumnBreaks, effectiveRepeat, textUnits, contentWidthPx, PAGE_PAD_PX } from '../src/export/autoBreaks'
import { buildExportModel } from '../src/export/model'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/export/options'

const mk = (n: number, text = 'abcdefghij') => ({
  columns: Array.from({ length: n }, (_, i) => `c${i}`.padEnd(text.length, 'x')),
  rows: [Array.from({ length: n }, () => text)],
})
const run = (o: { columns: string[]; rows: string[][] }, extra: Partial<Parameters<typeof autoColumnBreaks>[0]> = {}) =>
  autoColumnBreaks({ ...o, orientation: 'portrait', repeatCols: 0, leading: { kind: 'serial', rowCount: o.rows.length }, ...extra })
const base = (o: { columns: string[]; rows: string[][] }) => ({ ...o, orientation: 'portrait' as const, repeatCols: 0, leading: { kind: 'serial' as const, rowCount: o.rows.length } })
const groupsOf = (n: number, b: number[]) => { const out: number[][] = []; let s = 0; for (const c of [...b, n - 1]) { out.push(Array.from({ length: c - s + 1 }, (_, i) => s + i)); s = c + 1 } return out }

describe('textUnits', () => {
  it('CJK counts double, long text is capped by callers', () => {
    expect(textUnits('abc')).toBe(3)
    expect(textUnits('中文')).toBe(4)
    expect(textUnits('a中')).toBe(3)
  })
})

describe('autoColumnBreaks', () => {
  it('narrow table fits on one page: no breaks', () => {
    expect(run(mk(4))).toEqual([])
    expect(run({ columns: ['a'], rows: [] })).toEqual([])
  })
  it('wide table is split so each page fits, never empty groups', () => {
    const o = mk(24)
    const b = run(o)
    expect(b.length).toBeGreaterThan(1)
    expect(b).toEqual([...b].sort((x, y) => x - y))
    expect(new Set(b).size).toBe(b.length)
    expect(b.every((x) => x >= 0 && x < 23)).toBe(true)
    const per = Math.floor((contentWidthPx('portrait') - 40) / (PAGE_PAD_PX + 7.5 * 10))
    for (const g of groupsOf(24, b)) expect(g.length).toBeLessThanOrEqual(per)
  })
  it('landscape needs fewer pages than portrait', () => {
    const o = mk(24)
    expect(run(o, { orientation: 'landscape' }).length).toBeLessThan(run(o).length)
  })
  it('CJK cells are wider than ASCII of the same length', () => {
    const ascii = mk(8, 'abcdefgh')
    const cjk = mk(8, '一二三四五六七八')
    expect(run(ascii)).toEqual([])
    expect(run(cjk).length).toBeGreaterThan(0)
  })
  it('long text is capped so it never forces a split by itself', () => {
    const o = { columns: ['a', 'b'], rows: [['x'.repeat(500), 'y'.repeat(800)]] }
    expect(run(o)).toEqual([])
  })
  it('a single very wide column still gets its own page group', () => {
    const o = mk(3, 'x'.repeat(200))
    const b = run(o)
    expect(groupsOf(3, b).every((g) => g.length >= 1)).toBe(true)
  })
  it('header text counts too', () => {
    const o = { columns: Array.from({ length: 10 }, (_, i) => `a_rather_long_header_${i}_`), rows: [Array(10).fill('1')] }
    expect(run(o).length).toBeGreaterThan(0)
  })
  it('repeating first columns reduces the room on later pages', () => {
    const o = mk(24)
    const plain = run(o)
    const rep = run(o, { repeatCols: 3 })
    expect(rep.length).toBeGreaterThanOrEqual(plain.length)
    const g = groupsOf(24, rep)
    expect(g[1].length).toBeLessThan(groupsOf(24, plain)[1].length)
  })
  it('repeatCols >= column count is clamped, and repeats that leave no room are ignored', () => {
    const o = mk(24)
    expect(effectiveRepeat({ ...base(o), repeatCols: 3 })).toBe(3)
    expect(effectiveRepeat({ ...base(o), repeatCols: 24 })).toBe(0)
    expect(effectiveRepeat({ ...base(o), repeatCols: 99 })).toBe(0)
    const small = mk(3)
    expect(effectiveRepeat({ ...base(small), repeatCols: 9 })).toBe(2)
    for (const rc of [23, 24, 30]) {
      const g = groupsOf(24, run(o, { repeatCols: rc }))
      expect(g.slice(0, -1).every((x) => x.length > 1)).toBe(true)
    }
  })
  it('serial column width takes room; a name column does too', () => {
    const o = mk(7)
    expect(run(o)).toEqual([])
    expect(run(o, { leading: { kind: 'name', names: ['n'.repeat(24)] } }).length).toBeGreaterThan(0)
    const big = { ...o, rows: Array.from({ length: 1 }, () => o.rows[0]) }
    expect(run(big, { leading: { kind: 'serial', rowCount: 10_000_000_000 } }).length).toBeGreaterThan(0)
  })
})

describe('model uses auto breaks unless a block is manual', () => {
  const res = (n: number) => ({ columns: Array.from({ length: n }, (_, i) => ({ name: `column_name_${i}` })), rows: [Array.from({ length: n }, (_, i) => `value ${i}`)], truncated: false, elapsedMs: 1, dbType: 'x' })
  const store = (n: number) => ({
    nb: ref({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'a', type: 'sql', content: '', metadata: {} }] }),
    runs: new Map([['a', { status: 'ok', result: res(n), executedAt: '2026-10-18T00:00:00Z' }]]),
    analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
  }) as any
  const build = (n: number, o: Partial<ExportOptions> = {}) =>
    buildExportModel({ store: store(n), options: { ...DEFAULT_EXPORT_OPTIONS, ...o }, now: new Date(), dataSourceName: () => undefined }).sections[0] as any
  it('auto by default; autoBreaks always reported', () => {
    const t = build(30)
    expect(t.groups.length).toBeGreaterThan(1)
    expect(t.autoBreaks.length).toBe(t.groups.length - 1)
    expect(build(3).groups).toEqual([{ cols: [0, 1, 2] }])
  })
  it('orientation changes the result', () => {
    expect(build(30, { orientation: 'landscape' }).groups.length).toBeLessThan(build(30).groups.length)
  })
  it('manual breaks override, empty manual means no split', () => {
    expect(build(30, { columnBreaks: { a: [4] } }).groups).toHaveLength(2)
    expect(build(30, { columnBreaks: { a: [] } }).groups).toHaveLength(1)
    expect(build(30, { columnBreaks: { a: [] } }).autoBreaks.length).toBeGreaterThan(0)
  })
  it('works on the transposed matrix', () => {
    const s = store(30); const t = buildExportModel({ store: { ...s, transposed: new Map([['a', true]]) }, options: DEFAULT_EXPORT_OPTIONS, now: new Date(), dataSourceName: () => undefined }).sections[0] as any
    expect(t.transposed).toBe(true)
    expect(t.groups).toHaveLength(1)
  })
})

describe('repeat columns in the rendered auto pages', () => {
  const res = { columns: Array.from({ length: 24 }, (_, i) => ({ name: `column_name_${i}` })), rows: [Array.from({ length: 24 }, (_, i) => `value ${i}`)], truncated: false, elapsedMs: 1, dbType: 'x' }
  const store = () => ({
    nb: ref({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'a', type: 'sql', content: '', metadata: {} }] }),
    runs: new Map([['a', { status: 'ok', result: res, executedAt: '2026-10-18T00:00:00Z' }]]),
    analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
  }) as any
  const sec = (o: Partial<ExportOptions>) => buildExportModel({ store: store(), options: { ...DEFAULT_EXPORT_OPTIONS, ...o }, now: new Date(), dataSourceName: () => undefined }).sections[0] as any
  it('reports the repeat count that is actually used', () => {
    expect(sec({ repeatCols: 2 }).repeat).toBe(2)
    expect(sec({ repeatCols: 20 }).repeat).toBe(0)
    expect(sec({ repeatCols: 20, columnBreaks: { a: [3] } }).repeat).toBe(20)
  })
})
