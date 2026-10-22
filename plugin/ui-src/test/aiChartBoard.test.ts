import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
const render = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: (...a: unknown[]) => render(...a) }) }))
import ChartSchemeBoard from '../src/ai/ChartSchemeBoard.vue'
import boardSrc from '../src/ai/ChartSchemeBoard.vue?raw'
import { chartDrawWidth } from '../src/ai/chartSizing'
import { setLocale, t } from '../src/i18n'
import { fallbackSummary } from '../src/ai/chartAiGate'

const mk = (type: string, title = '') => ({ title, config: { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'sum' as const }] }, chartOptions: { type } } })
const cands = [mk('bar', 'A'), mk('barHorizontal', 'B'), mk('line', '')] as any[]
const few = { columns: [{ name: 'r' }, { name: 'v' }], rows: [['a', 1], ['b', 2]] as unknown[][] }
const many = { columns: [{ name: 'r' }, { name: 'v' }], rows: Array.from({ length: 80 }, (_, i) => [`cat${i}`, i]) as unknown[][] }

beforeEach(() => {
  setLocale('zh')
  render.mockReset()
  render.mockImplementation(async (_e: unknown, _s: unknown, rows: any[]) => ({
    view: {}, destroy() {},
    svg: async () => `<svg xmlns="http://www.w3.org/2000/svg">${rows.map((r) => `<text>${r.x}</text>`).join('')}</svg>`,
  }))
})

describe('ChartSchemeBoard', () => {
  it('cards show n. title and summary, no preview thumbnails (no CandidatePreview, no svg in cards)', async () => {
    const withSum = [{ ...cands[0], summary: 'Sum A' }, { ...cands[1], summary: 'Sum B' }, cands[2]] as any[]
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: withSum, selected: 0 } })
    await flushPromises()
    const cards = w.findAll('[data-test="scheme-card"]')
    expect(cards.length).toBe(3)
    expect(cards[0].text()).toContain('1. A')
    expect(cards[0].text()).toContain('Sum A')
    expect(cards[1].text()).toContain('2. B')
    expect(w.findComponent({ name: 'CandidatePreview' }).exists()).toBe(false)
    expect(w.findAll('[data-test="scheme-card"] svg').length).toBe(0)
    expect(boardSrc).not.toMatch(/<CandidatePreview|CandidatePreview\.vue/)
    expect(boardSrc).not.toContain('v-html="c.')
  })
  it('untitled card falls back to a numbered label', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
    await flushPromises()
    expect(w.findAll('[data-test="scheme-card"]')[2].text()).toContain('3. ' + t('ai.chart.untitled', { n: 3 }))
  })
  it('summary with <img onerror> renders as text, no img element', async () => {
    const evil = [{ ...cands[0], summary: '<img src=x onerror="window.__pwn=1">hi' }] as any[]
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: evil, selected: 0 } })
    await flushPromises()
    expect(w.find('[data-test="scheme-card"] img').exists()).toBe(false)
    expect(w.get('[data-test="scheme-card"]').text()).toContain('<img src=x onerror="window.__pwn=1">hi')
  })
  it('missing summary shows fallbackSummary text', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
    await flushPromises()
    const fb = fallbackSummary(cands[0].config)
    expect(fb).toContain('bar')
    expect(fb).toContain('sum(v)')
    expect(w.get('[data-test="scheme-card"]').text()).toContain(fb)
  })
  it('exactly one large preview; selecting another card redraws it; click emits select', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
    await flushPromises()
    expect(w.findAll('[data-test="scheme-large"]').length).toBe(1)
    expect(render.mock.calls.length).toBe(1)
    const th = w.findAll('[data-test="scheme-card"]')
    expect(th.map((x) => x.attributes('aria-checked'))).toEqual(['true', 'false', 'false'])
    await th[2].trigger('click')
    expect(w.emitted('select')![0]).toEqual([2])
    render.mockClear()
    await w.setProps({ selected: 2 })
    await flushPromises()
    expect(render.mock.calls.length).toBe(1)
    expect(w.findAll('[data-test="scheme-large"]').length).toBe(1)
  })
  it('large preview re-renders at previewSize on selection change', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: many, candidates: cands, selected: 0 } })
    await flushPromises()
    render.mockClear()
    await w.setProps({ selected: 1 })
    await flushPromises()
    const big = render.mock.calls.map((c: any[]) => c[3]).find((o: any) => o.height === 80 * 24 + 90)
    expect(big).toBeTruthy()
  })
  it('many categories: scroll container and all labels present', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: many, candidates: cands, selected: 1 } })
    await flushPromises()
    const large = w.get('[data-test="scheme-large"]')
    expect(large.attributes('style')).toContain('max-height: 520px')
    expect(large.attributes('style')).not.toContain('overflow-x')
    expect(large.findAll('text').length).toBe(80)
    expect(large.attributes('tabindex')).toBe('0')
    expect(large.attributes('aria-label')).toBeTruthy()
  })
  it('apply emits index with aria-label containing title', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 1 } })
    await flushPromises()
    const b = w.get('[data-test="scheme-apply"]')
    expect(b.attributes('aria-label')).toContain('B')
    await b.trigger('click')
    expect(w.emitted('apply')![0]).toEqual([1])
  })
  it('caption says approximate', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
    await flushPromises()
    expect(w.get('[data-test="scheme-caption"]').text()).toBe(t('ai.chart.preview'))
  })
  it('large preview scrolls vertically only (class), no inline overflow override', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 1 } })
    await flushPromises()
    expect(w.get('[data-test="scheme-large"]').attributes('style') ?? '').not.toContain('overflow')
  })
  it('only the large render gets large:true and the measured width', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
    await flushPromises()
    const opts = render.mock.calls.map((c: any[]) => c[3])
    expect(opts.filter((o: any) => o.config.axis.labelLimit === 0).length).toBe(1)
    expect(opts.length).toBe(1)
    expect(opts.some((o: any) => o.width === chartDrawWidth(480, { type: 'bar', hasLegend: false }) && o.height === 340)).toBe(true)
    w.unmount()
  })
  it('roving tabindex and arrow keys select and focus', async () => {
    const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 }, attachTo: document.body })
    await flushPromises()
    const th = () => w.findAll('[data-test="scheme-card"]')
    expect(th().map((x) => x.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(w.find('[role="radiogroup"]').exists()).toBe(true)
    await th()[0].trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('select')![0]).toEqual([1])
    await th()[0].trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('select')![1]).toEqual([2])
    w.unmount()
  })
  it('ResizeObserver re-measures (debounced) and disconnects on unmount', async () => {
    vi.useFakeTimers()
    const inst: any[] = []
    class RO { cb: () => void; disconnect = vi.fn(); observe = vi.fn(); constructor(cb: () => void) { this.cb = cb; inst.push(this) } }
    vi.stubGlobal('ResizeObserver', RO)
    let cw = 0
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => cw)
    try {
      const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(inst.length).toBe(1)
      expect(inst[0].observe).toHaveBeenCalled()
      render.mockClear()
      cw = 700
      inst[0].cb(); inst[0].cb()
      await vi.advanceTimersByTimeAsync(150)
      await flushPromises()
      expect(render.mock.calls.some((c: any[]) => c[3].width === chartDrawWidth(700, { type: 'bar', hasLegend: false }) && c[3].config.axis.labelLimit === 0)).toBe(true)
      w.unmount()
      expect(inst[0].disconnect).toHaveBeenCalled()
    } finally { spy.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })
  it('board measures .large, not the root', async () => {
    let large = 0
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-test') === 'scheme-large' ? large : 999
    })
    try {
      large = 433
      const w2 = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
      await flushPromises()
      const widths = render.mock.calls.map((c: any[]) => c[3].width)
      expect(widths).toContain(chartDrawWidth(433, { type: 'bar', hasLegend: false }))
      expect(widths).not.toContain(999)
      w2.unmount()
    } finally { spy.mockRestore() }
  })
  it('large container has overflow-x hidden and scrollbar-gutter stable', () => {
    const rule = /\.large\s*\{[^}]*\}/.exec(boardSrc)![0]
    expect(rule).toContain('overflow-x: hidden')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('scrollbar-gutter: stable')
  })
  it('hidden (0-width) container keeps the default, then redraws at the real width when shown', async () => {
    vi.useFakeTimers()
    const inst: any[] = []
    class RO { cb: () => void; disconnect = vi.fn(); observe = vi.fn(); constructor(cb: () => void) { this.cb = cb; inst.push(this) } }
    vi.stubGlobal('ResizeObserver', RO)
    let cw = 0
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => cw)
    try {
      const w = mount(ChartSchemeBoard, { props: { source: few, candidates: cands, selected: 0 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(render.mock.calls.some((c: any[]) => c[3].width === chartDrawWidth(480, { type: 'bar', hasLegend: false }))).toBe(true)
      render.mockClear()
      cw = 333
      inst[0].cb()
      await vi.advanceTimersByTimeAsync(150)
      await flushPromises()
      expect(render.mock.calls.some((c: any[]) => c[3].width === chartDrawWidth(333, { type: 'bar', hasLegend: false }))).toBe(true)
      w.unmount()
    } finally { spy.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })
})
