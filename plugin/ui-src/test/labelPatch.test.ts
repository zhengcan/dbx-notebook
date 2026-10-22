import { describe, it, expect } from 'vitest'
import { normalizeAnalysis, type ChartOptions, type PivotConfig } from '@sqlnb/format'
import { patchLabel, resetLabels, resetRefOverrides } from '../src/analysis/labelPatch'

const mk = (p: Partial<PivotConfig> = {}, c: Partial<ChartOptions> = {}) => ({
  pivot: { rows: [{ field: 'f' }], columns: [], values: [{ field: 'a', agg: 'sum' as const }], ...p } as PivotConfig,
  chart: { type: 'bar', ...c } as ChartOptions,
})

describe('patchLabel', () => {
  it('category write, remove, whitespace, empty valueLabels dropped', () => {
    const p = patchLabel(mk(), { kind: 'category', axis: 'row', index: 0, key: '0' }, '否')
    expect(p.pivot!.rows![0].valueLabels).toEqual({ '0': '否' })
    const cfg = mk({ rows: [{ field: 'f', valueLabels: { '0': '否', '1': '是' } }] })
    expect(patchLabel(cfg, { kind: 'category', axis: 'row', index: 0, key: '0' }, '').pivot!.rows![0].valueLabels).toEqual({ '1': '是' })
    const one = mk({ rows: [{ field: 'f', valueLabels: { '0': '否' } }] })
    for (const v of ['', '   ', null]) {
      const r = patchLabel(one, { kind: 'category', axis: 'row', index: 0, key: '0' }, v).pivot!.rows![0]
      expect('valueLabels' in r).toBe(false)
    }
  })
  it('caps at 200 code points, markup literal, emoji whole', () => {
    expect(Array.from(patchLabel(mk(), { kind: 'summary' }, 'x'.repeat(300)).pivot!.summaryLabel!)).toHaveLength(200)
    expect(patchLabel(mk(), { kind: 'summary' }, '<b>x</b>').pivot!.summaryLabel).toBe('<b>x</b>')
    const e = '😀'.repeat(300)
    const out = patchLabel(mk(), { kind: 'title' }, e).chartOptions!.title!
    expect(Array.from(out)).toHaveLength(200)
    expect(out).toBe('😀'.repeat(200))
  })
  it('scale parsing', () => {
    const f = patchLabel(mk(), { kind: 'scale', index: 0 }, '10000').pivot!.values![0].format
    expect(f).toEqual({ kind: 'thousands', scale: 10000 })
    for (const bad of ['abc', '0', '-5', 'Infinity', '1e13', '0x10', 'NaN', '1_0', '1,000', '.5e']) expect(patchLabel(mk(), { kind: 'scale', index: 0 }, bad)).toEqual({})
    const cfg = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'thousands', scale: 5, decimals: 1 } }] })
    expect(patchLabel(cfg, { kind: 'scale', index: 0 }, '').pivot!.values![0].format).toEqual({ kind: 'thousands', decimals: 1 })
  })
  it('unit on percent writes, scale on percent no-op, unit capped 20', () => {
    const cfg = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'percent' } }] })
    expect(patchLabel(cfg, { kind: 'unit', index: 0 }, 'pt').pivot!.values![0].format).toEqual({ kind: 'percent', unit: 'pt' })
    expect(patchLabel(cfg, { kind: 'scale', index: 0 }, '10')).toEqual({})
    expect(patchLabel(mk(), { kind: 'unit', index: 0 }, 'u'.repeat(50)).pivot!.values![0].format!.unit).toHaveLength(20)
  })
  it('axis merges and clears; stale index no-op', () => {
    const cfg = mk({}, { axisTitles: { x: 'X', y: 'Y' } })
    expect(patchLabel(cfg, { kind: 'axis', axis: 'x' }, null).chartOptions!.axisTitles).toEqual({ y: 'Y' })
    expect(patchLabel(mk({}, { axisTitles: { x: 'X' } }), { kind: 'axis', axis: 'x' }, ' ').chartOptions!.axisTitles).toBeUndefined()
    expect(patchLabel(cfg, { kind: 'axis', axis: 'legend' }, 'L').chartOptions!.axisTitles).toEqual({ x: 'X', y: 'Y', legend: 'L' })
    expect(patchLabel(mk(), { kind: 'rowName', index: 4 }, 'x')).toEqual({})
    expect(patchLabel(mk(), { kind: 'measureName', index: 4 }, 'x')).toEqual({})
  })
  it('does not mutate input; other refs untouched; __proto__ key stored as data', () => {
    const cfg = mk({ rows: [{ field: 'f' }, { field: 'g', label: 'G' }] })
    const snap = JSON.stringify(cfg)
    const p = patchLabel(cfg, { kind: 'rowName', index: 0 }, '渠道')
    expect(JSON.stringify(cfg)).toBe(snap)
    expect(p.pivot!.rows).toEqual([{ field: 'f', label: '渠道' }, { field: 'g', label: 'G' }])
    const q = patchLabel(cfg, { kind: 'category', axis: 'row', index: 0, key: '__proto__' }, 'P')
    expect(Object.keys(q.pivot!.rows![0].valueLabels!)).toEqual(['__proto__'])
  })
  it('round trips through normalizeAnalysis', () => {
    const cfg = mk()
    const p = patchLabel(cfg, { kind: 'category', axis: 'row', index: 0, key: '1' }, '是')
    const q = patchLabel({ pivot: { ...cfg.pivot, ...p.pivot }, chart: cfg.chart }, { kind: 'unit', index: 0 }, '万元')
    const pivot = { ...cfg.pivot, ...p.pivot, ...q.pivot }
    const n = normalizeAnalysis({ pivot, chartOptions: cfg.chart })
    expect(n.pivot!.rows[0].valueLabels).toEqual({ '1': '是' })
    expect(n.pivot!.values[0].format!.unit).toBe('万元')
  })
})

describe('patchLabel minors', () => {
  const f = (p: ReturnType<typeof patchLabel>) => p.pivot!.values![0].format
  it('no-op clears on a measure without format', () => {
    expect(patchLabel(mk(), { kind: 'unit', index: 0 }, '')).toEqual({})
    expect(patchLabel(mk(), { kind: 'scale', index: 0 }, null)).toEqual({})
  })
  it('clearing last unit/scale removes default format, keeps non-default', () => {
    const a = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'thousands', unit: 'u' } }] })
    expect('format' in patchLabel(a, { kind: 'unit', index: 0 }, '').pivot!.values![0]).toBe(false)
    const b = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'thousands', scale: 5 } }] })
    expect('format' in patchLabel(b, { kind: 'scale', index: 0 }, ' ').pivot!.values![0]).toBe(false)
    const c = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'plain', unit: 'u' } }] })
    expect(f(patchLabel(c, { kind: 'unit', index: 0 }, ''))).toEqual({ kind: 'plain' })
    const d = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'thousands', decimals: 1, unit: 'u' } }] })
    expect(f(patchLabel(d, { kind: 'unit', index: 0 }, ''))).toEqual({ kind: 'thousands', decimals: 1 })
  })
  it('scale accepts decimals and exponent', () => {
    expect(f(patchLabel(mk(), { kind: 'scale', index: 0 }, ' +1.5e3 '))!.scale).toBe(1500)
    expect(f(patchLabel(mk(), { kind: 'scale', index: 0 }, '1E4'))!.scale).toBe(10000)
  })
  it('nullLabel set and clear', () => {
    const t = { kind: 'nullLabel', axis: 'column', index: 0 } as const
    const cfg = mk({ columns: [{ field: 'c' }] })
    const set = patchLabel(cfg, t, '未知').pivot!.columns![0]
    expect(set).toEqual({ field: 'c', nullLabel: '未知' })
    const cleared = patchLabel(mk({ columns: [set] }), t, '').pivot!.columns![0]
    expect(cleared).toEqual({ field: 'c' })
    expect('nullLabel' in cleared).toBe(false)
  })
  it('columnName, measureName, summary, title set and clear', () => {
    const cfg = mk({ columns: [{ field: 'c' }], summaryLabel: 'S' }, { title: 'T' })
    expect(patchLabel(cfg, { kind: 'columnName', index: 0 }, 'C').pivot!.columns).toEqual([{ field: 'c', label: 'C' }])
    expect(patchLabel(cfg, { kind: 'measureName', index: 0 }, 'M').pivot!.values![0].label).toBe('M')
    const m = mk({ values: [{ field: 'a', agg: 'sum', label: 'M' }] })
    expect('label' in patchLabel(m, { kind: 'measureName', index: 0 }, null).pivot!.values![0]).toBe(false)
    expect(patchLabel(cfg, { kind: 'summary' }, '').pivot).toEqual({ summaryLabel: undefined })
    expect(patchLabel(cfg, { kind: 'title' }, ' ').chartOptions).toEqual({ title: undefined })
    expect(patchLabel(cfg, { kind: 'title' }, 'N').chartOptions).toEqual({ title: 'N' })
  })
})

describe('resetRefOverrides', () => {
  const old = { field: 'a', grain: 'day', label: 'L', nullLabel: 'N', valueLabels: { x: 'X' }, extra: 1 } as never
  it('field change drops label, nullLabel, valueLabels', () => {
    const o = JSON.stringify(old)
    const r = resetRefOverrides(old, { field: 'b', grain: 'day' } as never)
    expect(r).toEqual({ field: 'b', grain: 'day' })
    expect(JSON.stringify(old)).toBe(o)
  })
  it('field change drops overrides even if newRef carries them', () => {
    expect(resetRefOverrides(old, { field: 'b', label: 'Z', valueLabels: { q: 'Q' }, nullLabel: 'n' } as never)).toEqual({ field: 'b' })
  })
  it('grain change keeps label/nullLabel, drops valueLabels, takes newRef props', () => {
    const nr = { field: 'a', grain: 'month', label: 'L', nullLabel: 'N', valueLabels: { x: 'X' }, extra: 1 } as never
    const r = resetRefOverrides(old, nr)
    expect(r).toEqual({ field: 'a', grain: 'month', label: 'L', nullLabel: 'N', extra: 1 })
    expect('valueLabels' in r).toBe(false)
  })
  it('same-field keeps old label/nullLabel when newRef lacks them', () => {
    expect(resetRefOverrides(old, { field: 'a', grain: 'month' } as never)).toEqual({ field: 'a', grain: 'month', label: 'L', nullLabel: 'N' })
  })
  it('identical ref unchanged', () => {
    const r = resetRefOverrides(old, { ...(old as object) } as never)
    expect(r).toEqual(old)
    expect(r).not.toBe(old)
  })
  it('undefined oldRef returns copy of newRef', () => {
    const nr = { field: 'a', label: 'L', valueLabels: { x: 'X' } }
    const r = resetRefOverrides(undefined, nr)
    expect(r).toEqual(nr)
    expect(r.valueLabels).not.toBe(nr.valueLabels)
  })
  it('__proto__-ish keys safe and preserved when unchanged', () => {
    const vl = Object.defineProperty({}, '__proto__', { value: 'P', enumerable: true, configurable: true, writable: true }) as Record<string, string>
    const nr = { field: 'a', valueLabels: vl }
    const r = resetRefOverrides({ field: 'a', valueLabels: vl }, nr)
    expect(Object.keys(r.valueLabels!)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(r.valueLabels)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('resetLabels', () => {
  const full = () => mk(
    {
      rows: [{ field: 'f', label: 'F', nullLabel: 'N', valueLabels: { a: 'A', b: 'B' }, sort: 'asc' } as any],
      columns: [{ field: 'g', label: 'G', valueLabels: { x: 'X' } } as any],
      values: [{ field: 'a', agg: 'sum', label: 'M', format: { kind: 'thousands', unit: '元', scale: 100 } } as any],
      summaryLabel: 'S',
      showRowTotals: true,
    } as any,
    { type: 'bar', title: 'T', axisTitles: { x: 'X', y: 'Y', legend: 'L' }, stacked: true } as any,
  )
  const apply = (cfg: ReturnType<typeof mk>, p: ReturnType<typeof resetLabels>) => ({ pivot: { ...cfg.pivot, ...(p.pivot ?? {}) }, chart: { ...cfg.chart, ...(p.chartOptions ?? {}) } })
  it("'all' equals the cfg with every label field removed and keeps non-label fields", () => {
    const c = full()
    const out = apply(c, resetLabels(c, 'all')) as any
    expect(out.pivot.rows[0]).toEqual({ field: 'f', sort: 'asc' })
    expect(out.pivot.columns[0]).toEqual({ field: 'g' })
    expect(out.pivot.values[0]).toEqual({ field: 'a', agg: 'sum' })
    expect('summaryLabel' in out.pivot && out.pivot.summaryLabel !== undefined).toBe(false)
    expect(out.pivot.showRowTotals).toBe(true)
    expect(out.chart.title).toBeUndefined()
    expect(out.chart.axisTitles).toBeUndefined()
    expect(out.chart.stacked).toBe(true)
  })
  it('tab scopes touch only their own tab', () => {
    const c = full()
    const table = apply(c, resetLabels(c, 'table')) as any
    expect(table.pivot.rows[0].label).toBeUndefined()
    expect(table.pivot.rows[0].nullLabel).toBe('N')
    expect(table.pivot.values[0].label).toBeUndefined()
    expect(table.pivot.summaryLabel).toBeUndefined()
    expect(table.pivot.values[0].format.unit).toBe('元')
    expect(table.chart.title).toBe('T')
    const cats = apply(c, resetLabels(c, 'categories')) as any
    expect(cats.pivot.rows[0].valueLabels).toBeUndefined()
    expect(cats.pivot.rows[0].nullLabel).toBeUndefined()
    expect(cats.pivot.rows[0].label).toBe('F')
    const units = apply(c, resetLabels(c, 'numbers')) as any
    expect(units.pivot.values[0].format).toBeUndefined()
    expect(units.pivot.values[0].label).toBe('M')
    const chart = apply(c, resetLabels(c, 'chart')) as any
    expect(chart.chart.title).toBeUndefined()
    expect(chart.pivot.summaryLabel).toBe('S')
  })
  it('nothing overridden gives an empty patch', () => {
    expect(resetLabels(mk(), 'all')).toEqual({})
  })
})

import { countOverrides, type ScopeKey } from '../src/analysis/labelPatch'
import { isOverridden, type LabelTarget } from '../src/analysis/labelResolve'
import { tabOf, TAB_KEYS } from '../src/analysis/labelTabs'

// Independent enumeration of every possible target of a cfg (incl. valueLabels keys not in the data).
const enumerate = (cfg: ReturnType<typeof mk>): LabelTarget[] => {
  const out: LabelTarget[] = [{ kind: 'summary' }, { kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }]
  cfg.pivot.rows?.forEach((r, index) => { out.push({ kind: 'rowName', index }, { kind: 'nullLabel', axis: 'row', index }); Object.keys(r.valueLabels ?? {}).forEach((key) => out.push({ kind: 'category', axis: 'row', index, key })) })
  cfg.pivot.columns?.forEach((r, index) => { out.push({ kind: 'columnName', index }, { kind: 'nullLabel', axis: 'column', index }); Object.keys(r.valueLabels ?? {}).forEach((key) => out.push({ kind: 'category', axis: 'column', index, key })) })
  cfg.pivot.values?.forEach((_, index) => out.push({ kind: 'measureName', index }, { kind: 'unit', index }, { kind: 'scale', index }))
  return out
}
const apply = (cfg: ReturnType<typeof mk>, p: { pivot?: Partial<PivotConfig>; chartOptions?: Partial<ChartOptions> }) => ({ pivot: { ...cfg.pivot, ...(p.pivot ?? {}) } as PivotConfig, chart: { ...cfg.chart, ...(p.chartOptions ?? {}) } as ChartOptions })
const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, `V${i}`]))
const configs = {
  full: mk({
    rows: [{ field: 'r1', label: 'R1', nullLabel: '空', valueLabels: { a: 'A', b: 'B', gone: 'G' } }, { field: 'r2', label: 'R2' }],
    columns: [{ field: 'c1', label: 'C1', valueLabels: { x: 'X' } }, { field: 'c2', label: 'C2', nullLabel: 'N' }],
    values: [{ field: 'm1', agg: 'sum', label: 'M1', format: { kind: 'thousands', unit: '元', scale: 100 } }, { field: 'm2', agg: 'sum', label: 'M2', format: { kind: 'thousands', unit: '%' } }],
    summaryLabel: 'S',
  }, { title: 'T', axisTitles: { x: 'X', y: 'Y', legend: 'L' } }),
  many: mk({ rows: [{ field: 'f', valueLabels: many }] }),
  k70: mk({ rows: [{ field: 'f', valueLabels: { k70: 'seventy' } }] }),
  nullOnly: mk({ columns: [{ field: 'c', nullLabel: '空' }] }),
  none: mk(),
}

describe('per-tab scopes', () => {
  for (const [name, cfg] of Object.entries(configs)) {
    it(`${name}: tab counts sum to total and match independent enumeration`, () => {
      const sum = TAB_KEYS.reduce((n, k) => n + countOverrides(cfg, k), 0)
      expect(sum).toBe(countOverrides(cfg, 'all'))
      for (const k of TAB_KEYS) expect(countOverrides(cfg, k)).toBe(enumerate(cfg).filter((t) => tabOf(t) === k && isOverridden(cfg, t)).length)
    })
    for (const k of TAB_KEYS) {
      it(`${name}: reset ${k} removes exactly the counted overrides`, () => {
        const before = enumerate(cfg).map((t) => isOverridden(cfg, t))
        const next = apply(cfg, resetLabels(cfg, k))
        enumerate(cfg).forEach((t, i) => expect(isOverridden(next, t)).toBe(tabOf(t) === k ? false : before[i]))
        expect(countOverrides(next, k)).toBe(0)
        expect(countOverrides(cfg, 'all') - countOverrides(next, 'all')).toBe(countOverrides(cfg, k))
      })
    }
  }
  it('reset table is one patch', () => {
    const cfg = configs.full
    const p = resetLabels(cfg, 'table')
    expect(p.pivot).toBeTruthy(); expect(p.chartOptions).toBeUndefined()
  })
  it('tab scopes are disjoint: counts sum to total', () => {
    const cfg = configs.full
    const tabs: ScopeKey[] = ['table', 'chart', 'numbers', 'categories']
    expect(tabs.reduce((a, k) => a + countOverrides(cfg, k), 0)).toBe(countOverrides(cfg, 'all'))
    const each = tabs.map((k) => countOverrides(cfg, k))
    expect(each.every((n) => n > 0)).toBe(true)
  })
})
