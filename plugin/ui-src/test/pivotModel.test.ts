import { describe, it, expect, afterEach } from 'vitest'
import { setLocale } from '../src/i18n'
import { buildPivotModel, formatValue, toTsv, EMPTY_LABEL } from '../src/analysis/pivotModel'
import type { AnalysisResult } from '../src/analysis/analysisState'
import type { PivotConfig } from '@sqlnb/format'

const f = (r: number, c: number, v: number) => ({ rows: Array.from({ length: r }, (_, i) => ({ field: 'r' + i })), columns: Array.from({ length: c }, (_, i) => ({ field: 'c' + i })), values: Array.from({ length: v }, (_, i) => ({ field: 'v' + i, agg: 'sum' as const, label: 'M' + i })) }) as PivotConfig
const res = (rows: unknown[][], _unused?: undefined, nd = 2, nm = 1): AnalysisResult => ({
  status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x',
  long: { dims: Array.from({ length: nd }, (_, i) => 'd' + i), measures: Array.from({ length: nm }, (_, i) => 'v' + i), rows },
})

describe('buildPivotModel', () => {
  it('orders mixed-type keys totally and survives bigint', () => {
    const rows = [[10, 1], ['9', 1], [2, 1], ['b', 1], [1n, 1]]
    const a = buildPivotModel(res(rows, undefined, 1), f(1, 0, 1))
    const b = buildPivotModel(res([...rows].reverse(), undefined, 1), f(1, 0, 1))
    expect(a.rowLabels.map((r) => r[0])).toEqual(['1', '2', '10', '9', 'b'])
    expect(b.rowLabels).toEqual(a.rowLabels)
  })

  it('single row/col/value', () => {
    const m = buildPivotModel(res([['b', 'y', 2], ['a', 'x', 1], ['a', 'y', 3]]), f(1, 1, 1))
    expect(m.rowHeaders).toEqual(['r0'])
    expect(m.rowLabels).toEqual([['a'], ['b']])
    expect(m.columnHeaders).toEqual([['x', 'M0'], ['y', 'M0']])
    expect(m.cells).toEqual([[1, 3], [null, 2]])
    expect(m.truncated).toEqual({ rows: false, columns: false })
  })
  it('multi-level rows and columns', () => {
    const m = buildPivotModel(res([['a', 'p', 'x', 'u', 1], ['a', 'q', 'x', 'v', 2], ['b', 'p', 'x', 'u', 3]], undefined, 4), f(2, 2, 1))
    expect(m.rowLabels).toEqual([['a', 'p'], ['a', 'q'], ['b', 'p']])
    expect(m.columnHeaders).toEqual([['x', 'u', 'M0'], ['x', 'v', 'M0']])
    expect(m.cells).toEqual([[1, null], [null, 2], [3, null]])
  })
  it('multiple measures expand innermost', () => {
    const m = buildPivotModel(res([['a', 'x', 1, 10], ['a', 'y', 2, 20]], undefined, 2, 2), f(1, 1, 2))
    expect(m.columnHeaders).toEqual([['x', 'M0'], ['x', 'M1'], ['y', 'M0'], ['y', 'M1']])
    expect(m.cells).toEqual([[1, 10, 2, 20]])
    expect(m.measures.map((x) => x.label)).toEqual(['M0', 'M1'])
  })
  afterEach(() => setLocale('en'))
  it('NULL keys last', () => {
    setLocale('zh-CN')
    const m = buildPivotModel(res([[null, 'x', 1], ['b', null, 2], ['a', 'x', 3]]), f(1, 1, 1))
    expect(m.rowLabels).toEqual([['a'], ['b'], [EMPTY_LABEL]])
    expect(m.columnHeaders.map((h) => h[0])).toEqual(['x', EMPTY_LABEL])
    expect(buildPivotModel(res([[null, 1]], undefined, 1), f(1, 0, 1), { labels: { empty: '(empty)', summary: 'Summary' } }).rowLabels).toEqual([['(empty)']])
  })
  const rows = [['a', 'x', 5], ['b', 'x', 9], ['c', 'x', 1], ['d', 'x', 7]]
  it('sort by name / value, asc / desc', () => {
    const names = (sort: PivotConfig['sort']) => buildPivotModel(res(rows), { ...f(1, 1, 1), sort }).rowLabels.map((r) => r[0])
    expect(names({ by: 'name', dir: 'desc' })).toEqual(['d', 'c', 'b', 'a'])
    expect(names({ by: 'value', valueIndex: 0, dir: 'asc' })).toEqual(['c', 'a', 'd', 'b'])
    expect(names({ by: 'value', valueIndex: 0, dir: 'desc' })).toEqual(['b', 'd', 'a', 'c'])
  })
  it('sort only reorders outermost groups; inner levels keep name order', () => {
    const r = [['a', 'q', 'x', 1], ['a', 'p', 'x', 1], ['b', 'z', 'x', 5], ['b', 'y', 'x', 5]]
    const m = buildPivotModel(res(r, undefined, 3), { ...f(2, 1, 1), sort: { by: 'value', valueIndex: 0, dir: 'desc' } })
    expect(m.rowLabels).toEqual([['b', 'y'], ['b', 'z'], ['a', 'p'], ['a', 'q']])
  })
  describe('summaries', () => {
    const data = [['a', 'x', 1], ['a', 'y', 6], ['b', 'x', 3]]
    const cfg = (summary: any, extra: Partial<PivotConfig> = {}): PivotConfig => ({
      ...f(1, 1, 1), totals: { row: true, column: true, grand: true },
      values: [{ field: 'v0', agg: 'sum', label: 'M0', ...(summary ? { summary } : {}) }], ...extra,
    })
    const cases: [string, number[], number[], number][] = [
      ['sum', [7, 3], [4, 6], 10], ['count', [2, 1], [2, 1], 3], ['avg', [3.5, 3], [2, 6], 10 / 3],
      ['min', [1, 3], [1, 6], 1], ['max', [6, 3], [3, 6], 6], ['median', [3.5, 3], [2, 6], 3],
    ]
    for (const [name, row, col, grand] of cases) {
      it(`${name} over the displayed cells, nulls ignored`, () => {
        const m = buildPivotModel(res(data), cfg(name))
        expect(m.rowTotals!.map((r) => r[0])).toEqual(row)
        expect(m.columnTotals).toEqual(col)
        expect(m.grandTotal![0]).toBeCloseTo(grand, 9)
        expect(m.cells).toEqual([[1, 6], [3, null]])
      })
    }
    it('per-value different methods in one table', () => {
      const m = buildPivotModel(res([['a', 'x', 1, 10], ['a', 'y', 3, 20], ['b', 'x', 5, 30]], undefined, 2, 2), cfg(undefined, {
        values: [{ field: 'v0', agg: 'sum', label: 'M0', summary: 'max' }, { field: 'v1', agg: 'sum', label: 'M1', summary: 'avg' }],
      }))
      expect(m.rowTotals).toEqual([[3, 15], [5, 30]])
      expect(m.columnTotals).toEqual([5, 20, 3, 20])
      expect(m.grandTotal).toEqual([5, 20])
      expect(m.measures.map((x) => x.summary)).toEqual(['max', 'avg'])
    })
    it('skip one value: blank cells for it', () => {
      const m = buildPivotModel(res([['a', 'x', 1, 10], ['a', 'y', 3, 20]], undefined, 2, 2), cfg(undefined, {
        values: [{ field: 'v0', agg: 'sum', label: 'M0', summary: 'none' }, { field: 'v1', agg: 'sum', label: 'M1' }],
      }))
      expect(m.rowTotals).toEqual([[null, 30]])
      expect(m.columnTotals).toEqual([null, 10, null, 20])
      expect(m.grandTotal).toEqual([null, 30])
    })
    it('all skipped: the summary column/row/cell stay (blank) so the method can be changed back', () => {
      const m = buildPivotModel(res(data), cfg('none'))
      expect(m.rowTotals).toEqual([[null], [null]]); expect(m.columnTotals).toEqual([null, null]); expect(m.grandTotal).toEqual([null])
    })
    it('defaults follow the aggregate family', () => {
      const dflt = (agg: any) => buildPivotModel(res([['a', 'x', 1], ['a', 'y', 5]]), cfg(undefined, { values: [{ field: 'v0', agg }] })).measures[0].summary
      expect(['sum', 'count', 'countDistinct', 'avg', 'min', 'max', 'median'].map(dflt)).toEqual(['sum', 'sum', 'sum', 'avg', 'min', 'max', 'median'])
      const m = buildPivotModel(res([['a', 'x', 1], ['a', 'y', 5]]), cfg(undefined, { values: [{ field: 'v0', agg: 'avg' }] }))
      expect(m.rowTotals).toEqual([[3]])
    })
    it('no column fields: no row-summary column, but the column-summary row is there', () => {
      const m = buildPivotModel(res([['a', 1], ['b', 4]], undefined, 1), { ...cfg('sum'), columns: [] })
      expect(m.rowTotals).toBeUndefined()
      expect(m.columnTotals).toEqual([5])
    })
    it('no row fields: no footer, but the row-summary column is there', () => {
      const m = buildPivotModel(res([['x', 1], ['y', 4]], undefined, 1), { ...cfg('sum'), rows: [] })
      expect(m.columnTotals).toBeUndefined()
      expect(m.rowTotals).toEqual([[5]])
    })
    it('neither row nor column fields: nothing', () => {
      const m = buildPivotModel(res([[7]], undefined, 0), { ...cfg('sum'), rows: [], columns: [] })
      expect(m.rowTotals).toBeUndefined(); expect(m.columnTotals).toBeUndefined(); expect(m.grandTotal).toBeUndefined()
    })
    it('toggles off give nothing', () => {
      const m = buildPivotModel(res(data), cfg('sum', { totals: { row: false } }))
      expect(m.rowTotals).toBeUndefined(); expect(m.columnTotals).toBeUndefined(); expect(m.grandTotal).toBeUndefined()
    })
    it('truncated tables summarise only the displayed part', () => {
      const many = Array.from({ length: 5001 }, (_, i) => [String(i).padStart(5, '0'), 'x', 1])
      const m = buildPivotModel(res(many), cfg('sum'))
      expect(m.truncated.rows).toBe(true)
      expect(m.columnTotals).toEqual([5000])
      expect(m.grandTotal).toEqual([5000])
    })
    describe('sort by value scores groups with the measure summary', () => {
      const order = (rows: unknown[][], summary: any, agg: any = 'sum') => {
        const c = { ...cfg(summary, { values: [{ field: 'v0', agg, label: 'M0', ...(summary ? { summary } : {}) }] }), sort: { by: 'value', valueIndex: 0, dir: 'desc' } as const }
        const m = buildPivotModel(res(rows), c)
        return { names: m.rowLabels.map((r) => r[0]), rt: m.rowTotals?.map((r) => r[0]) }
      }
      const avgRows = [['a', 'x', 6], ['b', 'x', 4], ['b', 'y', 4], ['c', 'x', 1], ['c', 'y', 1], ['c', 'z', 1]]
      const rows3 = [['a', 'x', 1], ['a', 'y', 1], ['a', 'z', 13], ['b', 'x', 4], ['b', 'y', 4], ['b', 'z', 4], ['c', 'x', 2], ['c', 'y', 3], ['c', 'z', 5]]
      it('avg', () => {
        const r = order(avgRows, 'avg', 'avg')
        expect(r.names).toEqual(['a', 'b', 'c'])
        expect(r.rt).toEqual([6, 4, 1])
      })
      it('min', () => {
        const r = order(rows3, 'min', 'min')
        expect(r.names).toEqual(['b', 'c', 'a'])
        expect(r.rt).toEqual([4, 2, 1])
      })
      it('median', () => {
        const r = order(rows3, 'median', 'median')
        expect(r.names).toEqual(['b', 'c', 'a'])
        expect(r.rt).toEqual([4, 3, 1])
      })
      it('summary none falls back to the aggregate family for sorting only', () => {
        const r = order(avgRows, 'none', 'avg')
        expect(r.names).toEqual(['a', 'b', 'c'])
        expect(r.rt).toEqual([null, null, null])
      })
      it('sum aggregate still sorts by sum', () => {
        expect(order(avgRows, undefined, 'sum').names).toEqual(['b', 'a', 'c'])
      })
    })
    describe('sort by value with summary count', () => {
      const run = (rows: unknown[][], dir: 'asc' | 'desc', cols: boolean, nd = 1) => {
        const c = { rows: [{ field: 'r0' }], columns: cols ? [{ field: 'c0' }] : [], values: [{ field: 'v0', agg: 'count' as const, label: 'M0', summary: 'count' as const }], sort: { by: 'value' as const, valueIndex: 0, dir } } as PivotConfig
        const m = buildPivotModel(res(rows, undefined, nd), c)
        return { names: m.rowLabels.map((r) => r[0]), cells: m.cells.map((r) => r[0]) }
      }
      const user = [['k1', 6], ['k2', 1], ['k3', 0], ['k4', 16], ['k5', 0]]
      it('no column field: orders by the cell value (asc)', () => {
        expect(run(user, 'asc', false).cells).toEqual([0, 0, 1, 6, 16])
      })
      it('no column field: orders by the cell value (desc); ties keep ascending key order in both directions', () => {
        const d = run(user, 'desc', false)
        expect(d.cells).toEqual([16, 6, 1, 0, 0])
        expect(d.names).toEqual(['k4', 'k1', 'k2', 'k3', 'k5'])
        expect(run(user, 'asc', false).names.slice(0, 2)).toEqual(['k3', 'k5'])
      })
      it('no column field: null cells stay last in either direction', () => {
        const r = [['k1', 6], ['k2', null], ['k3', 1]]
        expect(run(r, 'asc', false).names).toEqual(['k3', 'k1', 'k2'])
        expect(run(r, 'desc', false).names).toEqual(['k1', 'k3', 'k2'])
      })
      it('with a column field: scores by the sum of the group cells, not their count', () => {
        const r = [['a', 'x', 1], ['a', 'y', 1], ['a', 'z', 1], ['b', 'x', 20], ['c', 'x', 3], ['c', 'y', 4]]
        expect(run(r, 'desc', true, 2).names).toEqual(['b', 'c', 'a'])
        expect(run(r, 'asc', true, 2).names).toEqual(['a', 'c', 'b'])
      })
    })
    describe('sort by value, two row fields and no column field', () => {
      const rows2 = [['a', 'p', 1], ['a', 'q', 1], ['a', 'r', 13], ['b', 'p', 4], ['b', 'q', 4], ['b', 'r', 4], ['c', 'p', 2], ['c', 'q', 3], ['c', 'r', 5]]
      const outer = (rows: unknown[][], summary: any, agg: any, dir: 'asc' | 'desc' = 'desc', vi = 0) => {
        const c = { rows: [{ field: 'r0' }, { field: 'r1' }], columns: [], values: [{ field: 'v0', agg, label: 'M0', summary }], sort: { by: 'value', valueIndex: vi, dir } } as PivotConfig
        const m = buildPivotModel(res(rows, undefined, 2), c)
        return [...new Set(m.rowLabels.map((r) => r[0]))]
      }
      it.each([
        ['sum', 'sum', ['a', 'b', 'c']],
        ['avg', 'avg', ['a', 'b', 'c']],
        ['max', 'max', ['a', 'c', 'b']],
        ['min', 'min', ['b', 'c', 'a']],
        ['median', 'median', ['b', 'c', 'a']],
        ['count', 'count', ['a', 'b', 'c']],
      ])('summary %s', (summary, agg, expected) => {
        expect(outer(rows2, summary, agg)).toEqual(expected)
      })
      it('count ranks by the sum of the cells (asc)', () => {
        expect(outer(rows2, 'count', 'count', 'asc')).toEqual(['c', 'b', 'a'])
      })
      it('first inner cell null does not sink the group', () => {
        const r = [['a', 'p', null], ['a', 'q', 50], ['b', 'p', 3], ['b', 'q', 4]]
        for (const sm of ['sum', 'max', 'count'] as const) expect(outer(r, sm, 'sum')).toEqual(['a', 'b'])
      })
      it('user case with one row field still sorts', () => {
        const u = [['k1', 6], ['k2', 1], ['k3', 0], ['k4', 16], ['k5', 0]]
        const c = (dir: 'asc' | 'desc') => buildPivotModel(res(u, undefined, 1), { rows: [{ field: 'r0' }], columns: [], values: [{ field: 'v0', agg: 'count', label: 'M0', summary: 'count' }], sort: { by: 'value', valueIndex: 0, dir } } as PivotConfig).cells.map((r) => r[0])
        expect(c('asc')).toEqual([0, 0, 1, 6, 16]); expect(c('desc')).toEqual([16, 6, 1, 0, 0])
      })
      it('equal infinities compare equal (stable key order) and order against finite values', () => {
        const r = [['a', 'p', Infinity], ['b', 'p', Infinity], ['c', 'p', 5], ['d', 'p', -Infinity], ['e', 'p', -Infinity]]
        expect(outer(r, 'sum', 'sum', 'desc')).toEqual(['a', 'b', 'c', 'd', 'e'])
        expect(outer(r, 'sum', 'sum', 'asc')).toEqual(['d', 'e', 'c', 'a', 'b'])
      })
      it('out-of-range valueIndex does not crash and keeps key order', () => {
        expect(outer(rows2, 'sum', 'sum', 'desc', 5)).toEqual(['a', 'b', 'c'])
      })
    })
    it('grand needs both axes; row and column summaries are independent of it', () => {
      const g = { totals: { grand: true } }
      const both = buildPivotModel(res(data), cfg('sum', g))
      expect(both.grandTotal).toEqual([10]); expect(both.rowTotals).toBeUndefined(); expect(both.columnTotals).toBeUndefined()
      const noCols = buildPivotModel(res([['a', 1], ['b', 4]], undefined, 1), { ...cfg('sum', g), columns: [] })
      expect(noCols.grandTotal).toBeUndefined(); expect(noCols.columnTotals).toBeUndefined(); expect(noCols.rowTotals).toBeUndefined()
      const noRows = buildPivotModel(res([['x', 1], ['y', 4]], undefined, 1), { ...cfg('sum', g), rows: [] })
      expect(noRows.grandTotal).toBeUndefined(); expect(noRows.rowTotals).toBeUndefined()
      const all = buildPivotModel(res(data), cfg('sum'))
      expect(all.rowTotals).toBeDefined(); expect(all.columnTotals).toBeDefined(); expect(all.grandTotal).toEqual([10])
      const rowOnly = buildPivotModel(res(data), cfg('sum', { totals: { row: true } }))
      expect(rowOnly.rowTotals).toBeDefined(); expect(rowOnly.columnTotals).toBeUndefined(); expect(rowOnly.grandTotal).toBeUndefined()
    })
 })
  it('truncation', () => {
    const many = Array.from({ length: 5001 }, (_, i) => [String(i).padStart(5, '0'), 'x', i])
    const m = buildPivotModel(res(many), f(1, 1, 1))
    expect(m.rowLabels).toHaveLength(5000)
    expect(m.truncated.rows).toBe(true)
    const wide = Array.from({ length: 501 }, (_, i) => ['a', String(i).padStart(4, '0'), i])
    const w = buildPivotModel(res(wide), f(1, 1, 1))
    expect(w.columnHeaders).toHaveLength(500)
    expect(w.cells[0]).toHaveLength(500)
    expect(w.truncated.columns).toBe(true)
  })
  it('time keys chronological', () => {
    const m = buildPivotModel(res([['a', '2024-10-01', 1], ['a', '2023-12-01', 2], ['a', '2024-02-01', 3]]), f(1, 1, 1))
    expect(m.columnHeaders.map((h) => h[0])).toEqual(['2023-12-01', '2024-02-01', '2024-10-01'])
  })
  it('error/empty/missing long give empty model', () => {
    for (const status of ['error', 'empty'] as const) {
      const m = buildPivotModel({ status, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' }, f(1, 1, 1))
      expect(m.cells).toEqual([])
      expect(m.rowLabels).toEqual([])
    }
    expect(buildPivotModel(res([]), f(1, 1, 1)).cells).toEqual([])
  })
})

describe('formatValue', () => {
  const th = { kind: 'thousands' as const }
  it('basics', () => {
    expect(formatValue(null, th)).toBe('')
    expect(formatValue(NaN, th)).toBe('')
    expect(formatValue(Infinity, th)).toBe('')
    expect(formatValue(0, th)).toBe('0')
    expect(formatValue(-0, th)).toBe('0')
    expect(formatValue(-1234567.5, th)).toBe('-1,234,567.5')
    expect(formatValue(1234567, { kind: 'plain' })).toBe('1234567')
    expect(formatValue(0.1 + 0.2, { kind: 'plain' })).toBe('0.3')
    expect(formatValue(1e21, th)).toBe('1e+21')
  })
  it('decimals and rounding half away from zero', () => {
    expect(formatValue(2.5, { kind: 'thousands', decimals: 0 })).toBe('3')
    expect(formatValue(-2.5, { kind: 'thousands', decimals: 0 })).toBe('-3')
    expect(formatValue(1.005, { kind: 'plain', decimals: 2 })).toBe('1.01')
    expect(formatValue(3, { kind: 'plain', decimals: 2 })).toBe('3.00')
    expect(formatValue(-0.001, { kind: 'plain', decimals: 2 })).toBe('0.00')
    expect(formatValue(1.23456789, { kind: 'plain' })).toBe('1.23')
  })
  it('percent', () => {
    expect(formatValue(0.1234, { kind: 'percent' })).toBe('12.3%')
    expect(formatValue(0.07, { kind: 'percent', decimals: 0 })).toBe('7%')
    expect(formatValue(0.07, { kind: 'percent', decimals: 2 })).toBe('7.00%')
  })
})

describe('toTsv', () => {
  const m = buildPivotModel(
    res([['a\tb', 'x"y', 1.5], ['c\nd', 'x"y', 2]]),
    { ...f(1, 1, 1), totals: { row: true, column: true, grand: true }, values: [{ field: 'v', agg: 'sum', label: 'M', format: { kind: 'thousands', decimals: 2 } }] },
  )
  it('escapes and includes summaries with headers', () => {
    const lines = toTsv(m).split('\n')
    expect(lines[0]).toBe('\t"x""y"\tSummary')
    expect(lines[1]).toBe('r0\tM\tSummary M')
    expect(toTsv(m)).toContain('"a\tb"\t1.5\t1.5')
    expect(toTsv(m)).toContain('"c\nd"\t2\t2')
    expect(lines[lines.length - 1]).toBe('Summary\t3.5\t3.5')
  })
  it('withFormat and no header', () => {
    expect(toTsv(m, { withHeader: false, withFormat: true })).toContain('"a\tb"\t1.50\t1.50')
    expect(toTsv(m, { withHeader: false }).startsWith('"a\tb"')).toBe(true)
  })
  it('empty model', () => {
    expect(toTsv(buildPivotModel(res([]), f(1, 1, 1)), { withHeader: false })).toBe('')
  })
})

import { resolveLabels } from '../src/analysis/labelResolve'
describe('formatValue scale/unit', () => {
  const F = { kind: 'thousands' as const, decimals: 2, scale: 10000, unit: '万元' }
  it('scales, rounds, groups and appends unit', () => {
    expect(formatValue(12345678, F)).toBe('1,234.57万元')
    expect(formatValue(-25000, { ...F, decimals: 1 })).toBe('-2.5万元')
    expect(formatValue(10, { ...F, decimals: 0 })).toBe('0万元')
    expect(formatValue(-10, { ...F, decimals: 0 })).toBe('0万元')
    expect(formatValue(-0, F)).toBe('0.00万元')
  })
  it('percent ignores scale', () => { expect(formatValue(0.256, { kind: 'percent', scale: 100 })).toBe('25.6%') })
  it('null/NaN/Infinity are empty', () => {
    for (const v of [null, NaN, Infinity, -Infinity]) expect(formatValue(v as number | null, F)).toBe('')
  })
  it('huge values do not crash', () => { expect(formatValue(1e21, F)).toMatch(/万元$/) })
})

describe('buildPivotModel with resolved labels', () => {
  const ctx = { empty: '（空）', summary: 'Summary' }
  const mk = (over: Partial<PivotConfig> = {}): PivotConfig => ({ ...f(1, 1, 1), ...over }) as PivotConfig
  const build = (r: AnalysisResult, cfg: PivotConfig) => buildPivotModel(r, cfg, { resolved: resolveLabels({ pivot: cfg, chart: {} as never }, ctx) })
  it('no resolved: unchanged', () => {
    const r = res([['a', 'x', 1]])
    expect(buildPivotModel(r, mk())).toEqual(buildPivotModel(r, mk(), {}))
    expect('rowKeys' in buildPivotModel(r, mk())).toBe(false)
  })
  it('names, measure override, summary label', () => {
    const cfg = mk({ rows: [{ field: 'r0', label: '地区' }], values: [{ field: 'v0', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 2, scale: 10000, unit: '万元' } }], summaryLabel: '合计', totals: { column: true } })
    const m = build(res([['a', 'x', 15000], ['b', 'x', 25000]]), cfg)
    expect(m.rowHeaders).toEqual(['地区'])
    expect(m.measures[0].label).toBe('销售额')
    expect(m.summaryLabel).toBe('合计')
    expect(m.columnTotals).toEqual([40000])
    expect(m.cells).toEqual([[15000], [25000]])
    expect(formatValue(m.columnTotals![0], m.measures[0].format)).toBe('4.00万元')
    expect(toTsv(m, { withFormat: true })).toContain('合计')
    expect(toTsv(m, { withFormat: true })).toContain('1.50万元')
    expect(toTsv(m)).toContain('15000')
    expect(toTsv(m)).not.toContain('万元')
  })
  it('sorts by raw keys/values, not mapped text', () => {
    const cfg = mk({ rows: [{ field: 'r0', valueLabels: { '0': '是', '1': '否' } }], sort: { by: 'name', dir: 'asc' } })
    const m = build(res([[1, 'x', 5], [0, 'x', 9]]), cfg)
    expect(m.rowLabels).toEqual([['是'], ['否']])
    expect(m.rowKeys).toEqual([[0], [1]])
    const v = build(res([['a', 'x', 9e4], ['b', 'x', 1e5]]), mk({ values: [{ field: 'v0', agg: 'sum', format: { kind: 'plain', scale: 1e12 } }], sort: { by: 'value', valueIndex: 0, dir: 'asc' } }))
    expect(v.rowLabels).toEqual([['a'], ['b']])
  })
  it('keys mapped to the same text stay separate; null uses nullLabel; real "（空）" untouched', () => {
    const cfg = mk({ rows: [{ field: 'r0', valueLabels: { a: 'Z', b: 'Z' }, nullLabel: '未知' }] })
    const m = build(res([['a', 'x', 1], ['b', 'x', 2], [null, 'x', 3], ['（空）', 'x', 4]]), cfg)
    expect(m.rowLabels.map((r) => r[0])).toEqual(['Z', 'Z', '（空）', '未知'])
    expect(m.rowKeys!.map((r) => r[0])).toEqual(['a', 'b', '（空）', null])
  })
})
