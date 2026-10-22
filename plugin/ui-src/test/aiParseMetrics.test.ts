import { describe, it, expect } from 'vitest'
import { parseMetricsReply, checkCandidate, detectMetricTarget, candidateToMetric, MAX_CANDIDATES, type LocalTable, type MetricCandidate } from '../src/ai/parseMetrics'
import { MAX_OUTPUT_CHARS } from '../src/ai/parse'

const ctx = { truncated: false, selected: null as number | null }
const p = (t: string, c: Partial<typeof ctx & { numbered: boolean }> = {}) => parseMetricsReply(t, { ...ctx, ...c })
const v = (t: string, c = {}) => { const r = p(t, c); if (!r.ok) throw new Error(r.reason); return r }
const cand = (o: Partial<MetricCandidate> = {}): MetricCandidate => ({ data: 'sales', field: 'amount', aggregate: 'sum', ...o })

describe('parseMetricsReply', () => {
  it('fenced JSON array with prose', () => {
    const r = v('Here you go:\n```json\n[{"data":"sales","field":"amount","aggregate":"sum","label":"Total"}]\n```\nenjoy')
    expect(r.value.metrics).toEqual([{ data: 'sales', field: 'amount', aggregate: 'sum', label: 'Total' }])
    expect(r.value.replaced).toBe('all')
  })
  it('object with metrics and question', () => {
    const r = v('{"metrics":[{"data":"s","field":"a","aggregate":"max"}],"question":"which?"}')
    expect(r.value.metrics).toHaveLength(1)
    expect(r.value.question).toBe('which?')
  })
  it('single object: one when selected else all', () => {
    const t = '{"data":"s","field":"a","aggregate":"max"}'
    expect(v(t).value.replaced).toBe('all')
    const r = v(t, { selected: 1 })
    expect(r.value.replaced).toBe('one'); expect(r.value.index).toBe(1)
  })
  it('drops non-whitelisted fields', () => {
    const r = v('{"data":"s","field":"a","aggregate":"sum","sql":"drop","where":"1","join":"x","note":"n"}')
    expect(Object.keys(r.value.metrics[0]).sort()).toEqual(['aggregate', 'data', 'field', 'note'])
  })
  it('wrong types dropped per field', () => {
    const r = v('[{"data":"s","field":"a","aggregate":"sum","label":5,"format":"x","filter":"y","compare":3,"note":[]}]')
    expect(r.value.metrics).toEqual([{ data: 's', field: 'a', aggregate: 'sum', filterDropped: true }])
    const bad = p('[{"data":5,"field":"a","aggregate":"sum"}]')
    expect(bad.ok).toBe(false)
  })
  it('filter/compare/distinct accepted', () => {
    const r = v('{"data":"s","field":"u","aggregate":"distinct","filter":[{"field":"r","op":"in","value":["a","b"]},{"field":"x","op":"isNull"}],"compare":{"kind":"MoM","dateField":"d"}}')
    const m = r.value.metrics[0]
    expect(m.aggregate).toBe('distinct')
    expect(m.filter).toEqual([{ field: 'r', op: 'in', value: ['a', 'b'] }, { field: 'x', op: 'isNull' }])
    expect(m.compare).toEqual({ kind: 'mom', dateField: 'd' })
  })
  it('7 filters → 5 + warning', () => {
    const f = Array.from({ length: 7 }, (_, i) => ({ field: 'c' + i, op: '=', value: 1 }))
    const r = v(JSON.stringify({ data: 's', field: 'a', aggregate: 'sum', filter: f }))
    expect(r.value.metrics[0].filter).toHaveLength(5)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('in list capped at 50', () => {
    const r = v(JSON.stringify({ data: 's', field: 'a', aggregate: 'sum', filter: [{ field: 'c', op: 'in', value: Array.from({ length: 60 }, (_, i) => i) }] }))
    expect((r.value.metrics[0].filter![0].value as unknown[]).length).toBe(50)
  })
  it('13 candidates → 12 + warning', () => {
    const items = Array.from({ length: 13 }, () => ({ data: 's', field: 'a', aggregate: 'sum' }))
    const r = v(JSON.stringify(items))
    expect(r.value.metrics).toHaveLength(MAX_CANDIDATES)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('average→mean, decimals clamp, label/note caps', () => {
    const r = v(JSON.stringify({ data: 's', field: 'a', aggregate: 'average', label: 'x'.repeat(500), note: 'n'.repeat(500), format: { kind: 'percent', decimals: 99 } }))
    const m = r.value.metrics[0]
    expect(m.aggregate).toBe('mean'); expect(m.format).toEqual({ kind: 'percent', decimals: 6 })
    expect(m.label!.length).toBe(200); expect(m.note!.length).toBe(200)
  })
  it('row count with empty field', () => {
    expect(v('{"data":"s","field":"","aggregate":"count"}').value.metrics[0].field).toBe('')
  })
  it('prototype pollution keys are inert', () => {
    const r = v('{"data":"s","field":"a","aggregate":"sum","__proto__":{"polluted":1},"constructor":{"x":1},"filter":[{"field":"c","op":"=","value":1,"__proto__":{"p":1}}]}')
    expect(({} as any).polluted).toBeUndefined()
    const m = r.value.metrics[0]
    expect(Object.keys(m).sort()).toEqual(['aggregate', 'data', 'field', 'filter'])
    expect(Object.keys(m.filter![0]).sort()).toEqual(['field', 'op', 'value'])
  })
  it('huge string fields drop the candidate', () => {
    expect(p(JSON.stringify([{ data: 's', field: 'a'.repeat(1000), aggregate: 'sum' }])).ok).toBe(false)
  })
  it('failures', () => {
    expect(p('x', { truncated: true })).toEqual({ ok: false, reason: 'truncated' })
    expect(p('  ')).toEqual({ ok: false, reason: 'empty' })
    expect(p('nothing json here')).toEqual({ ok: false, reason: 'unparseable' })
    expect(p('x'.repeat(MAX_OUTPUT_CHARS + 1))).toEqual({ ok: false, reason: 'too-long' })
    expect(p('[]').ok).toBe(false)
  })
  it('QUESTION: → no metrics + question', () => {
    const r = v('QUESTION: Which table?')
    expect(r.value.metrics).toEqual([]); expect(r.value.question).toBe('Which table?')
  })
  it('numbered with selection uses only the first item', () => {
    const r = v('[{"data":"s","field":"a","aggregate":"sum"},{"data":"s","field":"b","aggregate":"sum"}]', { selected: 0, numbered: true })
    expect(r.value.replaced).toBe('one'); expect(r.value.metrics).toHaveLength(1)
  })
})

const tables: LocalTable[] = [{ name: 'Sales', columns: [
  { name: 'amount', kind: 'number' }, { name: 'region', kind: 'text' }, { name: 'day', kind: 'temporal' }, { name: 'ok', kind: 'boolean' },
] }]
const code = (c: MetricCandidate) => checkCandidate(c, tables).problem?.code

describe('checkCandidate', () => {
  it('valid + case-insensitive table', () => { expect(code(cand())).toBeUndefined(); expect(code(cand({ data: 'sales' }))).toBeUndefined() })
  it('NO_TABLE / NO_COLUMN', () => {
    expect(code(cand({ data: 'zz' }))).toBe('NO_TABLE')
    expect(code(cand({ field: 'nope' }))).toBe('NO_COLUMN')
    expect(code(cand({ field: '' }))).toBe('NO_COLUMN')
  })
  it('type rules', () => {
    expect(code(cand({ field: 'region' }))).toBe('TYPE')
    expect(code(cand({ field: 'ok', aggregate: 'max' }))).toBe('TYPE')
    expect(code(cand({ field: 'region', aggregate: 'max' }))).toBeUndefined()
  })
  it('distinct / count / unknown agg', () => {
    expect(code(cand({ field: '', aggregate: 'distinct' }))).toBe('BAD_AGG')
    expect(code(cand({ field: 'region', aggregate: 'distinct' }))).toBeUndefined()
    expect(code(cand({ aggregate: 'stddev' }))).toBe('BAD_AGG')
    expect(code(cand({ field: '', aggregate: 'count' }))).toBeUndefined()
  })
  it('filters', () => {
    const f = (x: any) => code(cand({ filter: [x] }))
    expect(f({ field: 'zz', op: '=', value: 1 })).toBe('BAD_FILTER')
    expect(f({ field: 'amount', op: 'contains', value: '1' })).toBe('BAD_FILTER')
    expect(f({ field: 'amount', op: '=', value: 'x' })).toBe('BAD_FILTER')
    expect(f({ field: 'region', op: 'bogus', value: 'x' })).toBe('BAD_FILTER')
    expect(f({ field: 'region', op: 'in', value: 'x' })).toBe('BAD_FILTER')
    expect(f({ field: 'region', op: 'isNull', value: 'x' })).toBe('BAD_FILTER')
    expect(f({ field: 'ok', op: '>', value: true })).toBe('BAD_FILTER')
    expect(f({ field: 'region', op: 'contains', value: 'e' })).toBeUndefined()
    expect(f({ field: 'amount', op: 'in', value: [1, 2] })).toBeUndefined()
    expect(f({ field: 'amount', op: 'notNull' })).toBeUndefined()
  })
  it('compare', () => {
    expect(code(cand({ compare: { kind: 'mom', dateField: 'region' } }))).toBe('BAD_COMPARE')
    expect(code(cand({ compare: { kind: 'qoq' as 'mom', dateField: 'day' } }))).toBe('BAD_COMPARE')
    expect(code(cand({ compare: { kind: 'mom', dateField: 'nope' } }))).toBe('BAD_COMPARE')
    expect(code(cand({ compare: { kind: 'yoy', dateField: 'day' } }))).toBeUndefined()
  })
})

describe('detectMetricTarget', () => {
  it('detects', () => {
    expect(detectMetricTarget('把第2个改成百分比', 3)).toBe(2)
    expect(detectMetricTarget('make #2 a percent', 3)).toBe(2)
    expect(detectMetricTarget('change metric 2', 3)).toBe(2)
    expect(detectMetricTarget('#5', 3)).toBe('all')
    expect(detectMetricTarget('hello', 3)).toBe('all')
    expect(detectMetricTarget('#0', 3)).toBe('all')
  })
})

describe('candidateToMetric', () => {
  it('omits data/note', () => {
    const m = candidateToMetric(cand({ label: 'L', note: 'n', filter: [{ field: 'region', op: '=', value: 'x' }] }))
    expect(m).toEqual({ field: 'amount', aggregate: 'sum', label: 'L', filter: [{ field: 'region', op: '=', value: 'x' }] })
    expect('data' in m || 'note' in m).toBe(false)
  })
describe('dropped filter entries are flagged', () => {
  const tables: LocalTable[] = [{ name: 'sales', columns: [{ name: 'amount', kind: 'number' }, { name: 'region', kind: 'text' }] }]
  const parse1 = (filter: string) => v(`{"data":"sales","field":"amount","aggregate":"sum","filter":${filter}}`).value.metrics[0]
  it('a malformed entry, a non-list filter, extra entries or bad values set filterDropped', () => {
    for (const f of ['[{"field":"region","op":"=","value":"x"},{"op":"="}]', '"region=x"', '[{"field":"region","op":"in","value":["a",{"x":1}]}]', '[{"field":"region","op":"=","value":{"a":1}}]']) {
      expect(parse1(f).filterDropped, f).toBe(true)
    }
  })
  it('a clean filter is not flagged and the candidate stays checkable', () => {
    const c = parse1('[{"field":"region","op":"=","value":"x"}]')
    expect(c.filterDropped).toBeUndefined()
    expect(checkCandidate(c, tables).problem).toBeUndefined()
  })
  it('a flagged candidate is unapplyable with BAD_FILTER and never reaches the block', () => {
    const c = parse1('[{"field":"region","op":"=","value":"x"},{"op":"="}]')
    expect(checkCandidate(c, tables).problem?.code).toBe('BAD_FILTER')
    expect('filterDropped' in candidateToMetric(c)).toBe(false)
  })
})
})
