import { describe, it, expect, beforeEach } from 'vitest'
import { buildRenderSpec } from '@sqlnb/format'
import { toChartRows, toHistogramRows } from '../src/analysis/chartRows'
import { setLocale } from '../src/i18n'

beforeEach(() => setLocale('en'))
const columns = [
  { name: 'day', kind: 'temporal' as const }, { name: 'region', kind: 'text' as const }, { name: 'tier', kind: 'text' as const },
  { name: 'amount', kind: 'number' as const }, { name: 'qty', kind: 'number' as const },
]
const lab = { empty: '（空）', measure: (v: any) => (v.field ? `${v.agg} of ${v.field}` : 'count') }
const sum = (field: string) => ({ field, agg: 'sum' as const })
const run = (type: string, rows: string[], values: any[], longRows: unknown[][], cols: string[] = []) => {
  const pivot = { rows: rows.map((field) => ({ field })), columns: cols.map((field) => ({ field })), values }
  const chart = { type } as any
  const spec = (buildRenderSpec({ pivot, chart, columns }) as any).spec
  const out = toChartRows({ dims: [], measures: [], rows: longRows }, pivot, chart, columns, lab) as any[]
  return { spec, out }
}

describe('toChartRows', () => {
  it('bar with two row fields: combined nominal x', () => {
    const { spec, out } = run('bar', ['region', 'tier'], [sum('amount')], [['a', 'x', 5]])
    expect(spec.encoding.x.type).toBe('nominal')
    expect(out).toEqual([{ x: 'a / x', value: 5 }])
  })
  it('scatter with two row fields: quantitative x from the first field only', () => {
    const { spec, out } = run('scatter', ['amount', 'qty'], [sum('qty')], [[3, 4, 9]])
    expect(spec.encoding.x.type).toBe('quantitative')
    expect(out[0].x).toBe(3)
    expect(typeof out[0].x).toBe('number')
  })
  for (const t of ['pie', 'donut']) {
    it(t + ' with two row fields: x is the first field, first measure only', () => {
      const { spec, out } = run(t, ['region', 'tier'], [sum('amount'), sum('qty')], [['a', 'x', 't', 5, 6]], ['tier'])
      expect(spec.encoding.theta ?? spec.encoding.y).toBeDefined()
      expect(out).toEqual([{ x: 'a', value: 5 }])
    })
  }
  it('multi measures + columns build series', () => {
    const { out } = run('bar', ['region'], [sum('amount'), sum('qty')], [['a', 'x', 5, 6]], ['tier'])
    expect(out).toEqual([{ x: 'a', series: 'x · sum of amount', value: 5 }, { x: 'a', series: 'x · sum of qty', value: 6 }])
  })
  it('null x: temporal / quantitative stay null, nominal gets the label', () => {
    expect(run('line', ['day'], [sum('amount')], [[null, 1]]).out[0].x).toBeNull()
    expect(run('line', ['amount'], [sum('qty')], [[null, 1]]).out[0].x).toBeNull()
    expect(run('scatter', ['amount'], [sum('qty')], [[null, 1]]).out[0].x).toBeNull()
    expect(run('bar', ['region'], [sum('amount')], [[null, 1]]).out[0].x).toBe('（空）')
    expect(run('bar', ['region', 'tier'], [sum('amount')], [[null, 'x', 1]]).out[0].x).toBe('（空） / x')
  })
  it('null series gets the label', () => {
    expect(run('bar', ['region'], [sum('amount')], [['a', null, 1]], ['tier']).out[0].series).toBe('（空）')
  })
})

describe('toChartRows compact time axis', () => {
  const go = (grain: string, xs: unknown[], timeAxis: any = 'compact', type = 'bar') => {
    const pivot = { rows: [{ field: 'day', grain }], columns: [], values: [sum('amount')] } as any
    const chart = { type, timeAxis } as any
    return toChartRows({ dims: [], measures: [], rows: xs.map((x, i) => [x, i + 1]) }, pivot, chart, columns, lab) as any[]
  }
  it('adds xLabel per grain and keeps the ISO x', () => {
    expect(go('day', ['2026-03-07T00:00:00.000Z'])[0]).toEqual({ x: '2026-03-07T00:00:00.000Z', xLabel: '2026-03-07', value: 1 })
    expect(go('month', ['2026-03-01 00:00:00'])[0].xLabel).toBe('2026-03')
    expect(go('quarter', ['2026-01-01'])[0].xLabel).toBe('2026-Q1')
    expect(go('quarter', ['2026-10-01'])[0].xLabel).toBe('2026-Q4')
    expect(go('year', ['2026-01-01'])[0].xLabel).toBe('2026')
    expect(go('week', ['2026-03-02'])[0].xLabel).toBe('2026-03-02')
  })
  it('sparse / absent: no xLabel', () => {
    expect(go('month', ['2026-03-01'], 'sparse')[0]).not.toHaveProperty('xLabel')
    expect(go('month', ['2026-03-01'], 'sparse', 'bar')[0]).not.toHaveProperty('xLabel')
  })
  it('no xLabel for other chart types; NULL dates are excluded', () => {
    expect(go('month', ['2026-03-01'], 'compact', 'pie')[0]).not.toHaveProperty('xLabel')
    expect(go('month', [null])).toEqual([])
  })
  it('xLabel sorted by x min is chronological across years (label order == ISO order)', () => {
    const rows = go('month', ['2027-01-01', '2026-11-01', '2026-02-01'])
    const byX = [...rows].sort((a, b) => (a.x < b.x ? -1 : 1)).map((r) => r.xLabel)
    expect(byX).toEqual(['2026-02', '2026-11', '2027-01'])
  })
})


import { resolveLabels } from '../src/analysis/labelResolve'
describe('toChartRows display labels (Plan 13 T9)', () => {
  const ctx = { empty: '（空）', summary: '合计' }
  const go = (pivot: any, longRows: unknown[][], type = 'bar') => {
    const chart = { type } as any
    const resolved = resolveLabels({ pivot, chart }, ctx)
    return toChartRows({ dims: [], measures: [], rows: longRows }, pivot, chart, columns, resolved) as any[]
  }
  const unit = (extra: any = {}) => ({ kind: 'thousands', unit: '万元', scale: 10000, decimals: 1, ...extra })
  it('scale divides plotted values; null/NaN stay null; negative; percent ignored; huge finite', () => {
    const pivot = { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum', format: unit() }] }
    const out = go(pivot, [['a', 125000], ['b', null], ['c', NaN], ['d', -25000], ['e', 1e21]])
    expect(out.map((o) => o.value)).toEqual([12.5, null, null, -2.5, 1e17])
    const pc = go({ ...pivot, values: [{ field: 'amount', agg: 'sum', format: { kind: 'percent', scale: 100 } }] }, [['a', 0.5]])
    expect(pc[0].value).toBe(0.5)
  })
  it('valueText carries scaled formatted text + unit only when unit/scale set', () => {
    const pivot = { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum', format: unit() }] }
    expect(go(pivot, [['a', 125000]])[0].valueText).toBe('12.5万元')
    const plain = go({ ...pivot, values: [{ field: 'amount', agg: 'sum' }] }, [['a', 125000]])
    expect(plain[0]).not.toHaveProperty('valueText')
    expect(go({ ...pivot, values: [{ field: 'amount', agg: 'sum', format: unit({ unit: undefined }) }] }, [['a', 125000]])[0].valueText).toBe('12.5')
  })
  it('categories map via valueLabels, null uses nullLabel, order unchanged, xRaw keeps the raw key', () => {
    const pivot = { rows: [{ field: 'region', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
    const out = go(pivot, [[1, 5], [0, 6], [null, 7], [2, 8]])
    expect(out.map((o) => o.x)).toEqual(['是', '否', '未知', '2'])
    expect(out.map((o) => o.xRaw)).toEqual([1, 0, undefined, 2])
  })
  it('null category without mapping uses ctx.empty, no xRaw', () => {
    const out = go({ rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, [[null, 1]])
    expect(out[0]).toEqual({ x: '（空）', value: 1 })
  })
  it('two raw keys with the same mapped text stay distinct (disambiguated by raw key), no merge', () => {
    const pivot = { rows: [{ field: 'region', valueLabels: { '0': '否', '1': '否' } }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
    const out = go(pivot, [[0, 5], [1, 6], [2, 7]])
    expect(out.map((o) => o.x)).toEqual(['否 (0)', '否 (1)', '2'])
    expect(new Set(out.map((o) => o.x)).size).toBe(3)
  })
  it('column values map for series; measure names resolved for multi-measure', () => {
    const pivot = { rows: [{ field: 'region' }], columns: [{ field: 'tier', valueLabels: { g: '金牌' } }], values: [{ field: 'amount', agg: 'sum', label: '销售额' }, { field: 'qty', agg: 'sum' }] }
    const out = go(pivot, [['a', 'g', 1, 2]])
    expect(out.map((o) => o.series)).toEqual(['金牌 · 销售额', '金牌 · sum(qty)'])
  })
  it('combined x maps each part', () => {
    const pivot = { rows: [{ field: 'region', valueLabels: { a: 'A' } }, { field: 'tier', nullLabel: '无' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
    expect(go(pivot, [['a', null, 1]])[0].x).toBe('A / 无')
  })
  it('histogram rows scale the binned field only', () => {
    const pivot = { rows: [], columns: [], values: [{ field: 'amount', agg: 'sum', format: unit() }] }
    const raw = [{ amount: 125000, qty: 5 }, { amount: null, qty: 1 }, { amount: -25000, qty: 2 }]
    const out = toHistogramRows(raw, pivot as any, { type: 'histogram' } as any, columns)
    expect(out).toEqual([{ amount: 12.5, qty: 5 }, { amount: null, qty: 1 }, { amount: -2.5, qty: 2 }])
    expect(raw[0].amount).toBe(125000)
    expect(toHistogramRows(raw, { ...pivot, values: [{ field: 'amount', agg: 'sum' }] } as any, { type: 'histogram' } as any, columns)).toBe(raw)
  })
})
