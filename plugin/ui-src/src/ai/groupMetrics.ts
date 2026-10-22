// Single entry point for turning metric candidates into big-number definitions: planMetricApply.
// The metrics drawer must use it for BOTH the preview (previewCandidate on each def metric's source
// candidate) and the apply. It canonicalises names to the local schema's spelling, re-runs
// checkCandidate and refuses everything if any candidate is invalid or ambiguous (no partial apply).
// Never pass raw candidates to setBigNumberDef / insertBigNumberAfter.
import { MAX_METRICS } from '../analysis/bigNumberConfig'
import type { BigNumberDef } from '../state/notebookStore'
import { candidateToMetric, checkCandidate, type LocalTable, type MetricCandidate } from './parseMetrics'

export function groupBySource(cands: MetricCandidate[]): BigNumberDef[] {
  const groups = new Map<string, BigNumberDef>()
  for (const c of cands) {
    const key = c.data.toLowerCase()
    let g = groups.get(key)
    if (!g) { g = { data: c.data, metrics: [] }; groups.set(key, g) }
    g.metrics.push(candidateToMetric(c))
  }
  const out: BigNumberDef[] = []
  for (const g of groups.values()) {
    for (let i = 0; i < g.metrics.length; i += MAX_METRICS) out.push({ data: g.data, metrics: g.metrics.slice(i, i + MAX_METRICS) })
  }
  return out
}

const lc = (s: string) => s.toLowerCase()
// exact-case match wins; otherwise a unique case-insensitive match; otherwise undefined (none or ambiguous)
function resolve<T extends { name: string }>(list: T[], name: string): T | undefined {
  const exact = list.find((x) => x.name === name)
  if (exact) return exact
  const ci = list.filter((x) => lc(x.name) === lc(name))
  return ci.length === 1 ? ci[0] : undefined
}

// Rewrites table/column names to the local schema's spelling (the engine is case-sensitive about them).
export function canonicalizeCandidate(c: MetricCandidate, tables: LocalTable[]): MetricCandidate {
  const t = resolve(tables, c.data)
  if (!t) return c
  const col = (n: string) => resolve(t.columns, n)?.name ?? n
  const out: MetricCandidate = { ...c, data: t.name, field: c.field === '' ? '' : col(c.field) }
  if (c.filter) out.filter = c.filter.map((f) => ({ ...f, field: col(f.field) }))
  if (c.compare) out.compare = { ...c.compare, dateField: col(c.compare.dateField) }
  return out
}

export type PlanError = { code: 'empty' | 'mixed-sources' | 'too-many' } | { code: 'invalid' | 'ambiguous'; index: number; text?: string }

function exactNames(c: MetricCandidate, tables: LocalTable[]): boolean {
  const t = tables.find((x) => x.name === c.data)
  if (!t) return false
  const has = (n: string) => t.columns.some((x) => x.name === n)
  return (c.field === '' || has(c.field)) && (c.filter ?? []).every((f) => has(f.field)) && (!c.compare || has(c.compare.dateField))
}

export function planMetricApply(candidates: MetricCandidate[], tables: LocalTable[], mode: 'update' | 'insert'): { defs: BigNumberDef[] } | { error: PlanError } {
  if (candidates.length === 0) return { error: { code: 'empty' } }
  const canon: MetricCandidate[] = []
  for (let index = 0; index < candidates.length; index++) {
    const k = canonicalizeCandidate(candidates[index], tables)
    const r = checkCandidate(k, tables)
    if (r.problem) return { error: { code: 'invalid', index, text: r.problem.text } }
    if (!exactNames(k, tables)) return { error: { code: 'ambiguous', index } }
    canon.push(k)
  }
  const defs = groupBySource(canon)
  if (mode === 'insert') return { defs }
  if (defs.length > 1) return { error: { code: canon.some((c) => lc(c.data) !== lc(canon[0].data)) ? 'mixed-sources' : 'too-many' } }
  return { defs }
}
