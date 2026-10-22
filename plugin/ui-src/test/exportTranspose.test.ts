import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type ExportOptions } from '../src/export/options'
import { buildExportModel, type TableSection } from '../src/export/model'
import { renderExportHtml, type ExportLabels } from '../src/export/html'

const labels: ExportLabels = {
  exporter: 'By',
  firstN: (n, m) => `first ${n}/${m}`, truncatedAtRun: (k) => `trunc ${k}`, empty: '(empty)', exportedAt: 'E', dataRunAt: 'R', dataSource: 'S', notSet: 'N',
  chartUnavailable: 'x', noData: 'none', page: 'p', serial: 'No.', summary: 'Total', continued: 'cont', colon: ': ', listSep: '; ',
}
const res = (cols: string[], rows: unknown[][]) => ({ columns: cols.map((name) => ({ name })), rows, truncated: false, elapsedMs: 1, dbType: 'x' })
function store(result: any, transposed: string[] = ['a']) {
  return {
    nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'a', type: 'sql', content: 'select', metadata: { resultName: 'A' } }] }),
    runs: new Map([['a', { status: 'ok', result, executedAt: '2026-10-18T09:00:00Z' }]]),
    analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false,
    transposed: new Map(transposed.map((i) => [i, true])),
  } as any
}
const build = (s: any, o: Partial<ExportOptions> = {}) =>
  buildExportModel({ store: s, options: { ...DEFAULT_EXPORT_OPTIONS, ...o }, now: new Date('2026-10-18T10:00:00Z'), dataSourceName: () => undefined })
const tbl = (m: any) => m.sections[0] as TableSection
const html = (s: any, o: Partial<ExportOptions> = {}) => {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...o }
  return new DOMParser().parseFromString(renderExportHtml(build(s, o), opts, {}, labels), 'text/html')
}

describe('options.blocks', () => {
  it('normalises per-block overrides', () => {
    const o = normalizeExportOptions({ blocks: { a: { transpose: 'on', include: false }, b: { transpose: 'zzz' }, c: 5, d: null } })
    expect(o.blocks.a).toEqual({ include: false, transpose: 'on' })
    expect(o.blocks.b).toEqual({ include: true, transpose: 'follow' })
    expect(o.blocks.c).toBeUndefined()
    expect(normalizeExportOptions('x').blocks).toEqual({})
  })
})

describe('transposed export model', () => {
  const r = res(['id', 'name'], [[1, 'x'], [2, null], [3, 'z']])
  it('follows the notebook transposed preference', () => {
    const t = tbl(build(store(r)))
    expect(t.transposed).toBe(true)
    expect(t.rowNames).toEqual(['id', 'name'])
    expect(t.columns).toEqual(['#1', '#2', '#3'])
    expect(t.rows).toEqual([['1', '2', '3'], ['x', '', 'z']])
    expect(t.nullMask).toEqual([[false, false, false], [false, true, false]])
    expect(t.numeric).toEqual([false, false, false])
    expect(t.groups).toEqual([{ cols: [0, 1, 2] }])
    expect(t.totalRows).toBe(3)
  })
  it('stays normal when the notebook is not transposed', () => {
    const t = tbl(build(store(r, [])))
    expect(t.transposed).toBeFalsy()
    expect(t.columns).toEqual(['id', 'name'])
  })
  it('is not eligible above 20 rows, but is after the row limit', () => {
    const big = res(['v'], Array.from({ length: 25 }, (_, i) => [i]))
    expect(tbl(build(store(big))).transposed).toBeFalsy()
    const lim = tbl(build(store(big), { rowLimit: 5 }))
    expect(lim.transposed).toBe(true)
    expect(lim.columns).toEqual(['#1', '#2', '#3', '#4', '#5'])
    expect(lim.limitedNote).toBe('first-n')
    expect(lim.totalRows).toBe(25)
  })
  it('zero rows is never transposed', () => {
    expect(tbl(build(store(res(['a'], [])))).transposed).toBeFalsy()
  })
  it('1-row result', () => {
    const t = tbl(build(store(res(['a', 'b'], [[1, 2]]))))
    expect(t.columns).toEqual(['#1']); expect(t.rows).toEqual([['1'], ['2']])
  })
  it('per-block override: off beats notebook, on works without it', () => {
    expect(tbl(build(store(r), { blocks: { a: { include: true, transpose: 'off' } } })).transposed).toBeFalsy()
    expect(tbl(build(store(r, []), { blocks: { a: { include: true, transpose: 'on' } } })).transposed).toBe(true)
    const big = res(['v'], Array.from({ length: 25 }, (_, i) => [i]))
    expect(tbl(build(store(big, []), { blocks: { a: { include: true, transpose: 'on' } } })).transposed).toBeFalsy()
  })
  it('column breaks apply to displayed columns', () => {
    const t = tbl(build(store(r), { columnBreaks: { a: [0] } }))
    expect(t.groups).toEqual([{ cols: [0] }, { cols: [1, 2] }])
  })
})

describe('transposed export html', () => {
  const r = res(['id', 'a <b> very long column name that goes on'], [[1, null], [2, 'z']])
  it('has no serial column; name column first on every page; nulls kept', () => {
    const d = html(store(r), { columnBreaks: { a: [0] }, repeatCols: 0 })
    const tables = Array.from(d.querySelectorAll('table.grid'))
    expect(tables).toHaveLength(2)
    for (const tb of tables) {
      expect(tb.querySelector('th.serial')).toBeNull()
      expect(tb.querySelector('thead th:first-child')!.classList.contains('rowname')).toBe(true)
      const names = Array.from(tb.querySelectorAll('tbody tr')).map((tr) => tr.querySelector('td.rowname')!.textContent)
      expect(names).toEqual(['id', 'a <b> very long column name that goes on'])
    }
    expect(tables[0].querySelectorAll('thead th')[1].textContent).toBe('#1')
    expect(tables[1].querySelectorAll('thead th')[1].textContent).toBe('#2')
    expect(tables[0].querySelectorAll('td.null')).toHaveLength(1)
    expect(d.body.innerHTML).not.toContain('<b>')
  })
  it('1-row result renders one data column', () => {
    const d = html(store(res(['a', 'b'], [[1, 2]])))
    expect(d.querySelectorAll('table.grid thead th')).toHaveLength(2)
    expect(d.querySelectorAll('table.grid tbody tr')).toHaveLength(2)
  })
  it('normal tables keep the serial column', () => {
    const d = html(store(r, []))
    expect(d.querySelector('th.serial')).not.toBeNull()
  })
})
