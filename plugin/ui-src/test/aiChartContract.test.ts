import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { parseChartReply } from '../src/ai/parse'
import { chartApplyPatch } from '../src/ai/chartAiGate'
import { buildChatPrompt } from '../src/ai/promptChat'
import { normalizeAnalysis } from '@sqlnb/format'

const render = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: (...a: unknown[]) => render(...a) }) }))
import ChartDrawer from '../src/ai/ChartDrawer.vue'
import { createChatStore } from '../src/ai/chatStore'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFakeBridge } from '../src/host/fakeBridge'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, StoreKey } from '../src/injection'
import type { AiClient, AiRequest, AiResult } from '../src/ai/aiClient'
import { setLocale } from '../src/i18n'

const SAMPLE_A = `\`\`\`json
[
  {
    "rows": [{"field": "created_at", "grain": "day"}],
    "columns": [],
    "values": [{"field": "space_id", "agg": "count", "label": "新增空间数"}],
    "chartOptions": {"type": "bar", "stacking": "none", "timeAxis": "compact", "title": "每日新增空间数"}
  },
  {
    "rows": [{"field": "created_at", "grain": "day"}],
    "columns": [],
    "values": [{"field": "space_id", "agg": "count", "label": "新增空间数"}],
    "chartOptions": {"type": "line", "stacking": "none", "timeAxis": "sparse", "title": "空间创建趋势（按天）"}
  },
  {
    "rows": [{"field": "created_at", "grain": "day"}],
    "columns": [{"field": "dimension"}],
    "values": [{"field": "space_id", "agg": "count", "label": "空间数"}],
    "chartOptions": {"type": "area", "stacking": "stacked", "timeAxis": "compact", "title": "各维度空间增长趋势"}
  }
]
\`\`\``
const SAMPLE_B = `\`\`\`json
{
  "rows": [{"field": "created_at", "grain": "day"}],
  "columns": [],
  "values": [{"field": "space_id", "agg": "count", "label": "新增空间数"}],
  "chartOptions": {
    "type": "area",
    "stacking": "none",
    "timeAxis": "compact",
    "title": "空间每日新增趋势"
  }
}
\`\`\``
const C = { columns: ['created_at', 'space_id', 'dimension'], truncated: false }
const parseChartCandidates = (text: string, ctx: { columns: string[]; truncated: boolean }): any => {
  const r = parseChartReply(text, { ...ctx, current: [], selected: null })
  return r.ok ? { ok: true, value: r.value.schemes, warnings: r.warnings } : r
}
const parseChartConfig = (text: string, ctx: { columns: string[]; truncated: boolean }): any => {
  const r = parseChartReply(text, { ...ctx, current: [], selected: null })
  return r.ok ? { ok: true, value: r.value.schemes[0].config, warnings: r.warnings } : r
}

const E = { columns: ['category', 'amount'], truncated: false }
describe('chart parse: top-level shape (the prompt contract)', () => {
  it('SAMPLE A -> 3 candidates', () => {
    const r: any = parseChartCandidates(SAMPLE_A, C)
    expect(r.ok).toBe(true)
    expect(r.value.length).toBe(3)
    expect(r.value[2].config.pivot.columns).toEqual([{ field: 'dimension' }])
    expect(r.value[0].config.pivot.rows).toEqual([{ field: 'created_at', grain: 'day' }])
    expect(r.value[2].config.chartOptions).toMatchObject({ type: 'area', stacking: 'stacked' })
  })
  it('SAMPLE B -> config', () => {
    const r: any = parseChartConfig(SAMPLE_B, C)
    expect(r.ok).toBe(true)
    expect(r.value.pivot.values).toEqual([{ field: 'space_id', agg: 'count', label: '新增空间数' }])
    expect(r.value.chartOptions).toMatchObject({ type: 'area', stacking: 'none', timeAxis: 'compact' })
  })
  it('nested pivot still accepted', () => {
    const r: any = parseChartConfig(JSON.stringify({ pivot: { rows: [], values: [{ field: 'space_id', agg: 'count' }] }, chartOptions: { type: 'bar' } }), C)
    expect(r.ok).toBe(true)
  })
  it('unknown column dropped with warning; one bad candidate keeps the good ones', () => {
    const arr = JSON.parse(SAMPLE_A.replace(/```(json)?/g, ''))
    arr[2].columns = [{ field: 'ghost' }]
    arr[1].values = [{ field: 'nope', agg: 'sum' }]
    const r: any = parseChartCandidates(JSON.stringify(arr), C)
    expect(r.ok).toBe(true)
    expect(r.value.length).toBe(2)
    expect(r.warnings.join()).toMatch(/ghost/)
    expect(r.warnings.join()).toMatch(/candidate dropped/)
  })
})

describe('chart reply contract: prompt example round-trips through parseChartReply', () => {
  const chatP = (selected?: number) => buildChatPrompt({ locale: 'en', dialect: 'sqlite', send: { schema: false, sql: false, data: true }, purpose: 'chart', schemas: [], history: [], userText: 'x', chartSelected: selected, chart: { current: {}, columns: [{ name: 'category' }] } }).text
  const example = (t: string) => /EXAMPLE:\n```json\n([\s\S]*?)\n```/.exec(t)![1]
  it('not selected: example is a set of 2-3 with summaries', () => {
    const r: any = parseChartReply(example(chatP()), { ...E, current: [], selected: null })
    expect(r.ok).toBe(true)
    expect(r.value.replaced).toBe('all')
    expect(r.value.schemes.length).toBeGreaterThanOrEqual(2)
    expect(r.value.schemes.every((x: any) => x.summary && x.title)).toBe(true)
  })
  it('selected: example is ONE config replacing the selected scheme', () => {
    const cur = (parseChartReply(example(chatP()), { ...E, current: [], selected: null }) as any).value.schemes
    const r: any = parseChartReply(example(chatP(1)), { ...E, current: cur, selected: 1 })
    expect(r.ok).toBe(true)
    expect(r.value.replaced).toBe('one')
    expect(r.value.schemes.length).toBe(cur.length)
  })
  it('summary and title never appear in the applied patch or in normalizeAnalysis output', () => {
    const r: any = parseChartReply(JSON.stringify({ title: 'SCHEME_TITLE', summary: 'SCHEME_SUMMARY', pivot: { rows: [{ field: 'category' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar' } }), { ...E, current: [], selected: null })
    const c = r.value.schemes[0]
    expect(c.summary).toBe('SCHEME_SUMMARY')
    expect(JSON.stringify(c.config)).not.toMatch(/SCHEME_(TITLE|SUMMARY)/)
    const patch = chartApplyPatch(c.config)
    expect(JSON.stringify(patch)).not.toMatch(/SCHEME_(TITLE|SUMMARY)/)
    expect(Object.keys(patch.chartOptions)).not.toContain('summary')
    const n = normalizeAnalysis({ pivot: patch.pivot, chartOptions: patch.chartOptions, summary: 'SCHEME_SUMMARY', title: 'SCHEME_TITLE' } as any)
    expect(JSON.stringify(n)).not.toMatch(/SCHEME_(TITLE|SUMMARY)/)
  })
})

describe('ChartDrawer end-to-end with real samples', () => {
  beforeEach(() => { render.mockReset(); render.mockImplementation(async () => ({ view: {}, svg: async () => '<svg xmlns="http://www.w3.org/2000/svg"><rect width="3" height="3"/></svg>', destroy() {} })); setLocale('en') })
  async function setup() {
    const bridge = createFakeBridge({ caps: { aiCompletion: true } })
    const store = useNotebookStore()
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sp' } } as any)
    store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: 'sp', pivot: { rows: [{ field: 'dimension' }], columns: [], values: [{ field: 'space_id', agg: 'count' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any)
    store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: [{ name: 'created_at', dataType: 'timestamp' }, { name: 'space_id', dataType: 'integer' }, { name: 'dimension', dataType: 'text' }], rows: [['2026-01-01T00:00:00Z', 1, 'a'], ['2026-01-01T10:00:00Z', 2, 'b'], ['2026-01-02T00:00:00Z', 3, 'a']], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    store.setAnalysisRunner(async () => ({ status: 'ok', excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x' }) as any)
    let pending: ((r: AiResult) => void) | null = null
    const client: AiClient = { available: () => true, streaming: () => true, busy: () => false, listModels: async () => [], generate: vi.fn((_r: AiRequest) => new Promise<AiResult>((res) => { pending = res })) }
    const settings = { sendOptions: vi.fn(async () => ({ schema: true, sql: true, data: true })), effectiveModel: () => undefined }
    const provide = { [StoreKey as symbol]: store, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: client, [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: createChatStore(bridge) }
    const w = mount(ChartDrawer, { props: { spec: { purpose: 'chart', blockId: 'c1' } }, attachTo: document.body, global: { provide } })
    await flushPromises()
    const go = async () => { await w.find('[data-test=chart-generate]').trigger('click'); await flushPromises() }
    const respond = async (text: string) => { pending!({ text, truncated: false }); await flushPromises(); await new Promise((r) => setTimeout(r, 10)); await flushPromises() }
    const meta = () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any
    return { w, store, go, respond, meta }
  }
  it('candidates: 3 previews, apply #3', async () => {
    const s = await setup()
    await s.go(); await s.respond(SAMPLE_A)
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(false)
    const html = s.w.html()
    expect(html).not.toMatch(/Cannot parse/)
    const cands = s.w.findAll('[data-test=scheme-card]')
    expect(cands.length).toBe(3)
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(1)
    await cands[2].trigger('click'); await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    expect(s.meta().pivot.rows).toEqual([{ field: 'created_at', grain: 'day' }])
    expect(s.meta().pivot.columns).toEqual([{ field: 'dimension' }])
    expect(s.meta().chartOptions).toMatchObject({ type: 'area', stacking: 'stacked', timeAxis: 'compact', title: '各维度空间增长趋势' })
    expect(s.store.history.undoDepth.value).toBe(1)
  })
  it('single config first turn: diff then apply', async () => {
    const s = await setup()
    await s.go(); await s.respond(SAMPLE_B)
    expect(s.w.find('[data-test=chart-diff]').exists()).toBe(true)
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    expect(s.meta().pivot.values[0]).toMatchObject({ field: 'space_id', agg: 'count' })
    expect(s.meta().chartOptions).toMatchObject({ type: 'area', stacking: 'none', title: '空间每日新增趋势' })
    expect(s.store.history.undoDepth.value).toBe(1)
  })
})
