import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { buildRenderSpec } from '@sqlnb/format'
import { affectsOf, affectText, AFFECT_PLACES, type AffectPlace } from '../src/analysis/labelAffects'
import { resolveLabels, type LabelTarget } from '../src/analysis/labelResolve'
import { buildPivotModel, formatValue } from '../src/analysis/pivotModel'
import { toChartRows } from '../src/analysis/chartRows'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import { buildExportModel } from '../src/export/model'
import { setLocale, t, messages } from '../src/i18n'

// Claim table: target → places → code proving it (every claim is also pinned behaviourally below).
//  rowName      tableHeader  pivotModel.ts:88 rowHeaders ← rv.rowNames; PivotTable.vue:195 row <th>
//               axisX        vegaSpec.ts:211 xTitle = rowName(first)
//               tooltip      vegaSpec.ts:74,103 tooltip entries are the x/series/measure defs (titles = field names; vegaRuntime.ts:14-19 prints `title: value`)
//               export       export/model.ts:222 rowHeaders → html.ts:131; chart spec → chartSvg.ts
//  columnName   legend       vegaSpec.ts:214 colTitle = columns.map(rowName); :276/:279/:284 series title
//               tooltip      vegaSpec.ts:74 series def title
//               export       chart svg (chartSvg.ts). NOT tableHeader: pivotModel.ts:138 columnHeaders hold only category values + measure label, the column field name is never rendered in the table (claim deleted)
//  measureName  tableHeader  pivotModel.ts:86,138 measure label in columnHeaders; PivotTable.vue:208
//               totalsRow    PivotTable.vue:213 total-head shows m.label (when row totals + multi-level header)
//               legend       chartRows.ts:93 series = cols + labels.measure(v) when several measures; vegaSpec.ts:251
//               axisY        vegaSpec.ts:283 y title = label (+unit) when a single measure
//               tooltip      vegaSpec.ts:103 measure def title
//               export       model.ts:222 columnHeaders/measures; chart spec
//  summary      totalsRow    pivotModel.ts:142 summaryLabel; PivotTable.vue:129,204,213,234
//               export       html.ts:154 m.summaryLabel
//  title        chartTitle   vegaSpec.ts:166-167 spec.title; ChartView.vue:34 title click
//               export       model.ts:242 cs.title → html.ts:170
//  axis x/y/legend  the axis/legend title (vegaSpec.ts:211/212/213), tooltip (vegaSpec.ts:74,103: same defs), export (chart svg)
//  unit         cells        pivotModel.ts:169 formatValue suffix; PivotTable.vue:69 fmt
//               totalsRow    PivotTable.vue:119,125 totals use fmt of the measure format
//               axisY        vegaSpec.ts:282 `（unit）` for a single measure
//               tooltip      chartRows.ts:99 valueText via formatValue; vegaSpec.ts:102
//               export       model.ts:220 fm = fmtNum(measure format)
//  scale        cells/totalsRow/tooltip/export as unit; chartTicks chartRows.ts:96 value / scale → axis tick values
//  category / nullLabel (row)     rowHeader pivotModel.ts:137 rowLabels; chartTicks chartRows.ts:88 x via category mapper (categorical x); tooltip (x value); export
//  category / nullLabel (column)  tableHeader pivotModel.ts:138 columnHeaders; legend chartRows.ts:90,93 series; tooltip (series value); export
const KINDS: { name: string; target: LabelTarget }[] = [
  { name: 'rowName', target: { kind: 'rowName', index: 0 } },
  { name: 'columnName', target: { kind: 'columnName', index: 0 } },
  { name: 'measureName', target: { kind: 'measureName', index: 0 } },
  { name: 'summary', target: { kind: 'summary' } },
  { name: 'title', target: { kind: 'title' } },
  { name: 'axis x', target: { kind: 'axis', axis: 'x' } },
  { name: 'axis y', target: { kind: 'axis', axis: 'y' } },
  { name: 'axis legend', target: { kind: 'axis', axis: 'legend' } },
  { name: 'unit', target: { kind: 'unit', index: 0 } },
  { name: 'scale', target: { kind: 'scale', index: 0 } },
  { name: 'category row', target: { kind: 'category', axis: 'row', index: 0, key: 'a' } },
  { name: 'category column', target: { kind: 'category', axis: 'column', index: 0, key: 'x' } },
  { name: 'nullLabel row', target: { kind: 'nullLabel', axis: 'row', index: 0 } },
  { name: 'nullLabel column', target: { kind: 'nullLabel', axis: 'column', index: 0 } },
]

describe('affectsOf', () => {
  it('every LabelTarget kind (rowName, columnName, measureName, summary, title, axis x/y/legend, unit, scale, category row/column, nullLabel row/column) returns a non-empty affects list', () => {
    for (const k of KINDS) {
      const a = affectsOf(k.target)
      expect(a.length, k.name).toBeGreaterThan(0)
      expect(new Set(a).size, k.name).toBe(a.length)
      for (const p of a) expect(AFFECT_PLACES, k.name).toContain(p)
    }
  })
  it('zh and en text exist for every AffectPlace (t(key) !== key in both locales)', () => {
    for (const loc of ['zh', 'en']) {
      setLocale(loc)
      for (const p of [...AFFECT_PLACES, 'sep', 'lead']) {
        const key = `label.aff.${p}` as any
        expect(t(key), `${loc} ${p}`).not.toBe(key)
        expect(t(key).trim().length).toBeGreaterThan(0)
      }
    }
    expect(Object.keys(messages['zh-CN']).filter((k) => k.startsWith('label.aff.')).sort()).toEqual(Object.keys(messages.en).filter((k) => k.startsWith('label.aff.')).sort())
  })
  it('affectText zh for summary equals 影响：汇总行 · 导出, en equals Affects: Totals row, Export', () => {
    setLocale('zh')
    expect(affectText(affectsOf({ kind: 'summary' }))).toBe('影响：汇总行 · 导出')
    expect(affectText(['tableHeader', 'legend', 'tooltip', 'export'])).toBe('影响：表头 · 图例 · 提示框 · 导出')
    setLocale('en')
    expect(affectText(affectsOf({ kind: 'summary' }))).toBe('Affects: Totals row · Export')
    expect(affectText([])).toBe('')
    setLocale('zh')
  })
  it('pins the claim table (data)', () => {
    const o = (t: LabelTarget) => affectsOf(t).join(',')
    expect(o({ kind: 'rowName', index: 0 })).toBe('tableHeader,axisX,tooltip,export')
    expect(o({ kind: 'columnName', index: 0 })).toBe('legend,tooltip,export')
    expect(o({ kind: 'measureName', index: 0 })).toBe('tableHeader,totalsRow,legend,axisY,tooltip,export')
    expect(o({ kind: 'title' })).toBe('chartTitle,export')
    expect(o({ kind: 'axis', axis: 'x' })).toBe('axisX,tooltip,export')
    expect(o({ kind: 'axis', axis: 'y' })).toBe('axisY,tooltip,export')
    expect(o({ kind: 'axis', axis: 'legend' })).toBe('legend,tooltip,export')
    expect(o({ kind: 'unit', index: 0 })).toBe('cells,totalsRow,axisY,tooltip,export')
    expect(o({ kind: 'scale', index: 0 })).toBe('cells,totalsRow,chartTicks,tooltip,export')
    expect(o({ kind: 'category', axis: 'row', index: 0, key: 'a' })).toBe('rowHeader,chartTicks,tooltip,export')
    expect(o({ kind: 'nullLabel', axis: 'row', index: 0 })).toBe('rowHeader,chartTicks,tooltip,export')
    expect(o({ kind: 'category', axis: 'column', index: 0, key: 'x' })).toBe('tableHeader,legend,tooltip,export')
    expect(o({ kind: 'nullLabel', axis: 'column', index: 0 })).toBe('tableHeader,legend,tooltip,export')
  })
})

// ---- behavioural pins: render the real model/spec/rows/export with a sentinel label and observe where it shows ----
const S = '§SENTINEL§'
const columnsInfo = [{ name: 'region', kind: 'text' as const }, { name: 'flag', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }, { name: 'qty', kind: 'number' as const }]
const longRows = [['a', 'x', 1000, 10], ['a', 'y', 2000, 20], ['b', 'x', 3000, 30], [null, 'x', 4000, 40], ['a', null, 5000, 50]]
const mkCfg = (multi: boolean) => ({
  pivot: {
    rows: [{ field: 'region' }], columns: [{ field: 'flag' }],
    values: [{ field: 'amount', agg: 'sum', format: { kind: 'thousands' } }, ...(multi ? [{ field: 'qty', agg: 'sum', format: { kind: 'thousands' } }] : [])],
    totals: { row: true, column: true, grand: true },
  } as any,
  chart: { type: 'bar' } as any,
})
const ctx = { empty: '(empty)', summary: 'Summary' }
const okRes = (multi: boolean) => ({
  status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x',
  long: { dims: ['region', 'flag'], measures: multi ? ['amount', 'qty'] : ['amount'], rows: longRows.map((r) => (multi ? r : r.slice(0, 3))) },
})
function apply(cfg: any, target: LabelTarget) {
  const c = JSON.parse(JSON.stringify(cfg))
  const p = c.pivot
  switch (target.kind) {
    case 'rowName': p.rows[0].label = S; break
    case 'columnName': p.columns[0].label = S; break
    case 'measureName': p.values[0].label = S; break
    case 'summary': p.summaryLabel = S; break
    case 'title': c.chart.title = S; break
    case 'axis': c.chart.axisTitles = { [target.axis]: S }; break
    case 'unit': p.values[0].format.unit = S; break
    case 'scale': p.values[0].format.scale = 1000; break
    case 'category': (target.axis === 'row' ? p.rows : p.columns)[0].valueLabels = { [target.key]: S }; break
    case 'nullLabel': (target.axis === 'row' ? p.rows : p.columns)[0].nullLabel = S; break
  }
  return c
}
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
function exportOf(cfg: any, multi: boolean) {
  const res = (cols: string[], rows: unknown[][]) => ({ columns: cols.map((name) => ({ name })), rows, truncated: false, elapsedMs: 1, dbType: 'x' })
  const blocks = [
    { id: 's', type: 'sql', content: 'select 1', metadata: { resultName: 's' } },
    { id: 'c', type: 'chart', metadata: { data: 's', view: 'both', chartOptions: cfg.chart, pivot: cfg.pivot } },
  ]
  const store: any = {
    nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks }),
    runs: new Map([['s', { status: 'ok', result: res(['region', 'flag', 'amount', 'qty'], longRows), executedAt: '2026-10-18T09:00:00Z' }]]),
    analysis: new Map([['c', okRes(multi)]]), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
  }
  const m = buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS }, now: new Date('2026-10-18T10:00:00Z'), dataSourceName: () => 'db' })
  return json(m.sections.filter((x: any) => x.blockId === 'c'))
}
function surfaces(cfg: any, multi: boolean) {
  const resolved = resolveLabels(cfg, ctx)
  const pm = buildPivotModel(okRes(multi) as any, cfg.pivot, { resolved })
  const spec = (buildRenderSpec({ pivot: cfg.pivot, chart: cfg.chart, columns: columnsInfo }) as any).spec
  const rows = toChartRows((okRes(multi) as any).long, cfg.pivot, cfg.chart, columnsInfo, resolved) as any[]
  const enc = (spec.layer ? spec.layer[0] : spec).encoding
  const fmt = (v: number | null) => formatValue(v, pm.measures[0].format)
  return {
    rowHeaders: json(pm.rowHeaders), rowLabels: json(pm.rowLabels), columnHeaders: json(pm.columnHeaders),
    measureLabels: json(pm.measures.map((m) => m.label)), summaryLabel: pm.summaryLabel ?? '',
    cellText: fmt(pm.cells[0][0]), totalText: fmt(pm.columnTotals?.[0] ?? null),
    xTitle: json(enc.x?.title), yTitle: json(enc.y?.title), colorTitle: json(enc.color?.title), tooltip: json(enc.tooltip), title: json(spec.title ?? ''),
    rowsX: json(rows.map((r) => r.x)), rowsSeries: json(rows.map((r) => r.series)), rowsValue: json(rows.map((r) => r.value)), rowsText: json(rows.map((r) => r.valueText)),
    exported: exportOf(cfg, multi),
  }
}
const has = (s: string) => s.includes(S)
function observe(target: LabelTarget): Set<AffectPlace> {
  const seen = new Set<AffectPlace>()
  for (const multi of [false, true]) {
    const base = mkCfg(multi)
    const b = surfaces(base, multi)
    const a = surfaces(apply(base, target), multi)
    const hasTot = true
    if (has(a.rowHeaders) || has(a.columnHeaders) && !has(b.columnHeaders)) seen.add('tableHeader')
    if (has(a.rowLabels)) seen.add('rowHeader')
    if (has(a.summaryLabel) || (hasTot && has(a.measureLabels)) || a.totalText !== b.totalText) seen.add('totalsRow')
    if (a.cellText !== b.cellText) seen.add('cells')
    if (has(a.xTitle)) seen.add('axisX')
    if (has(a.yTitle)) seen.add('axisY')
    if (has(a.colorTitle) || has(a.rowsSeries)) seen.add('legend')
    if (has(a.title)) seen.add('chartTitle')
    if (has(a.tooltip) || has(a.rowsX) || has(a.rowsSeries) || a.rowsText !== b.rowsText) seen.add('tooltip')
    if (has(a.rowsX) || a.rowsValue !== b.rowsValue) seen.add('chartTicks')
    if (has(a.exported) || a.exported !== b.exported) seen.add('export')
  }
  return seen
}

describe('affectsOf is pinned to real render behaviour', () => {
  for (const k of KINDS) {
    it(`${k.name}: claimed places equal the places where the label is observed (table model / chart spec / chart rows / export model)`, () => {
      expect([...observe(k.target)].sort()).toEqual([...affectsOf(k.target)].sort())
    })
  }
})
