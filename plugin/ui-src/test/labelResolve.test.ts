import { describe, it, expect } from 'vitest'
import type { ChartOptions, PivotConfig } from '@sqlnb/format'
import { resolveLabels, autoLabels, isOverridden } from '../src/analysis/labelResolve'

const ctx = { empty: '（空）', summary: '汇总' }
const mk = (p: Partial<PivotConfig> = {}, c: Partial<ChartOptions> = {}) => ({
  pivot: { rows: [{ field: 'channel' }], columns: [], values: [{ field: 'amount', agg: 'sum' as const }], ...p } as PivotConfig,
  chart: { type: 'bar', ...c } as ChartOptions,
})

describe('resolveLabels', () => {
  it('auto labels equal today\'s text', () => {
    const r = resolveLabels(mk(), ctx)
    expect(r.rowNames).toEqual(['channel'])
    expect(r.measureNames).toEqual(['sum(amount)'])
    expect(r.summary).toBe('汇总')
    expect(r.title).toBe('')
    expect(r.category('row', 0, null)).toBe('（空）')
    expect(r.category('row', 0, 'x')).toBe('x')
  })
  it('overrides win', () => {
    const r = resolveLabels(mk({ rows: [{ field: 'channel', label: '渠道' }], values: [{ field: 'amount', agg: 'sum', label: '销售额' }], summaryLabel: '合计' }, { title: 'Q3 销售' }), ctx)
    expect([r.rowNames, r.measureNames, r.summary, r.title]).toEqual([['渠道'], ['销售额'], '合计', 'Q3 销售'])
  })
  it('category mapping', () => {
    const r = resolveLabels(mk({ rows: [{ field: 'f', valueLabels: { '0': '否', '1': '是', true: '是', null: 'NN' }, nullLabel: '未知' }] }), ctx)
    expect(r.category('row', 0, 0)).toBe('否')
    expect(r.category('row', 0, '0')).toBe('否')
    expect(r.category('row', 0, 1)).toBe('是')
    expect(r.category('row', 0, true)).toBe('是')
    expect(r.category('row', 0, null)).toBe('未知')
    expect(r.category('row', 0, 2)).toBe('2')
    expect(r.category('row', 0, 'null')).toBe('NN')
    expect(r.category('row', 0, 'null')).not.toBe('未知')
  })
  it('real string "null" unaffected by nullLabel; prototype keys safe', () => {
    const r = resolveLabels(mk({ rows: [{ field: 'f', nullLabel: '未知' }] }), ctx)
    expect(r.category('row', 0, 'null')).toBe('null')
    expect(r.category('row', 0, 'constructor')).toBe('constructor')
    expect(r.category('row', 0, '__proto__')).toBe('__proto__')
  })
  it('stale/out-of-range refs ignored, no crash', () => {
    const r = resolveLabels(mk(), ctx)
    expect(r.category('column', 3, 'a')).toBe('a')
    expect(r.category('column', 3, null)).toBe('（空）')
    expect(r.format(9)).toEqual({ kind: 'thousands' })
  })
  it('axis follows header and unit', () => {
    const base = { rows: [{ field: 'channel', label: '渠道' }], values: [{ field: 'amount', agg: 'sum' as const, label: '销售额', format: { kind: 'thousands' as const, decimals: 2, unit: '万元', scale: 10000 } }] }
    const r = resolveLabels(mk(base), ctx)
    expect(r.axis.x).toBe('渠道')
    expect(r.axis.y).toBe('销售额（万元）')
    expect(r.format(0)).toEqual({ kind: 'thousands', decimals: 2, unit: '万元', scale: 10000 })
    const o = resolveLabels(mk(base, { axisTitles: { x: 'X', y: 'Y' } }), ctx)
    expect([o.axis.x, o.axis.y]).toEqual(['X', 'Y'])
    const multi = resolveLabels(mk({ values: [base.values[0], { field: 'b', agg: 'count' }] }), ctx)
    expect(multi.axis.y).toBe('value')
    expect(autoLabels(mk({ values: [base.values[0], { field: 'b', agg: 'count' }] }), ctx).axis.y).toBe('value')
    expect(resolveLabels(mk({ values: [base.values[0], { field: 'b', agg: 'count' }] }, { axisTitles: { y: 'Y' } }), ctx).axis.y).toBe('Y')
  })
  it('percent ignores scale in resolved format', () => {
    const r = resolveLabels(mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'percent', scale: 100, unit: 'pt' } }] }), ctx)
    expect(r.format(0)).toEqual({ kind: 'percent', unit: 'pt' })
  })
  it('duplicate field in rows and columns resolved independently', () => {
    const r = resolveLabels(mk({ rows: [{ field: 'c', label: 'R', valueLabels: { a: 'RA' } }], columns: [{ field: 'c', label: 'C', valueLabels: { a: 'CA' } }] }), ctx)
    expect([r.rowNames[0], r.columnNames[0], r.category('row', 0, 'a'), r.category('column', 0, 'a')]).toEqual(['R', 'C', 'RA', 'CA'])
  })
  it('autoLabels ignores overrides', () => {
    const cfg = mk({ rows: [{ field: 'c', label: 'R', valueLabels: { a: 'RA' }, nullLabel: 'N' }], values: [{ field: 'v', agg: 'sum', label: 'M', format: { kind: 'thousands', decimals: 1, unit: 'u', scale: 10 } }], summaryLabel: 'S' }, { title: 'T', axisTitles: { x: 'X' } })
    const a = autoLabels(cfg, ctx)
    expect([a.rowNames, a.measureNames, a.summary, a.title, a.axis.x, a.category('row', 0, 'a'), a.category('row', 0, null)]).toEqual([['c'], ['sum(v)'], '汇总', '', 'c', 'a', '（空）'])
    expect(a.format(0)).toEqual({ kind: 'thousands', decimals: 1 })
  })
  it('blank overrides mean auto; text passes through untouched', () => {
    const wild = '<img src=x onerror=1> مرحبا 😀'.repeat(50)
    const r = resolveLabels(mk({ rows: [{ field: 'c', label: '  ', valueLabels: { a: wild } }], summaryLabel: ' ' }), ctx)
    expect(r.rowNames).toEqual(['c'])
    expect(r.summary).toBe('汇总')
    expect(r.category('row', 0, 'a')).toBe(wild)
  })
  it('does not mutate input', () => {
    const cfg = mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'percent', scale: 5 } }] })
    const snap = JSON.stringify(cfg)
    resolveLabels(cfg, ctx); autoLabels(cfg, ctx)
    expect(JSON.stringify(cfg)).toBe(snap)
  })
  it('raw values are never altered: category/format are descriptors only', () => {
    const r = resolveLabels(mk({ values: [{ field: 'a', agg: 'sum', format: { kind: 'thousands', scale: 10000 } }] }), ctx)
    expect(r.category('row', 0, 12345)).toBe('12345')
    expect(r.format(0).scale).toBe(10000)
  })
})

describe('isOverridden', () => {
  const cfg = mk({ rows: [{ field: 'c', label: 'R', valueLabels: { a: 'A' }, nullLabel: 'N' }], columns: [{ field: 'd' }], values: [{ field: 'v', agg: 'sum', label: 'M', format: { kind: 'thousands', unit: 'u', scale: 2 } }], summaryLabel: 'S' }, { title: 'T', axisTitles: { x: 'X' } })
  it('true for set', () => {
    for (const t of [
      { kind: 'rowName', index: 0 }, { kind: 'measureName', index: 0 }, { kind: 'summary' }, { kind: 'title' },
      { kind: 'axis', axis: 'x' }, { kind: 'unit', index: 0 }, { kind: 'scale', index: 0 },
      { kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'nullLabel', axis: 'row', index: 0 },
    ] as const) expect(isOverridden(cfg, t)).toBe(true)
  })
  it('false for unset, stale and percent scale', () => {
    for (const t of [
      { kind: 'columnName', index: 0 }, { kind: 'rowName', index: 5 }, { kind: 'axis', axis: 'y' },
      { kind: 'category', axis: 'row', index: 0, key: 'zz' }, { kind: 'category', axis: 'row', index: 0, key: 'constructor' },
      { kind: 'nullLabel', axis: 'column', index: 0 }, { kind: 'unit', index: 3 },
    ] as const) expect(isOverridden(cfg, t)).toBe(false)
    expect(isOverridden(mk({ values: [{ field: 'v', agg: 'sum', format: { kind: 'percent', scale: 2 } }] }), { kind: 'scale', index: 0 })).toBe(false)
  })
})
