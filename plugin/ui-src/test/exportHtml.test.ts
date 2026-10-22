import { describe, it, expect } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/export/options'
import type { ExportModel, TableSection, Section } from '../src/export/model'
import { escapeHtml, renderMarkdownSafe, renderExportHtml, sanitizeSvg, fitFont, columnWrapClass, type ExportLabels } from '../src/export/html'
import { printCss } from '../src/export/printCss'

const labels: ExportLabels = {
  exporter: '导出人',
  firstN: (n, m) => `仅显示前 ${n} 行，共 ${m} 行`,
  truncatedAtRun: (k) => `数据在运行时已被截断，共导出 ${k} 行`,
  empty: '(empty)', exportedAt: '导出时间', dataRunAt: '数据运行时间', dataSource: '数据源',
  chartUnavailable: '图表不可用', noData: '无数据', page: '页', serial: '#',
  summary: '合计', continued: '续', colon: '：', listSep: '；', notSet: '（未设置）',
}
const enLabels: ExportLabels = { ...labels, exportedAt: 'Exported', dataSource: 'Source', dataRunAt: 'Run', colon: ': ', listSep: '; ', continued: 'continued', summary: 'Total', notSet: '(not set)' }
const X = '<script>alert(1)</script>'
const IMG = '"><img src=x onerror=alert(1)>'
const STY = '</style><script>alert(2)</script>'

function table(over: Partial<TableSection> = {}): TableSection {
  return {
    kind: 'table', blockId: 't1', columns: ['a', 'b', 'c'], rows: [['1', 'x', '3'], ['', 'y', '4']],
    nullMask: [[false, false, false], [true, false, false]], totalRows: 2, shownRows: 2, limitedNote: null,
    groups: [{ cols: [0, 1, 2] }], numeric: [true, false, true], ...over,
  }
}
function model(sections: Section[] = [table()], over: Partial<ExportModel> = {}): ExportModel {
  return {
    documentTitle: 'Title', exportedAt: '2026-10-18T00:00:00.000Z', runTimes: [{ blockId: 'a', index: 1, name: 'A', at: '2026-10-17T00:00:00.000Z' }], exporter: null, dataSources: [], note: '',
    sections, catalog: [], skipped: [], staleBlockIds: [], estimate: { totalRows: 2, bigTables: [] }, exportable: true, ...over,
  }
}
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...o })
const render = (m: ExportModel, o: Partial<ExportOptions> = {}, charts = {}) => renderExportHtml(m, opts(o), charts, labels)
const parse = (h: string) => new DOMParser().parseFromString(h, 'text/html')

describe('escapeHtml', () => {
  it('escapes all five', () => expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;'))
})

describe('self-contained', () => {
  it('has no scripts / external refs and has CSP', () => {
    const h = render(model([table(), { kind: 'markdown', blockId: 'm', source: 'hi [l](https://a.com)' }]), { header: { exportedAt: true, dataRunAt: true, dataSource: false, exporter: false } })
    const noLinks = h.replace(/<a [^>]*>/g, '')
    for (const bad of ['<script', '<link', '@import', 'src="http', 'url(http', 'javascript:', 'unsafe-eval']) expect(h).not.toContain(bad)
    expect(noLinks).not.toContain('href="http')
    expect(h).not.toMatch(/\son\w+=/)
    expect(h).toContain('<meta charset="utf-8">')
    expect(h).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`)
  })
  it('has no controls or stale marks', () => {
    const m = model([table()], { staleBlockIds: ['t1'] })
    const d = parse(render(m))
    expect(d.querySelectorAll('button, input, select, textarea, [contenteditable]').length).toBe(0)
    expect(d.body.textContent).not.toMatch(/已过期|stale|Stale/)
  })
})

describe('escaping', () => {
  it('escapes payloads everywhere', () => {
    const m = model([table({ columns: [X, IMG, STY], rows: [[X, IMG, STY]], nullMask: [[false, false, false]], title: X, sql: STY })],
      { documentTitle: X, note: IMG, dataSources: [STY] })
    const h = render(m, { includeSql: true, filtersLine: true, header: { exportedAt: false, dataRunAt: false, dataSource: true, exporter: false } })
    const d = parse(h)
    expect(d.querySelectorAll('script,img[onerror],img').length).toBe(0)
    const text = d.body.textContent!
    for (const p of [X, IMG, STY]) expect(text).toContain(p)
    expect(d.querySelector('title')!.textContent).toBe(X)
    expect(Array.from(d.querySelectorAll('th')).map((e) => e.textContent)).toEqual(expect.arrayContaining([X, IMG, STY]))
    expect(d.querySelectorAll('style').length).toBe(1)
  })
  it('markdown is sanitized', () => {
    const src = `${X}\n\n[x](javascript:alert(1))\n\n![pic](http://evil/x.png)\n\n<iframe src="http://e"></iframe>\n\n[ok](https://a.com) [m](mailto:a@b.c)`
    const d = parse(render(model([{ kind: 'markdown', blockId: 'm', source: src }])))
    expect(d.querySelectorAll('script,iframe,img').length).toBe(0)
    const hrefs = Array.from(d.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['http://e', 'https://a.com', 'mailto:a@b.c'])
    expect(d.body.textContent).toContain('pic')
    expect(d.querySelector('a')!.hasAttribute('target')).toBe(false)
  })
  it('markdown allows data images only', () => {
    const h = renderMarkdownSafe('![a](data:image/png;base64,AAAA) ![b](https://x/y.png)')
    expect(h).toContain('src="data:image/png;base64,AAAA"')
    expect(h).not.toContain('https://x/y.png"')
    expect(h).not.toMatch(/class=|style=|\son\w+=/)
  })
})

describe('table', () => {
  const wide = table({
    columns: ['a', 'b', 'c', 'd', 'e'], rows: [['1', '2', '3', '4', '5']], nullMask: [[false, false, false, false, false]],
    numeric: [false, false, false, false, false], groups: [{ cols: [0, 1] }, { cols: [2, 3] }, { cols: [4] }],
  })
  it('serial column first in every group, repeatCols prepended', () => {
    const d = parse(render(model([wide]), { repeatCols: 2 }))
    const heads = Array.from(d.querySelectorAll('thead tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent))
    expect(heads).toEqual([['#', 'a', 'b'], ['#', 'a', 'b', 'c', 'd'], ['#', 'a', 'b', 'e']])
    const bodyFirst = Array.from(d.querySelectorAll('tbody tr')).map((tr) => tr.children[0].textContent)
    expect(bodyFirst).toEqual(['1', '1', '1'])
    expect(d.querySelectorAll('.pg-break').length).toBe(2)
  })
  it('no repeat by default; no fixed-first-group repeat', () => {
    const d = parse(render(model([wide])))
    expect(Array.from(d.querySelectorAll('thead tr')).map((tr) => tr.children.length)).toEqual([3, 3, 2])
  })
  it('limited notes appear after the table', () => {
    const a = render(model([table({ limitedNote: 'first-n', shownRows: 2, totalRows: 9 })]))
    expect(a).toContain('仅显示前 2 行，共 9 行')
    expect(a.indexOf('</table>')).toBeLessThan(a.indexOf('仅显示前'))
    const b = render(model([table({ limitedNote: 'truncated-at-run', shownRows: 2 })]))
    expect(b).toContain('数据在运行时已被截断，共导出 2 行')
    expect(a).not.toContain('已被截断')
  })
  it('null cells and numeric alignment', () => {
    const d = parse(render(model()))
    const n = d.querySelector('td.null')!
    expect(n.textContent).toBe('')
    expect(d.querySelectorAll('td.num').length).toBeGreaterThan(0)
    expect(d.querySelectorAll('th.num').length).toBe(2)
    expect(d.querySelector('td:not(.num):not(.null):not(.serial)')).not.toBeNull()
  })
  it('wide unsplit table scales its font', () => {
    expect(fitFont(8)).toBe(100)
    expect(fitFont(1)).toBe(100)
    expect(fitFont(100)).toBe(60)
    expect(fitFont(20)).toBeLessThan(100)
    expect(fitFont(20)).toBeGreaterThan(fitFont(30))
    const cols = Array.from({ length: 20 }, (_, i) => `c${i}`)
    const t = table({ columns: cols, rows: [cols.map(() => '1')], nullMask: [cols.map(() => false)], numeric: cols.map(() => false), groups: [{ cols: cols.map((_, i) => i) }] })
    const h = render(model([t]))
    expect(h).toContain(`font-size:${fitFont(20)}%`)
    expect(h).not.toContain('table-layout:fixed')
  })
  it('zero rows shows noData', () => {
    const d = parse(render(model([table({ rows: [], nullMask: [], totalRows: 0, shownRows: 0 })])))
    expect(d.body.textContent).toContain('无数据')
    expect(d.querySelectorAll('tbody tr').length).toBe(0)
  })
  it('sql shown only when present', () => {
    expect(parse(render(model([table({ sql: 'select 1' })]))).querySelector('pre.sql')!.textContent).toBe('select 1')
    expect(parse(render(model())).querySelector('pre.sql')).toBeNull()
  })
  it('extreme text', () => {
    const big = 'x'.repeat(100000)
    const h = render(model([table({ rows: [[big, '中文😀', 'ש']], nullMask: [[false, false, false]] })]))
    expect(parse(h).querySelectorAll('td').length).toBeGreaterThan(3)
    expect(h).toContain('overflow-wrap:anywhere')
    expect(h).not.toContain('word-break:break-all')
    expect(h).toContain('中文😀')
    for (const f of ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei']) expect(h).toContain(f)
  })
})

describe('header', () => {
  const H = (o: Partial<ExportOptions['header']>): ExportOptions['header'] => ({ exportedAt: false, dataRunAt: false, dataSource: false, exporter: false, ...o })
  it('no h1; document title only in <title>', () => {
    const d = parse(render(model()))
    expect(d.querySelector('h1')).toBeNull()
    expect(d.title).toBe('Title')
  })
  it('data source shown by default, hidden when unchecked', () => {
    const m = model([table()], { dataSources: ['PROBE_DS'] })
    expect(render(m)).toContain('PROBE_DS')
    expect(render(m, { header: H({ dataSource: false }) })).not.toContain('PROBE_DS')
    expect(render(m, { header: H({ dataSource: true }) })).toContain('PROBE_DS')
  })
  it('times', () => {
    const h = render(model(), { header: H({ exportedAt: true, dataRunAt: true }) })
    expect(h).toContain('导出时间')
    expect(h).toContain('数据运行时间')
    expect(render(model(), { header: H({}) })).not.toContain('导出时间')
  })
  it('note is in the end info block, pre-wrap, after sections', () => {
    const h = render(model([table()], { note: 'a\nb' }))
    const d = parse(h)
    const note = d.querySelector('.note')!
    expect(note.textContent).toBe('a\nb')
    expect(h).toContain('white-space:pre-wrap')
    expect(h.indexOf('class="note"')).toBeGreaterThan(h.indexOf('<table'))
  })
  describe('input-variable lines', () => {
    const iv = (name: string, text: string, id = 'i') => ({ kind: 'input', blockId: id, name, text }) as Section
    it('sits exactly between neighbours', () => {
      const h = render(model([table({ blockId: 'a' }), iv('city', 'Paris'), table({ blockId: 'b' })]))
      const d = parse(h)
      const kids = Array.from(d.body.children).filter((x) => x.tagName !== 'P' || x.className === 'in-var').filter((x) => x.tagName !== 'HR' && x.tagName !== 'FOOTER')
      expect(kids.map((x) => x.tagName + '.' + x.className)).toEqual(['SECTION.tbl', 'P.in-var', 'SECTION.tbl'])
    })
    it('uses labels.colon and not-set marker', () => {
      const d = parse(render(model([iv('city', 'Paris'), iv('x', '')])))
      expect(Array.from(d.querySelectorAll('.in-var')).map((x) => x.textContent)).toEqual(['city：Paris', 'x：（未设置）'])
      const en = parse(renderExportHtml(model([iv('x', '')]), opts(), {}, enLabels))
      expect(en.querySelector('.in-var')!.textContent).toBe('x: (not set)')
    })
    it('escapes label and value', () => {
      const h = render(model([iv('<script>a&', X + '&amp;')]))
      expect(h).not.toContain('<script>alert')
      expect(h).toContain('&lt;script&gt;a&amp;')
      expect(parse(h).querySelector('.in-var')!.textContent).toBe('<script>a&：' + X + '&amp;')
    })
    it('no aggregate filters element; CSS keeps line with next block', () => {
      const h = render(model([iv('k', 'v')]))
      expect(parse(h).querySelector('.filters')).toBeNull()
      expect(h).not.toContain('class="filters"')
      expect(h).toMatch(/\.in-var\{[^}]*break-after:avoid/)
      expect(printCss({ orientation: 'portrait' })).not.toContain('.filters')
    })
  })
})

describe('charts', () => {
  const ch = { kind: 'chart' as const, blockId: 'c1', spec: {}, rows: [], usesRawRows: false }
  it('inlines sanitized svg', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()"><script>1</script><foreignObject><div>x</div></foreignObject><image href="http://e/x.png"/><a xlink:href="javascript:1"><use href="#a"/></a><rect width="1" height="1" onclick="y()"/></svg>`
    const h = render(model([ch]), {}, { c1: { svg } })
    const d = parse(h)
    expect(d.querySelector('svg')).not.toBeNull()
    expect(d.querySelectorAll('script,foreignObject,foreignobject,image').length).toBe(0)
    expect(h).not.toMatch(/\son\w+=/)
    expect(h).not.toContain('javascript:')
    expect(h).not.toContain('http://e/')
    expect(d.querySelector('rect')).not.toBeNull()
  })
  it('keeps data images and # refs', () => {
    const s = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA"/><use href="#a"/></svg>`)
    expect(s).toContain('data:image/png;base64,AA')
    expect(s).toContain('href="#a"')
  })
  it('placeholder when null or missing', () => {
    expect(render(model([ch]), {}, { c1: { svg: null, error: 'x' } })).toContain('图表不可用')
    expect(render(model([ch]))).toContain('图表不可用')
  })
})

describe('chart title in export (no duplicate)', () => {
  const pvm = { rowHeaders: ['r'], columnHeaders: [['c1']], rowLabels: [['A']], cells: [['1']], measures: ['m'] }
  const pv = (title?: string): Section => ({ kind: 'pivot', blockId: 'c', model: pvm, ...(title ? { title } : {}) } as Section)
  const ch = (title?: string): Section => ({ kind: 'chart', blockId: 'c', spec: {}, rows: [], usesRawRows: false, ...(title ? { title } : {}) })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="role-title"><text>Chart T</text></g></svg>'
  it('both: title is a caption ABOVE the table, and not repeated as an h2 between table and chart', () => {
    const h = render(model([pv('Chart T <x>'), ch('Chart T <x>')]), {}, { c: { svg } })
    const d = parse(h)
    const cap = d.querySelector('table.pivot > caption')!
    expect(cap.textContent).toBe('Chart T <x>')
    expect(cap.nextElementSibling!.tagName).toBe('THEAD')
    expect(d.querySelectorAll('h2').length).toBe(0)
    expect(h).toContain('Chart T &lt;x&gt;')
    expect(h.indexOf('<caption')).toBeLessThan(h.indexOf('<svg'))
  })
  it('table only: caption above the table', () => {
    const d = parse(render(model([pv('T1')])))
    expect(d.querySelector('table.pivot > caption')!.textContent).toBe('T1')
  })
  it('chart only (table hidden): no table-side title; the chart svg keeps its own', () => {
    const h = render(model([ch('Chart T')]), {}, { c: { svg } })
    const d = parse(h)
    expect(d.querySelector('caption')).toBeNull()
    expect(d.querySelectorAll('h2').length).toBe(0)
    expect(h.match(/Chart T/g)!.length).toBe(1)
  })
  it('empty title: no caption, no h2', () => {
    const d = parse(render(model([pv(), ch()]), {}, { c: { svg } }))
    expect(d.querySelector('caption')).toBeNull()
    expect(d.querySelectorAll('h2').length).toBe(0)
  })
  it('chart svg unavailable: the placeholder is still labelled by the title (chart only)', () => {
    const d = parse(render(model([ch('Chart T')]), {}, { c: { svg: null, error: 'x' } }))
    expect(d.querySelector('h2')!.textContent).toBe('Chart T')
  })
  it('both with chart svg unavailable: caption only, no duplicate h2', () => {
    const h = render(model([pv('Chart T'), ch('Chart T')]), {}, { c: { svg: null, error: 'x' } })
    const d = parse(h)
    expect(d.querySelector('table.pivot > caption')!.textContent).toBe('Chart T')
    expect(d.querySelectorAll('h2').length).toBe(0)
    expect(h).toContain('图表不可用')
  })
  it('caption css exists and is above (caption-side top, not the table-bottom default override)', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/caption\{[^}]*font-size:15px/)
    expect(printCss({ orientation: 'portrait' })).not.toMatch(/caption-side:\s*bottom/)
  })
})

describe('other sections and css', () => {
  it('pivot and big number', () => {
    const d = parse(render(model([
      { kind: 'pivot', blockId: 'p', model: { rowHeaders: ['r'], columnHeaders: [['c1'], ['c2']], rowLabels: [['A']], cells: [['1', '2']], measures: ['m'] } },
      { kind: 'big-number', blockId: 'b', items: [{ label: 'L', text: '42' }] },
    ])))
    expect(d.querySelector('table.pivot')).not.toBeNull()
    expect(d.querySelector('.big-number')!.textContent).toContain('42')
  })
  it('big number compare is escaped under .l; absent without compare (byte-identical)', () => {
    const withC = render(model([{ kind: 'big-number', blockId: 'b', items: [{ label: 'L', text: '42', compare: '▲ 1.0% vs <x> (MoM)' }] }]))
    expect(withC).toContain('<div class="l" title="L">L</div><div class="c">▲ 1.0% vs &lt;x&gt; (MoM)</div></div>')
    const plain = render(model([{ kind: 'big-number', blockId: 'b', items: [{ label: 'L', text: '42' }] }]))
    expect(plain).toContain('<div class="bn"><div class="v">42</div><div class="l" title="L">L</div></div>')
    expect(plain).not.toContain('class="c"')
  })
  it('exported .bn .l clamps to 2 lines with full escaped title; .c unclamped', () => {
    const css = printCss({ orientation: 'portrait' })
    expect(css).toMatch(/\.bn \.l\{[^}]*-webkit-line-clamp:2/)
    expect(css).toMatch(/\.bn \.l\{[^}]*overflow-wrap:anywhere/)
    expect(css).not.toMatch(/\.bn \.c\{[^}]*line-clamp/)
    expect(css).toMatch(/\.big-number \.bn\{[^}]*break-inside:avoid/)
    const h = render(model([{ kind: 'big-number', blockId: 'b', items: [{ label: 'a<b>"q"', text: '1', compare: 'c' }] }]))
    expect(h).toContain('<div class="l" title="a&lt;b&gt;&quot;q&quot;">a&lt;b&gt;&quot;q&quot;</div>')
  })
  it('print CSS styles the compare line (.bn .c)', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/\.bn \.c\{[^}]*font-size:12px/)
  })
  it('big number keeps break-inside:avoid', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/\.big-number \.bn\{[^}]*break-inside:avoid/)
  })
  it('print css', () => {
    expect(printCss({ orientation: 'portrait' })).toContain('size: A4 portrait')
    expect(printCss({ orientation: 'landscape' })).toContain('size: A4 landscape')
    const c = printCss({ orientation: 'portrait' })
    expect(c).toContain('thead{display:table-header-group}')
    expect(c).toContain('tr{break-inside:avoid}')
    expect(c).toContain('break-before:page')
  })
  it('print css does not clip wide markdown tables', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/@media print\{[^]*\.md\{overflow:visible\}/)
  })
  it('print css keeps a right safety gutter so full-width bordered boxes are not clipped by printToPDF', () => {
    const c = printCss({ orientation: 'portrait' })
    const [screen, print] = c.split('@media print')
    expect(print).toContain('body{padding:0 2px 0 0}')
    expect(screen).toContain('body{font-family:')
    expect(screen).toMatch(/padding:0 4px\}/)
    expect(screen).not.toContain('padding:0 2px 0 0')
    expect(printCss({ orientation: 'landscape' })).toContain('@media print{body{padding:0 2px 0 0}')
  })
})

describe('review fixes', () => {
  const pv = (over = {}): Section => ({ kind: 'pivot', blockId: 'p', model: {
    rowHeaders: ['r'], rowLabels: [['A'], ['B']], measures: ['M'],
    columnHeaders: [['X', 'a', 'c1'], ['X', 'a', 'c2'], ['X', 'b', 'c3'], ['Y', 'a', 'c4']],
    cells: [['1', '2', '3', '4'], ['5', '6', '7', '8']], rowTotals: [['9'], ['10']], columnTotals: ['6', '8', '10', '12'], grandTotal: ['36'], ...over } })
  it('pivot merges parent headers with colspan', () => {
    const d = parse(render(model([pv()])))
    const rows = Array.from(d.querySelectorAll('table.pivot thead tr'))
    expect(rows.length).toBe(3)
    const spans = (tr: Element) => Array.from(tr.children).map((c) => `${c.textContent}:${c.getAttribute('colspan') ?? 1}`)
    expect(spans(rows[0]).slice(1)).toEqual(['X:3', 'Y:1', ':1'])
    expect(spans(rows[1]).slice(1)).toEqual(['a:2', 'b:1', 'a:1', ':1'])
  })
  it('row-total header cells only on last level', () => {
    const d = parse(render(model([pv()])))
    const rows = Array.from(d.querySelectorAll('table.pivot thead tr'))
    expect(rows.map((r) => Array.from(r.children).filter((c) => c.textContent === 'M').length)).toEqual([0, 0, 1])
    const widths = rows.map((r) => Array.from(r.children).reduce((n, c) => n + Number(c.getAttribute('colspan') ?? 1), 0))
    expect(new Set(widths).size).toBe(1)
  })
  it('column totals row is labelled', () => {
    const d = parse(render(model([pv()])))
    const last = d.querySelector('table.pivot tbody tr:last-child')!
    expect(last.children[0].textContent).toBe('合计')
  })
  it('numeric cells never break mid-number', () => {
    expect(printCss({ orientation: 'portrait' })).toMatch(/td\.num[^}]*white-space:nowrap/)
  })
  it('serial width grows with row count', () => {
    const rows = Array.from({ length: 100000 }, (_, i) => [String(i)])
    const t = table({ columns: ['a'], rows, nullMask: rows.map(() => [false]), numeric: [false], groups: [{ cols: [0] }], totalRows: 100000, shownRows: 100000 })
    expect(render(model([t]))).toContain('--serial:7ch')
    expect(render(model([table()]))).toContain('--serial:3ch')
    expect(printCss({ orientation: 'portrait' })).toMatch(/serial[^}]*min-width:var\(--serial/)
    expect(printCss({ orientation: 'portrait' })).toMatch(/serial[^}]*white-space:nowrap/)
  })
  it('english output has no full-width punctuation', () => {
    const m = model([table(), { kind: 'input', blockId: 'i', name: 'a', text: '1' }, { kind: 'input', blockId: 'j', name: 'b', text: '' }], { dataSources: ['S'] })
    const h = renderExportHtml(m, opts({ header: { exportedAt: true, dataRunAt: true, dataSource: true, exporter: false } }), {}, enLabels)
    expect(h).not.toMatch(/[：；]/)
    expect(Array.from(parse(h).querySelectorAll('.in-var')).map((x) => x.textContent)).toEqual(['a: 1', 'b: (not set)'])
  })
  it('continued caption on pages 2+', () => {
    const t = table({ title: 'T1', columns: ['a', 'b', 'c'], rows: [['1', '2', '3']], nullMask: [[false, false, false]], numeric: [false, false, false], groups: [{ cols: [0] }, { cols: [1] }, { cols: [2] }] })
    const d = parse(render(model([t])))
    const caps = Array.from(d.querySelectorAll('.cont'))
    expect(caps.map((c) => c.textContent)).toEqual(['T1 (续)', 'T1 (续)'])
    expect(d.querySelectorAll('h2').length).toBe(1)
    const en = parse(renderExportHtml(model([t]), opts(), {}, enLabels))
    expect(en.querySelector('.cont')!.textContent).toBe('T1 (continued)')
  })
})

describe('repeat count used by a table section', () => {
  it('uses section.repeat when the model provides it', () => {
    const cols = ['a', 'b', 'c', 'd']
    const t = table({ columns: cols, rows: [['1', '2', '3', '4']], nullMask: [[false, false, false, false]], numeric: [false, false, false, false], groups: [{ cols: [0, 1] }, { cols: [2, 3] }], repeat: 0 })
    const d = parse(render(model([t]), { repeatCols: 2 }))
    expect(Array.from(d.querySelectorAll('table.grid')).map((x) => x.querySelectorAll('thead th').length)).toEqual([3, 3])
    const d2 = parse(render(model([{ ...t, repeat: undefined }]), { repeatCols: 1 }))
    expect(Array.from(d2.querySelectorAll('table.grid')).map((x) => x.querySelectorAll('thead th').length)).toEqual([3, 4])
  })
})

describe('new page after a column-paginated table', () => {
  const split = () => table({ blockId: 'sp', columns: ['a', 'b'], rows: [['1', '2']], nullMask: [[false, false]], numeric: [false, false], groups: [{ cols: [0] }, { cols: [1] }] })
  const md = (id: string, source: string): Section => ({ kind: 'markdown', blockId: id, source } as any)
  it('marks a split table section and CSS starts the following block on a new page', () => {
    const h = render(model([split(), md('m', 'after')]))
    const d = parse(h)
    const sec = d.querySelector('section.tbl')!
    expect(sec.classList.contains('split')).toBe(true)
    expect(sec.nextElementSibling?.classList.contains('md')).toBe(true)
    expect(d.querySelector('style')!.textContent).toMatch(/section\.split\s*\+\s*\*\s*\{\s*break-before:\s*page/)
  })
  it('unsplit tables keep normal flow (no marker)', () => {
    const d = parse(render(model([table(), md('m', 'after')])))
    expect(d.querySelector('section.tbl')!.classList.contains('split')).toBe(false)
  })
  it('an empty table is never marked split', () => {
    const d = parse(render(model([table({ rows: [], nullMask: [], groups: [{ cols: [0] }, { cols: [1, 2] }] }), md('m', 'after')])))
    expect(d.querySelector('section.tbl')!.classList.contains('split')).toBe(false)
  })
  it('the notes of the split table stay inside its section, before the page break', () => {
    const d = parse(render(model([{ ...split(), limitedNote: 'first-n', totalRows: 5, shownRows: 1 } as any, md('m', 'after')])))
    expect(d.querySelector('section.tbl.split .note-after')).not.toBeNull()
  })
})

describe('markdown D v2 export css', () => {
  const css = () => render(model([{ kind: 'markdown', blockId: 'm', source: '# h' } as any])).match(/<style>([\s\S]*?)<\/style>/)![1]
  it('contains the D v2 rules scoped to .md with print rules', () => {
    const c = css()
    expect(c).toContain('.md h1{')
    expect(c).toContain('border-left:5px solid #0969da')
    expect(c).toContain('.md blockquote{')
    expect(c).toMatch(/@media print\{[^]*\.md pre[^]*break-inside:avoid/)
  })
  it('uses light MD_EXPORT_VARS and a single style tag', () => {
    const h = render(model([{ kind: 'markdown', blockId: 'm', source: '# h' } as any]))
    expect(h.match(/<style/g)!.length).toBe(1)
    expect(css()).not.toContain('var(--color-')
  })
  it('md tables are not clipped (wide tables)', () => {
    const c = css()
    expect(c).not.toMatch(/\.md table\{[^}]*overflow:hidden/)
    expect(c).toMatch(/\.md\{[^}]*overflow-x:auto/)
  })
  it('md table rule does not alter .grid rules', () => {
    const c = css()
    expect(c).toContain('table.grid{table-layout:auto;width:100%}')
    expect(c).toContain('th,td{border:1px solid #d0d7de;padding:3px 6px;text-align:left;')
    expect(c).not.toMatch(/\.md th[^{]*\{[^}]*text-align/)
  })
})

describe('content-adaptive column widths', () => {
  const desc = 'd'.repeat(200)
  const mixed = (over: Partial<TableSection> = {}) => table({
    columns: ['id', 'date', 'description', 'amount'],
    rows: [['1', '2026-10-01', desc, '9.5'], ['2', '2026-10-02', 'short', '10']],
    nullMask: [[false, false, false, false], [false, false, false, false]],
    groups: [{ cols: [0, 1, 2, 3] }], numeric: [true, false, false, true], ...over,
  })
  const html = (s: TableSection) => renderExportHtml(model([s]), DEFAULT_EXPORT_OPTIONS, {}, labels)
  const cells = (h: string, tag: string) => [...h.matchAll(new RegExp(`<${tag} class="([^"]*)">`, 'g'))].map((m) => m[1])

  it('columnWrapClass: short values are nw, long text and long headers wrap', () => {
    expect(columnWrapClass(['1', '2'], 'id', 'num')).toBe('nw')
    expect(columnWrapClass(['2026-10-01'], 'date', 'text')).toBe('nw')
    expect(columnWrapClass(['AB-12'], 'code', 'text')).toBe('nw')
    expect(columnWrapClass([desc], 'description', 'text')).toBe('')
    expect(columnWrapClass(['a'], 'h'.repeat(25), 'text')).toBe('')
    expect(columnWrapClass(['x'.repeat(25)], 'h', 'text')).toBe('')
    expect(columnWrapClass([desc], 'n', 'num')).toBe('nw')
  })
  it('empty cells do not make a column wrappable', () => {
    expect(columnWrapClass(['', '', 'ok'], 'c', 'text')).toBe('nw')
    expect(columnWrapClass(['', ''], 'c', 'text')).toBe('nw')
  })
  it('grid css is table-layout:auto without blanket break-all', () => {
    const css = printCss({ orientation: 'portrait' })
    expect(css).toContain('table.grid{table-layout:auto')
    expect(css).not.toContain('table-layout:fixed')
    expect(css).not.toMatch(/th,td\{[^}]*word-break:break-all/)
    expect(css).toMatch(/th\.nw,td\.nw\{[^}]*white-space:nowrap/)
    expect(css).toMatch(/th\.serial,td\.serial\{width:var\(--serial/)
  })
  it('paged and unpaged tables carry nw on short columns and not on the long one', () => {
    for (const s of [mixed(), mixed({ groups: [{ cols: [0, 1] }, { cols: [2, 3] }] })]) {
      const h = html(s)
      const ths = cells(h, 'th').filter((c) => c !== 'serial')
      expect(ths.some((c) => /\bnw\b/.test(c))).toBe(true)
      expect(h).toMatch(/<th class="txt">description<\/th>/)
      expect(h).not.toMatch(/<td class="txt nw">d{200}/)
    }
    const h = html(mixed())
    expect(h).toContain('<th class="num nw">id</th>')
    expect(h).toContain('<th class="txt nw">date</th>')
    expect(h).toContain('<th class="num nw">amount</th>')
  })
  it('serial column keeps its width variable', () => {
    expect(html(mixed())).toMatch(/<table class="grid" style="--serial:\d+ch/)
    expect(html(mixed())).toContain('<th class="serial">')
  })
  it('transposed tables use the same classes', () => {
    const h = html(mixed({ transposed: true, rowNames: ['r1', 'r2'] }))
    expect(h).toContain('<th class="txt nw">date</th>')
  })
  it('too many nowrap columns: the widest text columns wrap instead', () => {
    const cols = Array.from({ length: 8 }, (_, i) => `c${i}`)
    const row = cols.map(() => 'x'.repeat(20))
    const s = table({ columns: cols, rows: [row], nullMask: [cols.map(() => false)], groups: [{ cols: cols.map((_, i) => i) }], numeric: cols.map(() => false) })
    const h = html(s)
    expect(cells(h, 'td').filter((c) => c === 'txt').length).toBeGreaterThan(0)
  })
})
