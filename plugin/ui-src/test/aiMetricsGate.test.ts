import { describe, it, expect } from 'vitest'
import { genRequests, hostAiCalls } from './aiRequests'
import { createFakeBridge } from '../src/host/fakeBridge'
import { useNotebookStore } from '../src/state/notebookStore'
import { runBigNumber } from '../src/analysis/runBigNumber'
import { compareText } from '../src/analysis/compareText'
import { setLocale, t } from '../src/i18n'
import { candidateToMetric, type MetricCandidate } from '../src/ai/parseMetrics'
import { metricsAiGate, listLocalTables, tableSignature, previewCandidate } from '../src/ai/metricsAiGate'
import type { EngineClient } from '../src/run/engineClient'

const caps = (aiCompletion = true) => ({ aiCompletion }) as any
const send = (o: Partial<{ schema: boolean; sql: boolean; data: boolean }> = {}) => ({ schema: true, sql: true, data: true, ...o })
const gate = (o: any = {}) => metricsAiGate({ caps: caps(), send: send(), tables: 2, busy: false, ...o })

describe('metricsAiGate', () => {
  it('enabled when everything is available', () => expect(gate()).toEqual({ enabled: true }))
  it('each reason', () => {
    expect(gate({ caps: caps(false) })).toEqual({ enabled: false, reason: 'unsupported' })
    expect(gate({ send: send({ schema: false }) })).toEqual({ enabled: false, reason: 'no-schema-setting' })
    expect(gate({ tables: 0 })).toEqual({ enabled: false, reason: 'no-tables' })
    expect(gate({ busy: true })).toEqual({ enabled: false, reason: 'ai-busy' })
  })
  it('precedence unsupported > no-schema > no-tables > busy', () => {
    expect(gate({ caps: caps(false), send: send({ schema: false }), tables: 0, busy: true }).enabled === false && (gate({ caps: caps(false), send: send({ schema: false }), tables: 0, busy: true }) as any).reason).toBe('unsupported')
    expect((gate({ send: send({ schema: false }), tables: 0, busy: true }) as any).reason).toBe('no-schema-setting')
    expect((gate({ tables: 0, busy: true }) as any).reason).toBe('no-tables')
  })
  it('data off + schema on stays enabled', () => expect(gate({ send: send({ data: false }) })).toEqual({ enabled: true }))
})

const COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }]
const okRun = (cols = COLS) => ({ status: 'ok', executedAt: 'T1', result: { columns: cols, rows: [['a', 1, '2026-01-01']], truncated: false, elapsedMs: 1, dbType: 'sqlite' } }) as any
const sql = (id: string, resultName?: string) => ({ id, type: 'sql', content: 'select 1', metadata: resultName ? { resultName } : {} }) as any

describe('listLocalTables', () => {
  it('skips unrun / failed / unnamed, keeps order, case-insensitive dedup first wins', () => {
    setLocale('en')
    const store = useNotebookStore()
    store.nb.value.blocks.push(sql('a', 'Sales'), sql('b', 'unrun'), sql('c'), sql('d', 'bad'), sql('e', 'sales'), sql('f', 'costs'),
      { id: 'm', type: 'markdown', content: '', metadata: { resultName: 'md' } } as any)
    store.runs.set('a', okRun()); store.runs.set('c', okRun()); store.runs.set('e', okRun([{ name: 'x', dataType: 'text' }])); store.runs.set('f', okRun())
    store.runs.set('d', { status: 'error', error: 'x' } as any)
    const l = listLocalTables(store)
    expect(l.map((x) => x.name)).toEqual(['Sales', 'costs'])
    expect(l[0].block.id).toBe('a')
    expect(l[0].columns).toEqual([{ name: 'region', kind: 'text' }, { name: 'amount', kind: 'number' }, { name: 'd', kind: 'temporal' }])
    expect(l[0].partial).toBe(false)
    expect(l[0].executedAt).toBe('T1')
  })
  it('tableSignature changes when a column is added', () => {
    const a = [{ name: 't', columns: [{ name: 'x', kind: 'number' }] }]
    const b = [{ name: 't', columns: [{ name: 'x', kind: 'number' }, { name: 'y', kind: 'text' }] }]
    expect(tableSignature(a)).toBe(tableSignature(a))
    expect(tableSignature(a)).not.toBe(tableSignature(b))
  })
})

function setup(o: { total?: unknown; period?: unknown; byMonth?: Record<string, unknown>; fail?: boolean } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  store.nb.value.blocks.push(sql('s1', 'sales'), { id: 'b1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount' } } } as any)
  store.runs.set('s1', okRun())
  const log: string[] = []
  const engine: EngineClient = {
    sessionId: 's', async ensureRegistered() {}, invalidate() {}, async close() {},
    async query(s) {
      log.push(s)
      if (o.fail) throw new Error('boom')
      const rows = (v: unknown) => ({ columns: [], rows: [[v]], truncated: false, elapsedMs: 1 })
      if (s.startsWith('SELECT max(CASE')) return rows(o.period ?? null)
      const m = /= '(\d{4}-\d{2})'$/.exec(s)
      if (m) return rows(o.byMonth?.[m[1]] ?? null)
      return rows(o.total ?? 0)
    },
  }
  const bridge = createFakeBridge({ caps: { aiCompletion: true }, requestHandlers: { 'host.ai.generateText': async () => 'x' } })
  return { store, engine, log, bridge }
}
const cand = (o: Partial<MetricCandidate> = {}): MetricCandidate => ({ data: 'sales', field: 'amount', aggregate: 'sum', ...o })
const alive = () => true

describe('previewCandidate', () => {
  it('sum formatted with thousands/decimals; count; distinct; filtered', async () => {
    const s = setup({ total: 1234567.891 })
    const p = await previewCandidate(s, cand({ format: { kind: 'thousands', decimals: 2 } }), alive)
    expect(p).toEqual({ text: '1,234,567.89' })
    const s2 = setup({ total: 42 })
    expect((await previewCandidate(s2, cand({ field: '', aggregate: 'count' }), alive)).text).toBe('42')
    expect((await previewCandidate(s2, cand({ field: 'region', aggregate: 'distinct' }), alive)).text).toBe('42')
    const q = await previewCandidate(s2, cand({ filter: [{ field: 'region', op: '=', value: 'a' }] }), alive)
    expect(q.text).toBe('42')
    expect(s2.log.some((l) => l.includes('WHERE'))).toBe(true)
  })
  it('MoM / YoY compare text', async () => {
    const s = setup({ total: 9, period: '2026-03', byMonth: { '2026-03': 150, '2026-02': 100, '2025-03': 300 } })
    const m = await previewCandidate(s, cand({ compare: { kind: 'mom', dateField: 'd' } }), alive)
    expect(m.compare).toBe(compareText({ kind: 'mom', current: '2026-03', previous: '2026-02', currentValue: 150, previousValue: 100, deltaPct: 0.5 }, t as any))
    expect(m.compare).toContain('▲')
    const y = await previewCandidate(s, cand({ compare: { kind: 'yoy', dateField: 'd' } }), alive)
    expect(y.compare).toContain('▼')
  })
  it('TYPE / FILTER / COMPARE errors are {text:null,error}', async () => {
    const s = setup()
    const a = await previewCandidate(s, cand({ field: 'region', aggregate: 'sum' }), alive)
    expect(a.text).toBeNull(); expect(a.error).toBeTruthy()
    const b = await previewCandidate(s, cand({ filter: [{ field: 'amount', op: '=', value: 'str' }] }), alive)
    expect(b.text).toBeNull(); expect(b.error).toBeTruthy()
    const c = await previewCandidate(s, cand({ compare: { kind: 'mom', dateField: 'region' } }), alive)
    expect(c.text).toBeNull(); expect(c.error).toBeTruthy()
  })
  it('missing table / engine failure never throw', async () => {
    const s = setup({ fail: true })
    const a = await previewCandidate(s, cand({ data: 'nope' }), alive)
    expect(a.text).toBeNull(); expect(a.error).toBeTruthy()
    const b = await previewCandidate(s, cand(), alive)
    expect(b.text).toBeNull(); expect(b.error).toBeTruthy()
  })
  it('dead drawer yields no value', async () => {
    const s = setup({ total: 5 })
    const p = await previewCandidate(s, cand(), () => false)
    expect(p.text).toBeNull()
  })
  it('never writes store.bigNumbers and never calls host AI (both channels; positive control)', async () => {
    const s = setup({ total: 5 })
    await previewCandidate(s, cand(), alive)
    expect(s.store.bigNumbers.size).toBe(0)
    expect(genRequests(s.bridge)).toHaveLength(0)
    expect(hostAiCalls(s.bridge)).toHaveLength(0)
    await s.bridge.request('host.ai.generateText', { prompt: 'p' })
    expect(genRequests(s.bridge)).toHaveLength(1)
  })
  it('preview equals the block value after Apply (same fixture)', async () => {
    const s = setup({ total: 1234.5, period: '2026-03', byMonth: { '2026-03': 150, '2026-02': 100 } })
    const c = cand({ format: { kind: 'thousands', decimals: 1 }, compare: { kind: 'mom', dateField: 'd' } })
    const p = await previewCandidate(s, c, alive)
    s.store.nb.value.blocks[1].metadata = { data: 'sales', value: { field: 'amount' }, metrics: [candidateToMetric(c)] } as any
    const r = await runBigNumber(s, 'b1')
    expect(p.text).toBe('1,234.5')
    expect(r.items[0].value).toBe(1234.5)
    expect(p.compare).toBe(compareText(r.items[0].compare!, t as any))
  })
})
