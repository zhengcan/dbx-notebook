import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: async () => ({ view: {}, svg: async () => '', destroy() {} }) }) }))
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = () => ({ status: 'ok' as const, executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['a', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } })
const longRes = (rows: any[] = [['A', 10], ['B', 5]]) => ({ status: 'ok', long: { dims: ['region'], measures: ['amount'], rows }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' }) as any
const meta0 = (over: any = {}) => ({ data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, ...over })

let wrappers: VueWrapper<any>[] = []
function setup(m: any = meta0()) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  store.nb.value.blocks.push(src as any)
  store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: m } as any)
  store.runs.set('s1', run() as any)
  const calls: string[] = []
  store.setAnalysisRunner(async (id) => { calls.push(id); return longRes() })
  store.analysis.set('c1', longRes())
  const spy = vi.spyOn(store, 'setAnalysis')
  const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, attachTo: document.body, global: { provide: { [StoreKey as symbol]: store } } })
  wrappers.push(w)
  return { store, w, spy, calls, meta: () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any }
}
const D = '[data-test=labels-dialog]'
const dialogs = () => document.querySelectorAll(D)
const btn = (w: VueWrapper<any>) => w.find('[data-test=ab-labels-open]')
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-label-target="${id}"] input`)!
const group = async (g: string) => { document.querySelector<HTMLElement>(`[role=tab][data-tab=${({ measures: 'table', names: 'table', units: 'numbers' } as Record<string, string>)[g] ?? g}]`)!.click(); await flushPromises() }
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
const commit = async (el: HTMLInputElement, v: string) => { type(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); await flushPromises() }
const openDlg = async (w: VueWrapper<any>) => { await btn(w).trigger('click'); await flushPromises() }
const esc = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

beforeEach(() => vi.useRealTimers())
afterEach(() => { wrappers.forEach((w) => w.unmount()); wrappers = []; document.body.innerHTML = '' })

describe('labels dialog wiring', () => {
  it('clicking 高级设置 opens the dialog titled 高级设置 and focus is inside; Esc closes and focus returns to the button', async () => {
    const { w } = setup()
    setLocale('zh-CN')
    await w.vm.$nextTick()
    expect(btn(w).text()).toBe('高级设置')
    await openDlg(w)
    expect(dialogs()).toHaveLength(1)
    expect(document.querySelector(`${D} h2`)!.textContent).toBe('高级设置')
    expect(document.querySelector(D)!.getAttribute('aria-labelledby')).toBe(document.querySelector(`${D} h2`)!.id)
    setLocale('en')
    expect(document.querySelector(D)!.contains(document.activeElement)).toBe(true)
    esc(document.activeElement!); await flushPromises()
    expect(dialogs()).toHaveLength(0)
    expect(document.activeElement).toBe(btn(w).element)
  })
  it('open popover then click 标签: popover gone (its pending text committed), one dialog', async () => {
    const { w, meta } = setup()
    await w.find('.lbl-edit[data-label-target="rowName:0"]').trigger('click'); await flushPromises()
    const pi = document.querySelector<HTMLInputElement>('[data-test=label-popover-input]')!
    type(pi, 'Pending')
    await openDlg(w)
    expect(document.querySelector('[data-test=label-popover]')).toBeNull()
    expect(dialogs()).toHaveLength(1)
    expect(meta().pivot.rows[0].label).toBe('Pending')
  })
  it('✎ click while dialog open does nothing', async () => {
    const { w } = setup()
    await openDlg(w)
    await w.find('.lbl-edit[data-label-target="rowName:0"]').trigger('click'); await flushPromises()
    expect(document.querySelector('[data-test=label-popover]')).toBeNull()
    expect(dialogs()).toHaveLength(1)
  })
  it('commit in dialog = one history entry; undo refreshes the visible input and the runner is called; redo likewise', async () => {
    vi.useFakeTimers()
    const { w, store, calls, spy } = setup()
    await openDlg(w)
    await commit(input('rowName:0'), 'Reg')
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    const n0 = calls.length
    store.undo(); await vi.advanceTimersByTimeAsync(150)
    expect(input('rowName:0').value).toBe('')
    expect(calls.length).toBe(n0 + 1)
    store.redo(); await vi.advanceTimersByTimeAsync(150)
    expect(input('rowName:0').value).toBe('Reg')
    expect(calls.length).toBe(n0 + 2)
  })
  it('commit in the 表格 tab: undo/redo refresh the input, tab count, footer total and preview text', async () => {
    vi.useFakeTimers()
    const { w, store } = setup()
    await openDlg(w)
    const tabCount = () => document.querySelector('[role=tab][data-tab=table] .ld-n')?.textContent ?? ''
    const total = () => document.querySelector('[data-test=labels-total]')!.textContent
    const pv = () => document.querySelector('[data-test=labels-preview]')!.textContent
    const total0 = total()
    await commit(input('rowName:0'), 'Reg')
    await vi.advanceTimersByTimeAsync(150)
    expect(tabCount()).toContain('1')
    expect(total()).not.toBe(total0)
    expect(pv()).toContain('Reg')
    store.undo(); await vi.advanceTimersByTimeAsync(150)
    expect(input('rowName:0').value).toBe('')
    expect(tabCount()).toBe('')
    expect(total()).toBe(total0)
    expect(pv()).not.toContain('Reg')
    store.redo(); await vi.advanceTimersByTimeAsync(150)
    expect(input('rowName:0').value).toBe('Reg')
    expect(tabCount()).toContain('1')
    expect(total()).not.toBe(total0)
    expect(pv()).toContain('Reg')
  })
  it('undo while an input is dirty: shows the undone store value, a later blur does not rewrite the stale value', async () => {
    const { w, store, spy } = setup()
    await openDlg(w)
    await commit(input('rowName:0'), 'Reg')
    spy.mockClear()
    type(input('rowName:0'), 'Reg2')
    store.undo(); await flushPromises()
    expect(input('rowName:0').value).toBe('')
    input('rowName:0').dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    expect(spy).not.toHaveBeenCalled()
  })
  it('an input mid-edit is reset when an unrelated store change happens (undo of another row)', async () => {
    const { w, store, spy } = setup(meta0({ chartOptions: { type: 'bar' } }))
    await openDlg(w)
    await commit(input('rowName:0'), 'Reg')
    await group('chart')
    type(input('title'), 'dirty')
    store.undo(); await flushPromises()
    expect(input('title').value).toBe('')
    spy.mockClear()
    input('title').dispatchEvent(new Event('change', { bubbles: true })); await flushPromises()
    expect(spy).not.toHaveBeenCalled()
  })
  it('chart.title edited in the config panel updates the dialog input and vice versa (one history step each)', async () => {
    const { w, store, meta } = setup()
    await openDlg(w)
    await group('chart')
    const depth = store.history.undoDepth.value
    await w.find('[data-test=ab-title]').setValue('FromPanel')
    expect(input('title').value).toBe('FromPanel')
    expect(store.history.undoDepth.value).toBe(depth + 1)
    await commit(input('title'), 'FromDialog')
    expect((w.find('[data-test=ab-title]').element as HTMLInputElement).value).toBe('FromDialog')
    expect(meta().chartOptions.title).toBe('FromDialog')
    expect(store.history.undoDepth.value).toBe(depth + 2)
  })
  it('analysis re-run keeps the dialog open and the focused input value', async () => {
    const { w, store } = setup()
    await openDlg(w)
    const i = input('rowName:0')
    i.focus(); type(i, 'typing')
    store.analysis.set('c1', longRes([['A', 11], ['B', 6], ['C', 1]])); await flushPromises()
    expect(dialogs()).toHaveLength(1)
    expect(input('rowName:0')).toBe(i)
    expect(document.activeElement).toBe(i)
    expect(i.value).toBe('typing')
  })
  it('source cleared / block deleted / legacy → dialog closes', async () => {
    let c = setup(); await openDlg(c.w)
    c.store.runs.delete('s1'); await flushPromises()
    expect(dialogs()).toHaveLength(0)
    c.w.unmount(); wrappers.pop()
    c = setup(); await openDlg(c.w)
    c.store.removeBlock('c1'); await flushPromises()
    expect(dialogs()).toHaveLength(0)
    c.w.unmount(); wrappers.pop()
    c = setup(); await openDlg(c.w)
    c.meta().pivot = null; await flushPromises()
    expect(dialogs()).toHaveLength(0)
  })
  it('legacy flipping on then off does not resurrect the dialog', async () => {
    const { w, meta } = setup(); await openDlg(w)
    const pivot = meta().pivot
    meta().pivot = null; await flushPromises()
    expect(dialogs()).toHaveLength(0)
    meta().pivot = pivot; await flushPromises()
    expect(dialogs()).toHaveLength(0)
  })
  it('blockId change closes the dialog', async () => {
    const { w, store } = setup()
    store.nb.value.blocks.push({ id: 'c2', type: 'chart', metadata: meta0() } as any)
    await openDlg(w)
    await w.setProps({ blockId: 'c2' }); await flushPromises()
    expect(dialogs()).toHaveLength(0)
  })
  it('two AnalysisBlocks: opening in B closes A\'s dialog', async () => {
    setLocale('en')
    const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
    store.nb.value.blocks.push(src as any, { id: 'c1', type: 'chart', metadata: meta0() } as any, { id: 'c2', type: 'chart', metadata: meta0() } as any)
    store.runs.set('s1', run() as any)
    store.setAnalysisRunner(async () => longRes())
    store.analysis.set('c1', longRes()); store.analysis.set('c2', longRes())
    const Two = defineComponent({ render: () => h('div', [h(AnalysisBlock, { blockId: 'c1' }), h(AnalysisBlock, { blockId: 'c2' })]) })
    const w = mount(Two, { attachTo: document.body, global: { provide: { [StoreKey as symbol]: store } } })
    wrappers.push(w)
    const [a, b] = Array.from(document.querySelectorAll<HTMLElement>('[data-test=ab-labels-open]'))
    a.click(); await flushPromises()
    expect(dialogs()).toHaveLength(1)
    expect(document.querySelectorAll('[data-test=analysis-block]')[0].contains(document.querySelector(D))).toBe(true)
    // B's button sits behind the modal in real use; emulate a programmatic open
    b.click(); await flushPromises()
    expect(dialogs()).toHaveLength(1)
    expect(document.querySelectorAll('[data-test=analysis-block]')[1].contains(document.querySelector(D))).toBe(true)
  })
  it('dialog does not render for legacy blocks (no button either)', async () => {
    const { w } = setup({ data: 'sales', spec: { mark: 'bar' } })
    expect(btn(w).exists()).toBe(false)
    expect(dialogs()).toHaveLength(0)
  })
  it('no <details data-test=labels-panel> in the DOM, open or closed', async () => {
    const { w } = setup()
    expect(document.querySelector('details[data-test=labels-panel]')).toBeNull()
    await openDlg(w)
    expect(document.querySelector('details[data-test=labels-panel]')).toBeNull()
  })
  it('old file opens dirty=false; open/close the dialog without edits keeps the notebook byte-identical on save', async () => {
    const { w, store } = setup()
    const text = store.toText()
    store.load(text, null, null)
    expect(store.dirty.value).toBe(false)
    const before = store.toText()
    const w2 = mount(AnalysisBlock, { props: { blockId: 'c1' }, attachTo: document.body, global: { provide: { [StoreKey as symbol]: store } } })
    wrappers.push(w2)
    await flushPromises()
    await w2.find('[data-test=ab-labels-open]').trigger('click'); await flushPromises()
    esc(document.activeElement!); await flushPromises()
    expect(store.dirty.value).toBe(false)
    expect(store.toText()).toBe(before)
  })
  it('the preview slot gets the block\'s real category keys (rows map to row keys, columns to column keys)', async () => {
    const { w, store } = setup(meta0({ view: 'table', pivot: { rows: [{ field: 'region' }], columns: [{ field: 'q' }], values: [{ field: 'amount', agg: 'sum' }] } }))
    store.analysis.set('c1', { ...longRes(), long: { dims: ['region', 'q'], measures: ['amount'], rows: [['RowKeyA', 'ColKeyX', 1], ['RowKeyB', 'ColKeyY', 2]] } })
    await flushPromises()
    await openDlg(w)
    const pv = document.querySelector('[data-test=labels-preview-slot]')!
    const heads = Array.from(pv.querySelectorAll('.lpv-rh:not(.lpv-total)')).map((e) => e.textContent)
    const groups = Array.from(pv.querySelectorAll('.lpv-grp')).map((e) => e.textContent)
    expect(heads).toContain('RowKeyA')
    expect(heads).not.toContain('ColKeyX')
    expect(groups).toContain('ColKeyX')
    expect(groups).not.toContain('RowKeyA')
    await group('categories')
    const ids = Array.from(document.querySelectorAll('[data-label-target^="category:"]')).map((e) => e.getAttribute('data-label-target'))
    expect(ids).toEqual(expect.arrayContaining(['category:row:0:RowKeyA', 'category:column:0:ColKeyX']))
  })
  it('markup typed in the dialog is shown as text in the table header (no element injected)', async () => {
    const { w } = setup(meta0({ view: 'table' }))
    await openDlg(w)
    await group('measures')
    const evil = '<img src=x onerror=alert(1)>&amp;'
    await commit(input('measureName:0'), evil)
    expect(w.find('[data-test=ab-table] img').exists()).toBe(false)
    expect(w.find('[data-test=ab-table]').text()).toContain(evil)
  })
})

describe('dialog numbered preview', () => {
  const fx = () => {
    const r = setup(meta0({ view: 'table', pivot: { rows: [{ field: 'region' }, { field: 'city' }], columns: [{ field: 'q' }, { field: 'yr' }], values: [{ field: 'amount', agg: 'sum' }, { field: 'n', agg: 'count' }] } }))
    const rows: any[] = []
    for (const a of ['RA', 'RB', 'RC']) for (const b of ['CA', 'CB']) for (const c of ['Q1', 'Q2']) for (const y of ['Y1', 'Y2']) rows.push([a, b, c, y, 1, 2])
    r.store.analysis.set('c1', { ...longRes(), long: { dims: ['region', 'city', 'q', 'yr'], measures: ['amount', 'n'], rows } })
    return r
  }
  const heads = () => Array.from(document.querySelectorAll('[data-test=labels-dialog] [data-test=label-num]')).map((e) => e.textContent!.trim())
  const badges = () => Array.from(document.querySelectorAll('[data-test=labels-preview-slot] .lp-badge')).map((e) => e.textContent!.trim())
  for (const tab of ['table', 'chart', 'numbers', 'categories']) {
    it(`${tab} tab: every badge digit is a heading digit and no digit repeats among badges`, async () => {
      const { w } = fx()
      await openDlg(w)
      await group(tab)
      const b = badges(), h = heads()
      expect(h.length).toBeGreaterThan(0)
      expect(b.length).toBeGreaterThan(0)
      for (const d of b) expect(h).toContain(d)
      expect(new Set(b).size).toBe(b.length)
      expect(h.join()).toBe(h.map((_, i) => i + 1).join())
      expect(document.querySelector('[data-test=labels-preview-slot] .lp-badge')!.closest('[aria-hidden=true]')).not.toBeNull()
    })
  }
  it('table tab: every heading digit that has a place in the sketch appears once', async () => {
    const { w } = fx()
    await openDlg(w)
    const b = badges(), h = heads()
    expect(h.length).toBeGreaterThan(2)
    for (const d of h) expect(b.filter((x) => x === d)).toHaveLength(1)
  })
  it('categories: a search that hides items removes their numbers from the badges', async () => {
    const { w, store } = setup(meta0({ view: 'table' }))
    store.analysis.set('c1', { ...longRes(), long: { dims: ['region'], measures: ['amount'], rows: Array.from({ length: 60 }, (_, i) => ['k' + String(i).padStart(2, '0'), 1]) } })
    await openDlg(w)
    await group('categories')
    const before = badges()
    expect(before.length).toBeGreaterThan(1)
    expect(heads().length).toBe(51)
    const si = document.querySelector<HTMLInputElement>('[data-test=label-search]')!
    type(si, 'k59'); await flushPromises()
    expect(heads()).toEqual(['1', '2'])
    expect(badges()).toEqual(['1'])
    expect(before.length).toBeGreaterThan(1)
    type(si, ''); await flushPromises()
    expect(badges()).toEqual(before)
  })
  it('switching tabs renumbers 1..m per tab', async () => {
    const { w } = fx()
    await openDlg(w)
    for (const tab of ['table', 'chart', 'numbers', 'categories', 'table']) {
      await group(tab)
      const h = heads()
      expect(h).toEqual(h.map((_, i) => String(i + 1)))
      for (const d of badges()) expect(Number(d)).toBeLessThanOrEqual(h.length)
    }
  })
})

describe('advanced settings cleanup guards', () => {
  it('no sidebar/strip elements, and every label.dialog.* i18n key is referenced in src', async () => {
    const { w } = setup()
    await openDlg(w)
    expect(document.querySelector('[data-test=labels-groups],[data-test=labels-reset-group],.ld-nb,[data-group-nav]')).toBeNull()
    const mods = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const code = Object.entries(mods).filter(([f]) => !f.endsWith('/i18n.ts')).map(([, c]) => c).join('\n')
    const { messages } = await import('../src/i18n')
    const keys = Object.keys((messages as any).en).filter((k) => k.startsWith('label.dialog.'))
    expect(keys.length).toBeGreaterThan(5)
    expect(Object.keys((messages as any)['zh-CN']).filter((k) => k.startsWith('label.dialog.')).sort()).toEqual([...keys].sort())
    const quoted = (k: string) => ["'", '"', '`'].some((q) => code.includes(q + k + q))
    const dead = keys.filter((k) => !quoted(k) && !(/^label\.dialog\.tab\.[a-z]+$/.test(k) && code.includes('label.dialog.tab.${')))
    expect(dead).toEqual([])
  })
})
