import { describe, it, expect, vi } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'
import { groupBySource, canonicalizeCandidate, planMetricApply } from '../src/ai/groupMetrics'
import { checkCandidate, type MetricCandidate } from '../src/ai/parseMetrics'

const cand = (data: string, field: string, extra: Partial<MetricCandidate> = {}): MetricCandidate => ({ data, field, aggregate: field ? 'sum' : 'count', ...extra })
function fresh(meta?: Record<string, unknown>) {
  const s = useNotebookStore()
  const nb = createEmptyNotebook()
  nb.blocks.push({ id: 'a1', type: 'markdown', content: 'x' } as any)
  nb.blocks.push({ id: 'n1', type: 'big-number', metadata: meta ?? { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'Total', extra: 'keep' } } as any)
  nb.blocks.push({ id: 'z1', type: 'markdown', content: 'z' } as any)
  s.load(serializeNotebook(nb), null, null)
  return s
}
const ids = (s: ReturnType<typeof fresh>) => s.nb.value.blocks.map((b) => b.id)
const meta = (s: ReturnType<typeof fresh>, id: string) => s.nb.value.blocks.find((b) => b.id === id)!.metadata as any
const m3 = [
  { field: 'amount', aggregate: 'sum', label: 'Rev', format: { kind: 'thousands' as const } },
  { field: 'qty', aggregate: 'mean', filter: [{ field: 'region', op: '=', value: 'N' }] },
  { field: 'amount', aggregate: 'max', compare: { kind: 'mom' as const, dateField: 'd' } },
]

describe('setBigNumberDef', () => {
  it('replaces data+metrics, keeps extra metadata, one undo restores exactly, redo re-applies', () => {
    const s = fresh()
    const prev = JSON.parse(JSON.stringify(meta(s, 'n1')))
    s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('n1', { data: 'orders', metrics: m3 as any }) })
    const m = meta(s, 'n1')
    expect(m.data).toBe('orders'); expect(m.extra).toBe('keep')
    expect(m.value).toEqual({ field: 'amount', aggregate: 'sum' }); expect(m.label).toBe('Rev'); expect(m.format).toEqual({ kind: 'thousands' })
    expect(m.metrics).toHaveLength(3); expect(m.metrics[1].filter).toEqual(m3[1].filter); expect(m.metrics[2].compare).toEqual(m3[2].compare)
    const after = JSON.parse(JSON.stringify(m))
    expect(s.undo().ok).toBe(true)
    expect(meta(s, 'n1')).toEqual(prev)
    expect(s.redo().ok).toBe(true)
    expect(meta(s, 'n1')).toEqual(after)
  })
  it('single plain metric keeps the pre-AI single form', () => {
    const s = fresh()
    s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('n1', { data: 'orders', metrics: [{ field: 'qty', aggregate: 'sum' }] }) })
    expect('metrics' in meta(s, 'n1')).toBe(false)
    expect(meta(s, 'n1').value).toEqual({ field: 'qty', aggregate: 'sum' })
  })
  it('block that already had metrics[] keeps emitting it', () => {
    const s = fresh({ data: 'sales', value: { field: 'a', aggregate: 'sum' }, metrics: [{ field: 'a', aggregate: 'sum' }, { field: 'b', aggregate: 'sum' }] })
    s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('n1', { data: 'sales', metrics: [{ field: 'c', aggregate: 'sum' }] }) })
    expect(meta(s, 'n1').metrics).toEqual([{ field: 'c', aggregate: 'sum' }])
  })
  it('9 metrics -> too-many-metrics, nothing changed; 0 -> empty; wrong type -> not-big-number', () => {
    const s = fresh()
    const prev = JSON.stringify(s.nb.value); const rev = s.revision.value
    const nine = Array.from({ length: 9 }, () => ({ field: 'a', aggregate: 'sum' }))
    expect(() => s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('n1', { data: 'x', metrics: nine }) })).toThrow('too-many-metrics')
    expect(() => s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('n1', { data: 'x', metrics: [] }) })).toThrow('empty')
    expect(() => s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('a1', { data: 'x', metrics: nine.slice(0, 1) }) })).toThrow('not-big-number')
    expect(() => s.applyAiEdit({ label: 'AI', run: (tx) => tx.setBigNumberDef('nope', { data: 'x', metrics: nine.slice(0, 1) }) })).toThrow('block-gone')
    expect(JSON.stringify(s.nb.value)).toBe(prev); expect(s.revision.value).toBe(rev)
    expect(s.history.stack.canUndo?.() ?? false).toBe(false)
  })
})

describe('groupBySource', () => {
  const c = (d: string, n: number) => cand(d, 'f' + n)
  it('[A,B,A,C,B] -> A(1,3) B(2,5) C(4)', () => {
    const g = groupBySource([c('A', 1), c('B', 2), c('A', 3), c('C', 4), c('B', 5)])
    expect(g.map((x) => [x.data, x.metrics.map((m) => m.field)])).toEqual([['A', ['f1', 'f3']], ['B', ['f2', 'f5']], ['C', ['f4']]])
  })
  it('case-insensitive, first spelling written', () => {
    const g = groupBySource([c('Sales', 1), c('SALES', 2), c('sales', 3)])
    expect(g).toHaveLength(1); expect(g[0].data).toBe('Sales'); expect(g[0].metrics).toHaveLength(3)
  })
  it('10 same-source -> 8 + 2 in order', () => {
    const g = groupBySource(Array.from({ length: 10 }, (_, i) => c('A', i + 1)))
    expect(g.map((x) => x.metrics.map((m) => m.field))).toEqual([['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'], ['f9', 'f10']])
  })
  it('20 mixed: nothing lost/duplicated, order preserved inside defs', () => {
    const cs = Array.from({ length: 20 }, (_, i) => c(['A', 'b', 'C'][i % 3 === 0 ? 0 : i % 3], i + 1))
    const g = groupBySource(cs)
    const all = g.flatMap((x) => x.metrics.map((m) => m.field))
    expect([...all].sort()).toEqual(cs.map((x) => x.field).sort())
    for (const d of g) { const nums = d.metrics.map((m) => Number(m.field.slice(1))); expect(nums).toEqual([...nums].sort((a, b) => a - b)); expect(d.metrics.length).toBeLessThanOrEqual(8) }
  })
})

describe('insert grouped', () => {
  const run = (s: ReturnType<typeof fresh>, anchor: string, cs: MetricCandidate[]) =>
    s.applyAiEdit({ label: 'AI: add big numbers', run: (tx) => { let a = anchor; for (const d of groupBySource(cs)) a = tx.insertBigNumberAfter(a, d) } })
  it('blocks directly after anchor in group order; one undo removes all; redo restores in order', () => {
    const s = fresh()
    run(s, 'n1', [cand('A', 'x'), cand('B', 'y'), cand('A', 'z')])
    const order = ids(s)
    expect(order[0]).toBe('a1'); expect(order[1]).toBe('n1'); expect(order[4]).toBe('z1'); expect(order).toHaveLength(5)
    expect(meta(s, order[2]).data).toBe('A'); expect(meta(s, order[2]).metrics.map((m: any) => m.field)).toEqual(['x', 'z'])
    expect(meta(s, order[3]).data).toBe('B'); expect('metrics' in meta(s, order[3])).toBe(false)
    expect(s.undo().ok).toBe(true)
    expect(ids(s)).toEqual(['a1', 'n1', 'z1'])
    expect(s.redo().ok).toBe(true)
    expect(ids(s)).toEqual(order)
    expect(meta(s, order[3]).value.field).toBe('y')
  })
  it('3 sources -> 3 single blocks; filter/compare force metrics[]', () => {
    const s = fresh()
    run(s, 'n1', [cand('A', 'x'), cand('B', 'y', { filter: [{ field: 'r', op: '=', value: 1 }] }), cand('C', 'z')])
    const o = ids(s)
    expect(o).toHaveLength(6)
    expect('metrics' in meta(s, o[2])).toBe(false); expect('metrics' in meta(s, o[3])).toBe(true); expect('metrics' in meta(s, o[4])).toBe(false)
  })
  it('anchor missing -> throws, nothing changes; anchor present works', () => {
    const s = fresh()
    const prev = JSON.stringify(s.nb.value); const rev = s.revision.value; const dirty = s.dirty.value
    expect(() => run(s, 'nope', [cand('A', 'x')])).toThrow('anchor-missing')
    expect(JSON.stringify(s.nb.value)).toBe(prev); expect(s.revision.value).toBe(rev); expect(s.dirty.value).toBe(dirty)
    run(s, 'n1', [cand('A', 'x')])
    expect(ids(s)).toHaveLength(4)
  })
  it('failure midway -> none inserted', () => {
    const s = fresh()
    const prev = JSON.stringify(s.nb.value)
    expect(() => s.applyAiEdit({ label: 'AI', run: (tx) => { const a = tx.insertBigNumberAfter('n1', { data: 'A', metrics: [{ field: 'x', aggregate: 'sum' }] }); tx.insertBigNumberAfter(a, { data: 'B', metrics: [] }) } })).toThrow('empty')
    expect(JSON.stringify(s.nb.value)).toBe(prev)
  })
})

describe('undo/redo re-run and serialization', () => {
  it('undo/redo schedule bigNumberRunner for surviving blocks; removed dropped from bigNumbers', async () => {
    vi.useFakeTimers()
    try {
      const s = fresh()
      const seen: any[] = []
      s.setBigNumberRunner(async (id) => { seen.push([id, meta(s, id).data]); return { status: 'ok', value: null, items: [], partial: false, ranAt: '' } as any })
      s.applyAiEdit({ label: 'AI', run: (tx) => { tx.setBigNumberDef('n1', { data: 'orders', metrics: [{ field: 'q', aggregate: 'sum' }] }); tx.insertBigNumberAfter('n1', { data: 'B', metrics: [{ field: 'y', aggregate: 'sum' }] }) } })
      const newId = ids(s)[2]
      s.bigNumbers.set(newId, { status: 'ok' } as any)
      s.undo(); await vi.advanceTimersByTimeAsync(200)
      expect(seen).toEqual([['n1', 'sales']])
      expect(s.bigNumbers.has(newId)).toBe(false)
      seen.length = 0
      s.redo(); await vi.advanceTimersByTimeAsync(200)
      expect(seen.map((x) => x[0]).sort()).toEqual(['n1', newId].sort())
      expect(seen.find((x) => x[0] === 'n1')[1]).toBe('orders')
    } finally { vi.useRealTimers() }
  })
  it('serialized output has only ordinary big-number keys', () => {
    const s = fresh()
    s.applyAiEdit({ label: 'AI', run: (tx) => { tx.insertBigNumberAfter('n1', { data: 'B', metrics: [{ field: 'y', aggregate: 'sum', label: 'Y' }] }) } })
    const text = serializeNotebook(s.nb.value)
    const nb = JSON.parse(JSON.stringify(s.nb.value))
    const keys = new Set(Object.keys(nb.blocks[2].metadata))
    expect([...keys].every((k) => ['data', 'value', 'label', 'format', 'metrics'].includes(k))).toBe(true)
    expect(text).not.toMatch(/note|prompt|candidate/i)
  })
})

describe('canonicalizeCandidate', () => {
  const tables = [{ name: 'Sales', columns: [{ name: 'Amount', kind: 'number' }, { name: 'Region', kind: 'text' }, { name: 'Day', kind: 'temporal' }] }]
  it('rewrites data/field/filter/compare to schema spelling; apply path then matches engine case', () => {
    const c = cand('sales', 'amount', { filter: [{ field: 'region', op: '=', value: 'N' }], compare: { kind: 'mom', dateField: 'day' } })
    expect(checkCandidate(c, tables).problem).toBeUndefined()
    const k = canonicalizeCandidate(c, tables)
    expect(k.data).toBe('Sales'); expect(k.field).toBe('Amount'); expect(k.filter![0].field).toBe('Region'); expect(k.compare!.dateField).toBe('Day')
    expect(c.field).toBe('amount')
    expect(canonicalizeCandidate(cand('sales', ''), tables).field).toBe('')
    expect(canonicalizeCandidate(cand('x', 'amount'), tables).field).toBe('amount')
  })
  it('groups merge across spelling after canonicalisation', () => {
    const g = groupBySource([cand('sales', 'amount'), cand('SALES', 'region', { aggregate: 'distinct' })].map((c) => canonicalizeCandidate(c, tables)))
    expect(g).toHaveLength(1); expect(g[0].data).toBe('Sales'); expect(g[0].metrics.map((m) => m.field)).toEqual(['Amount', 'Region'])
  })
})

describe('ambiguous case variants', () => {
  const tables = [
    { name: 'sales', columns: [{ name: 'amount', kind: 'number' }, { name: 'Amount', kind: 'number' }, { name: 'Day', kind: 'temporal' }, { name: 'day', kind: 'temporal' }] },
    { name: 'Orders', columns: [{ name: 'x', kind: 'number' }] },
    { name: 'orders', columns: [{ name: 'x', kind: 'number' }] },
  ]
  it('exact-case match wins for column, filter field and dateField', () => {
    const k = canonicalizeCandidate(cand('sales', 'Amount', { filter: [{ field: 'Amount', op: '>', value: 1 }], compare: { kind: 'mom', dateField: 'Day' } }), tables)
    expect(k.field).toBe('Amount'); expect(k.filter![0].field).toBe('Amount'); expect(k.compare!.dateField).toBe('Day')
    expect(canonicalizeCandidate(cand('sales', 'amount'), tables).field).toBe('amount')
  })
  it('no exact match and several case-insensitive matches -> untouched', () => {
    const k = canonicalizeCandidate(cand('sales', 'AMOUNT', { filter: [{ field: 'AMOUNT', op: '>', value: 1 }], compare: { kind: 'mom', dateField: 'DAY' } }), tables)
    expect(k.field).toBe('AMOUNT'); expect(k.filter![0].field).toBe('AMOUNT'); expect(k.compare!.dateField).toBe('DAY')
  })
  it('tables differing by case: exact wins, otherwise untouched', () => {
    expect(canonicalizeCandidate(cand('Orders', 'x'), tables).data).toBe('Orders')
    expect(canonicalizeCandidate(cand('orders', 'x'), tables).data).toBe('orders')
    expect(canonicalizeCandidate(cand('ORDERS', 'x'), tables).data).toBe('ORDERS')
  })
})

describe('planMetricApply', () => {
  const tables = [
    { name: 'Sales', columns: [{ name: 'Amount', kind: 'number' }, { name: 'Region', kind: 'text' }, { name: 'Day', kind: 'temporal' }] },
    { name: 'Cust', columns: [{ name: 'Id', kind: 'number' }] },
    { name: 'amb', columns: [{ name: 'a', kind: 'number' }, { name: 'A', kind: 'number' }] },
  ]
  it('insert: canonicalises and groups', () => {
    const r: any = planMetricApply([cand('sales', 'amount'), cand('CUST', 'id'), cand('SALES', 'region', { aggregate: 'distinct' })], tables, 'insert')
    expect(r.defs.map((d: any) => [d.data, d.metrics.map((m: any) => m.field)])).toEqual([['Sales', ['Amount', 'Region']], ['Cust', ['Id']]])
  })
  it('update: one def, same source only, <= 8', () => {
    const ok: any = planMetricApply([cand('sales', 'amount'), cand('SALES', 'region', { aggregate: 'distinct' })], tables, 'update')
    expect(ok.defs).toHaveLength(1)
    expect((planMetricApply([cand('sales', 'amount'), cand('cust', 'id')], tables, 'update') as any).error.code).toBe('mixed-sources')
    const nine = Array.from({ length: 9 }, () => cand('sales', 'amount'))
    expect((planMetricApply(nine, tables, 'update') as any).error.code).toBe('too-many')
    expect((planMetricApply([], tables, 'update') as any).error.code).toBe('empty')
    expect((planMetricApply([], tables, 'insert') as any).error.code).toBe('empty')
  })
  it('invalid candidate refuses everything (no partial)', () => {
    const r: any = planMetricApply([cand('sales', 'amount'), cand('sales', 'nope'), cand('cust', 'id')], tables, 'insert')
    expect(r.defs).toBeUndefined(); expect(r.error.code).toBe('invalid'); expect(r.error.index).toBe(1)
    expect((planMetricApply([cand('gone', 'x')], tables, 'insert') as any).error.code).toBe('invalid')
  })
  it('ambiguous names are refused', () => {
    expect((planMetricApply([cand('amb', 'A')], tables, 'insert') as any).defs).toHaveLength(1)
    const q: any = planMetricApply([{ ...cand('amb', 'x') }], tables, 'insert')
    expect(q.error.code).toBe('invalid')
    const tb = [{ name: 'amb', columns: [{ name: 'ab', kind: 'number' }, { name: 'aB', kind: 'number' }] }]
    const z: any = planMetricApply([cand('amb', 'AB')], tb, 'insert')
    expect(z.error.code).toBe('ambiguous'); expect(z.error.index).toBe(0)
  })
})

describe('undo step count', () => {
  it('second undo is a no-op; redo then undo stable', () => {
    const s = fresh()
    const prev = JSON.stringify(s.nb.value.blocks)
    s.applyAiEdit({ label: 'AI', run: (tx) => { tx.setBigNumberDef('n1', { data: 'o', metrics: [{ field: 'q', aggregate: 'sum' }] }); tx.insertBigNumberAfter('n1', { data: 'B', metrics: [{ field: 'y', aggregate: 'sum' }] }) } })
    expect(s.history.undoDepth.value).toBe(1)
    expect(s.undo().ok).toBe(true)
    expect(JSON.stringify(s.nb.value.blocks)).toBe(prev)
    expect(s.undo().ok).toBe(false)
    expect(JSON.stringify(s.nb.value.blocks)).toBe(prev)
    const afterJson = (s.redo(), JSON.stringify(s.nb.value.blocks))
    expect(s.redo().ok).toBe(false)
    expect(s.undo().ok).toBe(true)
    expect(JSON.stringify(s.nb.value.blocks)).toBe(prev)
    s.redo()
    expect(JSON.stringify(s.nb.value.blocks)).toBe(afterJson)
    expect(s.history.undoDepth.value).toBe(1)
  })
})
