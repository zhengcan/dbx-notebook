import { describe, it, expect } from 'vitest'
import { runBigNumber } from '../src/analysis/runBigNumber'
import { useNotebookStore } from '../src/state/notebookStore'
import { setLocale } from '../src/i18n'
import type { EngineClient } from '../src/run/engineClient'

const COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }, { name: 'note', dataType: 'text' }]
const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const cmp = (kind = 'mom', dateField = 'd') => ({ kind, dateField })

// period: result of the period query; byMonth: metric value per 'YYYY-MM'; total: all-rows value
function setup(metrics: any[], o: { period?: unknown; byMonth?: Record<string, unknown>; total?: unknown; fail?: (s: string) => boolean } = {}) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  store.nb.value.blocks.push(src, { id: 'b1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount' }, metrics } } as any)
  store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: COLS, rows: [], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
  const log: string[] = []
  const engine: EngineClient = {
    sessionId: 's', async ensureRegistered() {}, invalidate() {}, async close() {},
    async query(s) {
      log.push(s)
      if (o.fail?.(s)) throw new Error('boom')
      const rows = (v: unknown) => ({ columns: [], rows: [[v]], truncated: false, elapsedMs: 1 })
      if (s.startsWith('SELECT max(CASE')) return rows(o.period ?? null)
      const m = /= '(\d{4}-\d{2})'$/.exec(s)
      if (m) return rows(o.byMonth?.[m[1]] ?? null)
      return rows(o.total ?? 0)
    },
  }
  return { store, engine, log }
}
const go = (s: ReturnType<typeof setup>) => runBigNumber({ store: s.store, engine: s.engine }, 'b1')

describe('big-number compare', () => {
  it('mom: current vs previous month, float delta; main value stays all-rows', async () => {
    const r = await go(setup([{ field: 'amount', aggregate: 'sum', compare: cmp() }], { period: '2026-03', byMonth: { '2026-03': 150, '2026-02': 100 }, total: 999 }))
    expect(r.items[0].value).toBe(999)
    expect(r.items[0].compare).toEqual({ kind: 'mom', current: '2026-03', previous: '2026-02', currentValue: 150, previousValue: 100, deltaPct: 0.5 })
  })
  it('mom wraps January to December of the previous year', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp() }], { period: '2026-01', byMonth: { '2026-01': 1, '2025-12': 4 } }))
    expect(r.items[0].compare?.previous).toBe('2025-12')
    expect(r.items[0].compare?.deltaPct).toBe(-0.75)
  })
  it('negative previous uses |previous|', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp() }], { period: '2026-03', byMonth: { '2026-03': -50, '2026-02': -100 } }))
    expect(r.items[0].compare?.deltaPct).toBe(0.5)
  })
  it('previous 0 -> deltaPct null', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp() }], { period: '2026-03', byMonth: { '2026-03': 5, '2026-02': 0 } }))
    expect(r.items[0].compare?.deltaPct).toBeNull()
    expect(r.items[0].compare?.previousValue).toBe(0)
  })
  it('yoy: same month prior year; absent previous -> null/null', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp('yoy') }], { period: '2026-03', byMonth: { '2026-03': 5 } }))
    expect(r.items[0].compare).toMatchObject({ kind: 'yoy', previous: '2025-03', previousValue: null, deltaPct: null })
  })
  it('non-numeric first/last values -> delta null', async () => {
    const r = await go(setup([{ field: 'note', aggregate: 'last', compare: cmp() }], { period: '2026-03', byMonth: { '2026-03': 'x', '2026-02': 'y' } }))
    expect(r.items[0].compare?.deltaPct).toBeNull()
  })
  it('no dates (empty filtered rows / all-null dates): no compare, value kept, info, no throw', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp() }], { period: null, total: 7 }))
    expect(r.status).toBe('ok')
    expect(r.items[0].value).toBe(7)
    expect(r.items[0].compare).toBeUndefined()
    expect(r.items[0].info).toEqual({ code: 'COMPARE_NO_DATES' })
  })
  it('dateField not temporal / missing -> COMPARE error on that metric only', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp('mom', 'region') }, { field: 'amount', compare: cmp('mom', 'nope') }, { field: 'amount' }], { total: 3 }))
    expect(r.items[0].error?.code).toBe('COMPARE')
    expect(r.items[1].error?.code).toBe('COMPARE')
    expect(r.items[2]).toEqual({ value: 3 })
    expect(r.status).toBe('ok')
  })
  it('unknown compare kind -> COMPARE error', async () => {
    const r = await go(setup([{ field: 'amount', compare: cmp('qoq') }, { field: 'amount' }]))
    expect(r.items[0].error?.code).toBe('COMPARE')
    expect(r.items[1].error).toBeUndefined()
  })
  it('filter errors are per metric; the filter reaches every SQL', async () => {
    const s = setup([
      { field: 'amount', aggregate: 'sum', filter: [{ field: 'region', op: '=', value: 'a' }], compare: cmp() },
      { field: 'amount', filter: [{ field: 'nope', op: '=', value: 1 }] },
      { field: 'amount', filter: [{ field: 'amount', op: '=', value: 'x' }] },
    ], { period: '2026-03', byMonth: { '2026-03': 2, '2026-02': 1 } })
    const r = await go(s)
    expect(r.items[0].compare?.deltaPct).toBe(1)
    expect(r.items[1].error?.code).toBe('FILTER')
    expect(r.items[2].error?.code).toBe('FILTER')
    expect(s.log.filter((q) => q.includes(`"region" = 'a'`)).length).toBe(4)
  })
  it('dates are matched through the guarded as-written month expression (ISO with time/zone)', async () => {
    const s = setup([{ field: 'amount', compare: cmp() }], { period: '2026-10', byMonth: { '2026-10': 1, '2026-09': 1 } })
    await go(s)
    expect(s.log.some((q) => q.startsWith('SELECT max(CASE') && q.includes('GLOB') && q.includes('substr("d", 1, 7)'))).toBe(true)
  })
  it('one metric failing in the engine does not fail the others', async () => {
    const r = await go(setup([{ field: 'amount', aggregate: 'sum' }, { field: 'amount', aggregate: 'max' }], { fail: (q) => q.includes('max(') }))
    expect(r.items[0].value).toBe(0)
    expect(r.items[1].error?.code).toBe('ENGINE')
    expect(r.status).toBe('ok')
  })
  it('fingerprint changes with filter or compare so the run is not deduplicated', async () => {
    const s = setup([{ field: 'amount' }], { total: 1 })
    await go(s); const n1 = s.log.length
    const b: any = s.store.nb.value.blocks[1]
    b.metadata = { ...b.metadata, metrics: [{ field: 'amount', filter: [{ field: 'region', op: '=', value: 'a' }] }] }
    await go(s)
    expect(s.log.length).toBeGreaterThan(n1)
    expect(s.log[s.log.length - 1]).toContain(`"region" = 'a'`)
    const n2 = s.log.length
    b.metadata = { ...b.metadata, metrics: [{ field: 'amount', filter: [{ field: 'region', op: '=', value: 'a' }], compare: cmp() }] }
    await go(s)
    expect(s.log.length).toBeGreaterThan(n2)
  })
})
