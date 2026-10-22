import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { parseNotebook, serializeNotebook, createEmptyNotebook } from '@sqlnb/format'
import bnSource from '../src/analysis/BigNumberBlock.vue?raw'
import BigNumberBlock from '../src/analysis/BigNumberBlock.vue'
import NotebookView from '../src/shell/NotebookView.vue'
import { runBigNumber } from '../src/analysis/runBigNumber'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey, AiSettingsKey, BridgeKey, DrawerKey, AiClientKey } from '../src/injection'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createDrawerManager } from '../src/ai/drawerState'
import type { AiClient } from '../src/ai/aiClient'
import { useAiRequest } from '../src/ai/useAiRequest'
import { setLocale, t } from '../src/i18n'
import type { EngineClient } from '../src/run/engineClient'

const COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }]
const ROWS: unknown[][] = [['a', 10, '2026-01-03'], ['b', 20, '2026-01-01'], ['c', 60, '2026-01-02']]
const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = (executedAt = 'T1', rows = ROWS) => ({
  status: 'ok' as const, executedAt,
  result: { columns: COLS, rows, truncated: false, elapsedMs: 1, dbType: 'sqlite' },
})
const bn = (over: any = {}) => ({ data: 'sales', value: { field: 'amount', aggregate: 'sum' }, ...over })

// Evaluates the SQL emitted by buildBigNumberSql over the given rows (source order = rowid).
function fakeEngine(rows: unknown[][], log: string[] = []): EngineClient {
  return {
    sessionId: 's',
    async ensureRegistered() {},
    invalidate() {},
    async close() {},
    async query(sql: string) {
      log.push(sql)
      const cnt = /^SELECT count\(\*\) FROM/.exec(sql)
      if (cnt) return { columns: [], rows: [[rows.length]], truncated: false, elapsedMs: 0 }
      const pick = /^SELECT "([^"]+)" FROM "[^"]+" ORDER BY rowid( DESC)? LIMIT 1$/.exec(sql)
      if (pick) {
        const i = COLS.findIndex((c) => c.name === pick[1])
        const r = pick[2] ? rows[rows.length - 1] : rows[0]
        return { columns: [], rows: r ? [[r[i]]] : [], truncated: false, elapsedMs: 0 }
      }
      const m = /^SELECT (\w+)\("([^"]+)"\) FROM/.exec(sql)!
      const i = COLS.findIndex((c) => c.name === m[2])
      const v = rows.map((r) => r[i]).filter((x) => x !== null && x !== undefined) as any[]
      const sorted = [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      let out: unknown = null
      if (m[1] === 'count') out = v.length
      else if (v.length) {
        if (m[1] === 'sum') out = v.reduce((a, b) => a + b, 0)
        else if (m[1] === 'avg') out = v.reduce((a, b) => a + b, 0) / v.length
        else if (m[1] === 'min') out = sorted[0]
        else if (m[1] === 'max') out = sorted[sorted.length - 1]
        else if (m[1] === 'median') out = sorted[Math.floor(sorted.length / 2)]
      }
      return { columns: [], rows: [[out]], truncated: false, elapsedMs: 0 }
    },
  } as EngineClient
}

function setup(meta: any, o: { run?: any; noSrc?: boolean; rows?: unknown[][]; engine?: EngineClient; mount?: boolean } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  if (!o.noSrc) store.nb.value.blocks.push(src as any)
  store.nb.value.blocks.push({ id: 'n1', type: 'big-number', metadata: meta } as any)
  if (o.run !== null && !o.noSrc) store.runs.set('s1', o.run ?? run('T1', o.rows ?? ROWS))
  const log: string[] = []
  const engine = o.engine ?? fakeEngine(o.rows ?? ROWS, log)
  store.setBigNumberRunner((id) => runBigNumber({ store, engine }, id))
  const w = o.mount === false ? null : mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
  return { store, w: w!, log, engine, meta: () => store.nb.value.blocks.find((b) => b.id === 'n1')!.metadata as any }
}
const value = (w: any) => w.find('[data-test=bn-value]').text()

beforeEach(() => vi.useRealTimers())

describe('BigNumberBlock auto refresh and DB types', () => {
  it('shows the value when the source result arrives after mount', async () => {
    const { store, w } = setup(bn(), { run: null })
    await flushPromises()
    store.runs.set('s1', run('T1'))
    await flushPromises()
    expect(value(w)).toBe('90')
  })
  it('sums a numeric-string column of a raw DB type (numeric) to 15.5', async () => {
    const numRun = { status: 'ok' as const, executedAt: 'T1', result: { columns: [{ name: 'amount', dataType: 'numeric' }], rows: [['12.50'], ['3']], truncated: false, elapsedMs: 1, dbType: 'postgres' } }
    const engine = { sessionId: 's', async ensureRegistered() {}, invalidate() {}, async close() {},
      async query(sql: string) { expect(sql).toContain('sum("amount")'); return { columns: [], rows: [[15.5]], truncated: false, elapsedMs: 0 } } } as EngineClient
    const { w } = setup(bn(), { run: numRun, engine })
    await flushPromises()
    expect(w.find('[data-test=bn-agg] option[value=sum]').attributes('disabled')).toBeUndefined()
    expect(value(w)).toBe('15.5')
  })
})

describe('aggregates through the engine', () => {
  const cases: [string, string, string][] = [
    ['sum', 'amount', '90'], ['mean', 'amount', '30'], ['average', 'amount', '30'], ['min', 'amount', '10'],
    ['max', 'amount', '60'], ['count', 'amount', '3'], ['median', 'amount', '20'],
    ['first', 'amount', '10'], ['last', 'amount', '60'],
  ]
  for (const [aggregate, field, expected] of cases) {
    it(`${aggregate}(${field}) = ${expected}`, async () => {
      const { w } = setup(bn({ value: { field, aggregate } }))
      await flushPromises()
      expect(value(w)).toBe(expected)
    })
  }
  it('count with empty field is count(*)', async () => {
    const { w, log } = setup(bn({ value: { field: '', aggregate: 'count' } }))
    await flushPromises()
    expect(value(w)).toBe('3')
    expect(log[0]).toMatch(/count\(\*\)/)
  })
  it('first/last follow source row order and may be text/date', async () => {
    const a = setup(bn({ value: { field: 'd', aggregate: 'first' } }))
    await flushPromises()
    expect(value(a.w)).toBe('2026-01-03')
    const b = setup(bn({ value: { field: 'region', aggregate: 'last' } }))
    await flushPromises()
    expect(value(b.w)).toBe('c')
  })
  it('mean and average are stored as written', () => {
    const { store, meta } = setup(bn(), { mount: false })
    store.setBigNumber('n1', { aggregate: 'mean' })
    expect(meta().value.aggregate).toBe('mean')
    store.setBigNumber('n1', { aggregate: 'average' })
    expect(meta().value.aggregate).toBe('average')
  })
})

describe('type restrictions', () => {
  it('sum on a text column is disabled in the dropdown and errors when forced', async () => {
    const { w, store } = setup(bn({ value: { field: 'region', aggregate: 'sum' } }))
    await flushPromises()
    for (const a of ['sum', 'mean', 'median']) expect(w.find(`[data-test=bn-agg] option[value=${a}]`).attributes('disabled')).toBeDefined()
    expect(w.find('[data-test=bn-agg] option[value=count]').attributes('disabled')).toBeUndefined()
    expect(store.bigNumbers.get('n1')!.status).toBe('error')
    expect(w.find('[data-test=bn-message]').text()).toMatch(/numeric/i)
  })
})

describe('states', () => {
  it('no source chosen', () => {
    const { w } = setup({ data: '', value: { field: '', aggregate: 'count' } })
    expect(w.find('[data-test=bn-message]').text()).toBe('Choose a data source')
  })
  it('source not run', () => {
    const { w } = setup(bn(), { run: null as any })
    expect(w.find('[data-test=bn-message]').text()).toBe('Run the source block first')
  })
  it('zh message for source not run', () => {
    setLocale('zh')
    const store = useNotebookStore()
    store.nb.value.blocks.push(src as any, { id: 'n1', type: 'big-number', metadata: bn() } as any)
    const w = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
    expect(w.find('[data-test=bn-message]').text()).toBe('请先运行源块')
  })
  it('field vanished is repairable (config kept)', async () => {
    const { w, meta } = setup(bn({ value: { field: 'gone', aggregate: 'sum' } }))
    await flushPromises()
    expect(w.find('[data-test=bn-message]').text()).toContain('gone')
    expect(meta().value.field).toBe('gone')
    expect(w.find('[data-test=bn-field]').exists()).toBe(true)
  })
  it('empty source shows a dash, but count shows 0', async () => {
    const a = setup(bn(), { rows: [] })
    await flushPromises()
    expect(value(a.w)).toBe('—')
    const b = setup(bn({ value: { field: '', aggregate: 'count' } }), { rows: [] })
    await flushPromises()
    expect(value(b.w)).toBe('0')
  })
  it('engine failure is shown and does not loop', async () => {
    let n = 0
    const engine = { ...fakeEngine(ROWS), async query() { n++; throw new Error('boom') } } as EngineClient
    const { w } = setup(bn(), { engine })
    await flushPromises()
    expect(w.find('[data-test=bn-message]').text()).toContain('boom')
    await flushPromises()
    expect(n).toBe(1)
  })
  it('does not refresh on mount when a value already exists', async () => {
    const { w, store, log } = setup(bn())
    await flushPromises()
    const n = log.length
    w.unmount()
    mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
    await flushPromises()
    expect(log.length).toBe(n)
  })
  it('spec-only legacy block displays', async () => {
    const { w } = setup({ data: 'sales', value: { field: 'amount' } })
    await flushPromises()
    expect(value(w)).toBe('90')
  })
})

describe('format and label', () => {
  it('thousands/decimals/percent via shared formatValue', async () => {
    const rows: unknown[][] = [['a', 1234567.891, 'x']]
    const a = setup(bn({ format: { kind: 'thousands', decimals: 1 } }), { rows })
    await flushPromises()
    expect(value(a.w)).toBe('1,234,567.9')
    const b = setup(bn({ value: { field: 'amount', aggregate: 'max' }, format: { kind: 'percent', decimals: 1 } }), { rows: [['a', 0.256, 'x']] })
    await flushPromises()
    expect(value(b.w)).toBe('25.6%')
  })
  it('label is displayed and editable, capped at 200', async () => {
    const { w, store, meta } = setup(bn({ label: 'Revenue' }))
    await flushPromises()
    expect(w.find('[data-test=bn-label-text]').text()).toBe('Revenue')
    store.setBigNumber('n1', { label: 'x'.repeat(300) })
    expect(meta().label).toHaveLength(200)
    store.setBigNumber('n1', { label: '' })
    expect('label' in meta()).toBe(false)
  })
  it('format control writes metadata.format', async () => {
    const { w, meta } = setup(bn())
    await flushPromises()
    await w.find('[data-test=bn-format]').setValue('percent')
    expect(meta().format).toEqual({ kind: 'percent' })
    await w.find('[data-test=bn-decimals]').setValue('9')
    expect(meta().format).toEqual({ kind: 'percent', decimals: 6 })
  })
})

describe('stale, refresh, supersession', () => {
  it('stale badge when the source reruns; refresh clears it', async () => {
    const { w, store } = setup(bn())
    await flushPromises()
    expect(w.find('[data-test=bn-stale]').exists()).toBe(false)
    store.runs.set('s1', run('T2', [['a', 1, 'x']]))
    await flushPromises()
    expect(w.find('[data-test=bn-stale]').exists()).toBe(true)
    store.setBigNumberRunner((id) => runBigNumber({ store, engine: fakeEngine([['a', 1, 'x']]) }, id))
    await w.find('[data-test=bn-refresh]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=bn-stale]').exists()).toBe(false)
    expect(value(w)).toBe('1')
  })
  it('partial badge', async () => {
    const r: any = run()
    r.result.truncated = true
    const { w } = setup(bn(), { run: r })
    await flushPromises()
    expect(w.find('[data-test=bn-partial]').exists()).toBe(true)
  })
  it('a superseded slow run cannot overwrite the newer config result', async () => {
    const release: (() => void)[] = []
    const engine = {
      ...fakeEngine(ROWS),
      query(sql: string) {
        return new Promise((res) => release.push(() => res({ columns: [], rows: [[/max/.test(sql) ? 60 : 90]], truncated: false, elapsedMs: 0 })))
      },
    } as EngineClient
    const { store, meta } = setup(bn(), { engine, mount: false })
    const p1 = store.refreshBigNumber('n1')
    store.setBigNumber('n1', { aggregate: 'max' })
    const p2 = store.refreshBigNumber('n1')
    await flushPromises()
    release[1]()
    await p2
    release[0]()
    await p1
    expect(meta().value.aggregate).toBe('max')
    expect(store.bigNumbers.get('n1')!.value).toBe(60)
  })
  it('setBigNumber debounces a refresh', async () => {
    vi.useFakeTimers()
    const { store, log } = setup(bn(), { mount: false })
    store.setBigNumber('n1', { aggregate: 'min' })
    store.setBigNumber('n1', { aggregate: 'max' })
    expect(log).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(150)
    expect(log).toHaveLength(1)
    expect(store.bigNumbers.get('n1')!.value).toBe(60)
  })
  it('a result finishing after the block is deleted is dropped', async () => {
    let rel!: () => void
    const engine = { ...fakeEngine(ROWS), query: () => new Promise((r) => { rel = () => r({ columns: [], rows: [[1]], truncated: false, elapsedMs: 0 }) }) } as EngineClient
    const { store } = setup(bn(), { engine, mount: false })
    const p = store.refreshBigNumber('n1')
    await flushPromises()
    store.removeBlock('n1')
    rel()
    await p
    expect(store.bigNumbers.has('n1')).toBe(false)
  })
})

describe('store', () => {
  it('addBlock default, duplicate without shared refs, delete cleanup', async () => {
    const store = useNotebookStore()
    const id = store.addBlock('big-number', null)
    const b = store.nb.value.blocks[0]
    expect(b.type).toBe('big-number')
    expect(b.metadata).toEqual({ data: '', value: { field: '', aggregate: 'count' } })
    const d = store.duplicateBlock(id)
    const c = store.nb.value.blocks.find((x) => x.id === d)!
    expect(c.metadata).toEqual(b.metadata)
    expect(c.metadata!.value).not.toBe(b.metadata!.value)
    store.bigNumbers.set(id, { status: 'ok', value: 1, partial: false, ranAt: 'x' } as any)
    store.removeBlock(id)
    expect(store.bigNumbers.has(id)).toBe(false)
  })
  it('invalid aggregate patch falls back to count', () => {
    const { store, meta } = setup(bn(), { mount: false })
    store.setBigNumber('n1', { aggregate: 'bogus' as any })
    expect(meta().value.aggregate).toBe('count')
  })
  it('malformed config is repaired on load with a notice; roundtrip keeps format', () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [src, { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'L'.repeat(500), format: { kind: 'bogus', decimals: 99 } } },
      { id: 'n2', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'average' }, format: { kind: 'thousands', decimals: 2 } } }]
    const s = useNotebookStore()
    s.load(serializeNotebook(nb), null, null)
    const m = (id: string) => s.nb.value.blocks.find((b) => b.id === id)!.metadata as any
    expect(m('n1').label).toHaveLength(200)
    expect(m('n1').format).toBeUndefined()
    expect(s.loadNotices.value).toContain('n1')
    expect(s.loadNotices.value).not.toContain('n2')
    expect(s.dirty.value).toBe(true)
    const back = parseNotebook(s.toText())
    expect((back.blocks[2].metadata as any).value.aggregate).toBe('average')
    expect((back.blocks[2].metadata as any).format).toEqual({ kind: 'thousands', decimals: 2 })
  })
  it('collectEntries still excludes big-number', () => {
    const { store } = setup(bn(), { mount: false })
    store.runs.set('n1', run() as any)
    expect(Object.keys(store.collectEntries())).toEqual(['s1'])
  })
})

describe('NotebookView', () => {
  it('insert + empty-state buttons, rendering', async () => {
    setLocale('en')
    const store = useNotebookStore()
    const provide = { [StoreKey as symbol]: store }
    const w = mount(NotebookView, { global: { provide } })
    expect(w.find('[data-test=empty-add-big-number]').text()).toBe('+ Big number')
    await w.find('[data-test=empty-add-big-number]').trigger('click')
    expect(store.nb.value.blocks[0].type).toBe('big-number')
    expect(w.find('[data-test=big-number-block]').exists()).toBe(true)
    await w.find('[data-test=add-big-number]').trigger('click')
    expect(store.nb.value.blocks).toHaveLength(2)
  })
  it('zh label', () => {
    setLocale('zh')
    const w = mount(NotebookView, { global: { provide: { [StoreKey as symbol]: useNotebookStore() } } })
    expect(w.find('[data-test=empty-add-big-number]').text()).toBe('+ 大数字')
  })
})

describe('a11y', () => {
  it('controls are labelled', async () => {
    const { w } = setup(bn())
    await flushPromises()
    for (const sel of ['bn-source', 'bn-field', 'bn-agg', 'bn-format', 'bn-decimals', 'bn-label']) {
      const el = w.find(`[data-test=${sel}]`)
      expect(el.exists(), sel).toBe(true)
      expect(el.element.closest('label') || el.attributes('aria-label'), sel).toBeTruthy()
    }
    expect(w.find('[data-test=bn-refresh]').attributes('aria-label')).toBe('Refresh')
  })
})

describe('fix round 1', () => {
  const loadWith = (md: any) => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [src, { id: 'n1', type: 'big-number', metadata: md }]
    const s = useNotebookStore()
    s.load(serializeNotebook(nb), null, null)
    return s
  }
  it('bad config values still open the file', () => {
    for (const md of [
      { data: 'sales', value: { field: 'amount', aggregate: 'stddev' } },
      { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 5 },
      { data: 'has space', value: { field: 'amount' } },
      { data: '', value: { field: '' } },
    ]) expect(() => loadWith(md)).not.toThrow()
  })
  it('unknown aggregate is kept byte-identical and shows a localised error', async () => {
    const s = loadWith({ data: 'sales', value: { field: 'amount', aggregate: 'stddev' } })
    expect(s.dirty.value).toBe(false)
    expect(JSON.stringify(parseNotebook(s.toText()).blocks[1].metadata)).toContain('"aggregate":"stddev"')
    expect((s.nb.value.blocks[1].metadata as any).value.aggregate).toBe('stddev')
    s.runs.set('s1', run() as any)
    setLocale('en')
    s.setBigNumberRunner((id) => runBigNumber({ store: s, engine: fakeEngine(ROWS) }, id))
    const w = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: s } } })
    await flushPromises()
    expect(w.find('[data-test=bn-message]').text()).toBe('Unsupported aggregate: stddev')
    expect(w.find('[data-test=bn-agg]').element.querySelector('option[value=stddev]')).toBeTruthy()
    await w.find('[data-test=bn-agg]').setValue('max')
    expect((s.nb.value.blocks[1].metadata as any).value.aggregate).toBe('max')
  })
  it('zh unsupported aggregate', async () => {
    const s = loadWith({ data: 'sales', value: { field: 'amount', aggregate: 'stddev' } })
    setLocale('zh')
    const w = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: s } } })
    expect(w.find('[data-test=bn-message]').text()).toBe('不支持的聚合: stddev')
  })
  it('agg select shows effective default when aggregate is undefined', async () => {
    const { w } = setup({ data: 'sales', value: { field: 'amount' } })
    await flushPromises()
    expect((w.find('[data-test=bn-agg]').element as HTMLSelectElement).value).toBe('sum')
  })
  it('label/format edits do not re-query; data/field/aggregate do', async () => {
    vi.useFakeTimers()
    const { store, log } = setup(bn(), { mount: false })
    store.setBigNumber('n1', { label: 'x' })
    store.setBigNumber('n1', { format: { kind: 'percent' } })
    await vi.advanceTimersByTimeAsync(150)
    expect(log).toHaveLength(0)
    store.setBigNumber('n1', { field: 'amount' , aggregate: 'min' })
    await vi.advanceTimersByTimeAsync(150)
    expect(log).toHaveLength(1)
  })
  it('visualizeResult stores an error result when the runner fails', async () => {
    const store = useNotebookStore()
    store.nb.value.blocks.push(src as any)
    store.runs.set('s1', run() as any)
    store.setAnalysisRunner(async () => { throw new Error('nope') })
    const id = store.visualizeResult('s1')!
    await flushPromises()
    expect(store.analysis.get(id)?.status).toBe('error')
    expect(store.analysis.get(id)?.error?.message).toBe('nope')
  })
})

describe('period comparison on cards', () => {
  const stubRunner = (store: any, items: any[]) => store.setBigNumberRunner(async (id: string) => {
    store.bigNumbers.set(id, { status: 'ok', value: items[0].value, items, partial: false, ranAt: 'x' })
  })
  const c = (deltaPct: number | null, kind = 'mom', previous = '2026-09') => ({ kind, current: '2026-10', previous, currentValue: 1, previousValue: 1, deltaPct })
  it('card shows ▲/▼/—/= text for up/down/null/zero', async () => {
    const metrics = [0, 1, 2, 3].map(() => ({ field: 'amount', aggregate: 'sum' }))
    const { store, w } = setup(bn({ metrics }))
    await flushPromises(); stubRunner(store, [{ value: 5, compare: c(0.123) }, { value: 5, compare: c(-0.04, 'yoy', '2025-10') }, { value: 5, compare: c(null) }, { value: 5, compare: c(0) }])
    await store.refreshBigNumber('n1'); await flushPromises()
    const t = w.findAll('[data-test=bn-compare]').map((x) => x.text())
    expect(t).toEqual(['▲ 12.3% vs 2026-09 (MoM)', '▼ 4.0% vs 2025-10 (YoY)', '— vs 2026-09 (MoM)', '= 0.0% vs 2026-09 (MoM)'])
    expect(w.findAll('[data-test=bn-compare]')[0].attributes('aria-label')).toBeUndefined()
  })
  it('zh wording', async () => {
    const { store, w } = setup(bn())
    setLocale('zh')
    await flushPromises(); stubRunner(store, [{ value: 5, compare: c(0.5, 'yoy', '2025-10') }])
    await store.refreshBigNumber('n1'); await flushPromises()
    expect(w.find('[data-test=bn-compare]').text()).toBe('▲ 50.0% 对比 2025-10（同比）')
  })
  it('no compare → no bn-compare element', async () => {
    const { w } = setup(bn())
    await flushPromises()
    expect(w.find('[data-test=bn-compare]').exists()).toBe(false)
  })
  it('distinct value renders as a number', async () => {
    const { store, w } = setup(bn({ value: { field: 'region', aggregate: 'distinct' } }))
    await flushPromises(); stubRunner(store, [{ value: 3 }])
    await store.refreshBigNumber('n1'); await flushPromises()
    expect(value(w)).toBe('3')
  })
  it('tiny delta rounding to 0.0% prints = ; non-finite prints —', async () => {
    const metrics = [0, 1, 2, 3, 4].map(() => ({ field: 'amount', aggregate: 'sum' }))
    const { store, w } = setup(bn({ metrics }))
    await flushPromises(); stubRunner(store, [0.0001, -0.0001, Infinity, -Infinity, NaN].map((d) => ({ value: 5, compare: c(d) })))
    await store.refreshBigNumber('n1'); await flushPromises()
    expect(w.findAll('[data-test=bn-compare]').map((x) => x.text())).toEqual([
      '= 0.0% vs 2026-09 (MoM)', '= 0.0% vs 2026-09 (MoM)', '— vs 2026-09 (MoM)', '— vs 2026-09 (MoM)', '— vs 2026-09 (MoM)'])
  })
  it('null value card still shows the compare line', async () => {
    const { store, w } = setup(bn())
    await flushPromises(); stubRunner(store, [{ value: null, compare: c(null) }])
    await store.refreshBigNumber('n1'); await flushPromises()
    expect(value(w)).toBe('—')
    expect(w.find('[data-test=bn-compare]').text()).toBe('— vs 2026-09 (MoM)')
  })
  it('COMPARE_NO_DATES info note renders muted on the card', async () => {
    const { store, w } = setup(bn())
    await flushPromises(); stubRunner(store, [{ value: 7, info: { code: 'COMPARE_NO_DATES' } }])
    await store.refreshBigNumber('n1'); await flushPromises()
    expect(value(w)).toBe('7')
    expect(w.find('[data-test=bn-info]').text()).toBe('No usable dates, comparison unavailable')
    setLocale('zh'); await flushPromises()
    expect(w.find('[data-test=bn-info]').text()).toBe('没有可用的日期，无法对比')
    setLocale('en')
    expect(w.find('[data-test=bn-info]').attributes('role')).toBe('status')
    expect(w.find('[data-test=bn-card-error]').exists()).toBe(false)
  })
  it('COMPARE error shows on that card only', async () => {
    const { store, w } = setup(bn({ metrics: [{ field: 'amount', aggregate: 'sum' }, { field: 'amount', aggregate: 'sum' }] }))
    await flushPromises(); stubRunner(store, [{ value: 1, compare: c(0.1) }, { value: null, error: { code: 'COMPARE', message: 'bad date' } }])
    await store.refreshBigNumber('n1'); await flushPromises()
    const cards = w.findAll('[data-test=bn-card]')
    expect(cards[0].find('[data-test=bn-compare]').exists()).toBe(true)
    expect(cards[1].find('[data-test=bn-card-error]').text()).toBe('bad date')
    expect(cards[0].find('[data-test=bn-card-error]').exists()).toBe(false)
  })
})


describe('BigNumberBlock Ask AI entry', () => {
  const aiMount = async (o: { send?: any; aiCompletion?: boolean; noSettings?: boolean; noRun?: boolean; busy?: boolean; client?: boolean } = {}) => {
    setLocale('en')
    const t0 = setup(bn(), { mount: false, run: o.noRun ? null : undefined })
    const bridge = createFakeBridge({ caps: { aiCompletion: o.aiCompletion ?? true } })
    const drawer = createDrawerManager(t0.store as any)
    const settings = { sendOptions: async () => o.send ?? { schema: true, sql: true, data: true } }
    const provide: any = { [StoreKey as symbol]: t0.store, [BridgeKey as symbol]: bridge, [DrawerKey as symbol]: drawer }
    if (!o.noSettings) provide[AiSettingsKey as symbol] = settings
    if (o.client) provide[AiClientKey as symbol] = { available: () => true, streaming: () => true, busy: () => false, listModels: async () => [], generate: () => new Promise(() => {}) } as AiClient
    const w = mount(BigNumberBlock, { props: { blockId: 'n1' }, attachTo: document.body, global: { provide } })
    await flushPromises()
    return { ...t0, w, drawer }
  }
  const btn = (w: any) => w.find('[data-test=bn-ask-ai]')

  it('enabled with a run SQL table and schema on', async () => {
    const { w } = await aiMount()
    expect(btn(w).exists()).toBe(true)
    expect(btn(w).attributes('disabled')).toBeUndefined()
    expect(btn(w).attributes('aria-describedby')).toBeUndefined()
  })
  it('disabled with a described reason: schema off / no tables / unsupported', async () => {
    for (const [o, key] of [[{ send: { schema: false, sql: true, data: true } }, 'no-schema-setting'], [{ noRun: true }, 'no-tables'], [{ aiCompletion: false }, 'unsupported']] as const) {
      const { w } = await aiMount(o as any)
      const b = btn(w)
      expect(b.attributes('disabled')).toBeDefined()
      const text = t(`ai.bn.gate.${key}` as any)
      expect(b.attributes('title')).toBe(text)
      const id = b.attributes('aria-describedby')!
      expect(w.find('#' + id).text()).toBe(text)
      w.unmount()
    }
  })
  it('click opens {purpose:"bignumber", blockId}; disabled while another drawer is open', async () => {
    const { w, drawer } = await aiMount()
    await btn(w).trigger('click')
    expect(drawer.current.value).toEqual({ purpose: 'bignumber', blockId: 'n1' })
    await flushPromises()
    expect(btn(w).attributes('disabled')).toBeDefined()
    expect(w.find('#' + btn(w).attributes('aria-describedby')!).text()).toBe(t('ai.askDrawerOpen'))
  })
  it('disabled with a described reason while another AI request is running', async () => {
    const { w } = await aiMount({ client: true })
    const client = (w.vm.$ as any).provides[AiClientKey as symbol] as AiClient
    void useAiRequest(client).start({ prompt: 'x' } as any)
    await flushPromises()
    expect(btn(w).attributes('disabled')).toBeDefined()
    expect(w.find('#' + btn(w).attributes('aria-describedby')!).text()).toBe(t('ai.bn.gate.ai-busy'))
  })
  it('absent without AiSettings', async () => {
    const { w } = await aiMount({ noSettings: true })
    expect(btn(w).exists()).toBe(false)
  })
})

describe('bn-label two-line clamp', () => {
  it('200-char label: full text and title preserved; empty label renders no element', async () => {
    const long = '长'.repeat(200)
    const { w } = setup(bn({ label: long }))
    await flushPromises()
    const el = w.find('[data-test=bn-label-text]')
    expect(el.text()).toBe(long)
    expect(el.attributes('title')).toBe(long)
    const e = setup(bn({ label: '' }))
    await flushPromises()
    expect(e.w.find('[data-test=bn-label-text]').exists()).toBe(false)
  })
  it('source CSS clamps .bn-label to 2 lines', () => {
    const v = bnSource
    const rule = /\.bn-label\s*\{([^}]*)\}/.exec(v)![1]
    expect(rule).toContain('-webkit-line-clamp: 2')
    expect(rule).toContain('overflow-wrap: anywhere')
    expect(rule).toContain('overflow: hidden')
  })
})
