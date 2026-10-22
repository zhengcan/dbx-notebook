import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type ExportOptions } from '../src/export/options'
import { buildExportModel, suggestColumnBreaks } from '../src/export/model'
import { renderExportHtml } from '../src/export/html'
import { buildExportLabels } from '../src/export/labels'
import { setLocale, t } from '../src/i18n'

describe('normalizeExportOptions', () => {
  it('never throws and falls back to defaults', () => {
    for (const raw of [undefined, null, 'x', [], 5]) expect(normalizeExportOptions(raw)).toEqual(DEFAULT_EXPORT_OPTIONS)
    const o = normalizeExportOptions({ rowLimit: -5, repeatCols: 99, orientation: 'x' })
    expect(o.rowLimit).toBe(1)
    expect(o.repeatCols).toBe(5)
    expect(o.orientation).toBe('portrait')
    expect(normalizeExportOptions({ rowLimit: 9e9 }).rowLimit).toBe(1000000)
    expect(normalizeExportOptions({ rowLimit: 'abc' }).rowLimit).toBe('all')
  })
  it('cleans columnBreaks', () => {
    expect(normalizeExportOptions({ columnBreaks: { a: [3, 1, 1, 'x', -2, 1.5] } }).columnBreaks).toEqual({ a: [1, 3] })
  })
  it('keeps valid values', () => {
    const o = normalizeExportOptions({ format: 'html', includeSql: true, header: { title: true }, note: 'hi', orientation: 'landscape', filtersLine: false })
    expect(o).toMatchObject({ format: 'html', includeSql: true, note: 'hi', orientation: 'landscape', filtersLine: false })
    expect(o.header).toEqual({ exportedAt: true, dataRunAt: true, dataSource: true, exporter: true })
    expect(normalizeExportOptions({ header: { dataSource: true } }).header.dataSource).toBe(true)
    expect(DEFAULT_EXPORT_OPTIONS).toMatchObject({ includeSql: false, filtersLine: true, note: '', rowLimit: 'all' })
  })
})

type Run = { status: string; result?: any; executedAt?: string; partial?: boolean }
const res = (cols: string[], rows: unknown[][], truncated = false) => ({ columns: cols.map((name) => ({ name })), rows, truncated, elapsedMs: 1, dbType: 'x' })
function mk(blocks: any[], runs: Record<string, Run> = {}, extra: { analysis?: any; bigNumbers?: any; stale?: string[]; partial?: string[]; transposed?: string[] } = {}) {
  return {
    nb: ref({ sqlnb: '1', metadata: { title: 'My <T>' }, settings: { outputs: 'separate' }, connections: [], blocks }),
    runs: new Map(Object.entries(runs)),
    analysis: new Map(Object.entries(extra.analysis ?? {})),
    bigNumbers: new Map(Object.entries(extra.bigNumbers ?? {})),
    isStale: (id: string) => (extra.stale ?? []).includes(id),
    isPartial: (id: string) => (extra.partial ?? []).includes(id),
    transposed: new Map((extra.transposed ?? []).map((i) => [i, true])),
  } as any
}
const NOW = new Date('2026-10-18T10:00:00Z')
const build = (store: any, o: Partial<ExportOptions> = {}) =>
  buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS, ...o }, now: NOW, dataSourceName: () => 'secret-db' })
const sqlB = (id: string, extra: any = {}) => ({ id, type: 'sql', content: 'select 1 -- ' + id, metadata: { resultName: id, ...extra } })

describe('normalizeExportOptions filtersLine compatibility', () => {
  it('remembered true/false kept, missing defaults to true', () => {
    expect(normalizeExportOptions({ filtersLine: true }).filtersLine).toBe(true)
    expect(normalizeExportOptions({ filtersLine: false }).filtersLine).toBe(false)
    expect(normalizeExportOptions({}).filtersLine).toBe(true)
    expect(normalizeExportOptions({ filtersLine: 'x' }).filtersLine).toBe(true)
  })
})

describe('buildExportModel', () => {
  it('defaults: SQL off, header items (incl. data source name) on', () => {
    const s = mk([sqlB('a')], { a: { status: 'ok', result: res(['x'], [[1]]), executedAt: '2026-10-18T09:00:00Z' } })
    const m = build(s)
    expect((m.sections[0] as any).sql).toBeUndefined()
    expect(m.dataSources).toEqual(['secret-db'])
    expect((m as any).title).toBeUndefined(); expect(JSON.stringify(m)).not.toContain('My <T>')
    expect(build(s, { header: { ...DEFAULT_EXPORT_OPTIONS.header, dataSource: true } }).dataSources).toEqual(['secret-db'])
    const m2 = build(s, { includeSql: true, header: { exportedAt: true, dataRunAt: true, dataSource: true, exporter: false } })
    expect((m2.sections[0] as any).sql).toBe('select 1 -- a')
    expect(m2.dataSources).toEqual(['secret-db'])
    expect((m2 as any).title).toBeUndefined()
    expect(m2.runTimes.map((r) => r.at)).toEqual(['2026-10-18T09:00:00Z'])
    expect(m2.exportedAt).toBe(NOW.toISOString())
  })
  it('skips blocks without results and errors', () => {
    const s = mk([sqlB('a'), sqlB('b'), sqlB('c')], { b: { status: 'idle' }, c: { status: 'error' } })
    const m = build(s)
    expect(m.sections).toEqual([])
    expect(m.skipped.map((x) => [x.blockId, x.reason])).toEqual([['a', 'no-result'], ['b', 'no-result'], ['c', 'error']])
    expect(m.exportable).toBe(false)
  })
  describe('input-variable blocks', () => {
    const inp = (id: string, variable: any, value: any, inputType = 'text') => ({ id, type: 'input', metadata: { variable, inputType, value } })
    const ok = { status: 'ok', result: res(['x'], [[1]]) }
    it('become sections in notebook order and have no aggregate', () => {
      const s = mk([{ id: 'm', type: 'markdown', content: 'hi' }, inp('i1', 'city', 'Paris'), sqlB('a'), inp('i2', 'n', 3)], { a: ok })
      const m = build(s)
      expect(m.sections.map((x) => x.kind)).toEqual(['markdown', 'input', 'table', 'input'])
      expect(m.sections[1]).toEqual({ kind: 'input', blockId: 'i1', name: 'city', text: 'Paris' })
      expect('filters' in m).toBe(false)
      expect(m.catalog.map((c) => c.blockId)).toEqual(['m', 'i1', 'a', 'i2'])
    })
    it('formats values', () => {
      const texts = (v: any) => (build(mk([inp('i', 'v', v)])).sections[0] as any).text
      expect(texts('abc')).toBe('abc')
      expect(texts(42)).toBe('42')
      expect(texts(10n ** 20n)).toBe('100000000000000000000')
      expect(texts('2026-10-01')).toBe('2026-10-01')
      expect(texts(true)).toBe('true')
      expect(texts(['a', 'b', 3])).toBe('a, b, 3')
    })
    it('empty values give empty text', () => {
      for (const v of [undefined, null, '', []]) expect((build(mk([inp('i', 'v', v)])).sections[0] as any).text).toBe('')
    })
    it('uses the current value, not the one the SQL ran with', () => {
      const store = mk([inp('i', 'k', 'old'), sqlB('a', { params: { k: 'old' } })], { a: ok })
      store.nb.value.blocks[0].metadata.value = 'new'
      expect((build(store).sections[0] as any).text).toBe('new')
    })
    it('filtersLine=false omits; per-block exclude omits; empty name skipped', () => {
      const s = mk([inp('i1', 'a', '1'), inp('i2', 'b', '2'), inp('i3', '', 'x'), inp('i4', undefined, 'x')])
      expect(build(s, { filtersLine: false }).sections).toEqual([])
      const m = build(s, { blocks: { i1: { include: false } } as any })
      expect(m.sections.map((x: any) => x.name)).toEqual(['b'])
      expect(m.catalog.find((c) => c.blockId === 'i1')!.included).toBe(false)
    })
    it('catalog labels an input block by its variable name; empty-name inputs are not listed', () => {
      const m = build(mk([inp('i1', 'city', 'x'), inp('i2', '', 'x')]))
      expect(m.catalog.map((c) => [c.blockId, c.type, c.label])).toEqual([['i1', 'input', 'city']])
    })
    it('other sections carry no filters/params', () => {
      const m = build(mk([inp('i', 'k', 'v'), sqlB('a', { params: { k: 'v' } })], { a: ok }))
      const t = m.sections[1] as any
      expect(Object.keys(t).filter((k) => /filter|param/i.test(k))).toEqual([])
    })
  })
  it('row limit', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [i])
    const s = mk([sqlB('a')], { a: { status: 'ok', result: res(['n'], rows) } })
    const t = build(s, { rowLimit: 50 }).sections[0] as any
    expect([t.shownRows, t.totalRows, t.limitedNote, t.rows.length]).toEqual([50, 120, 'first-n', 50])
    const all = build(s).sections[0] as any
    expect([all.shownRows, all.totalRows, all.limitedNote]).toEqual([120, 120, null])
  })
  it('truncated at run', () => {
    const s = mk([sqlB('a')], { a: { status: 'ok', result: res(['n'], [[1], [2], [3]], true) } })
    const t = build(s).sections[0] as any
    expect([t.limitedNote, t.totalRows, t.shownRows]).toEqual(['truncated-at-run', 3, 3])
  })
  it('cell text', () => {
    const long = 'x'.repeat(5000)
    const s = mk([sqlB('a')], { a: { status: 'ok', result: res(['a', 'b', 'c', 'd', 'e'], [[null, { k: 1 }, [1, 2], 12345678901234567890n, long], ['中文😀', 'ok', 'ok', 7n, 'ok']]) } })
    const t = build(s).sections[0] as any
    expect(t.rows[0].slice(0, 4)).toEqual(['', '{"k":1}', '[1,2]', '12345678901234567890'])
    expect(t.rows[0][4]).toBe(long)
    expect(t.nullMask[0]).toEqual([true, false, false, false, false])
    expect(t.rows[1][0]).toBe('中文😀')
    expect(t.numeric).toEqual([false, false, false, true, false])
  })
  it('column groups', () => {
    const s = mk([sqlB('b')], { b: { status: 'ok', result: res(['a', 'b', 'c', 'd', 'e', 'f'], [[1, 2, 3, 4, 5, 6]]) } })
    expect((build(s, { columnBreaks: { b: [1, 3] } }).sections[0] as any).groups).toEqual([{ cols: [0, 1] }, { cols: [2, 3] }, { cols: [4, 5] }])
    expect((build(s, { columnBreaks: { b: [] } }).sections[0] as any).groups).toEqual([{ cols: [0, 1, 2, 3, 4, 5] }])
    expect((build(s, { columnBreaks: { b: [2, 99, 5] } }).sections[0] as any).groups).toEqual([{ cols: [0, 1, 2] }, { cols: [3, 4, 5] }])
    const b = suggestColumnBreaks(10, 3)
    expect(b).toHaveLength(2)
    expect(b[0]).toBeLessThan(b[1])
    expect(suggestColumnBreaks(10, 1)).toEqual([])
  })
  it('zero rows, stale and partial', () => {
    const s = mk([sqlB('a'), sqlB('p')], { a: { status: 'ok', result: res(['x'], []) }, p: { status: 'ok', result: res(['x'], [[1]]) } }, { stale: ['a'], partial: ['p'] })
    const m = build(s)
    const t = m.sections[0] as any
    expect(t.rows).toEqual([])
    expect(t.groups).toEqual([{ cols: [0] }])
    expect(m.staleBlockIds).toEqual(['a'])
    expect(JSON.stringify(m.sections)).not.toMatch(/stale|partial/i)
  })
  it('exportable', () => {
    expect(build(mk([{ id: 'm', type: 'markdown', content: '# hi' }])).exportable).toBe(true)
    expect(build(mk([{ id: 'm', type: 'markdown', content: '# hi' }])).sections).toEqual([{ kind: 'markdown', blockId: 'm', source: '# hi' }])
    expect(build(mk([{ id: 'in', type: 'input', metadata: { variable: 'v', inputType: 'text', value: 1 } }])).exportable).toBe(false)
  })
  it('estimate', () => {
    const rows = Array.from({ length: 6000 }, (_, i) => [i])
    const s = mk([sqlB('a'), sqlB('b')], { a: { status: 'ok', result: res(['n'], rows) }, b: { status: 'ok', result: res(['n'], [[1]]) } })
    expect(build(s).estimate).toEqual({ totalRows: 6001, bigTables: [{ blockId: 'a', rows: 6000 }] })
    expect(build(s, { rowLimit: 100 }).estimate).toEqual({ totalRows: 101, bigTables: [] })
  })
})

const pivotCfg = { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'sum', label: 'Total', format: { kind: 'thousands', decimals: 0 } }] }
const okRes = { status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', long: { dims: ['r'], measures: ['v'], rows: [['a', 1234], ['b', 5]] } }
const srcRuns = { s: { status: 'ok', result: res(['r', 'v'], [['a', 1234], ['b', 5]]) } }
const chartB = (view: string, extra: any = {}) => ({ id: 'c', type: 'chart', metadata: { data: 's', view, chartOptions: { type: 'bar' }, pivot: pivotCfg, ...extra } })

describe('analysis blocks', () => {
  it('outputs pivot/chart by view', () => {
    const run = (view: string) => build(mk([sqlB('s'), chartB(view)], srcRuns, { analysis: { c: okRes } })).sections.filter((x) => x.blockId === 'c').map((x) => x.kind)
    expect(run('table')).toEqual(['pivot'])
    expect(run('chart')).toEqual(['chart'])
    expect(run('both')).toEqual(['pivot', 'chart'])
    const p = build(mk([sqlB('s'), chartB('table')], srcRuns, { analysis: { c: okRes } })).sections[1] as any
    expect(p.model.rowLabels).toEqual([['a'], ['b']])
    expect(p.model.cells).toEqual([['1,234'], ['5']])
  })
  it('chart title becomes the pivot (table) caption; chart section keeps its own title', () => {
    const co = { type: 'bar', title: 'Rev <by> region' }
    const sec = (view: string, chartOptions: any = co) => build(mk([sqlB('s'), chartB(view, { chartOptions })], srcRuns, { analysis: { c: okRes } })).sections.filter((x) => x.blockId === 'c') as any[]
    const both = sec('both')
    expect(both.map((x) => x.kind)).toEqual(['pivot', 'chart'])
    expect(both[0].title).toBe('Rev <by> region')
    expect(both[1].title).toBe('Rev <by> region')
    expect(sec('table')[0].title).toBe('Rev <by> region')
    const chartOnly = sec('chart')
    expect(chartOnly.map((x) => x.kind)).toEqual(['chart'])
    expect(chartOnly[0].title).toBe('Rev <by> region')
    for (const v of ['both', 'table', 'chart']) for (const x of sec(v, { type: 'bar', title: '' })) expect(x.title).toBeUndefined()
    for (const v of ['both', 'table']) expect(sec(v, { type: 'bar' })[0].title).toBeUndefined()
  })
  it('pivot section row order follows the value sort (summary count, no column field)', () => {
    const rows = [['k1', 6], ['k2', 1], ['k3', 0], ['k4', 16], ['k5', 0]]
    const pv = { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'count', summary: 'count', label: 'N' }] }
    const out = (dir: string) => (build(mk([sqlB('s'), chartB('table', { pivot: { ...pv, sort: { by: 'value', valueIndex: 0, dir } } })], srcRuns, { analysis: { c: { ...okRes, long: { dims: ['r'], measures: ['v'], rows } } } })).sections[1] as any).model.cells.map((r: string[]) => r[0])
    expect(out('asc')).toEqual(['0', '0', '1', '6', '16'])
    expect(out('desc')).toEqual(['16', '6', '1', '0', '0'])
  })
  it('skips empty / missing results', () => {
    const m = build(mk([sqlB('s'), chartB('both')], srcRuns, { analysis: { c: { ...okRes, status: 'empty' } } }))
    expect(m.skipped.find((x) => x.blockId === 'c')?.reason).toBe('no-result')
    const m2 = build(mk([sqlB('s'), chartB('both')], srcRuns))
    expect(m2.skipped.find((x) => x.blockId === 'c')?.reason).toBe('no-result')
    const m3 = build(mk([sqlB('s'), chartB('both')], srcRuns, { analysis: { c: { ...okRes, status: 'error' } } }))
    expect(m3.skipped.find((x) => x.blockId === 'c')?.reason).toBe('error')
  })
  it('legacy spec-only chart uses source rows', () => {
    const b = { id: 'c', type: 'chart', metadata: { data: 's', spec: { mark: 'bar' } } }
    const m = build(mk([sqlB('s'), b], srcRuns))
    const c = m.sections.find((x) => x.kind === 'chart') as any
    expect(c.usesRawRows).toBe(true)
    expect(c.rows).toEqual([{ r: 'a', v: 1234 }, { r: 'b', v: 5 }])
  })
  it('big number', () => {
    const bn = { id: 'n', type: 'big-number', metadata: { data: 's', metrics: [{ field: 'v', aggregate: 'sum', label: 'Sum', format: { kind: 'thousands', decimals: 0 } }, { field: 'r', aggregate: 'count' }] } }
    const r = { status: 'ok', value: 1239, partial: false, ranAt: 'x', items: [{ value: 1239 }, { value: 2 }] }
    const m = build(mk([sqlB('s'), bn], srcRuns, { bigNumbers: { n: r } }))
    expect((m.sections[1] as any).items).toEqual([{ label: 'Sum', text: '1,239' }, { label: 'r', text: '2' }])
    const m2 = build(mk([sqlB('s'), bn], srcRuns))
    expect(m2.skipped.find((x) => x.blockId === 'n')?.reason).toBe('no-result')
  })
})

describe('big-number comparison text', () => {
  const bn = { id: 'n', type: 'big-number', metadata: { data: 's', metrics: [{ field: 'v', aggregate: 'sum' }, { field: 'r', aggregate: 'count' }] } }
  const cmp = { kind: 'mom', current: '2026-10', previous: '2026-09', currentValue: 112, previousValue: 100, deltaPct: 0.123 }
  const r = { status: 'ok', value: 1, partial: false, ranAt: 'x', items: [{ value: 112, compare: cmp }, { value: 2 }] }
  const run = (loc: 'en' | 'zh') => {
    setLocale(loc)
    const labels = buildExportLabels((k, p) => t(k as any, p as any))
    const store = mk([sqlB('s'), bn], srcRuns, { bigNumbers: { n: r } })
    return buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS }, now: NOW, dataSourceName: () => undefined, labels }).sections[1] as any
  }
  it('model item carries compare text (en)', () => {
    const s = run('en')
    expect(s.items[0].compare).toBe('▲ 12.3% vs 2026-09 (MoM)')
    expect('compare' in s.items[1]).toBe(false)
  })
  it('YoY wording (en + zh)', () => {
    const yoy = { ...r, items: [{ value: 112, compare: { ...cmp, kind: 'yoy', previous: '2025-10', deltaPct: -0.05 } }, { value: 2 }] }
    const go = (loc: 'en' | 'zh') => {
      setLocale(loc)
      const labels = buildExportLabels((k, p) => t(k as any, p as any))
      const store = mk([sqlB('s'), bn], srcRuns, { bigNumbers: { n: yoy } })
      return (buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS }, now: NOW, dataSourceName: () => undefined, labels }).sections[1] as any).items[0].compare
    }
    expect(go('en')).toBe('▼ 5.0% vs 2025-10 (YoY)')
    expect(go('zh')).toBe('▼ 5.0% 对比 2025-10（同比）')
  })
  it('zh wording', () => { expect(run('zh').items[0].compare).toBe('▲ 12.3% 对比 2026-09（环比）') })
  it('no labels → no compare', () => {
    const store = mk([sqlB('s'), bn], srcRuns, { bigNumbers: { n: r } })
    const s = buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS }, now: NOW, dataSourceName: () => undefined }).sections[1] as any
    expect(s.items[0]).toEqual({ label: 'v', text: '112' })
  })
})

describe('pivot empty label follows report language', () => {
  const nullRes = { ...okRes, long: { dims: ['r'], measures: ['v'], rows: [[null, 3], ['b', 5]] } }
  const render = (loc: 'en' | 'zh') => {
    setLocale(loc)
    const labels = buildExportLabels((k, p) => t(k as any, p as any))
    setLocale(loc === 'en' ? 'zh' : 'en')
    const store = mk([sqlB('s'), chartB('table')], srcRuns, { analysis: { c: nullRes } })
    const opts = { ...DEFAULT_EXPORT_OPTIONS }
    const model = buildExportModel({ store, options: opts, now: NOW, dataSourceName: () => undefined, labels })
    return renderExportHtml(model, opts, {}, labels)
  }
  it('en shows (empty)', () => {
    const h = render('en')
    expect(h).toContain('(empty)'); expect(h).not.toContain('（空）')
  })
  it('zh unchanged', () => { const h = render('zh'); expect(h).toContain('（空）'); expect(h).not.toContain('(empty)') })
})

import { renderChartSvgs } from '../src/export/chartSvg'
import { loadVega } from '../src/analysis/vegaRuntime'
describe('chart section uses resolved labels (Plan 13 T9 fix)', () => {
  it('rows carry mapped categories, scaled values and valueText; spec has custom titles; svg shows them', async () => {
    const pivot = { rows: [{ field: 'r', label: '渠道', valueLabels: { a: '线上' } }], columns: [], values: [{ field: 'v', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 1, unit: '万元', scale: 10000 } }] }
    const long = { dims: ['r'], measures: ['v'], rows: [['a', 125000], ['b', 50000]] }
    const m = build(mk([sqlB('s'), chartB('chart', { pivot, chartOptions: { type: 'bar', labels: true } })], srcRuns, { analysis: { c: { ...okRes, long } } }))
    const c = m.sections.find((x) => x.kind === 'chart') as any
    expect(c.rows.map((r: any) => r.x)).toEqual(['线上', 'b'])
    expect(c.rows.map((r: any) => r.value)).toEqual([12.5, 5])
    expect(c.rows[0].valueText).toBe('12.5万元')
    expect(c.spec.layer[0].encoding.x.title).toBe('渠道')
    expect(c.spec.layer[0].encoding.y.title).toBe('销售额（万元）')
    const r = await renderChartSvgs([c], 'portrait', { vega: loadVega })
    const svg = r.svgs.c.svg as string
    expect(svg).toContain('线上')
    expect(svg).toContain('销售额（万元）')
    expect(svg).toContain('>12.5万元<')
  })
})

describe('pivot section uses resolved labels (Plan 13 T12)', () => {
  const labelled = () => ({
    rows: [{ field: 'r', label: '渠道', valueLabels: { a: '线上<img src=x onerror=1>' }, nullLabel: '未知' }],
    columns: [{ field: 'k', label: '是否 VIP', valueLabels: { '0': '否', '1': '是' } }],
    values: [{ field: 'v', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 2, unit: '万元', scale: 10000 } }],
    totals: { row: true, column: true, grand: true }, summaryLabel: '合计',
  })
  const lng = { dims: ['r', 'k'], measures: ['v'], rows: [['a', 0, 12345678], [null, 1, 5000], ['b', 0, 100000000]] }
  const mkM = (pivot: any, long = lng) => build(mk([sqlB('s'), chartB('table', { pivot })], srcRuns, { analysis: { c: { ...okRes, long } } })).sections[1] as any
  it('headers, mapped categories, nullLabel, summary and scaled cells', () => {
    const m = mkM(labelled()).model
    expect(m.rowHeaders).toEqual(['渠道'])
    expect(m.measures).toEqual(['销售额'])
    expect(m.columnHeaders.map((h: string[]) => h[0])).toEqual(['否', '是'])
    expect(m.rowLabels.flat()).toContain('未知')
    expect(m.summaryLabel).toBe('合计')
    expect(m.cells.flat()).toContain('1,234.57万元')
  })
  it('sort stays raw-based (by value) while labels are mapped', () => {
    const p = { ...labelled(), sort: { by: 'value', valueIndex: 0, dir: 'desc' } }
    const m = mkM(p).model
    expect(m.cells.map((r: string[]) => r[0])[0]).toBe('10,000.00万元')
  })
  it('html escapes hostile labels and uses the custom summary', () => {
    const store = mk([sqlB('s'), chartB('table', { pivot: labelled() })], srcRuns, { analysis: { c: { ...okRes, long: lng } } })
    const opts = { ...DEFAULT_EXPORT_OPTIONS }
    const labels = buildExportLabels((k, p) => t(k as any, p as any))
    const html = renderExportHtml(buildExportModel({ store, options: opts, now: NOW, dataSourceName: () => undefined, labels }), opts, {}, labels)
    expect(html).toContain('线上&lt;img src=x onerror=1&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toMatch(/<th[^>]*>合计<\/th>/)
    expect(html).toContain('销售额')
    expect(html).not.toContain('valueLabels')
    expect(html).not.toContain('"scale"')
  })
  it('unlabelled pivot keeps auto headers and cells', () => {
    const p = (build(mk([sqlB('s'), chartB('table')], srcRuns, { analysis: { c: okRes } })).sections[1] as any).model
    expect(p.rowHeaders).toEqual(['r'])
    expect(p.measures).toEqual(['Total'])
    expect(p.cells).toEqual([['1,234'], ['5']])
  })
  it('ExportOptions has no label key', () => {
    expect(Object.keys(DEFAULT_EXPORT_OPTIONS).filter((k) => /label/i.test(k))).toEqual([])
  })
})

describe('pivot export golden / privacy (Plan 13 T12)', () => {
  const html = (pivot: any, long: any) => {
    const store = mk([sqlB('s'), chartB('table', { pivot })], srcRuns, { analysis: { c: { ...okRes, long } } })
    const opts = { ...DEFAULT_EXPORT_OPTIONS }
    const labels = buildExportLabels((k, p) => t(k as any, p as any))
    const model = buildExportModel({ store, options: opts, now: NOW, dataSourceName: () => undefined, labels })
    return { model, out: renderExportHtml(model, opts, {}, labels) }
  }
  it('unlabelled pivot HTML is byte-identical to the pre-change output', () => {
    const p = { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'sum', format: { kind: 'thousands', decimals: 0 } }], totals: { column: true } }
    const out = html(p, { dims: ['r'], measures: ['v'], rows: [['a', 1234], ['b', 5]] }).out
    const m = out.match(/<table class="pivot">.*?<\/table>/s)![0]
    expect(m).toBe('<table class="pivot"><thead><tr><th>r</th><th>sum(v)</th></tr></thead><tbody><tr><th>a</th><td class="num">1,234</td></tr><tr><th>b</th><td class="num">5</td></tr><tr><th>Total</th><td class="num">1,239</td></tr></tbody></table>')
  })
  it('export model never carries raw valueLabels / overrides', () => {
    const p = { rows: [{ field: 'r', valueLabels: { a: 'SECRETMAP' } }], columns: [], values: [{ field: 'v', agg: 'sum', label: 'X' }] }
    const { model, out } = html(p, { dims: ['r'], measures: ['v'], rows: [['zz', 1]] })
    expect(JSON.stringify(model)).not.toContain('SECRETMAP')
    expect(out).not.toContain('SECRETMAP')
    expect(out).not.toContain('valueLabels')
  })
  it('keeps RTL, emoji, {{x}}, quotes and 200-char labels whole and escaped', () => {
    const long = 'x'.repeat(200)
    const p = { rows: [{ field: 'r', valueLabels: { a: 'مبيعات 🚀 {{x}} "q" \'s\' &amp;', b: long } }], columns: [], values: [{ field: 'v', agg: 'sum', label: '<script>alert(1)</script>' }] }
    const { out } = html(p, { dims: ['r'], measures: ['v'], rows: [['a', 1], ['b', 2]] })
    expect(out).toContain('مبيعات 🚀 {{x}} &quot;q&quot; ')
    expect(out).toContain('&amp;amp;')
    expect(out).toContain(`<th>${long}</th>`)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('<script>alert')
  })
})
