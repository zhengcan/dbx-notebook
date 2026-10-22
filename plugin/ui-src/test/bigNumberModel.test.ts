import { describe, it, expect } from 'vitest'
import { BIG_AGGS, NUMERIC_ONLY_AGGS, isKnownAggregate, isKnownOp, isKnownCompare, normalizeBigNumber } from '../src/analysis/bigNumberConfig'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

const mk = (meta: any) => {
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  store.nb.value.blocks.push({ id: 'n1', type: 'big-number', metadata: meta } as any)
  return { store, meta: () => store.nb.value.blocks[0].metadata as any }
}
const one = (m: any) => normalizeBigNumber({ data: 'd', metrics: [{ field: 'a', aggregate: 'sum', ...m }] })

describe('big number model', () => {
  it('distinct is a known aggregate', () => {
    expect(BIG_AGGS).toContain('distinct')
    expect(isKnownAggregate('distinct')).toBe(true)
    expect(NUMERIC_ONLY_AGGS).not.toContain('distinct')
  })
  it('normalize keeps valid filter/compare', () => {
    const f = [{ field: 'r', op: '=', value: 'a' }, { field: 'x', op: 'in', value: [1, 2] }, { field: 'y', op: 'isNull' }]
    const c = one({ filter: f, compare: { kind: 'mom', dateField: 'd' } })
    expect(c.metrics[0].filter).toEqual(f)
    expect(c.metrics[0].compare).toEqual({ kind: 'mom', dateField: 'd' })
    expect(c.warnings).toEqual([])
  })
  it('unknown op and compare.kind kept verbatim, isKnownOp false', () => {
    const c = one({ filter: [{ field: 'r', op: 'like', value: 'a' }], compare: { kind: 'qoq', dateField: 'd' } })
    expect(c.metrics[0].filter![0].op).toBe('like')
    expect(c.metrics[0].compare!.kind).toBe('qoq')
    expect(isKnownOp('like')).toBe(false)
    expect(isKnownOp('>=')).toBe(true)
    expect(isKnownCompare('qoq')).toBe(false)
    expect(isKnownCompare('yoy')).toBe(true)
  })
  it("non-array filter ignored with warning 'filter'", () => {
    const c = one({ filter: { field: 'r' } })
    expect(c.metrics[0].filter).toBeUndefined()
    expect(c.warnings).toContain('filter')
  })
  it('6 filters → 5 + warning', () => {
    const c = one({ filter: Array.from({ length: 6 }, () => ({ field: 'r', op: '=', value: 1 })) })
    expect(c.metrics[0].filter).toHaveLength(5)
    expect(c.warnings).toContain('filter')
  })
  it('in with 60 values → 50', () => {
    const c = one({ filter: [{ field: 'r', op: 'in', value: Array.from({ length: 60 }, (_, i) => i) }] })
    expect((c.metrics[0].filter![0].value as unknown[]).length).toBe(50)
    expect(c.warnings).toContain('filter')
  })
  it('filter value object dropped', () => {
    const c = one({ filter: [{ field: 'r', op: '=', value: { a: 1 } }, 'junk'] })
    expect(c.metrics[0].filter).toEqual([{ field: 'r', op: '=' }])
    expect(c.warnings).toContain('filter')
  })
  it('compare without dateField → dropped with warning', () => {
    const c = one({ compare: { kind: 'mom' } })
    expect(c.metrics[0].compare).toBeUndefined()
    expect(c.warnings).toContain('compare')
  })
  it('setBigNumber({index,filter}) writes only that metric filter and forces metrics[]', () => {
    const { store, meta } = mk({ data: 'd', value: { field: 'a', aggregate: 'sum' } })
    store.setBigNumber('n1', { filter: [{ field: 'r', op: '=', value: 'a' }] })
    expect(meta().metrics).toEqual([{ field: 'a', aggregate: 'sum', filter: [{ field: 'r', op: '=', value: 'a' }] }])
    const t = mk({ data: 'd', metrics: [{ field: 'a' }, { field: 'b' }] })
    t.store.setBigNumber('n1', { index: 1, filter: [{ field: 'r', op: 'notNull' }] })
    expect(t.meta().metrics[0].filter).toBeUndefined()
    expect(t.meta().metrics[1].filter).toEqual([{ field: 'r', op: 'notNull' }])
  })
  it('setBigNumber({compare:null}) removes the key', () => {
    const { store, meta } = mk({ data: 'd', metrics: [{ field: 'a', compare: { kind: 'mom', dateField: 'd' }, filter: [{ field: 'r', op: 'isNull' }] }] })
    store.setBigNumber('n1', { compare: null })
    expect('compare' in meta().metrics[0]).toBe(false)
    store.setBigNumber('n1', { filter: null })
    expect('filter' in meta().metrics[0]).toBe(false)
  })
  it('a block with no new fields serializes identical to before', () => {
    const legacy = { data: 'd', value: { field: 'a', aggregate: 'sum' }, label: 'T', format: { kind: 'thousands' } }
    const { store, meta } = mk(JSON.parse(JSON.stringify(legacy)))
    store.setBigNumber('n1', { label: 'T' })
    expect(JSON.stringify(meta())).toBe(JSON.stringify(legacy))
    const multi = { data: 'd', value: { field: 'a', aggregate: 'sum' }, metrics: [{ field: 'a', aggregate: 'sum' }, { field: 'b', aggregate: 'max', color: 'red' }] }
    const t = mk(JSON.parse(JSON.stringify(multi)))
    t.store.setBigNumber('n1', { aggregate: 'sum' })
    expect(t.meta()).toEqual(multi)
  })
  it('value/label/format/aggregate mirror metrics[0] incl. distinct', () => {
    const { store, meta } = mk({ data: 'd', metrics: [{ field: 'a', aggregate: 'sum' }] })
    store.setBigNumber('n1', { aggregate: 'distinct' })
    expect(meta().value).toEqual({ field: 'a', aggregate: 'distinct' })
    expect(meta().metrics[0].aggregate).toBe('distinct')
  })
  it('load→save of a file with extras on a metric preserves them', () => {
    const f = [{ field: 'r', op: '=', value: 'a', note: 'x' }]
    const { store, meta } = mk({ data: 'd', metrics: [{ field: 'a', color: 'red', filter: f, compare: { kind: 'yoy', dateField: 'd', extra: 1 } }] })
    store.setBigNumber('n1', { label: 'L' })
    expect(meta().metrics[0]).toEqual({ field: 'a', color: 'red', label: 'L', filter: f, compare: { kind: 'yoy', dateField: 'd', extra: 1 } })
  })
  it('filter entries missing field or op are dropped; unknown string op kept', () => {
    const c = one({ filter: [{ op: '=' }, { field: 'r' }, { field: 'r', op: 'like', value: 1 }] })
    expect(c.metrics[0].filter).toEqual([{ field: 'r', op: 'like', value: 1 }])
    expect(c.warnings).toContain('filter')
    expect(one({ filter: [{ op: '=' }] }).metrics[0].filter).toBeUndefined()
  })
  it('repair on load does not persist a phantom filter entry', () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [{ id: 'n1', type: 'big-number', metadata: { data: 'd', value: { field: 'a' }, metrics: [{ field: 'a', filter: [{ op: '=' }, { field: 'r', op: '=', value: 1 }] }] } }]
    const s = useNotebookStore()
    s.load(serializeNotebook(nb), null, null)
    expect(s.loadNotices.value).toContain('n1')
    expect((s.nb.value.blocks[0].metadata as any).metrics[0].filter).toEqual([{ field: 'r', op: '=', value: 1 }])
  })
  it('filter entry keeps original key order', () => {
    const c = one({ filter: [{ value: 1, op: '=', field: 'r' }] })
    expect(Object.keys(c.metrics[0].filter![0])).toEqual(['value', 'op', 'field'])
  })
  it('setBigNumber clones filter and compare', () => {
    const { store, meta } = mk({ data: 'd', metrics: [{ field: 'a' }] })
    const vals = [1, 2]
    const filter: any[] = [{ field: 'r', op: 'in', value: vals }]
    const compare = { kind: 'mom', dateField: 'd' }
    store.setBigNumber('n1', { filter, compare })
    vals.push(3); filter[0].field = 'zz'; filter.push({ field: 'q', op: '=' }); compare.kind = 'yoy'
    expect(meta().metrics[0].filter).toEqual([{ field: 'r', op: 'in', value: [1, 2] }])
    expect(meta().metrics[0].compare).toEqual({ kind: 'mom', dateField: 'd' })
  })
})
