import { extractJson, type Parsed } from './parse'
import {
  BIG_AGGS, FILTER_OPS, MAX_FILTERS, MAX_IN_VALUES, MAX_LABEL, NUMERIC_ONLY_AGGS,
  normalizeFormat, isKnownCompare,
  type FilterValue, type Metric, type MetricFilter,
} from '../analysis/bigNumberConfig'

export const MAX_CANDIDATES = 12
const MAX_NOTE = 200
const MAX_NAME = 200
const MAX_QUESTION = 2000

export interface LocalTable { name: string; columns: { name: string; kind: 'number' | 'text' | 'boolean' | 'temporal' | string }[] }
export interface MetricCandidate {
  data: string; field: string; aggregate: string; label?: string
  format?: { kind: 'plain' | 'thousands' | 'percent'; decimals?: number }
  filter?: MetricFilter[]
  compare?: { kind: 'mom' | 'yoy'; dateField: string }
  note?: string
  /** The parser dropped part of the model's filter: the candidate no longer means what the model proposed. */
  filterDropped?: true
}
export type MetricProblem = 'NO_TABLE' | 'NO_COLUMN' | 'BAD_AGG' | 'TYPE' | 'BAD_FILTER' | 'BAD_COMPARE'
export interface CheckedCandidate { cand: MetricCandidate; problem?: { code: MetricProblem; text: string } }
export type MetricsReply = { metrics: MetricCandidate[]; replaced: 'one' | 'all'; index?: number; question?: string }

const fail = (reason: 'empty' | 'truncated' | 'unparseable' | 'too-long' | 'incomplete'): { ok: false; reason: typeof reason } => ({ ok: false, reason })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isScalar = (x: unknown): x is FilterValue => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()

function buildFilters(raw: unknown, w: string[]): MetricFilter[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) { w.push('filter dropped: not a list'); return undefined }
  const out: MetricFilter[] = []
  for (const it of raw) {
    if (!isObj(it) || typeof it.field !== 'string' || it.field === '' || it.field.length > MAX_NAME || typeof it.op !== 'string' || it.op === '') { w.push('filter entry dropped: invalid'); continue }
    if (out.length >= MAX_FILTERS) { w.push(`filters: only the first ${MAX_FILTERS} are used`); break }
    const f: MetricFilter = { field: it.field, op: it.op }
    const val = it.value
    if (Array.isArray(val)) {
      const vals = val.filter(isScalar)
      if (vals.length !== val.length) w.push('filter values: invalid entries dropped')
      if (vals.length > MAX_IN_VALUES) w.push(`filter values: only the first ${MAX_IN_VALUES} are used`)
      f.value = vals.slice(0, MAX_IN_VALUES) as FilterValue[]
    } else if (isScalar(val)) {
      f.value = typeof val === 'string' ? val.slice(0, 1000) : val
    } else if (val !== undefined) w.push('filter value dropped: invalid')
    out.push(f)
  }
  return out.length ? out : undefined
}

function buildCandidate(raw: unknown, w: string[]): MetricCandidate | null {
  if (!isObj(raw)) return null
  const { data, field, aggregate } = raw
  if (typeof data !== 'string' || data === '' || data.length > MAX_NAME) return null
  if (typeof aggregate !== 'string' || aggregate === '' || aggregate.length > MAX_NAME) return null
  if (field !== undefined && (typeof field !== 'string' || field.length > MAX_NAME)) return null
  const c: MetricCandidate = { data, field: (field as string | undefined) ?? '', aggregate: aggregate === 'average' ? 'mean' : aggregate }
  if (typeof raw.label === 'string') { const l = clean(raw.label).slice(0, MAX_LABEL); if (l) c.label = l } else if (raw.label !== undefined) w.push('label dropped: invalid')
  if (raw.format !== undefined) {
    const f = normalizeFormat(raw.format)
    if (f) c.format = f as MetricCandidate['format']; else w.push('format dropped: invalid')
  }
  const before = w.length
  const filter = buildFilters(raw.filter, w)
  if (filter) c.filter = filter
  if (w.length > before) c.filterDropped = true
  if (raw.compare !== undefined) {
    const k = raw.compare
    if (isObj(k) && typeof k.kind === 'string' && typeof k.dateField === 'string' && k.dateField !== '' && k.dateField.length <= MAX_NAME) {
      c.compare = { kind: k.kind.toLowerCase() as 'mom' | 'yoy', dateField: k.dateField }
    } else w.push('compare dropped: invalid')
  }
  if (typeof raw.note === 'string') { const n = clean(raw.note).slice(0, MAX_NOTE); if (n) c.note = n } else if (raw.note !== undefined) w.push('note dropped: invalid')
  return c
}

const QUESTION = /^[\s*`]*(?:question|ask|问题|反问)[\s*`]*[:：][\s*`]*/i

export function parseMetricsReply(text: string, ctx: { truncated: boolean; selected: number | null; numbered?: boolean }): Parsed<MetricsReply> {
  if (ctx.truncated) return fail('truncated')
  if (text.trim() === '') return fail('empty')
  const trimmed = text.trim()
  const q = QUESTION.exec(trimmed)
  const qText = q ? trimmed.slice(q[0].length).trim().slice(0, MAX_QUESTION) : undefined
  const asQuestion = (warnings: string[]): Parsed<MetricsReply> => ({ ok: true, value: { metrics: [], replaced: 'all', question: qText }, warnings })
  if (q && !/^[ \t]*```/m.test(trimmed)) return qText ? asQuestion([]) : fail('empty')
  const j = extractJson(text)
  if (!j.ok) return qText && j.reason === 'unparseable' ? asQuestion([]) : j
  const warnings: string[] = []
  let items: unknown[]
  let replyQuestion: string | undefined
  if (isObj(j.value) && Array.isArray(j.value.metrics)) {
    items = j.value.metrics
    if (typeof j.value.question === 'string') replyQuestion = clean(j.value.question).slice(0, MAX_QUESTION) || undefined
  } else items = Array.isArray(j.value) ? j.value : [j.value]
  const question = qText ?? replyQuestion
  const qv = question ? { question } : {}
  const sel = ctx.selected !== null && ctx.selected >= 0 ? ctx.selected : null
  const used = sel !== null && ctx.numbered ? items.slice(0, 1) : items
  const out: MetricCandidate[] = []
  for (const it of used) {
    const c = buildCandidate(it, warnings)
    if (!c) { warnings.push('candidate dropped: invalid'); continue }
    out.push(c)
  }
  if (out.length === 0) return question ? { ok: true, value: { metrics: [], replaced: 'all', ...qv }, warnings } : fail('unparseable')
  if (out.length > MAX_CANDIDATES) warnings.push(`${out.length} candidates: only the first ${MAX_CANDIDATES} are used`)
  const metrics = out.slice(0, MAX_CANDIDATES)
  if (sel !== null && (items.length === 1 || ctx.numbered)) {
    if (items.length > 1) warnings.push('reply had several metrics, only the first is used')
    return { ok: true, value: { metrics: metrics.slice(0, 1), replaced: 'one', index: sel, ...qv }, warnings }
  }
  return { ok: true, value: { metrics, replaced: 'all', ...qv }, warnings }
}

const has = (list: readonly string[], x: string): boolean => list.includes(x)

export function checkCandidate(c: MetricCandidate, tables: LocalTable[]): CheckedCandidate {
  const bad = (code: MetricProblem, text: string): CheckedCandidate => ({ cand: c, problem: { code, text } })
  const lc = (s: string) => String(s).toLowerCase()
  const table = tables.find((t) => lc(t.name) === lc(c.data))
  if (!table) return bad('NO_TABLE', `Unknown table: ${String(c.data).slice(0, 64)}`)
  const col = (name: unknown) => (typeof name === 'string' ? table.columns.find((x) => lc(x.name) === lc(name)) : undefined)
  const agg = c.aggregate
  if (typeof agg !== 'string' || !has(BIG_AGGS, agg)) return bad('BAD_AGG', `Unsupported aggregate: ${String(agg).slice(0, 32)}`)
  if (agg === 'distinct' && c.field === '') return bad('BAD_AGG', 'distinct needs a field')
  if (!(agg === 'count' && c.field === '')) {
    const fc = col(c.field)
    if (!fc) return bad('NO_COLUMN', `Unknown column: ${String(c.field).slice(0, 64)}`)
    if (has(NUMERIC_ONLY_AGGS, agg) && fc.kind !== 'number') return bad('TYPE', `${agg} requires a numeric column`)
    if ((agg === 'min' || agg === 'max') && fc.kind === 'boolean') return bad('TYPE', `${agg} requires a number, date or text column`)
  }
  if (c.filterDropped) return bad('BAD_FILTER', 'Part of the filter was invalid and dropped')
  if (c.filter !== undefined) {
    if (!Array.isArray(c.filter) || c.filter.length > MAX_FILTERS) return bad('BAD_FILTER', 'Too many filters')
    for (const f of c.filter) {
      const fc = col(f?.field)
      const name = String(f?.field).slice(0, 64)
      if (!fc) return bad('BAD_FILTER', `Unknown filter column: ${name}`)
      const op = f.op
      if (typeof op !== 'string' || !has(FILTER_OPS, op)) return bad('BAD_FILTER', `Unsupported filter operator on ${name}`)
      const okOne = (v: unknown) => (fc.kind === 'number' ? typeof v === 'number' : fc.kind === 'boolean' ? typeof v === 'boolean' : typeof v === 'string')
      const mismatch = bad('BAD_FILTER', `Filter value does not match the type of ${name}`)
      if (op === 'isNull' || op === 'notNull') { if (f.value !== undefined) return bad('BAD_FILTER', `${op} takes no value`) }
      else if (op === 'in' || op === 'notIn') {
        if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > MAX_IN_VALUES) return bad('BAD_FILTER', `${op} needs 1 to ${MAX_IN_VALUES} values`)
        if (!f.value.every(okOne)) return mismatch
      } else if (op === 'contains') {
        if (fc.kind !== 'text') return bad('BAD_FILTER', `contains requires a text column: ${name}`)
        if (typeof f.value !== 'string' || f.value === '') return mismatch
      } else {
        if (fc.kind === 'boolean' && op !== '=' && op !== '!=') return bad('BAD_FILTER', `${op} is not valid for boolean column ${name}`)
        if (Array.isArray(f.value) || !okOne(f.value)) return mismatch
      }
    }
  }
  if (c.compare !== undefined) {
    if (!isKnownCompare(c.compare?.kind)) return bad('BAD_COMPARE', `Unsupported comparison: ${String(c.compare?.kind).slice(0, 32)}`)
    const dc = col(c.compare.dateField)
    if (!dc) return bad('BAD_COMPARE', `Unknown date column: ${String(c.compare.dateField).slice(0, 64)}`)
    if (dc.kind !== 'temporal') return bad('BAD_COMPARE', `Comparison requires a date column: ${dc.name}`)
  }
  return { cand: c }
}

const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const NUM = '(?:\\d+|[一二两三四五六七八九十])'
const toNum = (x: string): number => ZH_NUM[x] ?? Number(x)
const REFS = [
  new RegExp(`(?<![\\w#])#\\s*(${NUM})(?![\\w])`, 'g'),
  new RegExp(`第\\s*(${NUM})\\s*(?:个|项|条|张|块)`, 'g'),
  new RegExp(`(?:metrics?|指标)\\s*#?\\s*(${NUM})(?![\\w.])`, 'gi'),
]

export function detectMetricTarget(text: string, count: number): 'all' | number {
  const found = new Set<number>()
  for (const re of REFS) for (const m of text.matchAll(re)) found.add(toNum(m[1]))
  if (found.size !== 1) return 'all'
  const n = [...found][0]
  return Number.isInteger(n) && n >= 1 && n <= count ? n : 'all'
}

export function candidateToMetric(c: MetricCandidate): Metric {
  const m: Metric = { field: c.field, aggregate: c.aggregate }
  if (c.label !== undefined) m.label = c.label
  if (c.format !== undefined) m.format = { ...c.format }
  if (c.filter !== undefined) m.filter = c.filter.map((f) => ({ ...f }))
  if (c.compare !== undefined) m.compare = { ...c.compare }
  return m
}
