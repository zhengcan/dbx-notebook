import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/export/options'
import { buildExportModel, type ExportModel } from '../src/export/model'
import { renderExportHtml, type ExportLabels } from '../src/export/html'
import { printCss } from '../src/export/printCss'

const L: ExportLabels = {
  exporter: 'By',
  firstN: () => '', truncatedAtRun: () => '', empty: '', exportedAt: 'Exported', dataRunAt: 'Run', dataSource: 'Source',
  chartUnavailable: '', noData: '', page: '', serial: '#', summary: '', notSet: '', continued: '', colon: ': ', listSep: ', ',
}
const res = { columns: [{ name: 'x' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'x' }
const sql = (id: string, name: string) => ({ id, type: 'sql', content: 'select 1', metadata: { resultName: name } })
const md = (id: string) => ({ id, type: 'markdown', content: 'hello', metadata: {} })
function mk(blocks: any[], runs: Record<string, any>, extra: any = {}) {
  return {
    nb: ref({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [{ id: 'HOSTCONN', name: 'HostSentinel', host: 'h.sentinel', user: 'u_sentinel' }], blocks }),
    runs: new Map(Object.entries(runs)), analysis: new Map(), bigNumbers: new Map(Object.entries(extra.bigNumbers ?? {})),
    isStale: () => false, isPartial: () => false, transposed: new Map(),
  } as any
}
const run = (at: string) => ({ status: 'ok', result: res, executedAt: at })
const H = (o: Partial<ExportOptions['header']> = {}): ExportOptions['header'] => ({ exportedAt: true, dataRunAt: true, dataSource: true, exporter: false, ...o })
const build = (store: any, o: Partial<ExportOptions> = {}, dsn: (b: any) => string | undefined = () => 'DS1') =>
  buildExportModel({ store, options: { ...DEFAULT_EXPORT_OPTIONS, header: H(), ...o }, now: new Date('2026-10-20T08:00:00Z'), documentTitle: 'T', dataSourceName: dsn })
const render = (m: ExportModel, o: Partial<ExportOptions> = {}) => renderExportHtml(m, { ...DEFAULT_EXPORT_OPTIONS, header: H(), ...o }, {}, L)
const parse = (h: string) => new DOMParser().parseFromString(h, 'text/html')

describe('model.runTimes', () => {
  it('lists each exported block with a result in block order, numbered by notebook position', () => {
    const s = mk([md('m'), sql('b', 'B'), sql('a', 'A')], { a: run('2026-10-20T01:00:00Z'), b: run('2026-10-20T02:00:00Z') })
    expect(build(s).runTimes).toEqual([
      { blockId: 'b', index: 2, name: 'B', at: '2026-10-20T02:00:00Z' },
      { blockId: 'a', index: 3, name: 'A', at: '2026-10-20T01:00:00Z' },
    ])
    expect((build(s) as any).dataRunAt).toBeUndefined()
  })
  it('blocks without results or excluded are not listed', () => {
    const s = mk([sql('a', 'A'), sql('b', 'B'), sql('c', 'C')], { a: run('2026-10-20T01:00:00Z'), b: { status: 'idle' }, c: run('2026-10-20T03:00:00Z') })
    const m = build(s, { blocks: { c: { include: false, transpose: 'follow' } } })
    expect(m.runTimes.map((r) => r.blockId)).toEqual(['a'])
  })
  it('chart over one SQL block lists that SQL block once', () => {
    const chart = { id: 'c', type: 'chart', content: '', metadata: { data: 'A', spec: { mark: 'bar' } } }
    const c2 = { id: 'c2', type: 'chart', content: '', metadata: { data: 'A', spec: { mark: 'bar' } } }
    const s = mk([sql('a', 'A'), chart, c2], { a: run('2026-10-20T01:00:00Z') })
    const m = build(s)
    expect(m.sections.map((x) => x.kind)).toEqual(['table', 'chart', 'chart'])
    expect(m.runTimes).toEqual([{ blockId: 'a', index: 1, name: 'A', at: '2026-10-20T01:00:00Z' }])
  })
  it('data sources deduped, names only', () => {
    const s = mk([sql('a', 'A'), sql('b', 'B')], { a: run('2026-10-20T01:00:00Z'), b: run('2026-10-20T01:00:00Z') })
    const m = build(s)
    expect(m.dataSources).toEqual(['DS1'])
    expect(JSON.stringify(m)).not.toMatch(/sentinel|HOSTCONN/)
  })
  it('dataSource toggle off → none; exporter placeholder is null', () => {
    const s = mk([sql('a', 'A')], { a: run('2026-10-20T01:00:00Z') })
    expect(build(s, { header: H({ dataSource: false }) }).dataSources).toEqual([])
    expect(build(s).exporter).toBeNull()
  })
})

const model = (over: Partial<ExportModel> = {}): ExportModel => ({
  documentTitle: 'T', exportedAt: '2026-10-20T08:00:00.000Z', runTimes: [{ blockId: 'a', index: 2, name: 'Sales', at: '2026-10-20T08:05:00' }],
  dataSources: ['DS1', 'DS2'], note: 'n1\nn2', exporter: null,
  sections: [{ kind: 'markdown', blockId: 'm', source: 'hello' }], catalog: [], skipped: [], staleBlockIds: [],
  estimate: { totalRows: 0, bigTables: [] }, exportable: true, ...over,
})

describe('info block html', () => {
  it('is the last element in <body>, directly preceded by hr.info-sep', () => {
    const d = parse(render(model()))
    const kids = Array.from(d.body.children)
    expect(kids[kids.length - 1].matches('footer.export-info')).toBe(true)
    expect(kids[kids.length - 2].matches('hr.info-sep')).toBe(true)
  })
  it('info rows appear in order exporter, exportedAt, dataSource, runAt, note', () => {
    const h = render(model({ exporter: 'Zed' }), { header: H({ exporter: true } as any) })
    const pos = ['By: Zed', 'Exported: 2026', 'Source: DS1', 'Run: ', '#2 Sales', 'class="note"'].map((x) => h.indexOf(x))
    expect(pos.every((x) => x > 0)).toBe(true)
    expect([...pos].sort((x, y) => x - y)).toEqual(pos)
  })
  it('any subset renders in the same relative order', () => {
    const d = parse(render(model({ exporter: 'Zed' }), { header: H({ exporter: true, exportedAt: false, dataRunAt: false } as any) }))
    const rows = Array.from(d.querySelectorAll('.export-info > *')).map((x) => x.textContent)
    expect(rows).toEqual(['By: Zed', 'Source: DS1, DS2', 'n1\nn2'])
  })
  it('info-sep has margin-top >= 1.5em', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/\.info-sep\{[^}]*margin:(?:[2-9]|1\.5)(?:\.\d)?em 0 8px/)
  })
  it('run times follow the given (block) order, one line each', () => {
    const rt = [{ blockId: 'b', index: 2, name: 'B', at: '2026-10-20T02:00:00' }, { blockId: 'a', index: 3, name: 'A', at: '2026-10-20T01:00:00' }]
    const lines = Array.from(parse(render(model({ runTimes: rt }))).querySelectorAll('.export-info li')).map((x) => x.textContent)
    expect(lines).toEqual(['#2 B · 2026-10-20 02:00', '#3 A · 2026-10-20 01:00'])
  })
  it('escapes text, preserves note newlines', () => {
    const h = render(model({ note: '<img src=x onerror=1>\nb', dataSources: ['<b>x</b>'], runTimes: [{ blockId: 'a', index: 1, name: '<i>n</i>', at: 'bad' }] }))
    const d = parse(h)
    expect(d.querySelector('.export-info img, .export-info b, .export-info i')).toBeNull()
    expect(d.querySelector('.export-info .note')!.textContent).toBe('<img src=x onerror=1>\nb')
  })
  it('toggles control the rows', () => {
    const d = parse(render(model(), { header: H({ exportedAt: false, dataRunAt: false, dataSource: false }) }))
    expect(d.querySelector('.export-info .note')).not.toBeNull()
    expect(d.querySelectorAll('.export-info > *').length).toBe(1)
  })
  it('all rows disabled/empty → neither hr nor footer', () => {
    const h = render(model({ note: '', runTimes: [], dataSources: [] }), { header: H({ exportedAt: false }) })
    expect(h).not.toContain('class="info-sep"')
    expect(h).not.toContain('<footer')
    const h2 = render(model(), { header: H({ exportedAt: false, dataRunAt: false, dataSource: false }), note: '' })
    expect(h2).toContain('class="note"')
    expect(render(model({ note: '' }), { header: H({ exportedAt: false, dataRunAt: false, dataSource: false }) })).not.toContain('class="info-sep"')
  })
  it('nothing of the info block appears before the first section', () => {
    const h = render(model())
    const first = h.indexOf('class="md"')
    expect(h.slice(0, first)).not.toMatch(/Exported|DS1|n1|Sales|class="note"/)
    expect(h.slice(0, first)).not.toContain('class="meta"')
  })
  it('print css avoids splitting the info block', () => {
    const css = printCss({ orientation: 'portrait' })
    expect(css).toMatch(/\.export-info\{[^}]*break-inside:avoid/)
    expect(css).toMatch(/\.info-sep\{/)
    expect(css).toMatch(/hr\{break-after:avoid\}/)
  })
})

describe('exporter name', () => {
  const st = () => mk([sql('a', 'A')], { a: run('2026-10-20T01:00:00Z') })
  const HE = (e: boolean) => H({ exporter: e } as any)
  it('model.exporter set only when option on and name present', () => {
    expect(build(st(), { header: HE(true) }).exporter).toBeNull()
    const b = (o: boolean, n: string | null | undefined) => buildExportModel({ store: st(), options: { ...DEFAULT_EXPORT_OPTIONS, header: HE(o) }, now: new Date(), exporter: n, dataSourceName: () => 'DS' } as any).exporter
    expect(b(true, '张 三')).toBe('张 三')
    expect(b(false, '张 三')).toBeNull()
    expect(b(true, null)).toBeNull()
    expect(b(true, '  ')).toBeNull()
  })
  it('defaults: header.exporter is true', () => {
    expect((DEFAULT_EXPORT_OPTIONS.header as any).exporter).toBe(true)
  })
  it('row escaped, labelled and first in the info block; zh and en labels', () => {
    const m = model({ exporter: '张 <三>&' })
    for (const [lab, colon] of [['导出人', '：'], ['Exported by', ': ']]) {
      const d = parse(renderExportHtml(m, { ...DEFAULT_EXPORT_OPTIONS, header: H() }, {}, { ...L, exporter: lab, colon }))
      const kids = Array.from(d.querySelectorAll('.export-info > *'))
      expect(kids[0].textContent).toBe(`${lab}${colon}张 <三>&`)
      expect(d.querySelector('.export-info')!.innerHTML).toContain('张 &lt;三&gt;&amp;')
    }
  })
  it('null → no row', () => {
    expect(render(model({ exporter: null }))).not.toContain('Exported by')
  })
})
