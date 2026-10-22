import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'

vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: async () => ({ view: {}, svg: async () => '', destroy() {} }) }) }))
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import ChartView from '../src/analysis/ChartView.vue'
import PivotTable from '../src/analysis/PivotTable.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = () => ({ status: 'ok' as const, executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['a', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } })
const longRes = { status: 'ok', long: { dims: ['region'], measures: ['amount'], rows: [['a', 10], ['b', 5]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any
const meta0 = (over: any = {}) => ({ data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, ...over })

let wrappers: VueWrapper[] = []
function setup(m: any = meta0()) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  store.nb.value.blocks.push(src as any)
  store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: m } as any)
  store.runs.set('s1', run() as any)
  store.setAnalysisRunner(async () => longRes)
  store.analysis.set('c1', longRes)
  const spy = vi.spyOn(store, 'setAnalysis')
  const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, attachTo: document.body, global: { provide: { [StoreKey as symbol]: store } } })
  wrappers.push(w)
  return { store, w, spy, meta: () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any }
}
const dlg = () => document.querySelector<HTMLElement>('[role=dialog][data-test=label-popover]')
const inp = (i = 0) => document.querySelectorAll<HTMLInputElement>('[data-test=label-popover-input]')[i]
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
const key = (el: Element, k: string, o: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }))
const edit = (w: VueWrapper, id: string) => w.find(`.lbl-edit[data-label-target="${id}"]`)
async function open(w: VueWrapper, id = 'rowName:0') { await edit(w, id).trigger('click'); await flushPromises() }

beforeEach(() => vi.useRealTimers())
afterEach(() => { wrappers.forEach((w) => w.unmount()); wrappers = []; document.body.innerHTML = '' })

describe('label popover', () => {
  it('opens from PivotTable edit-label with input focused and auto text as placeholder', async () => {
    const { w } = setup()
    await open(w)
    expect(dlg()).toBeTruthy()
    expect(inp().placeholder).toBe('region')
    expect(document.activeElement).toBe(inp())
    expect(w.element.contains(dlg())).toBe(true)
    expect(dlg()!.parentElement).toBe(w.element)
  })
  it('Enter commits patch and closes; one history entry; undo restores', async () => {
    const { w, store, spy, meta } = setup()
    await open(w)
    type(inp(), 'Area')
    key(inp(), 'Enter'); await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(meta().pivot.rows[0].label).toBe('Area')
    expect(dlg()).toBeNull()
    store.undo(); await flushPromises()
    expect(meta().pivot.rows[0].label).toBeUndefined()
  })
  it('typing 5 characters = one history entry', async () => {
    const { w, spy } = setup()
    await open(w)
    for (const v of ['A', 'Ab', 'Abc', 'Abcd', 'Abcde']) type(inp(), v)
    expect(spy).not.toHaveBeenCalled()
    key(inp(), 'Enter')
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('Escape closes, no store call, focus on trigger', async () => {
    const { w, spy } = setup()
    await open(w)
    type(inp(), 'zzz')
    key(inp(), 'Escape'); await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(dlg()).toBeNull()
    expect(document.activeElement).toBe(edit(w, 'rowName:0').element)
  })
  it('outside click commits when changed, no call when unchanged', async () => {
    const a = setup()
    await open(a.w); type(inp(), 'X')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await flushPromises()
    expect(a.spy).toHaveBeenCalledTimes(1); expect(dlg()).toBeNull()
    a.w.unmount(); wrappers = []
    const b = setup()
    await open(b.w)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await flushPromises()
    expect(b.spy).not.toHaveBeenCalled(); expect(dlg()).toBeNull()
  })
  it('reset button removes override', async () => {
    const { w, meta } = setup(meta0({ pivot: { rows: [{ field: 'region', label: 'Area' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] } }))
    await open(w)
    expect(inp().value).toBe('Area')
    ;(document.querySelector('[data-test=label-popover-reset]') as HTMLElement).click(); await flushPromises()
    expect(meta().pivot.rows[0].label).toBeUndefined()
    expect(dlg()).toBeNull()
  })
  it('Tab from last control wraps to input (trap) and Shift+Tab reverse', async () => {
    const { w } = setup()
    await open(w)
    const done = document.querySelector<HTMLElement>('[data-test=label-popover-done]')!
    done.focus()
    key(done, 'Tab')
    expect(document.activeElement).toBe(inp())
    key(inp(), 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(done)
  })
  it('focus returns to the new .lbl-edit with same data-label-target when the header re-rendered', async () => {
    const { w, store } = setup()
    await open(w)
    type(inp(), 'Area')
    key(inp(), 'Enter'); await flushPromises()
    const nu = edit(w, 'rowName:0').element
    expect(document.activeElement).toBe(nu)
    expect(nu.isConnected).toBe(true)
    void store
  })
  it('falls back to the block root when nothing matches', async () => {
    const { w } = setup()
    await w.findComponent(ChartView).vm.$emit('edit-label', { target: { kind: 'title' }, el: document.createElement('span') })
    await flushPromises()
    key(inp(), 'Escape'); await flushPromises()
    expect(document.activeElement).toBe(w.element)
  })
  it('opening a second popover closes the first (one dialog in DOM)', async () => {
    const { w } = setup()
    await open(w)
    await open(w, 'measureName:0')
    expect(document.querySelectorAll('[role=dialog][data-test=label-popover]')).toHaveLength(1)
  })
  it('aria: role dialog non-modal, aria-label contains current name; input has accessible name', async () => {
    const { w } = setup()
    await open(w)
    expect(dlg()!.getAttribute('aria-label')).toBe('Edit label: region')
    expect(dlg()!.getAttribute('aria-modal')).toBeNull()
    expect(document.querySelector(`label[for="${inp().id}"]`)!.textContent).toBeTruthy()
  })
  it('chart title click opens popover for target title; axis click for axis x', async () => {
    const { w, meta } = setup()
    const cv = w.findComponent(ChartView)
    expect(cv.props('editable')).toBe(true)
    cv.vm.$emit('edit-label', { target: { kind: 'title' }, el: document.createElement('span') }); await flushPromises()
    expect(dlg()!.getAttribute('aria-label')).toContain('Edit label')
    type(inp(), 'T!'); key(inp(), 'Enter'); await flushPromises()
    expect(meta().chartOptions.title).toBe('T!')
    cv.vm.$emit('edit-label', { target: { kind: 'axis', axis: 'x' }, el: document.createElement('span') }); await flushPromises()
    expect(inp().placeholder).toBe('region')
    type(inp(), 'XX'); key(inp(), 'Enter'); await flushPromises()
    expect(meta().chartOptions.axisTitles.x).toBe('XX')
  })
  it('measure popover edits label, unit and scale in one commit (single history step)', async () => {
    const { w, store, spy, meta } = setup()
    await open(w, 'measureName:0')
    expect(document.querySelectorAll('[data-test=label-popover-input]')).toHaveLength(3)
    type(inp(0), 'Sales'); type(inp(1), '万元'); type(inp(2), '10000')
    ;(document.querySelector('[data-test=label-popover-done]') as HTMLElement).click(); await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
    const v = meta().pivot.values[0]
    expect([v.label, v.format.unit, v.format.scale]).toEqual(['Sales', '万元', 10000])
    store.undo(); await flushPromises()
    expect(meta().pivot.values[0].label).toBeUndefined()
  })
  it('invalid scale blocks commit and shows aria-invalid', async () => {
    const { w, spy } = setup()
    await open(w, 'measureName:0')
    type(inp(2), 'abc')
    key(inp(2), 'Enter'); await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(dlg()).toBeTruthy()
    expect(inp(2).getAttribute('aria-invalid')).toBe('true')
  })
  it('markup is stored literally and rendered as text; 200+ chars truncated', async () => {
    const { w, meta } = setup()
    await open(w)
    type(inp(), '<img src=x onerror=alert(1)>'); key(inp(), 'Enter'); await flushPromises()
    expect(meta().pivot.rows[0].label).toBe('<img src=x onerror=alert(1)>')
    expect(w.element.querySelector('th img')).toBeNull()
    expect(w.text()).toContain('<img src=x onerror=alert(1)>')
    await open(w)
    type(inp(), 'a'.repeat(250)); key(inp(), 'Enter'); await flushPromises()
    expect(meta().pivot.rows[0].label).toHaveLength(200)
  })
  it('popover not offered when not editable (legacy spec block)', async () => {
    const { w } = setup({ data: 'sales', spec: { mark: 'bar' }, view: 'both' })
    expect(w.find('.lbl-edit').exists()).toBe(false)
    expect(w.findComponent(ChartView).props('editable')).toBeFalsy()
  })
  it('sort click on header still sorts while popover closed', async () => {
    const { w, meta } = setup()
    await w.find('button[data-sort=value]').trigger('click')
    expect(meta().pivot.sort).toBeTruthy()
    expect(dlg()).toBeNull()
  })
  it('F2 on header sort button opens the popover', async () => {
    const { w } = setup()
    await w.find('button[data-sort=name]').trigger('keydown', { key: 'F2' }); await flushPromises()
    expect(dlg()).toBeTruthy()
    expect(w.findComponent(PivotTable).props('editable')).toBe(true)
  })
})
