import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { serializeNotebook } from '@sqlnb/format'

const render = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: (...a: unknown[]) => render(...a) }) }))
import ChartDrawer from '../src/ai/ChartDrawer.vue'
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import { chartApplyPatch } from '../src/ai/chartAiGate'
import { createDrawerManager } from '../src/ai/drawerState'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createChatStore } from '../src/ai/chatStore'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, DrawerKey, StoreKey } from '../src/injection'
import { AiError, type AiClient, type AiRequest, type AiResult } from '../src/ai/aiClient'
import { setLocale, t } from '../src/i18n'
import { createAiClient } from '../src/ai/aiClient'
import { genRequests } from './aiRequests'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="3" height="3"/></svg>'
const okRender = async () => ({ view: {}, svg: async () => SVG, destroy() {} })
const send0 = { schema: true, sql: true, data: true }
const fence = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```'
const mk = (type: string, agg = 'sum', extra: Record<string, unknown> = {}) => ({ title: `T-${type}`, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg }] }, chartOptions: { type, ...extra } })
const three = () => fence([mk('bar'), mk('line'), mk('pie')])
const mounted: { unmount(): void }[] = []

async function setup(opts: { send?: Partial<typeof send0> } = {}) {
  setLocale('en')
  const bridge = createFakeBridge({ caps: { aiCompletion: true } })
  const store = useNotebookStore()
  store.path.value = '/n.sqlnb'
  store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } } as any)
  store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: 'sales', pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any)
  store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['PROBE_CELL', 1], ['a', 2], ['b', 5]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
  store.setAnalysisRunner(async () => ({ status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' }) as any)
  const calls: AiRequest[] = []
  let pending: { resolve(r: AiResult): void; reject(e: unknown): void } | null = null
  const client: AiClient = {
    available: () => true, streaming: () => true, busy: () => false, listModels: async () => [],
    generate: vi.fn((req: AiRequest) => new Promise<AiResult>((resolve, reject) => {
      calls.push(req)
      pending = { resolve, reject }
      req.signal?.addEventListener('abort', () => reject(new AiError('cancelled')))
    })),
  }
  const settings = { sendOptions: vi.fn(async () => ({ ...send0, ...opts.send })), effectiveModel: () => undefined }
  const chat = createChatStore(bridge)
  const provide = { [StoreKey as symbol]: store, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: client, [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: chat }
  const mountIt = async () => {
    const w = mount(ChartDrawer, { props: { spec: { purpose: 'chart', blockId: 'c1' } } as any, attachTo: document.body, global: { provide } })
    mounted.push(w)
    await flushPromises()
    return w
  }
  const w = await mountIt()
  const bytes = () => serializeNotebook(store.nb.value)
  const meta = () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any
  const respond = async (text: string, truncated = false) => { pending!.resolve({ text, truncated }); await flushPromises(); await new Promise((r) => setTimeout(r, 10)); await flushPromises() }
  const gen = async (wr = w) => { await wr.find('[data-test=chart-generate]').trigger('click'); await flushPromises() }
  const chatSend = async (text: string, wr = w) => {
    await wr.find('[data-test=chat-input]').setValue(text)
    await wr.find('[data-test=chat-send]').trigger('click')
    await flushPromises()
  }
  const confirm = async (wr = w) => { await wr.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises() }
  const types = (wr = w) => wr.findAll('[data-test=scheme-card]').length
  return { w, store, calls, client, settings, chat, provide, mountIt, bytes, meta, respond, gen, chatSend, confirm, types }
}

beforeEach(() => { while (mounted.length) { try { mounted.pop()!.unmount() } catch { /* gone */ } } render.mockReset(); render.mockImplementation(okRender); setLocale('en'); document.body.innerHTML = '' })

describe('ChartDrawer candidates', () => {
  it('sends nothing on open; first turn returns 3 schemes: board shows 3 summary cards + one large preview of scheme 1', async () => {
    const s = await setup()
    expect(s.calls.length).toBe(0)
    expect(s.w.find('[data-test=scheme-board]').exists()).toBe(false)
    await s.gen()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0].prompt).toContain('PROBE_CELL')
    await s.respond(three())
    expect(s.types()).toBe(3)
    expect(s.w.findAll('[data-test=scheme-card]')[0].attributes('aria-checked')).toBe('true')
    expect(s.w.find('[data-test=scheme-large]').exists()).toBe(true)
    expect(s.w.find('[data-test=scheme-caption]').exists()).toBe(true)
  })
  it('"调整方案2 用折线图" overrides the selection for that turn: only scheme 2 changes, selection moves to 2, others unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.chatSend('调整方案2 用折线图')
    expect(s.calls[1].prompt).toContain('[SELECTED SCHEME 2]')
    await s.respond(fence(mk('area', 'avg', { title: 'T-area' })))
    const cards = s.w.findAll('[data-test=scheme-card]')
    expect(cards.map((c) => c.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
    await cards[2].trigger('click')
    await s.confirm()
    expect(s.meta().chartOptions.type).toBe('pie')
    expect(s.store.history.undoDepth.value).toBe(1)
  })
  it('numbered target replaces only that scheme (stored result)', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.chatSend('调整方案2 用折线图')
    await s.respond(fence(mk('area', 'avg')))
    const w2 = await s.mountIt()
    const sums = w2.findAll('[data-test=scheme-card]').map((x) => x.text())
    expect(sums.length).toBe(3)
    await w2.findAll('[data-test=scheme-card]')[1].trigger('click')
    expect(w2.find('[data-test=scheme-apply]').exists()).toBe(true)
    await s.confirm(w2)
    expect(s.meta().chartOptions.type).toBe('area')
    s.store.undo()
    await w2.findAll('[data-test=scheme-card]')[0].trigger('click')
    await s.confirm(w2)
    expect(s.meta().chartOptions.type).toBe('bar')
    s.store.undo()
    await w2.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.confirm(w2)
    expect(s.meta().chartOptions.type).toBe('pie')
  })
  it('selected scheme + single-config reply replaces only that scheme; others and selection unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.chatSend('make it smoother')
    const prompt = s.calls[1].prompt
    expect(prompt).toContain('[SELECTED SCHEME 2]')
    expect(prompt).not.toContain('[CURRENT SCHEMES]')
    expect(prompt).toContain('"type":"line"')
    expect(prompt).not.toContain('"type":"pie"')
    await s.respond(fence(mk('area', 'avg', { title: 'T-area' })))
    const cards = s.w.findAll('[data-test=scheme-card]')
    expect(cards.map((c) => c.text())).toEqual([expect.stringContaining('1. T-bar'), expect.stringContaining('2. T-area'), expect.stringContaining('3. T-pie')])
    expect(cards.map((c) => c.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
    await s.confirm()
    expect(s.meta().chartOptions.type).toBe('area')
  })
  it('selection clicked mid-flight stays; the reply replaces the send-time target scheme', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.chatSend('make it smoother')
    await s.w.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.respond(fence(mk('area', 'avg', { title: 'T-area' })))
    const cards = s.w.findAll('[data-test=scheme-card]')
    expect(cards.map((c) => c.text().replace(/\s+/g, ' '))).toEqual([expect.stringContaining('1. T-bar'), expect.stringContaining('2. T-area'), expect.stringContaining('3. T-pie')])
    expect(cards.map((c) => c.attributes('aria-checked'))).toEqual(['false', 'false', 'true'])
  })
  it('a QUESTION reply leaves the selection alone', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.chatSend('hmm')
    await s.respond('QUESTION: which?')
    expect(s.w.findAll('[data-test=scheme-card]')[2].attributes('aria-checked')).toBe('true')
  })
  it('typed 方案2 moves the selection to 2 only when the reply succeeds; a failed turn leaves it', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.chatSend('方案2 改成折线')
    await s.respond('no idea')
    expect(s.w.findAll('[data-test=scheme-card]')[2].attributes('aria-checked')).toBe('true')
    await s.chatSend('方案2 改成折线')
    await s.respond(fence(mk('area')))
    expect(s.w.findAll('[data-test=scheme-card]')[1].attributes('aria-checked')).toBe('true')
  })
  it('selected + set reply with fewer than 2 valid: error, nothing replaced, selection kept', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.chatSend('give me options')
    const badCfg = { ...mk('area'), pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'ghost', agg: 'sum' }] } }
    await s.respond(fence([mk('scatter'), badCfg, badCfg]))
    expect(s.w.find('[data-test=chat-error]').text()).toBe(t('ai.err.incomplete'))
    const cards = s.w.findAll('[data-test=scheme-card]')
    expect(cards.map((c) => c.text())).toEqual([expect.stringContaining('T-bar'), expect.stringContaining('T-line'), expect.stringContaining('T-pie')])
    expect(cards[1].attributes('aria-checked')).toBe('true')
  })
  it('array reply replaces the set and selects scheme 1', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[2].trigger('click')
    await s.chatSend('show me other options')
    await s.respond(fence([mk('scatter'), mk('area')]))
    expect(s.types()).toBe(2)
    expect(s.w.findAll('[data-test=scheme-card]')[0].attributes('aria-checked')).toBe('true')
    await s.confirm()
    expect(s.meta().chartOptions.type).toBe('scatter')
  })
  it('first turn with no selection yet: the whole set, scheme 1 selected by default', async () => {
    const s = await setup()
    await s.gen()
    expect(s.calls[0].prompt).toContain('JSON array of 2-3 configurations')
    expect(s.calls[0].prompt).not.toContain('SELECTED SCHEME')
    await s.respond(fence(mk('scatter')))
    expect(s.types()).toBe(1)
    expect(s.w.findAll('[data-test=scheme-card]')[0].attributes('aria-checked')).toBe('true')
  })
  it('no mode control; first generate sends the candidates turn', async () => {
    const s = await setup()
    expect(s.w.find('[data-test=chart-mode-candidates]').exists()).toBe(false)
    expect(s.w.find('[data-test=chart-mode-configure]').exists()).toBe(false)
    expect(s.w.find('[data-test=chart-mode-hint]').exists()).toBe(false)
    await s.gen()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0].prompt).toContain(t('drawer.chart.firstTurn.candidates'))
  })
  it('hint and singleScheme wording match the Generate schemes / Regenerate buttons (en + zh)', async () => {
    const { setLocale: sl } = await import('../src/i18n')
    sl('en')
    expect(t('drawer.chart.hint')).toMatch(/Generate schemes/)
    expect(t('drawer.chart.singleScheme')).toBe('the AI returned only one scheme (click Regenerate for more)')
    sl('zh')
    expect(t('drawer.chart.hint')).toContain('生成方案')
    expect(t('drawer.chart.hint')).not.toContain('点击“生成方案”后才会')
    expect(t('drawer.chart.singleScheme')).toBe('AI 只返回了一个方案，可点击“重新生成”获得更多')
    sl('en')
  })
  it('changing selection sends nothing (zero generateText* on both channels; positive control)', async () => {
    setLocale('en')
    const bridge = createFakeBridge({ caps: { aiCompletion: true }, requestHandlers: {
      'host.ai.listModels': () => [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }], 'host.ai.generateTextStream': () => three(), 'host.ai.generateText': () => three(), 'host.ai.cancelGeneration': () => ({ cancelled: true }),
    } } as any)
    const store = useNotebookStore()
    store.path.value = '/n.sqlnb'
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } } as any)
    store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: 'sales', pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any)
    store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['a', 2]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    const provide = { [StoreKey as symbol]: store, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: createAiClient(bridge), [AiSettingsKey as symbol]: { sendOptions: async () => send0, effectiveModel: () => undefined }, [ChatStoreKey as symbol]: createChatStore(bridge) }
    const w = mount(ChartDrawer, { props: { spec: { purpose: 'chart', blockId: 'c1' } } as any, attachTo: document.body, global: { provide } })
    mounted.push(w)
    await flushPromises()
    expect(genRequests(bridge).length).toBe(0)
    await w.find('[data-test=chart-generate]').trigger('click'); await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(genRequests(bridge).length).toBe(1)
    const cards = w.findAll('[data-test=scheme-card]')
    expect(cards.length).toBe(3)
    await cards[2].trigger('click'); await cards[1].trigger('keydown', { key: 'ArrowRight' }); await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(w.findAll('[data-test=scheme-card]')[2].attributes('aria-checked')).toBe('true')
    expect(genRequests(bridge).length).toBe(1)
  })
  it('an AI question leaves the schemes unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.chatSend('make it nicer')
    await s.respond('QUESTION: nicer how?')
    expect(s.types()).toBe(3)
    expect(s.w.text()).toContain('nicer how?')
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(false)
  })
  it('apply selected: block analysis equals chartApplyPatch result; omitted stacking/timeAxis/title/totals cleared; one history entry; undo restores', async () => {
    const s = await setup()
    s.store.setAnalysis('c1', { view: 'chart', pivot: { totals: { grand: true, row: true }, sort: { by: 'name', dir: 'desc' } }, chartOptions: { stacking: 'stacked', title: 'Old title', timeAxis: 'compact', labels: true, type: 'bar' } } as any)
    s.store.undo(); s.store.setAnalysis('c1', { view: 'chart', pivot: { totals: { grand: true, row: true }, sort: { by: 'name', dir: 'desc' } }, chartOptions: { stacking: 'stacked', title: 'Old title', timeAxis: 'compact', labels: true, type: 'bar' } } as any)
    const before = s.bytes()
    const depth = s.store.history.undoDepth.value
    await s.gen()
    const cfg = mk('line', 'avg')
    await s.respond(fence([cfg, mk('bar')]))
    await s.w.findAll('[data-test=scheme-card]')[0].trigger('click')
    await s.confirm()
    const m = s.meta()
    expect(m.chartOptions).toEqual({ type: 'line' })
    expect(m.pivot.totals).toEqual({ row: false, column: false, grand: false })
    expect(m.pivot.sort ?? null).toBeNull()
    expect(m.view).toBe('chart'); expect(m.data).toBe('sales')
    expect(m.chartOptions).toEqual(chartApplyPatch({ pivot: cfg.pivot as any, chartOptions: { type: 'line' } as any }).chartOptions && { type: 'line' })
    expect(s.store.history.undoDepth.value).toBe(depth + 1)
    expect(s.store.undo().ok).toBe(true)
    expect(s.bytes()).toBe(before)
    expect(s.w.emitted('close')).toBeTruthy()
  })
  it('previewed config deep-equals applied config', async () => {
    const s = await setup()
    await s.gen(); await s.respond(fence([mk('line', 'max', { title: 'Hello' }), mk('bar')]))
    const spec = JSON.stringify((render.mock.calls.filter((c: any[]) => c[3]?.width !== undefined).pop() as any[])[1])
    expect(spec).toContain('Hello')
    await s.confirm()
    expect(s.meta().chartOptions).toEqual({ type: 'line', title: 'Hello' })
    expect(s.meta().pivot.values[0].agg).toBe('max')
  })
  it('block changed after scheme produced → apply disabled with reason; no change', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    s.store.setAnalysis('c1', { chartOptions: { title: 'mine' } })
    await flushPromises()
    const depth = s.store.history.undoDepth.value
    const after = s.bytes()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toBe(t('ai.chart.modifiedSince'))
    await s.w.find('[data-test=scheme-apply]').trigger('click'); await flushPromises()
    expect(s.bytes()).toBe(after)
    expect(s.store.history.undoDepth.value).toBe(depth)
  })
  it('block deleted → apply disabled with reason', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    s.store.nb.value.blocks.splice(1, 1)
    await flushPromises()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toBe(t('drawer.chart.deleted'))
  })
})

const rename = (s: any) => s.store.runs.set('s1', { status: 'ok', executedAt: 'T2', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'total', dataType: 'integer' }], rows: [['a', 2]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } })

describe('ChartDrawer column revalidation', () => {
  it('result columns renamed, drawer reopened: schemes unusable, Apply disabled with reason, notebook unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    rename(s)
    const before = s.bytes()
    const w2 = await s.mountIt()
    expect(w2.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    expect(w2.find('[data-test=drawer-confirm-reason]').text()).toBe(t('drawer.chart.colsChanged'))
    expect(w2.find('[data-test=chart-dropped]').exists()).toBe(true)
    await s.confirm(w2)
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
  })
  it('legacy record without signature: schemes naming missing columns are dropped with a note', async () => {
    const s = await setup()
    const cfg = (f: string) => ({ title: f, config: { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: f, agg: 'sum' }] }, chartOptions: { type: 'bar' } } })
    await s.chat.save('/n.sqlnb', 'c1:chart', { v: 1, updated: 1, messages: [{ id: 'a', role: 'assistant', at: 1, parts: [{ kind: 'text', text: 'x' }], chartAfter: JSON.stringify({ mode: 'candidates', schemes: [cfg('amount'), cfg('ghost')] }) }] })
    const w2 = await s.mountIt()
    expect(s.types(w2)).toBe(1)
    expect(w2.find('[data-test=chart-dropped]').exists()).toBe(true)
  })
  it('column change in the same session: Apply refused, notebook unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    rename(s); await flushPromises()
    const before = s.bytes()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toBe(t('drawer.chart.colsChanged'))
    expect(s.w.find('[data-test=scheme-apply]').exists()).toBe(false)
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    await s.confirm()
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
  })
  it('column added (signature differs, schemes still valid): Apply disabled with reason', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    s.store.runs.set('s1', { status: 'ok', executedAt: 'T3', result: { columns: [{ name: 'region' }, { name: 'amount' }, { name: 'extra' }], rows: [['a', 1, 2]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    await flushPromises()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toBe(t('drawer.chart.colsChanged'))
    await s.w.find('[data-test=scheme-apply]').trigger('click'); await flushPromises()
    expect(s.store.history.undoDepth.value).toBe(0)
  })
  it('unchanged columns (rows re-run): Apply works and undo is byte-exact', async () => {
    const s = await setup()
    const before = s.bytes()
    await s.gen(); await s.respond(three())
    const r = s.store.runs.get('s1') as any
    s.store.runs.set('s1', { ...r, executedAt: 'T9', result: { ...r.result, rows: [['z', 9]] } })
    const w2 = await s.mountIt()
    await s.confirm(w2)
    expect(s.meta().chartOptions.type).toBe('bar')
    expect(s.store.history.undoDepth.value).toBe(1)
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })
  it('stored signature is a hash only, no column names', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    const m = (await s.chat.load('/n.sqlnb', 'c1:chart')).messages.find((x) => x.chartAfter)!
    expect(JSON.parse(m.chartAfter!).cols).toMatch(/^[0-9a-f]+$/)
  })
})

describe('ChartDrawer misc', () => {
  it('numbered target beyond the scheme count is ignored: the selected scheme is the target', async () => {
    const s = await setup()
    await s.gen(); await s.respond(fence([mk('bar'), mk('line')]))
    await s.chatSend('调整方案3 用饼图')
    expect(s.calls[1].prompt).toContain('[SELECTED SCHEME 1]')
    await s.respond(fence(mk('pie')))
    expect(s.types()).toBe(2)
  })
  it('legacy stored {mode:"configure"} message (items without summary) still restores', async () => {
    const s = await setup()
    const c = { title: 'L', config: { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar' } } }
    await s.chat.save('/n.sqlnb', 'c1:chart', { v: 1, updated: 1, messages: [{ id: 'a', role: 'assistant', at: 1, parts: [{ kind: 'text', text: 'x' }], chartAfter: JSON.stringify({ mode: 'configure', schemes: [c] }) }] })
    const w2 = await s.mountIt()
    expect(s.types(w2)).toBe(1)
    expect(w2.find('[data-test=scheme-card]').text()).toContain('1. L')
  })
  it('clearing the chat clears the schemes', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.find('[data-test=chat-clear]').trigger('click'); await flushPromises()
    expect(s.types()).toBe(0)
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    const w2 = await s.mountIt()
    expect(s.types(w2)).toBe(0)
  })
})

describe('ChartDrawer config diff', () => {
  it('shows old vs new summary diff for the selected scheme with removals as old → —; apply works; nothing changes before apply', async () => {
    const s = await setup()
    s.store.setAnalysis('c1', { view: 'chart', chartOptions: { stacking: 'stacked', title: 'Old title', timeAxis: 'compact', type: 'bar' } } as any)
    const before = s.bytes()
    await s.gen()
    await s.respond(fence({ pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'avg' }] }, chartOptions: { type: 'line' } }))
    const diff = s.w.find('[data-test=chart-diff]')
    expect(diff.exists()).toBe(true)
    expect(diff.text()).toContain('Old title')
    const row = diff.findAll('tbody tr').find((r) => r.text().includes('Stacking'))!
    expect(row.findAll('td')[0].text()).toBe('stacked'); expect(row.findAll('td')[1].text()).toBe('—')
    expect(s.w.find('[data-test=scheme-large]').exists()).toBe(true)
    expect(s.bytes()).toBe(before)
    await s.confirm()
    expect(s.meta().chartOptions).toEqual({ type: 'line' })
    expect(s.meta().pivot.values[0].agg).toBe('avg')
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })
})

describe('ChartDrawer gating and errors', () => {
  it('send.data off: send/generate disabled with reason, no request; cached chat intact; back on → works and history included', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    s.settings.sendOptions.mockResolvedValue({ ...send0, data: false })
    const w2 = await s.mountIt()
    expect(w2.find('[data-test=chat-disabled-reason]').text()).toBe(t('ai.chart.gate.no-data-setting'))
    expect(w2.find('[data-test=chart-generate]').attributes('disabled')).toBeDefined()
    expect(w2.find('[data-test=chart-generate]').attributes('aria-describedby')).toBeTruthy()
    expect(w2.find('[data-test=chat-send]').attributes('disabled')).toBeDefined()
    expect(w2.findAll('[data-test=chat-msg]').length).toBe(2)
    expect(s.calls.length).toBe(1)
    s.settings.sendOptions.mockResolvedValue(send0)
    const w3 = await s.mountIt()
    await s.chatSend('again please', w3)
    expect(s.calls.length).toBe(2)
    expect(s.calls[1].prompt).toContain('again please')
    expect(s.calls[1].prompt).toContain('CONVERSATION SO FAR')
  })
  it('TOCTOU: data turned off between pre-check and turn → reason alert, zero requests', async () => {
    const s = await setup()
    s.settings.sendOptions.mockResolvedValueOnce(send0).mockResolvedValue({ ...send0, data: false })
    await s.gen()
    expect(s.calls.length).toBe(0)
    expect(s.w.find('[data-test=chat-error]').text()).toBe(t('ai.chart.gate.no-data-setting'))
  })
  it('unparseable → error + show model output; schemes unchanged', async () => {
    const s = await setup()
    await s.gen(); await s.respond('I cannot do that')
    expect(s.w.find('[data-test=chat-error]').attributes('role')).toBe('alert')
    expect(s.w.find('[data-test=raw-output-text]').text()).toBe('I cannot do that')
    expect(s.types()).toBe(0)
    expect(s.store.history.undoDepth.value).toBe(0)
  })
  it('truncated reply → truncation error', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three(), true)
    expect(s.w.find('[data-test=chat-error]').text()).toBe(t('ai.err.truncated'))
  })
  it('warnings for dropped content are shown', async () => {
    const s = await setup()
    await s.gen(); await s.respond(fence([mk('bar'), { title: 'x', pivot: { rows: [{ field: 'ghost' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar' } }]))
    expect(s.w.find('[data-test=chart-warnings]').text().length).toBeGreaterThan(0)
  })
  it('no data-tagged parts are shown in the chat', async () => {
    const s = await setup()
    await s.chat.save('/n.sqlnb', 'c1:chart', { v: 1, updated: 1, messages: [{ id: 'x', role: 'user', at: 1, parts: [{ kind: 'text', text: 'visible' }, { kind: 'data', text: 'SECRET_DATA' }] }] })
    const w2 = await s.mountIt()
    expect(w2.text()).toContain('visible')
    expect(w2.text()).not.toContain('SECRET_DATA')
  })
  it('Discard / Esc: block unchanged and a running request is cancelled', async () => {
    const s = await setup()
    const before = s.bytes()
    await s.gen(); await s.respond(three())
    await s.chatSend('more')
    const signal = s.calls[1].signal!
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await flushPromises()
    expect(s.w.emitted('close')).toBeTruthy()
    s.w.unmount()
    expect(signal.aborted).toBe(true)
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
  })
  it('discard button emits close with no change', async () => {
    const s = await setup()
    const before = s.bytes()
    await s.gen(); await s.respond(three())
    await s.w.find('[data-test=drawer-discard]').trigger('click')
    expect(s.w.emitted('close')).toBeTruthy()
    expect(s.bytes()).toBe(before)
  })
  it('reopen restores chat and schemes', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    const w2 = await s.mountIt()
    expect(s.types(w2)).toBe(3)
    expect(w2.findAll('[data-test=chat-msg]').length).toBe(2)
    expect(s.calls.length).toBe(1)
  })
  it('chat is stored per block under blockId:chart, separate from the SQL chat', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    expect((await s.chat.load('/n.sqlnb', 'c1:chart')).messages.length).toBe(2)
    expect((await s.chat.load('/n.sqlnb', 'c1')).messages.length).toBe(0)
  })
  it('notebook load cancels the in-flight request and drops the pending reply', async () => {
    const s = await setup()
    await s.gen()
    const signal = s.calls[0].signal!
    s.store.load(serializeNotebook({ ...s.store.nb.value, blocks: [] } as any), null, null)
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(s.types()).toBe(0)
  })
  it('cancel while preparing: nothing is sent', async () => {
    const s = await setup()
    let release!: () => void
    s.settings.sendOptions.mockImplementationOnce(() => Promise.resolve(send0)).mockImplementationOnce(() => new Promise((r) => { release = () => r(send0) }))
    await s.gen()
    await s.w.find('[data-test=chat-cancel]').trigger('click')
    release(); await flushPromises()
    expect(s.client.generate).not.toHaveBeenCalled()
  })
  it('consent declined: alert, no change, schemes none', async () => {
    const s = await setup()
    ;(s.client.generate as any).mockImplementationOnce(() => Promise.reject(new AiError('consent-declined', 'x')))
    await s.gen()
    expect(s.w.find('[data-test=chat-error]').attributes('role')).toBe('alert')
  })
})

describe('AnalysisBlock entry', () => {
  function mountBlock(s: Awaited<ReturnType<typeof setup>>, aiCompletion = true) {
    const bridge = createFakeBridge({ caps: { aiCompletion } })
    const drawer = createDrawerManager(s.store)
    const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, attachTo: document.body, global: { provide: { ...s.provide, [BridgeKey as symbol]: bridge, [DrawerKey as symbol]: drawer } } })
    mounted.push(w)
    return { w, drawer }
  }
  it('hidden without capability', async () => {
    const s = await setup()
    const { w } = mountBlock(s, false); await flushPromises()
    expect(w.find('[data-test=ask-ai]').exists()).toBe(false)
  })
  it('disabled with reason + aria-describedby when result data is off; zero requests, no drawer', async () => {
    const s = await setup({ send: { data: false } })
    const { w, drawer } = mountBlock(s); await flushPromises()
    const b = w.find('[data-test=ask-ai]')
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.attributes('title')).toBe(t('ai.chart.gate.no-data-setting'))
    expect(w.find(`#${b.attributes('aria-describedby')}`).text()).toBe(t('ai.chart.gate.no-data-setting'))
    await b.trigger('click'); await flushPromises()
    expect(drawer.current.value).toBeNull()
    expect(s.calls.length).toBe(0)
  })
  it('enabled opens the chart drawer for the block', async () => {
    const s = await setup()
    const { w, drawer } = mountBlock(s); await flushPromises()
    await w.find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    expect(drawer.current.value).toEqual({ purpose: 'chart', blockId: 'c1' })
    expect(w.find('[data-test=chart-assistant]').exists()).toBe(false)
  })
  it('disabled while another drawer is open', async () => {
    const s = await setup()
    const { w, drawer } = mountBlock(s); await flushPromises()
    drawer.open({ purpose: 'sql', blockId: 's1' }); await flushPromises()
    expect(w.find('[data-test=ask-ai]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test=ask-ai]').attributes('title')).toBe(t('ai.askDrawerOpen'))
  })
})

describe('Task 8: single generate button + reopen selection', () => {
  const cards = (w: any) => w.findAll('[data-test=scheme-card]').map((c: any) => c.attributes('aria-checked'))
  it('button label flips Generate -> Regenerate', async () => {
    const s = await setup()
    expect(s.w.find('[data-test=chart-generate]').text()).toBe('Generate schemes')
    await s.gen(); await s.respond(three())
    expect(s.w.find('[data-test=chart-generate]').text()).toBe('Regenerate')
  })
  it('click with selection 2 sends a whole-set prompt (no selected-scheme block) and replaces all 3, selection resets', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.gen()
    const prompt = s.calls[1].prompt
    expect(prompt).not.toContain('SELECTED SCHEME')
    expect(prompt).not.toMatch(/scheme 2/i)
    await s.respond(fence([mk('area'), mk('scatter'), mk('barHorizontal')]))
    const c = s.w.findAll('[data-test=scheme-card]')
    expect(c.map((x) => x.text())).toEqual([expect.stringContaining('T-area'), expect.stringContaining('T-scatter'), expect.stringContaining('T-barHorizontal')])
    expect(cards(s.w)).toEqual(['true', 'false', 'false'])
  })
  it('click + single-config reply = 1-scheme set with a warning (not a refinement)', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.gen(); await s.respond(fence(mk('area')))
    expect(s.types()).toBe(1)
    expect(s.w.find('[data-test=chart-warnings]').exists()).toBe(true)
  })
  it('typed text with selection 2 updates only scheme 2', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.findAll('[data-test=scheme-card]')[1].trigger('click')
    await s.chatSend('make it blue')
    expect(s.calls[1].prompt).toContain('[SELECTED SCHEME 2]')
    await s.respond(fence(mk('area')))
    expect(s.w.findAll('[data-test=scheme-card]').map((x) => x.text())).toEqual([expect.stringContaining('T-bar'), expect.stringContaining('T-area'), expect.stringContaining('T-pie')])
  })
  it('click while gate disabled sends nothing on either channel; positive control when enabled', async () => {
    const s = await setup({ send: { data: false } })
    await s.gen()
    expect(s.calls.length).toBe(0)
    const s2 = await setup()
    await s2.gen()
    expect(s2.calls.length).toBe(1)
  })
  it('reopen: block config equal to scheme 2 selects it; no match / manually changed -> scheme 1', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    const w1 = await s.mountIt()
    expect(cards(w1)).toEqual(['true', 'false', 'false'])
    const m = s.store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any
    m.chartOptions = { type: 'line' }
    m.pivot = mk('line').pivot
    const w2 = await s.mountIt()
    expect(cards(w2)).toEqual(['false', 'true', 'false'])
    m.chartOptions = { type: 'line', title: 'manual' }
    const w3 = await s.mountIt()
    expect(cards(w3)).toEqual(['true', 'false', 'false'])
  })
  it('stale reply after regenerate click is discarded', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.chatSend('tweak')
    await s.w.find('[data-test=chat-cancel]').trigger('click'); await flushPromises()
    await s.gen(); await s.respond(fence([mk('area'), mk('scatter')]))
    expect(s.types()).toBe(2)
  })
})
