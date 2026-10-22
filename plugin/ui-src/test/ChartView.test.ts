import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const destroy = vi.fn()
const render = vi.fn(async () => ({ view: {}, svg: async () => '<svg/>', destroy }))
const loadVega = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: () => loadVega() }))
import ChartView from '../src/analysis/ChartView.vue'

const props = { spec: { mark: 'bar' }, rows: [{ a: 1 }], description: 'Sales by month' }
beforeEach(() => { vi.useFakeTimers(); destroy.mockClear(); render.mockClear(); loadVega.mockReset(); loadVega.mockResolvedValue({ render }) })
afterEach(() => vi.useRealTimers())
const settle = async () => { await flushPromises(); await vi.advanceTimersByTimeAsync(60); await flushPromises() }

describe('ChartView first draw with ResizeObserver', () => {
  it('does not draw at an unknown width: waits for the first real measurement, then draws once at it', async () => {
    let cb: ResizeObserverCallback = () => {}
    class RO { constructor(c: ResizeObserverCallback) { cb = c } observe() {} disconnect() {} unobserve() {} }
    vi.stubGlobal('ResizeObserver', RO)
    const w = mount(ChartView, { props })
    await settle()
    expect(render).not.toHaveBeenCalled()
    cb([{ contentRect: { width: 360 } } as any], {} as any)
    await settle()
    expect(render).toHaveBeenCalledTimes(1)
    expect((render.mock.calls[0] as any[])[3].width).toBe(360)
    w.unmount()
    vi.unstubAllGlobals()
  })
})

describe('ChartView', () => {
  it('loads vega only on mount and renders', async () => {
    expect(loadVega).not.toHaveBeenCalled()
    const w = mount(ChartView, { props })
    await settle()
    expect(loadVega).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(1)
    w.unmount()
  })
  it('role/aria', () => {
    const w = mount(ChartView, { props })
    const el = w.find('[role="img"]')
    expect(el.attributes('aria-label')).toBe('Sales by month')
    w.unmount()
  })
  it('debounces redraw on spec/rows change', async () => {
    const w = mount(ChartView, { props })
    await settle()
    await w.setProps({ rows: [{ a: 2 }] })
    await w.setProps({ spec: { mark: 'line' } })
    await settle()
    expect(render).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
    w.unmount()
  })
  it('destroys on unmount', async () => {
    const w = mount(ChartView, { props })
    await settle()
    w.unmount()
    expect(destroy).toHaveBeenCalled()
  })
  it('load failure shows fallback, emits error, and can retry', async () => {
    loadVega.mockRejectedValueOnce(new Error('boom'))
    const w = mount(ChartView, { props })
    await settle()
    expect(w.text()).toContain('Failed to load the chart component')
    expect(w.emitted('error')).toHaveLength(1)
    await w.find('button').trigger('click')
    await settle()
    expect(render).toHaveBeenCalledTimes(1)
    expect(w.text()).not.toContain('Failed to load')
    w.unmount()
  })
  it('exposes svg()', async () => {
    const w = mount(ChartView, { props })
    await settle()
    expect(await (w.vm as any).svg()).toBe('<svg/>')
    w.unmount()
  })
})

describe('ChartView label click targets (Plan 13 T9)', () => {
  const SVG = '<svg><g class="mark-group role-title"><g class="mark-text role-title-text"><text>Q3</text></g></g>'
    + '<g class="mark-group role-axis" aria-label="X-axis titled \'渠道\'"><g class="mark-text role-axis-title"><text id="xt">渠道</text></g></g>'
    + '<g class="mark-group role-axis" aria-label="Y-axis titled \'销售额\'"><g class="mark-text role-axis-title"><text id="yt">销售额</text></g></g>'
    + '<g class="mark-group role-axis" aria-label="Y-axis"><g class="mark-text role-axis-label"><text id="tick">否</text></g></g>'
    + '<g class="role-legend-title"><text id="lt">是否 VIP</text></g>'
    + '<g class="role-legend-label"><text id="lm1">销售额</text></g><g class="role-legend-label"><text id="lm2">是</text></g></svg>'
  async function mountWith(extra: Record<string, unknown> = {}) {
    render.mockImplementation((async (el: HTMLElement) => { el.innerHTML = SVG; return { view: {}, svg: async () => '<svg/>', destroy } }) as any)
    const w = mount(ChartView, { props: { ...props, ...extra }, attachTo: document.body })
    await settle()
    return w
  }
  const clickOn = (w: any, sel: string) => w.find(sel).element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  it('emits edit-label with the right target for title / x / y axis title / legend title / measure legend entry', async () => {
    const w = await mountWith({ editable: true, measureNames: ['销售额'] })
    clickOn(w, 'g.role-title text'); clickOn(w, '#xt'); clickOn(w, '#yt'); clickOn(w, '#lt'); clickOn(w, '#lm1'); clickOn(w, '#lm2'); clickOn(w, '#tick')
    expect(w.emitted('edit-label')!.map((e: any) => e[0].target)).toEqual([
      { kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }, { kind: 'measureName', index: 0 },
    ])
    expect((w.emitted('edit-label')![1][0] as any).el.tagName.toLowerCase()).toBe('text')
    w.unmount()
  })
  it('horizontal swaps which axis title is x; legendAxis x for pie-like', async () => {
    const w = await mountWith({ editable: true, horizontal: true, legendAxis: 'x' })
    clickOn(w, '#xt'); clickOn(w, '#yt'); clickOn(w, '#lt')
    expect(w.emitted('edit-label')!.map((e: any) => e[0].target)).toEqual([{ kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'x' }])
    w.unmount()
  })
  it('editable=false (default) emits nothing and has no editable class', async () => {
    const w = await mountWith()
    clickOn(w, 'g.role-title text'); clickOn(w, '#xt'); clickOn(w, '#lt')
    expect(w.emitted('edit-label')).toBeUndefined()
    expect(w.find('.chart-host').classes()).not.toContain('editable')
    w.unmount()
  })
})

describe('ChartView legend measure matching and axis wording (Plan 13 T9 fix)', () => {
  const legend = (t: string) => `<svg><g class="role-legend-label"><text id="lg">${t}</text></g></svg>`
  async function click(textInLegend: string, measureNames: string[]) {
    render.mockImplementation((async (el: HTMLElement) => { el.innerHTML = legend(textInLegend); return { view: {}, svg: async () => '<svg/>', destroy } }) as any)
    const w = mount(ChartView, { props: { ...props, editable: true, measureNames }, attachTo: document.body })
    await settle()
    w.find('#lg').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const e = w.emitted('edit-label')
    w.unmount()
    return e ? (e[0][0] as any).target : null
  }
  it('exact match beats suffix match', async () => {
    expect(await click('B · A', ['A', 'B · A'])).toEqual({ kind: 'measureName', index: 1 })
    expect(await click('A', ['A', 'B · A'])).toEqual({ kind: 'measureName', index: 0 })
  })
  it('suffix ties go to the longest measure name; category value equal to a measure name still resolves the suffix', async () => {
    expect(await click('x · B · A', ['A', 'B · A'])).toEqual({ kind: 'measureName', index: 1 })
    expect(await click('A · A', ['A', 'B'])).toEqual({ kind: 'measureName', index: 0 })
    expect(await click('x · C', ['A', 'B'])).toBeNull()
  })
  it('pins the vega axis aria-label wording that axis detection depends on', async () => {
    const { loadVega } = await vi.importActual<typeof import('../src/analysis/vegaRuntime')>('../src/analysis/vegaRuntime')
    const rt = await loadVega()
    const el = document.createElement('div')
    const spec = { data: { name: 'table' }, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal', title: 'XT' }, y: { field: 'b', type: 'quantitative', title: 'YT' } } }
    const c = await rt.render(el, spec, [{ a: 'p', b: 1 }], { width: 200, height: 120, config: {} })
    const labels = Array.from(el.querySelectorAll('g.role-axis')).map((n) => n.getAttribute('aria-label') ?? '')
    expect(labels.some((l) => /^x-axis/i.test(l))).toBe(true)
    expect(labels.some((l) => /^y-axis/i.test(l))).toBe(true)
    expect(el.querySelectorAll('g.role-axis g.role-axis-title text').length).toBe(2)
    c.destroy()
  })
})
