// Generates the sample export HTML files used by scripts/export-check.mjs (run with vite-node; needs a DOM only for DOMPurify/DOMParser).
import { mkdirSync, writeFileSync } from 'node:fs'
import { markdownCss, MD_TOKEN_VARS } from '../src/ui/markdownCss'
import { JSDOM, VirtualConsole } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { virtualConsole: new VirtualConsole() })
for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'NodeFilter']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : (dom.window as any)[k], configurable: true, writable: true })
}

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })

const { ref } = await import('vue')
const { buildExportModel } = await import('../src/export/model')
const { renderExportHtml } = await import('../src/export/html')
const { renderChartSvgs } = await import('../src/export/chartSvg')
const { buildExportLabels } = await import('../src/export/labels')
const { DEFAULT_EXPORT_OPTIONS } = await import('../src/export/options')
const { setLocale, t } = await import('../src/i18n')
const vega = await import('vega')
const vl = await import('vega-lite')
const { expressionInterpreter } = await import('vega-interpreter')

setLocale('zh-CN')
const labels = buildExportLabels((k, p) => t(k as any, p as any))

// Headless vega runtime mirroring analysis/vegaRuntime.ts (no container; the SVG string is what matters).
const headless = async () => ({
  async render(_el: unknown, spec: any, data: unknown[], opts: any) {
    const s: any = { ...spec }
    if (opts.width && s.width === undefined) s.width = opts.width
    if (opts.height && s.height === undefined) s.height = opts.height
    if (s.autosize === undefined && typeof s.width === 'number' && typeof s.height === 'number') s.autosize = { type: 'fit', contains: 'padding' }
    const compiled = vl.compile(s, { config: opts.config }).spec as any
    const view = new vega.View(vega.parse(compiled, opts.config, { ast: true }), { expr: expressionInterpreter as any, renderer: 'none' })
    const names = (compiled.data ?? []).map((d: any) => d.name) as string[]
    view.data(names.includes('table') || !names.length ? 'table' : names[0], data as any[])
    await view.runAsync()
    return { view, svg: () => view.toSVG(), destroy: () => view.finalize() }
  },
})
;(globalThis as any).document.createElement = (globalThis as any).document.createElement.bind((globalThis as any).document)

const N = 30
const cols = Array.from({ length: N }, (_, i) => ({ name: i === 1 ? '名称' : `col${i}` }))
const rows = Array.from({ length: 100 }, (_, r) => cols.map((_, c) => (c === 1 ? (r === 0 ? '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">' : `中文名${r}`) : `v${r}_${c}`)))
const long = ['Very long category name number one', 'Very long category name number two', 'Very long category name number three', 'Another extremely long legend label']
const chartRows = long.flatMap((k, i) => ['Q1', 'Q2', 'Q3'].map((q, j) => ({ cat: k, q, amount: 10 + i * 5 + j })))
const chartRun = { columns: [{ name: 'cat' }, { name: 'q' }, { name: 'amount' }], rows: chartRows.map((r) => [r.cat, r.q, r.amount]), truncated: false, elapsedMs: 1, dbType: 'x' }
const blocks: any[] = [
  { id: 'm1', type: 'markdown', content: '# 标题\n\n<script>window.__pwned=3</script>\n\n[x](javascript:window.__pwned=4) ![r](https://example.com/a.png)', metadata: {} },
  { id: 'in1', type: 'input', content: '', metadata: { variable: '城市<b>', inputType: 'text', value: '上海 & <i>x</i>' } },
  { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'wide' } },
  { id: 's2', type: 'sql', content: 'select 2', metadata: { resultName: 'sales' } },
  { id: 'in2', type: 'input', content: '', metadata: { variable: 'empty', inputType: 'text', value: '' } },
  { id: 's3', type: 'sql', content: 'select 3', metadata: { resultName: 'tr' } },
  { id: 'c1', type: 'chart', content: '', metadata: { data: 'sales', spec: { mark: 'bar', encoding: { x: { field: 'q', type: 'nominal' }, y: { field: 'amount', type: 'quantitative' }, color: { field: 'cat', type: 'nominal' } } } } },
]
const store: any = {
  nb: ref({ sqlnb: '1', metadata: { title: '报告' }, settings: { outputs: 'separate' }, connections: [], blocks }),
  runs: new Map<string, any>([
    ['s1', { status: 'ok', result: { columns: cols, rows, truncated: false, elapsedMs: 1, dbType: 'x' }, executedAt: '2026-10-18T00:00:00Z' }],
    ['s3', { status: 'ok', result: { columns: [{ name: 'id' }, { name: 'name <b>' }, { name: 'amount' }], rows: [[1, 'alpha', 10], [2, null, 20], [3, '中文名', 30]], truncated: false, elapsedMs: 1, dbType: 'x' }, executedAt: '2026-10-18T00:00:00Z' }],
    ['s2', { status: 'ok', result: chartRun, executedAt: '2026-10-18T00:00:00Z' }],
  ]),
  analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
}
const mixedRows = Array.from({ length: 6 }, (_, r) => [r + 1, `2026-10-0${r + 1}`, `AB-${r}`, `Quarterly revenue reconciliation note for the regional office number ${r} covering supplier invoices, credit memos and manual adjustments booked late in the period ${'z'.repeat(r === 0 ? 80 : 0)}`, 1234.5 * (r + 1)])
const mixedRun = { columns: ['id', 'date', 'code', 'description', 'amount'].map((name) => ({ name })), rows: mixedRows, truncated: false, elapsedMs: 1, dbType: 'x' }
const mixedStore: any = {
  nb: ref({ sqlnb: '1', metadata: { title: 'm' }, settings: { outputs: 'separate' }, connections: [], blocks: [
    { id: 'u1', type: 'sql', content: 'select 1', metadata: { resultName: 'mixed_unpaged' } },
    { id: 'p1', type: 'sql', content: 'select 2', metadata: { resultName: 'mixed_paged' } },
  ] }),
  runs: new Map<string, any>([
    ['u1', { status: 'ok', result: mixedRun, executedAt: '2026-10-18T00:00:00Z' }],
    ['p1', { status: 'ok', result: mixedRun, executedAt: '2026-10-18T00:00:00Z' }],
  ]),
  analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
}
const transposedStore: any = { ...store, transposed: new Map([['s3', true]]) }

// Every label-override kind on one analysis block (table + chart): used by export-check / export-pdf-edge-check.
const LONG60 = '很长的自定义图例名称'.repeat(6)
const labPivot = {
  rows: [{ field: 'vip', label: '是否 VIP', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' }],
  columns: [{ field: 'ch', label: '渠道 <b>粗体</b>', valueLabels: { a: '线上 <img src=x onerror="window.__pwned=9">', b: LONG60 } }],
  values: [{ field: 'amt', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 2, unit: '万元', scale: 10000 } }],
  totals: { row: true, column: true, grand: true }, summaryLabel: '合计', sort: { by: 'value', valueIndex: 0, dir: 'desc' },
}
const labStore: any = {
  nb: ref({ sqlnb: '1', metadata: { title: '标签' }, settings: { outputs: 'separate' }, connections: [], blocks: [
    { id: 'ls', type: 'sql', content: 'select 1', metadata: { resultName: 'lab_src' } },
    { id: 'lab1', type: 'chart', content: '', metadata: { data: 'lab_src', view: 'both', chartOptions: { type: 'bar', labels: false, title: '季度销售 <b>报告</b>', axisTitles: { x: '会员类型', y: '金额（自定义）', legend: '渠道名称' } }, pivot: labPivot } },
  ] }),
  runs: new Map<string, any>([['ls', { status: 'ok', result: { columns: [{ name: 'vip', type: 'int' }, { name: 'ch', type: 'text' }, { name: 'amt', type: 'int' }], rows: [[0, 'a', 12345678], [1, 'a', 50000000], [null, 'a', 5000], [1, 'b', 3000000], [0, 'b', 100]], truncated: false, elapsedMs: 1, dbType: 'x' }, executedAt: '2026-10-18T00:00:00Z' }]]),
  analysis: new Map([['lab1', { status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', long: { dims: ['vip', 'ch'], measures: ['amt'], rows: [[0, 'a', 12345678], [1, 'a', 50000000], [null, 'a', 5000], [1, 'b', 3000000], [0, 'b', 100]] } }]]),
  bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
}

async function make(name: string, o: Partial<typeof DEFAULT_EXPORT_OPTIONS>, st: any = store) {
  const options = { ...DEFAULT_EXPORT_OPTIONS, note: '导出备注 <b>x</b>\n第二行', ...o }
  const model = buildExportModel({ store: st, options, now: new Date('2026-10-18T10:00:00Z'), documentTitle: 'export-fixture', dataSourceName: () => '生产数据库-主库' })
  const charts = model.sections.filter((s): s is any => s.kind === 'chart')
  const { svgs } = await renderChartSvgs(charts, options.orientation, { vega: headless as any })
  for (const [id, c] of Object.entries(svgs)) if (!c.svg) console.log('chart', id, 'failed:', c.error)
  writeFileSync(`${outDir}/${name}.html`, renderExportHtml(model, options, svgs, labels))
}
await make('paged', { orientation: 'portrait', repeatCols: 1, columnBreaks: { s1: [9, 19] } })
await make('fit-portrait', { orientation: 'portrait' })
await make('fit-landscape', { orientation: 'landscape' })
await make('auto-repeat', { orientation: 'portrait', repeatCols: 1 })
await make('transposed', { orientation: 'portrait' }, transposedStore)
await make('labels', { orientation: 'portrait' }, labStore)
await make('mixed', { orientation: 'portrait', columnBreaks: { p1: [3] } }, mixedStore)
console.log('fixtures written to', outDir)

{
  const cols = Array.from({ length: 12 }, (_, i) => `<th>column_number_${i}</th>`).join('')
  const row = Array.from({ length: 12 }, (_, i) => `<td>value_${i}</td>`).join('')
  writeFileSync(`${outDir}/mdwide.html`, `<!doctype html><style>${markdownCss('.md-view', MD_TOKEN_VARS)}</style><div class="md-view" style="width:400px"><table><thead><tr>${cols}</tr></thead><tbody><tr>${row}</tr></tbody></table></div>`)
}

