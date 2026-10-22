import { describe, it, expect } from 'vitest'
import { runAnalysis } from '../src/analysis/runAnalysis'
import { resolveSource } from '../src/analysis/source'
import { buildAggregateSql, buildExcludedCountSql } from '../src/analysis/sql'
import { useNotebookStore } from '../src/state/notebookStore'
import { EngineError, type EngineClient } from '../src/run/engineClient'
import { setLocale, t } from '../src/i18n'

const src = (id = 's1', name = 'sales') => ({ id, type: 'sql', content: 'select 1', metadata: { resultName: name } })
const chart = (pivot: any, extra: any = {}, id = 'c1', data = 'sales') => ({ id, type: 'chart', metadata: { data, pivot, ...extra } })
const okRun = (executedAt = 'T1', o: any = {}) => ({
  status: 'ok' as const,
  result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }], rows: [['a', 1, '2026-01-01']], truncated: false, elapsedMs: 1, dbType: 'sqlite', ...(o.result ?? {}) },
  executedAt, ...(o.run ?? {}),
})
const pv = (o: any = {}) => ({ rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }], ...o })

function setup(blocks: any[], opts: { queryImpl?: (s: string, n: number) => any; run?: any } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  store.nb.value.blocks.push(...blocks)
  if (opts.run !== null) store.runs.set('s1', opts.run ?? okRun())
  const calls = { query: [] as [string, number][], register: 0, invalidate: 0 }
  const engine: EngineClient = {
    sessionId: 's',
    async ensureRegistered() { calls.register++ },
    async query(s, n) {
      calls.query.push([s, n])
      if (opts.queryImpl) return opts.queryImpl(s, n)
      return { columns: [], rows: [[1]], truncated: false, elapsedMs: 1 }
    },
    invalidate() { calls.invalidate++ },
    async close() {},
  }
  store.setAnalysisRunner((id) => runAnalysis({ store, engine }, id))
  return { store, engine, calls }
}

describe('resolveSource', () => {
  it('typed errors and success', () => {
    const { store } = setup([src(), chart(pv())])
    const r: any = resolveSource(store, 'sales')
    expect(r.block.id).toBe('s1'); expect(r.executedAt).toBe('T1'); expect(r.partial).toBe(false)
    expect(r.columns).toEqual([{ name: 'region', kind: 'text' }, { name: 'amount', kind: 'number' }, { name: 'd', kind: 'temporal' }])
    expect((resolveSource(store, 'nope') as any).error.code).toBe('NO_SOURCE')
    store.runs.delete('s1')
    expect((resolveSource(store, 'sales') as any).error.code).toBe('SOURCE_NOT_RUN')
  })
})

describe('runAnalysis', () => {
  it('success path stores result and uses generator SQL', async () => {
    const { store, calls } = setup([src(), chart(pv({ totals: { row: true, column: true, grand: true } }))], {
      queryImpl: () => ({ columns: [], rows: [['a', 1]], truncated: false, elapsedMs: 1 }),
    })
    const out = await store.refreshAnalysis('c1')
    expect(out.status).toBe('ok')
    expect(out.long).toEqual({ dims: ['__sqlnb_r0'], measures: ['__sqlnb_v0'], rows: [['a', 1]] })
    expect(out.sourceExecutedAt).toBe('T1'); expect(out.ranAt).toBe('2026-01-02T03:04:05.000Z')
    expect(out.partial).toBe(false); expect(out.tooManyPoints).toBe(false); expect(out.excludedDateRows).toBe(0)
    expect(store.analysis.get('c1')).toEqual(out)
    expect((out as any).totals).toBeUndefined()
    const cols = [{ name: 'region', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }, { name: 'd', kind: 'temporal' as const }]
    const p: any = pv()
    expect(calls.query[0][0]).toBe((buildAggregateSql('sales', p, cols) as any).sql)
    expect(calls.query[0][1]).toBe(5000)
    expect(calls.query).toHaveLength(1) // summaries are computed client-side: no totals queries
  })
  it('summary toggles never add queries; summaries come from the loaded cells', async () => {
    const { buildPivotModel } = await import('../src/analysis/pivotModel')
    const p = pv({ totals: { row: true, column: true, grand: true }, columns: [{ field: 'd' }] })
    const { store, calls } = setup([src(), chart(p)], { queryImpl: () => ({ columns: [], rows: [['a', 'x', 1], ['a', 'y', 2], ['b', 'x', 4]], truncated: false, elapsedMs: 1 }) })
    const out = await store.refreshAnalysis('c1')
    expect(calls.query).toHaveLength(2) // aggregate + excluded-date-rows count only
    const m = buildPivotModel(out, p)
    expect(m.rowTotals).toEqual([[3], [4]])
    expect(m.columnTotals).toEqual([5, 2])
    expect(m.grandTotal).toEqual([7])
  })
  it('error codes', async () => {
    const a = setup([chart(pv())]); a.store.runs.delete('s1')
    expect((await a.store.refreshAnalysis('c1')).error).toEqual({ code: 'NO_SOURCE', message: t('analysis.err.NO_SOURCE') })
    const b = setup([src(), chart(pv())], { run: null })
    expect((await b.store.refreshAnalysis('c1')).error!.code).toBe('SOURCE_NOT_RUN')
    const c = setup([src(), chart(pv({ rows: [{ field: 'zzz' }, { field: 'yyy' }] }))])
    const cr = await c.store.refreshAnalysis('c1')
    expect(cr.status).toBe('error'); expect(cr.error!.code).toBe('BAD_FIELD')
    expect(cr.error!.message).toContain('zzz'); expect(cr.error!.message).toContain('yyy')
    expect(c.calls.query).toHaveLength(0)
    const d = setup([src(), chart(pv({ values: [{ field: 'region', agg: 'sum' }] }))])
    expect((await d.store.refreshAnalysis('c1')).error!.code).toBe('SQL')
    const e = setup([src(), chart(pv())], { queryImpl: () => { throw new EngineError(-32000, 'boom') } })
    const er = await e.store.refreshAnalysis('c1')
    expect(er.error!.code).toBe('ENGINE'); expect(er.error!.message).toContain('boom')
    const f = setup([src(), chart(pv({ values: [] }))])
    const fr = await f.store.refreshAnalysis('c1')
    expect(fr.status).toBe('empty'); expect(fr.error).toBeUndefined()
  })
  it('error messages localised', async () => {
    const a = setup([chart(pv())]); a.store.runs.delete('s1')
    setLocale('zh-CN')
    const r = await a.store.refreshAnalysis('c1')
    expect(r.error!.message).toBe(t('analysis.err.NO_SOURCE'))
    expect(r.error!.message).not.toBe('analysis.err.NO_SOURCE')
    expect(/[\u4e00-\u9fff]/.test(r.error!.message)).toBe(true)
    setLocale('en')
    for (const k of ['NO_SOURCE', 'SOURCE_NOT_RUN', 'BAD_FIELD', 'ENGINE', 'SQL']) expect(t(`analysis.err.${k}` as any, { fields: 'x', message: 'y' })).not.toBe(`analysis.err.${k}`)
  })
  it('partial from truncated source or store.isPartial', async () => {
    const a = setup([src(), chart(pv())], { run: okRun('T1', { result: { truncated: true } }) })
    expect((await a.store.refreshAnalysis('c1')).partial).toBe(true)
    const b = setup([src(), chart(pv())], { run: okRun('T1', { run: { partial: true } }) })
    expect((await b.store.refreshAnalysis('c1')).partial).toBe(true)
  })
  it('tooManyPoints returns no rows', async () => {
    const a = setup([src(), chart(pv())], { queryImpl: () => ({ columns: [], rows: [[1, 2]], truncated: true, elapsedMs: 1 }) })
    const r = await a.store.refreshAnalysis('c1')
    expect(r.tooManyPoints).toBe(true); expect(r.long).toBeUndefined(); expect(r.status).toBe('ok')
  })
  it('excluded date rows', async () => {
    const a = setup([src(), chart(pv({ rows: [{ field: 'd', grain: 'month' }] }))], {
      queryImpl: (s) => /count\(\*\) FROM/.test(s) ? { columns: [], rows: [[3]], truncated: false, elapsedMs: 1 } : { columns: [], rows: [], truncated: false, elapsedMs: 1 },
    })
    const r = await a.store.refreshAnalysis('c1')
    expect(r.excludedDateRows).toBe(3)
    const cols = [{ name: 'region', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }, { name: 'd', kind: 'temporal' as const }]
    expect(a.calls.query.map((q) => q[0])).toContain((buildExcludedCountSql('sales', pv({ rows: [{ field: 'd', grain: 'month' }] }) as any, cols) as any).sql)
  })
  it('session lost retries after reregister', async () => {
    let n = 0
    const a = setup([src(), chart(pv())], {
      queryImpl: () => { if (n++ === 0) { const e = new EngineError(-32000, 'no such table: sales'); e.needsReregister = true; throw e } return { columns: [], rows: [[1, 2]], truncated: false, elapsedMs: 1 } },
    })
    const r = await a.store.refreshAnalysis('c1')
    expect(r.status).toBe('ok'); expect(a.calls.invalidate).toBe(1)
  })
  it('in-flight dedupe', async () => {
    const a = setup([src(), chart(pv())])
    const [x, y] = await Promise.all([a.store.refreshAnalysis('c1'), a.store.refreshAnalysis('c1')])
    expect(x).toBe(y); expect(a.calls.query).toHaveLength(1)
    await a.store.refreshAnalysis('c1')
    expect(a.calls.query).toHaveLength(2)
  })
  it('generation guard drops stale result', async () => {
    let store: any
    const a = setup([src(), chart(pv())], { queryImpl: () => { store.generation.value++; return { columns: [], rows: [[1, 2]], truncated: false, elapsedMs: 1 } } })
    store = a.store
    await a.store.refreshAnalysis('c1')
    expect(a.store.analysis.has('c1')).toBe(false)
  })
  it('hostile field names only via generator', async () => {
    const bad = 'x"; DROP TABLE t;--'
    const blocks = [src(), chart(pv({ rows: [{ field: bad }] }))]
    const a = setup(blocks)
    a.store.runs.set('s1', okRun('T1', { result: { columns: [{ name: bad, dataType: 'text' }, { name: 'amount', dataType: 'integer' }] } }))
    await a.store.refreshAnalysis('c1')
    const p: any = pv({ rows: [{ field: bad }] })
    const cols = [{ name: bad, kind: 'text' as const }, { name: 'amount', kind: 'number' as const }]
    expect(a.calls.query[0][0]).toBe((buildAggregateSql('sales', p, cols) as any).sql)
  })
  it('legacy chart without pivot: no aggregation', async () => {
    const a = setup([src(), { id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {} } }])
    const r = await a.store.refreshAnalysis('c1')
    expect(r.status).toBe('ok'); expect(r.long).toBeUndefined(); expect(r.sourceExecutedAt).toBe('T1')
    expect(a.calls.query).toHaveLength(0)
    a.store.runs.set('s1', okRun('T2', { result: { truncated: true } }))
    expect(a.store.staleReasons('c1')).toEqual(['upstream'])
    expect((await a.store.refreshAnalysis('c1')).partial).toBe(true)
  })
  it('column vanished after source re-ran', async () => {
    const a = setup([src(), chart(pv())])
    expect((await a.store.refreshAnalysis('c1')).status).toBe('ok')
    a.store.runs.set('s1', okRun('T2', { result: { columns: [{ name: 'amount', dataType: 'integer' }] } }))
    const r = await a.store.refreshAnalysis('c1')
    expect(r.error!.code).toBe('BAD_FIELD'); expect(r.error!.message).toContain('region')
  })
})

describe('staleness', () => {
  it('transitions', async () => {
    const { store } = setup([src(), chart(pv())])
    expect(store.staleReasons('c1')).toEqual([])
    await store.refreshAnalysis('c1')
    expect(store.staleReasons('c1')).toEqual([])
    store.runs.set('s1', okRun('T2'))
    expect(store.staleReasons('c1')).toEqual(['upstream'])
    await store.refreshAnalysis('c1')
    expect(store.staleReasons('c1')).toEqual([])
    store.runs.set('s1', { status: 'running' })
    expect(store.staleReasons('c1')).toEqual([])
    store.runs.set('s1', { status: 'error' })
    expect(store.staleReasons('c1')).toEqual(['upstream'])
    store.runs.set('s1', okRun('T2'))
    expect(store.staleReasons('c1')).toEqual([])
    store.removeBlock('s1')
    expect(store.staleReasons('c1')).toEqual(['upstream'])
  })
  it('config change recomputes, not stale', async () => {
    const { store } = setup([src(), chart(pv())])
    await store.refreshAnalysis('c1')
    store.updateMeta('c1', { pivot: pv({ rows: [] }) })
    expect(store.staleReasons('c1')).toEqual([])
  })
  it('block deletion cleans analysis', async () => {
    const { store } = setup([src(), chart(pv())])
    await store.refreshAnalysis('c1')
    store.removeBlock('c1')
    expect(store.analysis.has('c1')).toBe(false)
  })
})

describe('fix round 1', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r }); return { p, open } }
  it('config change mid-flight reruns and final result reflects new config', async () => {
    const g = gate(); let first = true
    const a = setup([src(), chart(pv())], { queryImpl: async (s) => { if (first && !/count\(\*\) FROM/.test(s)) { first = false; await g.p; return { columns: [], rows: [['OLD', 1]], truncated: false, elapsedMs: 1 } } return { columns: [], rows: [['NEW', 2]], truncated: false, elapsedMs: 1 } } })
    const p1 = a.store.refreshAnalysis('c1')
    await Promise.resolve(); await Promise.resolve()
    a.store.updateMeta('c1', { pivot: pv({ rows: [] }) })
    const p2 = a.store.refreshAnalysis('c1')
    expect(p2).not.toBe(p1)
    const r2 = await p2
    g.open()
    const r1 = await p1
    expect(r1.long!.rows[0][0]).toBe('OLD')
    expect(r2.long!.rows[0][0]).toBe('NEW')
    expect(a.store.analysis.get('c1')!.long!.rows[0][0]).toBe('NEW')
  })
  it('same config coalesces; deletion mid-run safe', async () => {
    const g = gate()
    const a = setup([src(), chart(pv())], { queryImpl: async () => { await g.p; return { columns: [], rows: [[1, 2]], truncated: false, elapsedMs: 1 } } })
    const p1 = a.store.refreshAnalysis('c1'), p2 = a.store.refreshAnalysis('c1')
    expect(p1).toBe(p2)
    a.store.removeBlock('c1')
    g.open()
    await p1
    expect(a.store.analysis.has('c1')).toBe(false)
    expect(a.calls.query).toHaveLength(1)
  })
  it('refreshAnalysis without runner rejects; App wires runner', async () => {
    const s = useNotebookStore()
    await expect(s.refreshAnalysis('x')).rejects.toThrow()
    const app = (await import('../src/App.vue?raw')).default as string
    expect(app).toMatch(/setAnalysisRunner/)
  })
})

describe('shared in-flight helper', () => {
  it('dedupes same fingerprint, supersedes on change, isLatest flips', async () => {
    const { createFlights } = await import('../src/analysis/flights')
    const store = {} as object
    const flights = createFlights<string>()
    const latest: boolean[] = []
    let release!: () => void
    const exec = (isLatest: () => boolean) => new Promise<string>((res) => { release = () => { latest.push(isLatest()); res('x') } })
    const p1 = flights.run(store, 'b', 'fp1', exec)
    expect(flights.run(store, 'b', 'fp1', exec)).toBe(p1)
    const r1 = release
    const p2 = flights.run(store, 'b', 'fp2', exec)
    expect(p2).not.toBe(p1)
    r1(); release()
    await Promise.all([p1, p2])
    expect(latest).toEqual([false, true])
  })
})
