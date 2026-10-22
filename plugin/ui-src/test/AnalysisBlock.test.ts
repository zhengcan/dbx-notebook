import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: async () => ({ view: {}, svg: async () => '', destroy() {} }) }) }))
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import NotebookView from '../src/shell/NotebookView.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale, t } from '../src/i18n'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { AiClientKey, AiSettingsKey, BridgeKey } from '../src/injection'

const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = (executedAt = 'T1') => ({
  status: 'ok' as const, executedAt,
  result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }], rows: [['a', 1, '2026-01-01']], truncated: false, elapsedMs: 1, dbType: 'sqlite' },
})
const pv = { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }

function aiProvide() {
  const bridge = createFakeBridge({ caps: { aiCompletion: true } })
  return { [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: createAiClient(bridge), [AiSettingsKey as symbol]: { sendOptions: async () => ({ schema: true, sql: true, data: true }), effectiveModel: () => undefined } }
}
function setup(chartMeta: any, o: { run?: any; noSrc?: boolean; runner?: boolean; ai?: boolean } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  if (!o.noSrc) store.nb.value.blocks.push(src as any)
  store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: chartMeta } as any)
  if (o.run !== null && !o.noSrc) store.runs.set('s1', o.run ?? run())
  const calls: string[] = []
  if (o.runner !== false) store.setAnalysisRunner(async (id) => { calls.push(id); return { status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' } as any })
  const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, global: { provide: { [StoreKey as symbol]: store, ...(o.ai ? aiProvide() : {}) } } })
  return { store, w, calls, meta: () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any }
}
const base = (over: any = {}) => ({ data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] }, ...over })

beforeEach(() => vi.useRealTimers())

describe('summary help', () => {
  it('each summary toggle has a tooltip and accessible description', () => {
    const { w } = setup(base({ pivot: { ...pv, columns: [{ field: 'd' }] } }))
    for (const k of ['row', 'column', 'grand']) {
      const input = w.find(`[data-test=ab-summary-${k}]`)
      const help = w.find(`[data-test=ab-summary-${k}-help]`)
      expect(help.text().length).toBeGreaterThan(10)
      expect(help.text().split(/[.;。；]/).filter(Boolean)).toHaveLength(1)
      expect(input.attributes('aria-describedby')).toBe(help.attributes('id'))
      const title = input.element.closest('label')!.getAttribute('title')!
      expect(title.length).toBeGreaterThan(help.text().length)
      expect(title).toContain('displayed')
    }
  })
})

describe('summaries UI', () => {
  const longRes = { status: 'ok', long: { dims: ['a'], measures: ['m'], rows: [['a', 1], ['b', 5]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any
  it('toggles are labelled Row/Column/Grand summary in en and 行汇总/列汇总/总汇总 in zh', async () => {
    const { w } = setup(base({ pivot: pv }))
    const lab = (k: string) => w.find(`[data-test=ab-summary-${k}]`).element.closest('label')!.textContent
    expect(lab('row')).toContain('Row summary'); expect(lab('column')).toContain('Column summary'); expect(lab('grand')).toContain('Grand summary')
    expect(w.find('[data-test=ab-summary-row]').element.closest('label')!.getAttribute('title')).toContain('displayed')
    setLocale('zh-CN')
    await w.vm.$nextTick()
    expect(lab('row')).toContain('行汇总'); expect(lab('column')).toContain('列汇总'); expect(lab('grand')).toContain('总汇总')
    expect(w.find('[data-test=ab-summary-row]').element.closest('label')!.getAttribute('title')).toContain('每个值')
  })
  it('no summary select in the top area; editing a summary cell writes the value spec and the table updates', async () => {
    const { w, store, meta } = setup(base({ pivot: pv }))
    store.analysis.set('c1', longRes)
    await w.find('[data-test="ab-summary-column"]').setValue(true)
    expect(w.find('[data-test="ab-head"] [data-test=fp-summary]').exists()).toBe(false)
    expect(w.find('[data-test="ab-head"] select[data-test="summary-select"]').exists()).toBe(false)
    const cell = () => w.find('tr.total-row td.total')
    expect(cell().text()).toBe('Sum: 6')
    await cell().trigger('dblclick')
    await w.find('select[data-test="summary-select"]').setValue('max')
    expect(meta().pivot.values[0].summary).toBe('max')
    await w.vm.$nextTick()
    expect(cell().text()).toBe('Max: 5')
    await cell().trigger('dblclick')
    await w.find('select[data-test="summary-select"]').setValue('none')
    expect(cell().text()).toBe('Skipped')
    expect(w.find('tr.total-row').exists()).toBe(true)
  })
})

describe('value header sort reorders rendered rows', () => {
  it('summary count, no column field: clicking the value header twice sorts asc then desc', async () => {
    const rows = [['k1', 6], ['k2', 1], ['k3', 0], ['k4', 16], ['k5', 0]]
    const { w, store } = setup(base({ pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'count', summary: 'count' }] } }))
    store.analysis.set('c1', { status: 'ok', long: { dims: ['region'], measures: ['m'], rows }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any)
    await flushPromises()
    const body = () => w.findAll('tr[data-row]').map((r) => r.findAll('td').at(-1)!.text())
    await w.find('button[data-sort="value"]').trigger('click')
    expect(body()).toEqual(['0', '0', '1', '6', '16'])
    await w.find('button[data-sort="value"]').trigger('click')
    expect(body()).toEqual(['16', '6', '1', '0', '0'])
  })
})

describe('grand summary toggle', () => {
  it('is disabled (with an explanation) unless both row and column fields exist; stored value untouched', async () => {
    const { w, meta } = setup(base({ pivot: { ...pv, totals: { grand: true } } }))
    const g = () => w.find('[data-test="ab-summary-grand"]')
    expect(g().attributes('disabled')).toBeDefined()
    expect(g().element.closest('label')!.getAttribute('title')).toBe('Needs both row and column fields')
    expect((g().element as HTMLInputElement).checked).toBe(true)
    expect(meta().pivot.totals.grand).toBe(true)
    await w.find('[data-test="ab-cols"] [data-test="fp-add"]').setValue('d')
    expect(g().attributes('disabled')).toBeUndefined()
    expect(g().element.closest('label')!.getAttribute('title')).toContain('displayed')
    expect(meta().pivot.totals.grand).toBe(true)
  })
})

describe('auto refresh', () => {
  const meta = base({ pivot: pv })
  it('refreshes once when the source result arrives after mount; not again on source rerun (stale only)', async () => {
    const { store, calls } = setup(meta, { run: null })
    await flushPromises()
    expect(calls).toEqual([])
    store.runs.set('s1', run('T1'))
    await flushPromises()
    expect(calls).toEqual(['c1'])
    store.analysis.set('c1', { status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any)
    store.runs.set('s1', run('T2'))
    await flushPromises()
    expect(calls).toEqual(['c1'])
  })
  it('does not retry a failed auto refresh until the source changes', async () => {
    const { store, w } = setup(meta, { run: null, runner: false })
    let n = 0
    store.setAnalysisRunner(async () => { n++; throw new Error('boom') })
    store.runs.set('s1', run('T1'))
    await flushPromises()
    expect(n).toBe(1)
    expect(w.text()).toContain('boom')
    await w.setProps({ blockId: 'c1' })
    await flushPromises()
    expect(n).toBe(1)
    store.runs.set('s1', run('T2'))
    await flushPromises()
    expect(n).toBe(2)
  })
})

describe('store chart blocks', () => {
  it('addBlock chart default and duplicate', () => {
    const store = useNotebookStore()
    const id = store.addBlock('chart', null)
    const b = store.nb.value.blocks[0]
    expect(b.id).toBe(id)
    expect(b.type).toBe('chart')
    expect(b.metadata).toEqual({ data: '', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } })
    const d = store.duplicateBlock(id)
    const c = store.nb.value.blocks.find((x) => x.id === d)!
    expect(c.metadata).toEqual(b.metadata)
    expect(c.metadata).not.toBe(b.metadata)
  })
  it('setAnalysis writes metadata, regenerates spec, keeps unknown keys, debounces refresh', async () => {
    vi.useFakeTimers()
    const { store, meta, calls } = setup(base({ extra: { k: 1 } }), { runner: true })
    calls.length = 0
    store.setAnalysis('c1', { pivot: pv as any })
    store.setAnalysis('c1', { chartOptions: { type: 'line' } })
    expect(meta().extra).toEqual({ k: 1 })
    expect(meta().chartOptions.type).toBe('line')
    expect(meta().pivot.rows).toEqual([{ field: 'region' }])
    expect(JSON.stringify(meta().spec)).toContain('region')
    expect(store.dirty.value).toBe(true)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(120)
    expect(calls).toEqual(['c1'])
  })
  it('keeps the old spec when source columns are unknown', () => {
    const { store, meta } = setup(base({ spec: { old: 1 } }), { run: null })
    store.setAnalysis('c1', { pivot: pv as any })
    expect(meta().spec).toEqual({ old: 1 })
  })
})

describe('AnalysisBlock', () => {
  it('no source selected prompts; choosing a source populates field pickers', async () => {
    const { w, meta } = setup(base({ data: '' }))
    expect(w.find('[data-test="ab-message"]').text()).toBe('Choose a data source')
    await w.find('[data-test="ab-source"]').setValue('sales')
    expect(meta().data).toBe('sales')
    const add = w.find('[data-test="ab-rows"] [data-test="fp-add"]')
    expect(add.findAll('option').map((o) => o.text())).toEqual(expect.arrayContaining(['region', 'amount', 'd']))
    const srcOpts = w.find('[data-test="ab-source"]').findAll('option').map((o) => o.element.value)
    expect(srcOpts).toEqual(['', 'sales'])
  })
  it('controls write metadata and spec is rewritten', async () => {
    const { w, meta } = setup(base({ pivot: { ...pv, columns: [{ field: 'd' }] } }))
    await w.find('[data-test="ab-view"] [data-view="table"]').trigger('click')
    expect(meta().view).toBe('table')
    await w.find('[data-test="ab-type"]').setValue('barHorizontal')
    expect(meta().chartOptions.type).toBe('barHorizontal')
    await w.find('[data-test="ab-stacking"]').setValue('stacked')
    expect(meta().chartOptions.stacking).toBe('stacked')
    await w.find('[data-test="ab-summary-row"]').setValue(true)
    await w.find('[data-test="ab-summary-column"]').setValue(true)
    await w.find('[data-test="ab-summary-grand"]').setValue(true)
    expect(meta().pivot.totals).toEqual({ row: true, column: true, grand: true })
    await w.find('[data-test="ab-labels"]').setValue(true)
    expect(meta().chartOptions.labels).toBe(true)
    await w.find('[data-test="ab-title"]').setValue('Sales')
    expect(meta().chartOptions.title).toBe('Sales')
    expect(JSON.stringify(meta().spec)).toContain('Sales')
    await w.find('[data-test="ab-values"] [data-test="fp-add"]').setValue('\u0000count')
    expect(meta().pivot.values).toHaveLength(2)
    await w.find('[data-test="ab-rows"] [data-test="fp-remove"]').trigger('click')
    expect(meta().pivot.rows).toEqual([])
    await w.find('[data-test="ab-type"]').setValue('line')
    expect(w.find('[data-test="ab-stacking"]').exists()).toBe(false)
  })
  it('stacking select: disabled with a hint without a column field, enabled with one; area gets none/stacked/percent; percent is written', async () => {
    const a = setup(base({ pivot: pv }))
    expect(a.w.find('[data-test="ab-stacking"]').attributes('disabled')).toBeDefined()
    expect(a.w.find('[data-test="ab-stacking-hint"]').text()).toContain('column field')
    const b = setup(base({ pivot: { ...pv, columns: [{ field: 'd' }] } }))
    const sel = b.w.find('[data-test="ab-stacking"]')
    expect(sel.attributes('disabled')).toBeUndefined()
    expect(b.w.find('[data-test="ab-stacking-hint"]').exists()).toBe(false)
    expect((sel.element as HTMLSelectElement).value).toBe('stacked')
    await sel.setValue('percent')
    expect(b.meta().chartOptions.stacking).toBe('percent')
    expect(JSON.stringify(b.meta().spec)).toContain('normalize')
    await b.w.find('[data-test="ab-type"]').setValue('area')
    expect(b.w.find('[data-test="ab-stacking"]').findAll('option').map((o) => o.element.value)).toEqual(['none', 'stacked', 'percent'])
  })
  it('area chart with stored grouped displays the effective stacking (stacked)', () => {
    const { w } = setup(base({ chartOptions: { type: 'area', stacking: 'grouped' }, pivot: { ...pv, columns: [{ field: 'd' }] } }))
    expect((w.find('[data-test="ab-stacking"]').element as HTMLSelectElement).value).toBe('stacked')
  })
  it('bar stacking select offers stacked/grouped/percent and shows a stored none as grouped', () => {
    const { w } = setup(base({ chartOptions: { type: 'bar', stacking: 'none' }, pivot: { ...pv, columns: [{ field: 'd' }] } }))
    const sel = w.find('[data-test="ab-stacking"]')
    expect(sel.findAll('option').map((o) => o.element.value)).toEqual(['grouped', 'stacked', 'percent'])
    expect((sel.element as HTMLSelectElement).value).toBe('grouped')
  })
  it('header layout: row 1 controls, then rows/columns/values, then summaries + refresh + badges', async () => {
    const { w, store } = setup(base({ chartOptions: { type: 'bar' }, pivot: { ...pv, columns: [{ field: 'd' }] } }))
    store.analysis.set('c1', { status: 'ok', long: { dims: ['a'], measures: ['m'], rows: [['a', 1]] }, excludedDateRows: 2, partial: true, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any)
    await w.vm.$nextTick()
    const order = ['ab-source', 'ab-view', 'ab-type', 'ab-stacking', 'ab-labels', 'ab-title', 'ab-rows', 'ab-cols', 'ab-values', 'ab-summary-row', 'ab-summary-column', 'ab-summary-grand', 'ab-partial', 'ab-excluded']
    const els = order.map((id) => { const e = w.find(`[data-test="${id}"]`); expect(e.exists(), id).toBe(true); return e.element as HTMLElement })
    for (let i = 1; i < els.length; i++) expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING, order[i]).toBeTruthy()
    const row = (id: string) => w.find(`[data-test="${id}"]`).element.closest('[data-row]')!.getAttribute('data-row')
    expect(['ab-source', 'ab-view', 'ab-type', 'ab-stacking', 'ab-labels'].map(row)).toEqual(Array(5).fill('options'))
    expect(row('ab-title')).toBe('title')
    expect([row('ab-rows'), row('ab-cols'), row('ab-values')]).toEqual(['rows', 'cols', 'values'])
    expect(['ab-summary-row', 'ab-summary-column', 'ab-summary-grand', 'ab-partial', 'ab-excluded'].map(row)).toEqual(Array(5).fill('summary'))
  })
  it('title row: own .ab-row before rows, outside .ab-opts, input is its direct-child label content', async () => {
    const { w } = setup(base({ chartOptions: { type: 'bar' } }))
    const title = w.find('[data-test="ab-title"]').element as HTMLElement
    const trow = title.closest('.ab-row') as HTMLElement
    expect(trow.getAttribute('data-row')).toBe('title')
    expect(title.closest('.ab-opts')).toBeNull()
    expect(trow.querySelectorAll('input,select,button').length).toBe(1)
    const rows = w.find('[data-row="rows"]').element
    expect(trow.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trow.nextElementSibling).toBe(rows)
  })
  it('title edit writes chartOptions.title in exactly one setAnalysis call on change', async () => {
    const { w, store } = setup(base({ chartOptions: { type: 'bar' } }))
    const spy = vi.spyOn(store, 'setAnalysis')
    await w.find('[data-test="ab-title"]').setValue('Q')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toEqual({ chartOptions: { title: 'Q' } })
  })
  it('summary row: button immediately follows the ab-summary-grand label and precedes every .ab-badge', async () => {
    const { w, store } = setup(base({ chartOptions: { type: 'bar' }, pivot: pv }))
    store.analysis.set('c1', { status: 'ok', long: { dims: ['a'], measures: ['m'], rows: [['a', 1]] }, excludedDateRows: 2, partial: true, tooManyPoints: true, ranAt: 'x', sourceExecutedAt: 'OLD' } as any)
    await w.vm.$nextTick()
    const row = w.find('[data-row="summary"]').element as HTMLElement
    const btn = w.find('[data-test="ab-labels-open"]').element as HTMLElement
    const grand = w.find('[data-test="ab-summary-grand"]').element.closest('label')!
    expect(btn.tagName).toBe('BUTTON')
    expect(grand.nextElementSibling).toBe(btn)
    expect(row.lastElementChild).not.toBe(btn)
    const badges = Array.from(row.querySelectorAll('.ab-badge'))
    expect(badges.length).toBeGreaterThanOrEqual(3)
    for (const b of badges) expect(btn.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('button text is Advanced (en) / 高级设置 (zh), no digits, aria-haspopup=dialog', async () => {
    const { w } = setup(base({ chartOptions: { type: 'bar' }, pivot: pv }))
    const btn = w.find('[data-test="ab-labels-open"]').element as HTMLElement
    expect(btn.textContent).toBe('Advanced')
    expect(btn.textContent).not.toMatch(/\d/)
    expect(btn.classList.contains('ab-labels-btn')).toBe(true)
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(btn.getAttribute('type')).toBe('button')
    setLocale('zh-CN')
    expect(t('label.open')).toBe('高级设置')
    setLocale('en')
  })
  it('title row label has class ab-rlabel and the input is labelled by it', async () => {
    const { w } = setup(base({ chartOptions: { type: 'bar' } }))
    const input = w.find('[data-test="ab-title"]').element as HTMLInputElement
    const lab = w.find('[data-row="title"] label').element as HTMLLabelElement
    expect(lab.classList.contains('ab-rlabel')).toBe(true)
    expect(lab.textContent).toBe('Title')
    expect(input.id).toBeTruthy()
    expect(lab.htmlFor).toBe(input.id)
    expect(input.labels?.[0]).toBe(lab)
    expect(input.classList.contains('ab-title-input')).toBe(true)
  })
  it('legacy block renders no labels button', async () => {
    const { w } = setup({ data: 'sales', spec: { mark: 'bar', data: { name: 'sales' } } })
    expect(w.find('[data-test="ab-legacy"]').exists()).toBe(true)
    expect(w.find('[data-test="ab-labels-open"]').exists()).toBe(false)
  })
  it('Ask AI and Refresh sit in the same wrapper as the Time axis control, after it', async () => {
    const tp = { rows: [{ field: 'd', grain: 'month' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
    const { w } = setup(base({ chartOptions: { type: 'bar' }, pivot: tp }), { ai: true })
    await w.vm.$nextTick()
    const ta = w.find('[data-test="ab-timeaxis"]').element as HTMLElement
    const rf = w.find('[data-test="ab-refresh"]').element as HTMLElement
    const ai = w.find('[data-test="ask-ai"]')
    expect(ai.exists()).toBe(true)
    const tail = ta.closest('[data-test="ab-tail"]')!
    expect(tail).toBeTruthy()
    expect(tail.contains(rf) && tail.contains(ai.element)).toBe(true)
    expect(ta.compareDocumentPosition(ai.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(ai.element.compareDocumentPosition(rf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rf.closest('[data-row]')!.getAttribute('data-row')).toBe('options')
  })
  it('time axis select: shown only for temporal first row field + line/area/bar/barHorizontal, appended after title, writes metadata', async () => {
    const tp = { rows: [{ field: 'd', grain: 'month' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
    const a = setup(base({ chartOptions: { type: 'bar' }, pivot: tp }))
    const sel = a.w.find('[data-test="ab-timeaxis"]')
    expect(sel.exists()).toBe(true)
    expect(sel.findAll('option').map((o) => o.element.value)).toEqual(['sparse', 'compact'])
    expect((sel.element as HTMLSelectElement).value).toBe('sparse')
    expect(a.w.text()).toContain('Time axis')
    const t = a.w.find('[data-test="ab-title"]').element as HTMLElement
    expect(sel.element.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sel.element.closest('[data-row]')!.getAttribute('data-row')).toBe('options')
    await sel.setValue('compact')
    expect(a.meta().chartOptions.timeAxis).toBe('compact')
    expect(JSON.stringify(a.meta().spec)).toContain('ordinal')
    for (const type of ['line', 'area', 'barHorizontal']) {
      await a.w.find('[data-test="ab-type"]').setValue(type)
      expect(a.w.find('[data-test="ab-timeaxis"]').exists(), type).toBe(true)
    }
    for (const type of ['scatter', 'pie', 'donut', 'histogram']) {
      await a.w.find('[data-test="ab-type"]').setValue(type)
      expect(a.w.find('[data-test="ab-timeaxis"]').exists(), type).toBe(false)
    }
    expect(a.meta().chartOptions.timeAxis).toBe('compact')
    const b = setup(base({ chartOptions: { type: 'bar' }, pivot: pv }))
    expect(b.w.find('[data-test="ab-timeaxis"]').exists()).toBe(false)
    const c = setup(base({ chartOptions: { type: 'bar', timeAxis: 'compact' }, pivot: tp }))
    expect((c.w.find('[data-test="ab-timeaxis"]').element as HTMLSelectElement).value).toBe('compact')
    setLocale('zh-CN')
    await c.w.vm.$nextTick()
    expect(c.w.text()).toContain('时间轴')
    expect(c.w.find('[data-test="ab-timeaxis"]').text()).toContain('紧凑')
  })
  it('view switch shows only the matching subview', async () => {
    const st = { status: 'ok', long: { dims: ['a'], measures: ['m'], rows: [['a', 1]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' } as any
    const { w, store } = setup(base({ pivot: pv }))
    store.analysis.set('c1', { ...st, sourceExecutedAt: 'T1' })
    await w.vm.$nextTick()
    expect(w.find('[data-test="ab-table"]').exists()).toBe(true)
    expect(w.find('[data-test="ab-chart"]').exists()).toBe(true)
    await w.find('[data-view="table"]').trigger('click')
    expect(w.find('[data-test="ab-chart"]').exists()).toBe(false)
    await w.find('[data-view="chart"]').trigger('click')
    expect(w.find('[data-test="ab-table"]').exists()).toBe(false)
    expect(w.find('[data-test="ab-chart"]').exists()).toBe(true)
    expect(w.find('[data-test="ab-chart"] .chart-view').exists()).toBe(true)
  })
  it('legacy chart is read-only: no controls, still shows chart', () => {
    const { w } = setup({ data: 'sales', spec: { mark: 'bar', data: { name: 'sales' } } })
    expect(w.find('[data-test="ab-head"]').exists()).toBe(false)
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('[data-test="ab-legacy"]').exists()).toBe(true)
    expect(w.find('.chart-view').exists()).toBe(true)
  })
  it('source not run / missing source / deleted source messages', async () => {
    const a = setup(base({ pivot: pv }), { run: null })
    expect(a.w.find('[data-test="ab-message"]').text()).toBe('Run the source block first')
    const b = setup(base({ pivot: pv }), { noSrc: true })
    expect(b.w.find('[data-test="ab-message"]').text()).toContain('Data source not found')
    const c = setup(base({ pivot: pv }))
    c.store.removeBlock('s1')
    await c.w.vm.$nextTick()
    expect(c.w.find('[data-test="ab-message"]').text()).toContain('Data source not found')
    expect(c.w.find('[data-test="ab-source"]').element).toHaveProperty('value', 'sales')
  })
  it('missing field is listed, config is kept and repairable', async () => {
    const { w, meta } = setup(base({ pivot: { ...pv, rows: [{ field: 'gone' }] } }))
    expect(w.find('[data-test="ab-message"]').text()).toContain('gone')
    await w.find('[data-test="ab-rows"] [data-test="fp-remove"]').trigger('click')
    expect(meta().pivot.rows).toEqual([])
    expect(meta().pivot.values).toEqual([{ field: 'amount', agg: 'sum' }])
  })
  it('stale badge appears and refresh calls the runner', async () => {
    const { w, store, calls } = setup(base({ pivot: pv }))
    store.analysis.set('c1', { status: 'ok', excludedDateRows: 0, partial: true, tooManyPoints: true, sourceExecutedAt: 'OLD', ranAt: 'x' } as any)
    await w.vm.$nextTick()
    expect(w.find('[data-test="ab-stale"]').text()).toContain('Upstream results changed')
    expect(w.find('[data-test="ab-partial"]').text()).toBe('Based on partial data')
    expect(w.find('[data-test="ab-toomany"]').exists()).toBe(true)
    calls.length = 0
    await w.find('[data-test="ab-refresh"]').trigger('click')
    expect(calls).toEqual(['c1'])
  })
  it('excluded rows badge and bilingual UI', async () => {
    const { w, store } = setup(base({ pivot: pv }))
    store.analysis.set('c1', { status: 'ok', excludedDateRows: 3, partial: false, tooManyPoints: false, sourceExecutedAt: 'T1', ranAt: 'x' } as any)
    setLocale('zh-CN')
    await w.vm.$nextTick()
    expect(w.find('[data-test="ab-excluded"]').text()).toContain('3')
    expect(w.find('[data-test="ab-view"]').text()).toContain('并列')
    expect(w.find('[data-test="ab-head"]').text()).toContain('数据源')
  })
  it('no JSON textarea anywhere', () => {
    const { w } = setup(base({ pivot: pv }))
    expect(w.find('textarea').exists()).toBe(false)
  })
})

describe('AnalysisBlock refresh errors and labels', () => {
  it('mount-time refresh failure surfaces as a message, with no retry loop; refresh button retries', async () => {
    setLocale('en')
    const store = useNotebookStore()
    store.nb.value.blocks.push(src as any, { id: 'c1', type: 'chart', metadata: base({ pivot: pv }) } as any)
    store.runs.set('s1', run())
    let n = 0
    store.setAnalysisRunner(async () => { n++; throw new Error('boom') })
    const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, global: { provide: { [StoreKey as symbol]: store } } })
    await flushPromises(); await flushPromises()
    expect(n).toBe(1)
    expect(w.find('[data-test="ab-message"]').text()).toContain('boom')
    await w.find('[data-test="ab-refresh"]').trigger('click')
    await flushPromises()
    expect(n).toBe(2)
  })
  it('localises measure labels used for chart series', async () => {
    const { chartMeasureLabel } = await import('../src/analysis/chartRows')
    setLocale('zh-CN')
    expect(chartMeasureLabel({ field: '', agg: 'count' })).toBe('计数')
    expect(chartMeasureLabel({ field: 'amount', agg: 'sum' })).toContain('amount')
    expect(chartMeasureLabel({ field: 'amount', agg: 'sum' })).not.toContain(' of ')
    setLocale('en')
    expect(chartMeasureLabel({ field: 'amount', agg: 'sum' })).toBe('Sum of amount')
    expect(chartMeasureLabel({ field: '', agg: 'count' })).toBe('Count')
    expect(chartMeasureLabel({ field: 'x', agg: 'sum', label: 'Mine' })).toBe('Mine')
  })
})

describe('NotebookView chart insertion', () => {
  it('empty-state and insert buttons add chart blocks', async () => {
    setLocale('en')
    const store = useNotebookStore()
    const w = mount(NotebookView, { global: { provide: { [StoreKey as symbol]: store } } })
    await w.find('[data-test="empty-add-chart"]').trigger('click')
    expect(store.nb.value.blocks[0].type).toBe('chart')
    expect(w.find('[data-test="analysis-block"]').exists()).toBe(true)
    await w.find('[data-test="add-chart"]').trigger('click')
    expect(store.nb.value.blocks).toHaveLength(2)
    await flushPromises()
  })
})

describe('labels section wiring (T10)', () => {
  const openDlg = async (w: any, group?: string) => {
    await w.find('[data-test=ab-labels-open]').trigger('click'); await w.vm.$nextTick()
    if (group) { await w.find(`[role=tab][data-tab=${({ names: 'table', measures: 'table', units: 'numbers' } as Record<string, string>)[group] ?? group}]`).trigger('click'); await w.vm.$nextTick() }
  }
  const typed = async (el: any, v: string) => { el.element.value = v; await el.trigger('input') }
  const dpv = (rows: any, cols: any = []) => base({ pivot: { rows, columns: cols, values: [{ field: 'amount', agg: 'sum' }] } })
  const emitRows = async (w: any, sel: string, next: any[]) => { w.findComponent(`[data-test=${sel}]`).vm.$emit('update:modelValue', next) ; await w.vm.$nextTick() }
  it('dialog commit goes through setAnalysis as one history step', async () => {
    const { w, store, meta } = setup(dpv([{ field: 'region' }]))
    await openDlg(w)
    const i = w.find('[data-label-target="rowName:0"] input')
    await typed(i, 'Reg'); await i.trigger('change')
    expect(meta().pivot.rows[0].label).toBe('Reg')
    expect(store.history.stack.canUndo?.() ?? true).toBeTruthy()
    store.undo()
    expect(meta().pivot.rows[0].label).toBeUndefined()
    store.redo()
    expect(meta().pivot.rows[0].label).toBe('Reg')
  })
  it('typing 5 characters then change = ONE history entry', async () => {
    const { w, store, meta } = setup(dpv([{ field: 'region' }]))
    await openDlg(w)
    const i = w.find('[data-label-target="rowName:0"] input')
    for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde']) await typed(i, s)
    await i.trigger('change'); await i.trigger('keydown', { key: 'Enter' })
    store.undo()
    expect(meta().pivot.rows[0].label).toBeUndefined()
  })
  it('changing a ref field drops label/valueLabels/nullLabel in the SAME setAnalysis call (one undo)', async () => {
    const { w, store, meta } = setup(dpv([{ field: 'region', label: 'R', nullLabel: 'N', valueLabels: { a: 'A' } }]))
    await emitRows(w, 'ab-rows', [{ field: 'd', label: 'R', nullLabel: 'N', valueLabels: { a: 'A' } }])
    expect(meta().pivot.rows).toEqual([{ field: 'd' }])
    store.undo()
    expect(meta().pivot.rows).toEqual([{ field: 'region', label: 'R', nullLabel: 'N', valueLabels: { a: 'A' } }])
  })
  it('changing only the grain keeps label/nullLabel and drops valueLabels', async () => {
    const { w, meta } = setup(dpv([{ field: 'd', label: 'R', nullLabel: 'N', valueLabels: { a: 'A' } }]))
    await emitRows(w, 'ab-rows', [{ field: 'd', grain: 'month', label: 'R', nullLabel: 'N', valueLabels: { a: 'A' } }])
    expect(meta().pivot.rows).toEqual([{ field: 'd', grain: 'month', label: 'R', nullLabel: 'N' }])
  })
  it('identical ref change writes nothing; removing another ref keeps the survivor overrides', async () => {
    const { w, store, meta } = setup(dpv([{ field: 'region', label: 'R' }, { field: 'd', label: 'D', valueLabels: { x: 'X' } }]))
    await emitRows(w, 'ab-rows', [{ field: 'region', label: 'R' }, { field: 'd', label: 'D', valueLabels: { x: 'X' } }])
    expect(store.history.stack.canUndo?.() ?? false).toBeFalsy()
    await emitRows(w, 'ab-rows', [{ field: 'd', label: 'D', valueLabels: { x: 'X' } }])
    expect(meta().pivot.rows).toEqual([{ field: 'd', label: 'D', valueLabels: { x: 'X' } }])
  })
  it('categories come from the result: raw keys of the long rows, null excluded', async () => {
    const { w, store } = setup(dpv([{ field: 'region' }]))
    store.analysis.set('c1', { status: 'ok', long: { dims: ['region'], measures: ['m'], rows: [['a', 1], [null, 2], ['b', 3]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' } as any)
    await w.vm.$nextTick()
    await openDlg(w, 'categories')
    const ids = w.findAll('[data-test=labels-dialog] [data-label-target^="category:row:0:"]').map((e) => e.attributes('data-label-target'))
    expect(ids).toEqual(['category:row:0:a', 'category:row:0:b'])
  })
  it('undo and redo of a label commit re-run the analysis refresh', async () => {
    vi.useFakeTimers()
    const { w, store, calls } = setup(dpv([{ field: 'region' }]))
    await openDlg(w)
    const i = w.find('[data-label-target="rowName:0"] input')
    await typed(i, 'Reg'); await i.trigger('change')
    await vi.advanceTimersByTimeAsync(150)
    const n0 = calls.length
    store.undo(); await vi.advanceTimersByTimeAsync(150)
    expect(calls.length).toBe(n0 + 1)
    store.redo(); await vi.advanceTimersByTimeAsync(150)
    expect(calls.length).toBe(n0 + 2)
    vi.useRealTimers()
  })
})
