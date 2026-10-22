import { describe, it, expect } from 'vitest'
import { buildPreviewModel, sampleValue, Y_TICK_FRACTIONS, type PreviewModel } from '../src/analysis/labelPreviewModel'
import { resolveLabels, type LabelTarget } from '../src/analysis/labelResolve'
import { labelTargetId } from '../src/analysis/labelTargetId'
import { affectsOf } from '../src/analysis/labelAffects'
import { buildPivotModel, formatValue } from '../src/analysis/pivotModel'

const ctx = { empty: '(空)', summary: '汇总' }
const full = () => ({
  pivot: {
    rows: [{ field: 'region', label: '大区', valueLabels: { '0': '否', a: 'AA' }, nullLabel: '未知' }],
    columns: [{ field: 'q', label: '季度' }],
    values: [{ field: 'amount', agg: 'sum', label: '销售额', format: { kind: 'thousands', unit: '万元', scale: 10000 } }],
    summaryLabel: '合计',
  },
  chart: { type: 'bar', title: '标题', axisTitles: { x: 'XX', y: 'YY', legend: 'LL' } },
} as any)
const none = () => ({ pivot: { rows: [{ field: 'region' }], columns: [{ field: 'q' }], values: [{ field: 'amount', agg: 'sum' }] }, chart: { type: 'bar' } } as any)
const cats = { rows: [['0', 'a', 'b', 'c', 'd']], columns: [['Q1', 'Q2']] }
const two = () => ({
  pivot: {
    rows: [{ field: 'r1', valueLabels: { a: 'AA' } }, { field: 'r2', valueLabels: { x: 'ex' }, nullLabel: '空2' }],
    columns: [{ field: 'c1' }, { field: 'c2', valueLabels: { p: 'pp' }, nullLabel: '空c' }],
    values: [{ field: 'amount', agg: 'sum' }],
  }, chart: { type: 'bar' },
} as any)
const cats2 = { rows: [['a', 'b'], ['x', 'y']], columns: [['Q1', 'Q2'], ['p', 'q']] }
const flags = (m: PreviewModel): string[] => {
  const out: string[] = []
  m.header.cells.forEach((c) => c.active && out.push(`${c.role}:${c.index}`))
  if (m.header.summary.active) out.push('summary')
  m.table.groups.forEach((g) => g.parts.forEach((p) => p.active && out.push('group')))
  m.table.rows.forEach((r) => { r.heads.forEach((h) => h.active && out.push('rowhead')); r.cells.forEach((c) => c.active && out.push('cell')) })
  m.table.totals.cells.forEach((c) => c.active && out.push('total'))
  if (m.table.totals.label.active) out.push('totalLabel')
  const c = m.chart
  c.title.active && out.push('title'); c.axisX.active && out.push('axisX'); c.axisY.active && out.push('axisY'); c.legend.active && out.push('legend')
  c.series.forEach((t) => t.active && out.push('series')); c.ticks.forEach((t) => t.active && out.push('tick')); c.yTicks.forEach((t) => t.active && out.push('ytick'))
  return [...new Set(out)].sort()
}
const at = (t: LabelTarget | null) => flags(buildPreviewModel(full(), ctx, t, cats))


const fmt = (kind: string, extra: any = {}) => ({ kind, ...extra })
const driftConfigs: [string, any, any][] = [
  ['none', none(), cats],
  ['full overrides', full(), { rows: [['0', 'a', 'b']], columns: [['Q1', 'Q2']] }],
  ['scale+unit', { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum', format: fmt('thousands', { unit: '元', scale: 100 }) }] }, chart: {} }, { rows: [['a', 'b', 'c']] }],
  ['percent', { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum', format: fmt('percent') }] }, chart: {} }, { rows: [['a', 'b']] }],
  ['multi-measure', { pivot: { rows: [{ field: 'r', label: 'R' }], columns: [], values: [{ field: 'a', agg: 'sum', label: 'M1', format: fmt('thousands', { unit: 'u' }) }, { field: 'b', agg: 'sum', format: fmt('percent') }] }, chart: {} }, { rows: [['a', 'b']] }],
  ['column field nullLabel', { pivot: { rows: [{ field: 'r' }], columns: [{ field: 'q', nullLabel: '无季度', valueLabels: { Q1: '一季' } }], values: [{ field: 'a', agg: 'sum' }, { field: 'b', agg: 'sum', label: 'B' }] }, chart: {} }, { rows: [['a', 'b']], columns: [['Q1', null]] }],
  ['two row fields', two(), cats2],
  ['valueLabels with null key', { pivot: { rows: [{ field: 'r', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' }], columns: [], values: [{ field: 'a', agg: 'sum' }] }, chart: {} }, { rows: [[0, 1, null]] }],
  ['summaryLabel only', { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum' }], summaryLabel: '总计' }, chart: {} }, { rows: [['a']] }],
]

describe('drift: preview vs the REAL buildPivotModel', () => {
  for (const [name, cfg0, cs] of driftConfigs) {
    it(name, () => {
      const cfg = { ...cfg0, pivot: { ...cfg0.pivot, totals: { column: true } } }
      const pv = buildPreviewModel(cfg, ctx, null, cs)
      const nr = cfg.pivot.rows.length, nc = cfg.pivot.columns.length, nm = cfg.pivot.values.length
      const kind = (m: number) => cfg.pivot.values[m].format?.kind ?? 'thousands'
      const groups = nc ? pv.table.groups : [{ keys: [] as unknown[], parts: [] }]
      const rows: unknown[][] = []
      pv.table.rows.forEach((row, ri) => groups.forEach((g) => rows.push([...row.keys, ...g.keys, ...Array.from({ length: nm }, (_, m) => sampleValue(kind(m), ri))])))
      const res = { status: 'ok', long: { dims: [], measures: [], rows } } as any
      const pm = buildPivotModel(res, cfg.pivot, { labels: ctx, resolved: resolveLabels(cfg, ctx) })
      const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => (x == null && b[i] == null) || String(x) === String(b[i]))
      const measureTexts = pv.header.cells.filter((c) => c.role === 'measureName').map((c) => c.text)
      expect(pv.header.cells.filter((c) => c.role === 'rowName').map((c) => c.text)).toEqual(pm.rowHeaders)
      expect(measureTexts).toEqual(pm.measures.map((x) => x.label))
      expect(pv.header.summary.text).toBe(pm.summaryLabel)
      expect(pv.table.totals.label.text).toBe(pm.summaryLabel)
      expect(pv.table.rows.length).toBe(pm.rowLabels.length)
      pv.table.rows.forEach((row, ri) => {
        const j = pm.rowKeys!.findIndex((k) => same(k, row.keys))
        expect(j, 'row found').toBeGreaterThanOrEqual(0)
        expect(row.heads.map((h) => h.text)).toEqual(pm.rowLabels[j])
        groups.forEach((g, gi) => {
          for (let m = 0; m < nm; m++) {
            const c = pm.columnKeys!.findIndex((k, ci) => same(k, nc ? g.keys : []) && ci % nm === m)
            expect(c).toBeGreaterThanOrEqual(0)
            expect(pm.columnHeaders[c]).toEqual([...g.parts.map((p) => p.text), measureTexts[m]])
            expect(row.cells[gi * nm + m].text, `cell ${ri}/${gi}/${m}`).toBe(formatValue(pm.cells[j][c], pm.measures[m].format))
            expect(pv.table.totals.cells[gi * nm + m].text).toBe(formatValue(pm.columnTotals![c], pm.measures[m].format))
          }
        })
      })
    })
  }
  it('non-vacuous: mapped texts really differ from raw keys', () => {
    const pv = buildPreviewModel(driftConfigs[7][1], ctx, null, driftConfigs[7][2])
    expect(pv.table.rows.map((r) => r.heads[0].text)).toEqual(['否', '是', '未知'])
    expect(buildPreviewModel(driftConfigs[2][1], ctx, null, driftConfigs[2][2]).table.rows[0].cells[0].text).toBe('12,345.67元')
  })
})

describe('buildPreviewModel', () => {
  it('active flags per item kind', () => {
    expect(at(null)).toEqual([])
    expect(at({ kind: 'rowName', index: 0 })).toEqual(['axisX', 'rowName:0'])
    expect(at({ kind: 'columnName', index: 0 })).toEqual(['columnName:0', 'legend'])
    expect(at({ kind: 'measureName', index: 0 })).toEqual(['axisY', 'measureName:0', 'total'])
    expect(at({ kind: 'summary' })).toEqual(['summary', 'totalLabel'])
    expect(at({ kind: 'title' })).toEqual(['title'])
    expect(at({ kind: 'axis', axis: 'x' })).toEqual(['axisX'])
    expect(at({ kind: 'axis', axis: 'y' })).toEqual(['axisY'])
    expect(at({ kind: 'axis', axis: 'legend' })).toEqual(['legend'])
    expect(at({ kind: 'unit', index: 0 })).toEqual(['axisY', 'cell', 'total'])
    expect(at({ kind: 'scale', index: 0 })).toEqual(['cell', 'total', 'ytick'])
    expect(at({ kind: 'category', axis: 'row', index: 0, key: 'a' })).toEqual(['rowhead', 'tick'])
    expect(at({ kind: 'category', axis: 'column', index: 0, key: 'Q1' })).toEqual(['group', 'series'])
    expect(at({ kind: 'nullLabel', axis: 'row', index: 0 })).toEqual(['rowhead', 'tick'])
  })
  it('unit/scale equal formatValue', () => {
    const m = buildPreviewModel(full(), ctx, null, cats)
    expect(m.table.rows[0].cells[0].text).toBe(formatValue(1234567, { kind: 'thousands', unit: '万元', scale: 10000 }))
    expect(m.table.rows[0].cells[0].text).toBe('123.46万元')
    const n = buildPreviewModel(none(), ctx, null, cats)
    expect(n.table.rows[0].cells[0].text).toBe('1,234,567')
  })
  it('category mapping and null label in ticks', () => {
    const m = buildPreviewModel(full(), ctx, null, { rows: [['0', 'a', null]] })
    expect(m.chart.ticks.map((t) => t.text)).toEqual(['否', 'AA', '未知'])
    expect(m.table.rows.map((r) => r.heads[0].text)).toEqual(['否', 'AA', '未知'])
  })
  it('placeholders and capped samples; degenerate configs do not throw', () => {
    expect(buildPreviewModel(none(), ctx, null).table.rows.length).toBe(3)
    expect(buildPreviewModel(none(), ctx, null, cats).table.rows.length).toBeLessThanOrEqual(4)
    for (const c of [{ pivot: { rows: [], columns: [], values: [] }, chart: {} }, { pivot: { rows: [], columns: [], values: [{ field: 'a', agg: 'sum' }, { field: 'b', agg: 'avg' }] }, chart: {} }, { pivot: { rows: [{ field: 'r' }], columns: [], values: [] }, chart: {} }] as any[])
      expect(() => buildPreviewModel(c, ctx, { kind: 'unit', index: 5 }, { rows: [[]] })).not.toThrow()
  })
  it('active category key outside the sample is still shown', () => {
    const m = buildPreviewModel(full(), ctx, { kind: 'category', axis: 'row', index: 0, key: 'zzz' }, cats)
    expect(m.table.rows.some((r) => r.heads[0].active && r.heads[0].text === 'zzz')).toBe(true)
  })
  it('percent y ticks use the named fractions and the same formatter', () => {
    const c = none(); c.pivot.values[0].format = { kind: 'percent' }
    const m = buildPreviewModel(c, ctx, null, cats)
    expect(Y_TICK_FRACTIONS).toEqual([1, 0.5])
    expect(m.chart.yTicks.map((t) => t.text)).toEqual(Y_TICK_FRACTIONS.map((f) => formatValue(sampleValue('percent', 0) * f, { kind: 'percent' })))
    expect(m.chart.yTicks[0].text).toBe('43.2%')
  })
  it('index >= 1 targets highlight their own field (two row + two column fields)', () => {
    const c = two()
    const f = (t: LabelTarget) => flags(buildPreviewModel(c, ctx, t, cats2))
    expect(f({ kind: 'category', axis: 'row', index: 1, key: 'x' })).toEqual(['rowhead'])
    expect(f({ kind: 'nullLabel', axis: 'row', index: 1 })).toEqual(['rowhead'])
    expect(f({ kind: 'category', axis: 'column', index: 1, key: 'p' })).toEqual(['group', 'series'])
    expect(f({ kind: 'nullLabel', axis: 'column', index: 1 })).toEqual(['group', 'series'])
    expect(f({ kind: 'rowName', index: 1 })).toEqual(['rowName:1'])
    expect(f({ kind: 'columnName', index: 1 })).toEqual(['columnName:1'])
    const m = buildPreviewModel(c, ctx, { kind: 'category', axis: 'row', index: 1, key: 'x' }, cats2)
    expect(m.table.rows[0].heads.map((h) => h.text)).toEqual(['AA', 'ex'])
  })
  const PLACE_FLAGS: Record<string, string[]> = {
    tableHeader: ['rowName:0', 'measureName:0', 'group'], rowHeader: ['rowhead'], legend: ['legend', 'series'], totalsRow: ['total', 'totalLabel'],
    axisX: ['axisX'], axisY: ['axisY'], chartTitle: ['title'], cells: ['cell'], chartTicks: ['tick', 'ytick'],
  }
  it('measureName highlights the legend series when there is no column field', () => {
    const c = full(); c.pivot.columns = []
    expect(flags(buildPreviewModel(c, ctx, { kind: 'measureName', index: 0 }, cats))).toContain('series')
  })
  it('every LabelTarget kind highlights every place labelAffects claims that the sketch can show', () => {
    // tooltip/export are not sketched. Fields at index >= 1 only show in the table (the chart sketch uses field 0).
    const targets: LabelTarget[] = [
      { kind: 'rowName', index: 0 }, { kind: 'columnName', index: 0 }, { kind: 'measureName', index: 0 }, { kind: 'summary' }, { kind: 'title' },
      { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }, { kind: 'unit', index: 0 }, { kind: 'scale', index: 0 },
      { kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'category', axis: 'column', index: 0, key: 'Q1' },
      { kind: 'nullLabel', axis: 'row', index: 0 }, { kind: 'nullLabel', axis: 'column', index: 0 },
    ]
    for (const tg of targets) {
      const got = new Set(flags(buildPreviewModel(full(), ctx, tg, { rows: [['0', 'a', null]], columns: [['Q1', 'Q2', null]] })).map((x) => x.replace(/:\d+$/, ':0')))
      expect(got.size, JSON.stringify(tg)).toBeGreaterThan(0)
      for (const place of affectsOf(tg)) {
        if (!PLACE_FLAGS[place] || (place === 'legend' && tg.kind === 'measureName')) continue  // measure names only fill the legend when there is no column field (next test)
        expect(PLACE_FLAGS[place].some((fl) => got.has(fl)), `${JSON.stringify(tg)} -> ${place} (got ${[...got]})`).toBe(true)
      }
    }
  })
})

describe('numbered callouts (ns)', () => {
  const id = labelTargetId
  const mk = (ts: LabelTarget[]) => new Map(ts.map((t, i) => [id(t), i + 1] as [string, number]))
  const allNs = (m: PreviewModel): number[] => {
    const out: number[] = []
    const add = (i: { ns?: number[] }) => i.ns && out.push(...i.ns)
    m.header.cells.forEach(add); add(m.header.summary)
    m.table.groups.forEach((g) => g.parts.forEach(add))
    m.table.rows.forEach((r) => { r.heads.forEach(add); r.cells.forEach(add) })
    add(m.table.totals.label); m.table.totals.cells.forEach(add)
    const c = m.chart
    ;[c.title, c.axisX, c.axisY, c.legend, ...c.ticks, ...c.yTicks, ...c.series].forEach(add)
    return out
  }
  const tableTargets: LabelTarget[] = [
    { kind: 'rowName', index: 0 }, { kind: 'rowName', index: 1 }, { kind: 'columnName', index: 0 }, { kind: 'columnName', index: 1 },
    { kind: 'measureName', index: 0 }, { kind: 'summary' },
  ]
  it('table tab: rowName 1,2 columnName 3,4 measure 5 summary last, 2 row + 2 column fields', () => {
    const m = buildPreviewModel(two(), ctx, null, cats2, mk(tableTargets))
    const h = m.header.cells
    expect(h.filter((c) => c.role === 'rowName').map((c) => c.ns)).toEqual([[1], [2]])
    expect(h.filter((c) => c.role === 'columnName').map((c) => c.ns)).toEqual([[3], [4]])
    expect(h.filter((c) => c.role === 'measureName').map((c) => c.ns)).toEqual([[5]])
    expect(m.table.totals.label.ns).toEqual([6])
    expect(m.header.summary.ns).toBeUndefined()
  })
  it('chart tab numbers land on title/axisX/axisY/legend', () => {
    const m = buildPreviewModel(full(), ctx, null, cats, mk([{ kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }]))
    expect([m.chart.title.ns, m.chart.axisX.ns, m.chart.axisY.ns, m.chart.legend.ns]).toEqual([[1], [2], [3], [4]])
  })
  it('numbers tab: unit and scale of measure m both on its first cell ns [u,s]', () => {
    const c = { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum' }, { field: 'b', agg: 'sum' }] }, chart: {} } as any
    const m = buildPreviewModel(c, ctx, null, { rows: [['a', 'b']] }, mk([{ kind: 'unit', index: 0 }, { kind: 'scale', index: 0 }, { kind: 'unit', index: 1 }, { kind: 'scale', index: 1 }]))
    expect(m.table.rows[0].cells.map((x) => x.ns)).toEqual([[1, 2], [3, 4]])
    expect(m.table.rows[1].cells.every((x) => x.ns === undefined)).toBe(true)
  })
  it('categories tab: numbered keys get badges on heads/parts and null on the null head; keys beyond the 3 sampled get none', () => {
    const cfg = two()
    const ts: LabelTarget[] = [
      { kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'category', axis: 'row', index: 0, key: 'b' },
      { kind: 'nullLabel', axis: 'row', index: 1 }, { kind: 'category', axis: 'column', index: 1, key: 'p' },
      { kind: 'category', axis: 'row', index: 0, key: 'zz1' }, { kind: 'category', axis: 'row', index: 0, key: 'zz2' }, { kind: 'category', axis: 'row', index: 0, key: 'zz3' },
    ]
    const m = buildPreviewModel(cfg, ctx, null, { rows: [['a', 'b', 'c', 'd'], ['x', null]], columns: [['Q1'], ['p', 'q']] }, mk(ts))
    const heads0 = m.table.rows.map((r) => r.heads[0])
    expect(heads0.find((h) => h.text === 'AA')?.ns).toEqual([1])
    expect(heads0.find((h) => h.text === 'b')?.ns).toEqual([2])
    expect(m.table.rows.map((r) => r.heads[1]).find((h) => h.text === '空2')?.ns).toEqual([3])
    expect(m.table.groups.map((g) => g.parts[1]).find((p) => p.text === 'pp')?.ns).toEqual([4])
    const ns = allNs(m)
    expect(ns).not.toContain(7)
    expect(new Set(ns).size).toBe(ns.length)
  })
  it('sampling takes the first numbered keys, not the first data keys', () => {
    const ts: LabelTarget[] = ['x7', 'x8', 'x9', 'x10'].map((key) => ({ kind: 'category', axis: 'row', index: 0, key }))
    const c = { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum' }] }, chart: {} } as any
    const m = buildPreviewModel(c, ctx, null, { rows: [['d1', 'd2', 'd3', 'x7', 'x8', 'x9', 'x10']] }, mk(ts))
    expect(m.table.rows.map((r) => r.heads[0].text)).toEqual(['x7', 'x8', 'x9'])
    expect(m.table.rows.map((r) => r.heads[0].ns)).toEqual([[1], [2], [3]])
    const plain = buildPreviewModel(c, ctx, null, { rows: [['d1', 'd2', 'd3', 'x7']] }, new Map())
    expect(plain.table.rows.map((r) => r.heads[0].text)).toEqual(['d1', 'd2', 'd3'])
  })
  it('keys containing colons resolve to their ids', () => {
    const c = { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum' }] }, chart: {} } as any
    const m = buildPreviewModel(c, ctx, null, { rows: [['a:b:c']] }, mk([{ kind: 'category', axis: 'row', index: 0, key: 'a:b:c' }]))
    expect(m.table.rows[0].heads[0].ns).toEqual([1])
  })
  it('no number in the map -> no ns anywhere', () => {
    expect(allNs(buildPreviewModel(full(), ctx, null, cats))).toEqual([])
    expect(allNs(buildPreviewModel(full(), ctx, null, cats, new Map()))).toEqual([])
    expect(allNs(buildPreviewModel(full(), ctx, null, cats, new Map([['bogus:9', 1]])))).toEqual([])
    const only = buildPreviewModel(two(), ctx, null, cats2, mk([{ kind: 'title' }]))
    expect(allNs(only)).toEqual([1])
  })
  it('property: every ns digit is a map value; every displayed number appears exactly once', () => {
    const sets: LabelTarget[][] = [
      tableTargets,
      [{ kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }],
      [{ kind: 'unit', index: 0 }, { kind: 'scale', index: 0 }],
      [{ kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'category', axis: 'row', index: 1, key: 'x' }, { kind: 'category', axis: 'column', index: 0, key: 'Q2' }, { kind: 'nullLabel', axis: 'row', index: 1 }, { kind: 'nullLabel', axis: 'column', index: 1 }],
    ]
    for (const cfg of [two(), full(), none()]) for (const ts of sets) {
      const nums = mk(ts)
      const ns = allNs(buildPreviewModel(cfg, ctx, null, cats2, nums))
      const vals = new Set(nums.values())
      expect(ns.every((n) => vals.has(n))).toBe(true)
      expect(new Set(ns).size).toBe(ns.length)
    }
    const nums = mk(tableTargets)
    const ns = allNs(buildPreviewModel(two(), ctx, null, cats2, nums))
    expect(ns.sort()).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('drift guard still equals resolveLabels with numbers present', () => {
    const nums = mk([...tableTargets, { kind: 'title' }, { kind: 'unit', index: 0 }])
    const a = buildPreviewModel(full(), ctx, null, cats, nums), b = buildPreviewModel(full(), ctx, null, cats)
    const strip = (m: PreviewModel) => JSON.parse(JSON.stringify(m, (k, v) => (k === 'ns' ? undefined : v)))
    expect(strip(a)).toEqual(strip(b))
    const r = resolveLabels(full(), ctx)
    expect(a.chart.title.text).toBe(r.title)
    expect(a.table.totals.label.text).toBe(r.summary)
  })
})

describe('numbered sampling keeps texts equal to resolveLabels', () => {
  it('numbered category sampling: every head text is resolveLabels.category of its key', () => {
    const nums = new Map([[labelTargetId({ kind: 'category', axis: 'row', index: 0, key: 'a' }), 1], [labelTargetId({ kind: 'category', axis: 'row', index: 0, key: '0' }), 2]])
    const m = buildPreviewModel(full(), ctx, null, cats, nums)
    const r = resolveLabels(full(), ctx)
    expect(m.table.rows.map((x) => x.heads[0].text)).toEqual(m.table.rows.map((x) => r.category('row', 0, x.keys[0])))
    expect(m.table.rows.map((x) => x.keys[0])).toEqual(['a', '0', null])
  })
})
