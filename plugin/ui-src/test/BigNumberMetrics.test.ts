import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { parseNotebook, serializeNotebook, createEmptyNotebook } from '@sqlnb/format'
import BigNumberBlock from '../src/analysis/BigNumberBlock.vue'
import { runBigNumber } from '../src/analysis/runBigNumber'
import { normalizeBigNumber } from '../src/analysis/bigNumberConfig'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { messages } from '../src/i18n'
import type { EngineClient } from '../src/run/engineClient'

const COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }]
const ROWS: unknown[][] = [['a', 10, '2026-01-03'], ['b', 20, '2026-01-01'], ['c', 60, '2026-01-02']]
const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = (executedAt = 'T1') => ({ status: 'ok' as const, executedAt, result: { columns: COLS, rows: ROWS, truncated: false, elapsedMs: 1, dbType: 'sqlite' } })

function fakeEngine(log: string[] = [], failOn?: RegExp): EngineClient {
  return {
    sessionId: 's', async ensureRegistered() {}, invalidate() {}, async close() {},
    async query(sql: string) {
      log.push(sql)
      if (failOn?.test(sql)) throw new Error('boom')
      const cnt = /^SELECT count\(\*\) FROM/.exec(sql)
      if (cnt) return { columns: [], rows: [[ROWS.length]], truncated: false, elapsedMs: 0 }
      const pick = /^SELECT "([^"]+)" FROM "[^"]+" ORDER BY rowid( DESC)? LIMIT 1$/.exec(sql)
      if (pick) {
        const i = COLS.findIndex((c) => c.name === pick[1])
        return { columns: [], rows: [[(pick[2] ? ROWS[ROWS.length - 1] : ROWS[0])[i]]], truncated: false, elapsedMs: 0 }
      }
      const m = /^SELECT (\w+)\("([^"]+)"\) FROM/.exec(sql)!
      const v = ROWS.map((r) => r[COLS.findIndex((c) => c.name === m[2])]) as any[]
      const out = m[1] === 'sum' ? v.reduce((a, b) => a + b, 0) : m[1] === 'max' ? Math.max(...v) : m[1] === 'min' ? Math.min(...v) : m[1] === 'avg' ? v.reduce((a, b) => a + b, 0) / v.length : v.length
      return { columns: [], rows: [[out]], truncated: false, elapsedMs: 0 }
    },
  } as EngineClient
}

const M = (over: any = {}) => ({ field: 'amount', aggregate: 'sum', ...over })
function setup(meta: any, o: { engine?: EngineClient; mount?: boolean; log?: string[] } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  store.nb.value.blocks.push(src as any, { id: 'n1', type: 'big-number', metadata: meta } as any)
  store.runs.set('s1', run() as any)
  const log = o.log ?? []
  const engine = o.engine ?? fakeEngine(log)
  store.setBigNumberRunner((id) => runBigNumber({ store, engine }, id))
  const w = o.mount === false ? null : mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
  return { store, w: w!, log, meta: () => store.nb.value.blocks.find((b) => b.id === 'n1')!.metadata as any }
}
const legacy = () => ({ data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'Total', format: { kind: 'thousands' } })
const multi = () => ({
  data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'Total',
  metrics: [{ label: 'Total', field: 'amount', aggregate: 'sum' }, { label: 'Max', field: 'amount', aggregate: 'max', format: { kind: 'percent' } }],
})
const values = (w: any) => w.findAll('[data-test=bn-value]').map((x: any) => x.text())

beforeEach(() => vi.useRealTimers())

describe('normalizeBigNumber metrics', () => {
  it('legacy file is a single metric view, no warnings', () => {
    const c = normalizeBigNumber(legacy())
    expect(c.hasMetrics).toBe(false)
    expect(c.metrics).toEqual([{ field: 'amount', aggregate: 'sum', label: 'Total', format: { kind: 'thousands' } }])
    expect(c.warnings).toEqual([])
  })
  it('metrics are authoritative and keep unknown keys and unknown aggregates', () => {
    const c = normalizeBigNumber({ ...multi(), metrics: [{ field: 'x', aggregate: 'stddev', color: 'red' }, { field: 'y' }] })
    expect(c.hasMetrics).toBe(true)
    expect(c.metrics).toEqual([{ field: 'x', aggregate: 'stddev', color: 'red' }, { field: 'y' }])
    expect(c.warnings).toEqual([])
  })
  it('over 8 dropped, invalid items dropped, bad parts repaired, all with warnings', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ field: 'f' + i }))
    const a = normalizeBigNumber({ data: 'sales', value: { field: 'f0' }, metrics: many })
    expect(a.metrics).toHaveLength(8)
    expect(a.warnings.length).toBeGreaterThan(0)
    const b = normalizeBigNumber({ data: 'sales', value: { field: 'f0' }, metrics: [5, { field: 'ok', label: 'L'.repeat(300), format: { kind: 'bad' } }] })
    expect(b.metrics).toHaveLength(1)
    expect(b.metrics[0].label).toHaveLength(200)
    expect(b.metrics[0].format).toBeUndefined()
    expect(b.warnings.length).toBeGreaterThan(0)
    const c = normalizeBigNumber({ data: 'sales', value: { field: 'f0' }, metrics: 'nope' })
    expect(c.hasMetrics).toBe(false)
    expect(c.warnings.length).toBeGreaterThan(0)
  })
})

describe('store metrics', () => {
  it('legacy file is not rewritten on load; gets metrics only when a second is added', () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [src, { id: 'n1', type: 'big-number', metadata: legacy() }]
    const s = useNotebookStore()
    s.load(serializeNotebook(nb), null, null)
    expect(s.dirty.value).toBe(false)
    expect((s.nb.value.blocks[1].metadata as any).metrics).toBeUndefined()
    s.setBigNumber('n1', { label: 'T2' })
    expect((s.nb.value.blocks[1].metadata as any).metrics).toBeUndefined()
    s.addBigNumberMetric('n1')
    const m = s.nb.value.blocks[1].metadata as any
    expect(m.metrics).toHaveLength(2)
    expect(m.metrics[0]).toEqual({ field: 'amount', aggregate: 'sum', label: 'T2', format: { kind: 'thousands' } })
    expect(m.metrics[1]).toEqual({ field: '', aggregate: 'count' })
    expect(m.value).toEqual({ field: 'amount', aggregate: 'sum' })
    expect(m.label).toBe('T2')
  })
  it('edit/reorder/remove keep value mirroring metrics[0]; one left keeps metrics', () => {
    const { store, meta } = setup(multi(), { mount: false })
    store.setBigNumber('n1', { index: 1, aggregate: 'min', label: 'Min' })
    expect(meta().metrics[1]).toEqual({ label: 'Min', field: 'amount', aggregate: 'min', format: { kind: 'percent' } })
    store.moveBigNumberMetric('n1', 1, -1)
    expect(meta().metrics.map((x: any) => x.aggregate)).toEqual(['min', 'sum'])
    expect(meta().value).toEqual({ field: 'amount', aggregate: 'min' })
    expect(meta().label).toBe('Min')
    expect(meta().format).toEqual({ kind: 'percent' })
    store.removeBigNumberMetric('n1', 0)
    expect(meta().metrics).toEqual([{ label: 'Total', field: 'amount', aggregate: 'sum' }])
    expect(meta().value).toEqual({ field: 'amount', aggregate: 'sum' })
    expect(meta().format).toBeUndefined()
    store.removeBigNumberMetric('n1', 0)
    expect(meta().metrics).toHaveLength(1)
  })
  it('caps at 8 and preserves unknown keys', () => {
    const { store, meta } = setup({ ...multi(), metrics: [{ field: 'amount', aggregate: 'sum', color: 'red' }] }, { mount: false })
    for (let i = 0; i < 10; i++) store.addBigNumberMetric('n1')
    expect(meta().metrics).toHaveLength(8)
    store.setBigNumber('n1', { label: 'z' })
    expect(meta().metrics[0].color).toBe('red')
  })
  it('malformed metrics repaired on load with a notice; roundtrip stable', () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [src, { id: 'n1', type: 'big-number', metadata: { ...multi(), metrics: [5, ...multi().metrics] } }]
    const s = useNotebookStore()
    s.load(serializeNotebook(nb), null, null)
    expect(s.loadNotices.value).toContain('n1')
    expect((s.nb.value.blocks[1].metadata as any).metrics).toHaveLength(2)
    const again = useNotebookStore()
    again.load(s.toText(), null, null)
    expect(again.dirty.value).toBe(false)
    expect(JSON.stringify(parseNotebook(again.toText()).blocks[1].metadata)).toBe(JSON.stringify(parseNotebook(s.toText()).blocks[1].metadata))
  })
  it('file with metrics of non-array type still opens', () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [src, { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount' }, metrics: 'x' } }]
    expect(() => useNotebookStore().load(serializeNotebook(nb), null, null)).not.toThrow()
  })
})

describe('run with several metrics', () => {
  it('one query per metric, each with its own result and error', async () => {
    const log: string[] = []
    const { store } = setup({ data: 'sales', value: { field: 'amount', aggregate: 'sum' }, metrics: [M(), M({ aggregate: 'max' }), { field: 'd', aggregate: 'first' }, { field: 'd', aggregate: 'last' }, { field: 'region', aggregate: 'sum' }] }, { mount: false, log })
    const r = await store.refreshBigNumber('n1')
    expect(log).toHaveLength(4)
    expect(r.items.map((i) => i.value)).toEqual([90, 60, '2026-01-03', '2026-01-02', null])
    expect(r.items[4].error?.code).toBe('TYPE')
    expect(r.items[0].error).toBeUndefined()
    expect(r.status).toBe('ok')
  })
  it('a failing query only fails its metric', async () => {
    const { store } = setup({ ...multi(), metrics: [M(), M({ aggregate: 'max' })] }, { mount: false, engine: fakeEngine([], /max/) })
    const r = await store.refreshBigNumber('n1')
    expect(r.items[0].value).toBe(90)
    expect(r.items[1].error?.code).toBe('ENGINE')
  })
  it('editing a metric supersedes an in-flight run', async () => {
    const rel: (() => void)[] = []
    const engine = { ...fakeEngine(), query(sql: string) { return new Promise((res) => rel.push(() => res({ columns: [], rows: [[/max/.test(sql) ? 60 : 90]], truncated: false, elapsedMs: 0 }))) } } as EngineClient
    const { store } = setup(multi(), { mount: false, engine })
    const p1 = store.refreshBigNumber('n1')
    await flushPromises()
    store.setBigNumber('n1', { index: 1, aggregate: 'sum' })
    const p2 = store.refreshBigNumber('n1')
    await flushPromises()
    expect(rel.length).toBe(4)
    rel.slice(2).forEach((f) => f())
    await p2
    rel.slice(0, 2).forEach((f) => f())
    await p1
    expect(store.bigNumbers.get('n1')!.items.map((i) => i.value)).toEqual([90, 90])
  })
  it('only data/field/aggregate/structure changes schedule a run', async () => {
    vi.useFakeTimers()
    const { store, log } = setup(multi(), { mount: false })
    store.setBigNumber('n1', { index: 1, label: 'x', format: { kind: 'plain' } })
    await vi.advanceTimersByTimeAsync(150)
    expect(log).toHaveLength(0)
    store.addBigNumberMetric('n1')
    await vi.advanceTimersByTimeAsync(150)
    expect(log).toHaveLength(3)
  })
})

describe('BigNumberBlock UI with metrics', () => {
  it('renders several cards with values and labels', async () => {
    const { w } = setup(multi())
    await flushPromises()
    expect(w.findAll('[data-test=bn-card]')).toHaveLength(2)
    expect(values(w)).toEqual(['90', '6000.0%'])
    expect(w.findAll('[data-test=bn-label-text]').map((x) => x.text())).toEqual(['Total', 'Max'])
  })
  it('single metric still uses the message area for errors (as before)', async () => {
    const { w } = setup({ data: 'sales', value: { field: 'region', aggregate: 'sum' } })
    await flushPromises()
    expect(w.find('[data-test=bn-message]').text()).toMatch(/numeric/i)
  })
  it('per-card error while others show values', async () => {
    const { w } = setup({ ...multi(), metrics: [M(), M({ field: 'region' }), { field: 'gone', aggregate: 'sum' }, { field: 'amount', aggregate: 'stddev' }] })
    await flushPromises()
    expect(w.find('[data-test=bn-message]').exists()).toBe(false)
    const cards = w.findAll('[data-test=bn-card]')
    expect(cards[0].find('[data-test=bn-value]').text()).toBe('90')
    expect(cards[1].find('[data-test=bn-card-error]').text()).toMatch(/numeric/i)
    expect(cards[2].find('[data-test=bn-card-error]').text()).toContain('gone')
    expect(cards[3].find('[data-test=bn-card-error]').text()).toBe('Unsupported aggregate: stddev')
  })
  it('add, edit, reorder and remove metrics via the editor', async () => {
    const { w, meta } = setup(legacy())
    await flushPromises()
    expect(w.findAll('[data-test=bn-metric]')).toHaveLength(1)
    expect(w.find('[data-test=bn-remove]').attributes('disabled')).toBeDefined()
    await w.find('[data-test=bn-add]').trigger('click')
    expect(w.findAll('[data-test=bn-metric]')).toHaveLength(2)
    const row2 = () => w.findAll('[data-test=bn-metric]')[1]
    await row2().find('[data-test=bn-field]').setValue('amount')
    await row2().find('[data-test=bn-agg]').setValue('max')
    await row2().find('[data-test=bn-label]').setValue('Peak')
    expect(meta().metrics[1]).toEqual({ field: 'amount', aggregate: 'max', label: 'Peak' })
    await row2().find('[data-test=bn-up]').trigger('click')
    expect(meta().metrics.map((x: any) => x.label)).toEqual(['Peak', 'Total'])
    expect(meta().value.aggregate).toBe('max')
    await w.findAll('[data-test=bn-metric]')[0].find('[data-test=bn-remove]').trigger('click')
    expect(meta().metrics).toHaveLength(1)
    expect(w.findAll('[data-test=bn-metric]')).toHaveLength(1)
  })
  it('add is disabled at 8', () => {
    const { w } = setup({ ...multi(), metrics: Array.from({ length: 8 }, () => M()) }, { mount: true })
    expect(w.find('[data-test=bn-add]').attributes('disabled')).toBeDefined()
  })
  it('numeric-only aggregates are disabled per metric', async () => {
    const { w } = setup({ ...multi(), metrics: [M(), { field: 'region', aggregate: 'count' }] })
    await flushPromises()
    const rows = w.findAll('[data-test=bn-metric]')
    expect(rows[0].find('option[value=sum]').attributes('disabled')).toBeUndefined()
    expect(rows[1].find('option[value=sum]').attributes('disabled')).toBeDefined()
  })
  it('controls carry per-metric aria-labels', () => {
    const { w } = setup(multi())
    const row = w.findAll('[data-test=bn-metric]')[1]
    expect(row.attributes('role')).toBe('group')
    expect(row.attributes('aria-label')).toContain('2')
    expect(row.find('[data-test=bn-remove]').attributes('aria-label')).toContain('Max')
    expect(row.find('[data-test=bn-up]').attributes('aria-label')).toContain('2')
  })
  it('zh strings', () => {
    const { store } = setup(multi(), { mount: false })
    setLocale('zh')
    const m = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
    expect(m.find('[data-test=bn-add]').text()).toBe('+ 添加指标')
    expect(m.findAll('[data-test=bn-metric]')[1].attributes('aria-label')).toContain('指标 2')
  })
})

describe('i18n', () => {
  it('bn/nb keys have zh+en parity', () => {
    const keys = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith('bn.') || k === 'nb.addBigNumber').sort()
    expect(keys(messages['zh-CN'])).toEqual(keys(messages.en))
    expect(keys(messages.en)).toContain('bn.addMetric')
    expect(keys(messages.en)).toContain('bn.removeMetric')
  })
})
