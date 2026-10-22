import type { NumberFormat } from '@sqlnb/format'

export const BIG_AGGS = ['sum', 'mean', 'average', 'min', 'max', 'count', 'median', 'first', 'last', 'distinct'] as const
export const NUMERIC_ONLY_AGGS = ['sum', 'mean', 'average', 'median']
const KINDS = ['plain', 'thousands', 'percent']
export const MAX_LABEL = 200

// Controller design: a block has ONE source (`data`) and an optional `metrics` array (max 8). When
// `metrics` is present it is authoritative and `value`/`label`/`format` mirror metrics[0] for
// clients that only know the single-metric form. Without `metrics` the block is one metric.
export const MAX_METRICS = 8
export const FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'notIn', 'contains', 'isNull', 'notNull'] as const
export const MAX_FILTERS = 5
export const MAX_IN_VALUES = 50
const COMPARE_KINDS = ['mom', 'yoy']
export type FilterValue = string | number | boolean
export interface MetricFilter { field: string; op: string; value?: FilterValue | FilterValue[]; [k: string]: unknown }
export interface MetricCompare { kind: string; dateField: string; [k: string]: unknown }
export interface Metric { field: string; aggregate?: string; label?: string; format?: NumberFormat; filter?: MetricFilter[]; compare?: MetricCompare; [k: string]: unknown }
export interface BigNumberConfig {
  data: string
  metrics: Metric[]
  hasMetrics: boolean
  value: { field: string; aggregate?: string }
  label?: string
  format?: NumberFormat
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

export function normalizeFormat(raw: unknown): NumberFormat | null {
  if (!isObj(raw) || typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) return null
  const f: NumberFormat = { kind: raw.kind as NumberFormat['kind'] }
  if (typeof raw.decimals === 'number' && Number.isFinite(raw.decimals)) f.decimals = Math.min(6, Math.max(0, Math.round(raw.decimals)))
  return f
}

const KNOWN = ['field', 'aggregate', 'label', 'format', 'filter', 'compare']

const isScalar = (x: unknown): x is FilterValue => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))

export function normalizeFilters(raw: unknown, warn: string[]): MetricFilter[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) { warn.push('filter'); return undefined }
  const out: MetricFilter[] = []
  for (const item of raw) {
    if (!isObj(item)) { warn.push('filter'); continue }
    if (out.length >= MAX_FILTERS) { warn.push('filter'); continue }
    if (typeof item.field !== 'string' || item.field === '' || typeof item.op !== 'string' || item.op === '') { warn.push('filter'); continue }
    const f: MetricFilter = { ...item, field: item.field, op: item.op }
    if (item.value !== undefined) {
      if (Array.isArray(item.value)) {
        const vals = item.value.filter(isScalar)
        if (vals.length !== item.value.length || vals.length > MAX_IN_VALUES) warn.push('filter')
        f.value = vals.slice(0, MAX_IN_VALUES)
      } else if (isScalar(item.value)) f.value = item.value
      else { warn.push('filter'); delete f.value }
    }
    out.push(f)
  }
  return out.length > 0 ? out : undefined
}

export function normalizeCompare(raw: unknown, warn: string[]): MetricCompare | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw) || typeof raw.kind !== 'string' || typeof raw.dateField !== 'string' || raw.dateField === '') { warn.push('compare'); return undefined }
  return { ...raw, kind: raw.kind, dateField: raw.dateField }
}

function normalizeMetric(raw: Record<string, unknown>, w: string[], keepExtras: boolean): Metric {
  const out: Metric = { field: '' }
  if (keepExtras) for (const k of Object.keys(raw)) if (!KNOWN.includes(k)) out[k] = raw[k]
  if (typeof raw.field === 'string') out.field = raw.field
  else if (raw.field !== undefined) w.push('field')
  if (raw.aggregate !== undefined) {
    if (typeof raw.aggregate === 'string') out.aggregate = raw.aggregate
    else { out.aggregate = 'count'; w.push('aggregate') }
  }
  if (raw.label !== undefined) {
    if (typeof raw.label === 'string') {
      out.label = raw.label.slice(0, MAX_LABEL)
      if (raw.label.length > MAX_LABEL) w.push('label')
    } else w.push('label')
  }
  if (raw.format !== undefined) {
    const f = normalizeFormat(raw.format)
    if (f) {
      out.format = f
      if (JSON.stringify(f) !== JSON.stringify(raw.format)) w.push('format')
    } else w.push('format')
  }
  if (keepExtras) {
    const filter = normalizeFilters(raw.filter, w)
    if (filter) out.filter = filter
    const compare = normalizeCompare(raw.compare, w)
    if (compare) out.compare = compare
  }
  return out
}

export function normalizeBigNumber(meta: unknown): BigNumberConfig & { warnings: string[] } {
  const m = isObj(meta) ? meta : {}
  const w: string[] = []
  const data = typeof m.data === 'string' ? m.data : ''
  if (m.data !== undefined && typeof m.data !== 'string') w.push('data')
  if (m.value !== undefined && !isObj(m.value)) w.push('value')
  const v = isObj(m.value) ? m.value : {}
  const legacy = normalizeMetric({ ...v, label: m.label, format: m.format }, w, false)
  let metrics: Metric[] | null = null
  if (m.metrics !== undefined) {
    if (Array.isArray(m.metrics)) {
      const list: Metric[] = []
      for (const item of m.metrics) {
        if (!isObj(item)) { w.push('metrics'); continue }
        if (list.length >= MAX_METRICS) { w.push('metrics'); continue }
        list.push(normalizeMetric(item, w, true))
      }
      if (list.length > 0) metrics = list
      else w.push('metrics')
    } else w.push('metrics')
  }
  const first = metrics ? metrics[0] : legacy
  const out: BigNumberConfig & { warnings: string[] } = {
    data, metrics: metrics ?? [legacy], hasMetrics: metrics !== null,
    value: { field: first.field }, warnings: w,
  }
  if (first.aggregate !== undefined) out.value.aggregate = first.aggregate
  if (first.label !== undefined) out.label = first.label
  if (first.format !== undefined) out.format = first.format
  return out
}

export const isKnownAggregate = (a: unknown): boolean => typeof a === 'string' && (BIG_AGGS as readonly string[]).includes(a)
export const isKnownOp = (o: unknown): boolean => typeof o === 'string' && (FILTER_OPS as readonly string[]).includes(o)
export const isKnownCompare = (k: unknown): boolean => typeof k === 'string' && COMPARE_KINDS.includes(k)
