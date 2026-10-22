import { normalizeAnalysis } from '@sqlnb/format'
import { isBalancedSql } from './sqlSafety'
import type { PivotConfig, ChartOptions, View } from '@sqlnb/format'

export type ParseFailure = 'empty' | 'truncated' | 'unparseable' | 'too-long' | 'incomplete'
export type Parsed<T> = { ok: true; value: T; warnings: string[] } | { ok: false; reason: ParseFailure }

export const MAX_OUTPUT_CHARS = 20_000
const MAX_LABEL = 120
const MAX_DEPTH = 32
const MAX_CANDIDATES = 3
const MAX_SUMMARY = 200

const fail = (reason: ParseFailure): { ok: false; reason: ParseFailure } => ({ ok: false, reason })

const FENCE_TAG = /^(?:[a-z0-9]*sql[a-z0-9]*|)$/i
const SQL_START = /^\s*(?:select|insert|update|delete|merge|create|drop|alter|truncate|replace|explain|pragma|values|attach|with\s+(?:recursive\s+)?[\w"`\[\]]+\s*(?:\([^)]*\)\s*)?as\b)(?![\w])/i
const EXPLAIN_MARK = /^\s*(?:why|explanation|note|notes|reason|说明|解释|原因|理由|注)\s*[:：]/i

// Index just after the first top-level ';' (outside quotes and comments), or -1.
function firstSemicolonEnd(sql: string): number {
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++ }
    else if (c === '/' && sql[i + 1] === '*') { i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2 }
    else if (c === "'" || c === '"' || c === '`') { i++; while (i < n && sql[i] !== c) i++; i++ }
    else if (c === ';') return i + 1
    else i++
  }
  return -1
}

function parseFenced(src: string): Parsed<{ sql: string; explanation?: string }> | null {
  const openRe = /^[ \t]*```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\n/gm
  let open: RegExpExecArray | null
  while ((open = openRe.exec(src)) && !FENCE_TAG.test(open[1])) { /* skip non-sql fences */ }
  if (!open) return /^[ \t]*```/m.test(src) ? fail('unparseable') : null
  const bodyStart = open.index + open[0].length
  const closeRe = /^[ \t]*```[^\n]*$/gm
  closeRe.lastIndex = bodyStart
  const close = closeRe.exec(src)
  if (!close) return fail('truncated')
  const sql = src.slice(bodyStart, close.index).trim()
  if (sql === '') return fail('empty')
  if (!isBalancedSql(sql)) return fail('truncated')
  const rest = src.slice(close.index + close[0].length)
  const tail = close[0].replace(/^[ \t]*```[ \t]*/, '')
  const warnings: string[] = []
  if (/^[ \t]*```[ \t]*[A-Za-z0-9_+-]*sql[A-Za-z0-9_+-]*[ \t]*\n/im.test(rest)) warnings.push('multiple sql blocks: only the first is used')
  const explanation = (src.slice(0, open.index) + '\n' + tail + '\n' + rest.replace(/^[ \t]*```[ \t]*[A-Za-z0-9_+-]*sql[A-Za-z0-9_+-]*[ \t]*\n[\s\S]*?(^[ \t]*```[^\n]*$|$(?![\s\S]))/gim, '')).trim()
  return { ok: true, value: explanation ? { sql, explanation } : { sql }, warnings }
}

function parseBare(input: string): Parsed<{ sql: string; explanation?: string }> {
  let src = input.trim()
  const tagged = /^<sql>\s*([\s\S]*?)\s*<\/sql>([\s\S]*)$/i.exec(src)
  if (tagged) src = (tagged[1] + '\n' + tagged[2].trim()).trim()
  src = src.replace(/^sql[ \t]*\n/i, '')
  if (src.includes('```')) return fail('unparseable')
  const lines = src.split('\n')
  const start = lines.findIndex((l) => SQL_START.test(l))
  if (start < 0) return fail('unparseable')
  const pre = lines.slice(0, start)
  if (pre.length) {
    const last = pre[pre.length - 1].trim()
    if (pre.length > 4 || !(last === '' || /[:：]$/.test(last))) return fail('unparseable')
    if (pre.some((l) => SQL_START.test(l))) return fail('unparseable')
  }
  let body = lines.slice(start).join('\n')
  let after = ''
  const m = /^[ \t]*(?:why|explanation|note|notes|reason|说明|解释|原因|理由|注)[ \t]*[:：]/im.exec(body)
  if (m && EXPLAIN_MARK.test(body.slice(m.index))) { after = body.slice(m.index); body = body.slice(0, m.index) }
  else {
    const semi = firstSemicolonEnd(body)
    if (semi > 0) {
      const tail = body.slice(semi)
      const next = tail.split('\n').find((l) => l.trim() !== '')
      if (next !== undefined && !SQL_START.test(next) && !/^\s*(?:--|\/\*)/.test(next)) { after = tail; body = body.slice(0, semi) }
    }
  }
  const sql = body.trim()
  if (sql === '') return fail('empty')
  if (!isBalancedSql(sql)) return fail('truncated')
  const explanation = (pre.join('\n') + '\n' + after).trim()
  return { ok: true, value: explanation ? { sql, explanation } : { sql }, warnings: [] }
}

export function parseSqlOutput(text: string, opts: { truncated: boolean }): Parsed<{ sql: string; explanation?: string }> {
  if (opts.truncated) return fail('truncated')
  if (text.trim() === '') return fail('empty')
  if (text.length > MAX_OUTPUT_CHARS) return fail('too-long')
  const src = text.replace(/\r\n?/g, '\n')
  return parseFenced(src) ?? parseBare(src)
}

export interface ChartConfig { data?: never; pivot: PivotConfig; view?: View; chartOptions: ChartOptions }
export interface ChartCandidate { title: string; summary?: string; config: ChartConfig }

function balancedEnd(src: string, start: number): number | 'deep' | -1 {
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') {
      if (++depth > MAX_DEPTH) return 'deep'
    } else if (c === '}' || c === ']') {
      if (--depth === 0) return i
    }
  }
  return -1
}

function tryStarts(src: string, objectOnly: boolean): Json {
  let truncated = false
  let attempts = 0
  for (let i = 0; i < src.length && attempts < 50; i++) {
    if (src[i] !== '{' && src[i] !== '[') continue
    attempts++
    const end = balancedEnd(src, i)
    if (end === 'deep') return fail('unparseable')
    if (end < 0) { truncated = true; continue }
    try {
      const value = JSON.parse(src.slice(i, end + 1))
      if (!objectOnly || isObj(value)) return { ok: true, value }
    } catch { /* try next start */ }
  }
  return fail(truncated ? 'truncated' : 'unparseable')
}

type Json = { ok: true; value: unknown } | { ok: false; reason: ParseFailure }

export function extractJson(text: string, objectOnly = false): Json {
  if (text.trim() === '') return fail('empty')
  if (text.length > MAX_OUTPUT_CHARS) return fail('too-long')
  const src = text.replace(/\r\n?/g, '\n')
  let body: string
  const fenceOpen = /```[ \t]*(?:json)?[ \t]*\n/i.exec(src)
  if (fenceOpen) {
    const s = fenceOpen.index + fenceOpen[0].length
    const e = src.indexOf('```', s)
    if (e < 0) return fail('truncated')
    body = src.slice(s, e)
  } else {
    return tryStarts(src, objectOnly)
  }
  let depth = 0, inStr = false, esc = false
  for (const c of body) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') { if (++depth > MAX_DEPTH) return fail('unparseable') }
    else if (c === '}' || c === ']') depth--
  }
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return fail('unparseable')
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function buildConfig(raw: unknown, columns: string[], warnings: string[]): ChartConfig | null {
  if (!isObj(raw)) return null
  // Documented shape: rows/columns/values (+ optional totals/sort/view) at the top level next to chartOptions.
  // A nested `pivot` object is also accepted.
  const shaped = isObj(raw.pivot) ? raw : { ...raw, pivot: { rows: raw.rows, columns: raw.columns, values: raw.values, totals: raw.totals, sort: raw.sort } }
  const n = normalizeAnalysis(shaped)
  warnings.push(...n.warnings)
  if (!n.pivot) return null
  const have = new Set(columns)
  const keep = <T extends { field: string }>(items: T[], label: string): T[] =>
    items.filter((it) => {
      if (have.has(it.field)) return true
      warnings.push(`${label}: unknown column "${it.field}" dropped`)
      return false
    })
  const p = n.pivot
  const values = p.values.filter((v) => {
    if (v.field === '' && v.agg === 'count') return true
    if (have.has(v.field)) return true
    warnings.push(`values: unknown column "${v.field}" dropped`)
    return false
  }).map((v) => (v.label !== undefined && v.label.length > MAX_LABEL ? { ...v, label: v.label.slice(0, MAX_LABEL) } : v))
  if (values.length === 0) return null
  const pivot: PivotConfig = { ...p, rows: keep(p.rows, 'rows'), columns: keep(p.columns, 'columns'), values }
  if (values.length !== p.values.length && pivot.sort?.by === 'value') pivot.sort = null
  const chartOptions: ChartOptions = { ...n.chart }
  if (chartOptions.title !== undefined) chartOptions.title = chartOptions.title.slice(0, MAX_LABEL)
  return { pivot, view: n.view, chartOptions }
}

/** True when every column the config names exists in `columns` (same rule buildConfig applies to a fresh reply). */
export function chartConfigColumnsValid(cfg: ChartConfig, columns: string[]): boolean {
  const have = new Set(columns)
  const p = cfg.pivot
  return p.rows.every((r) => have.has(r.field)) && p.columns.every((c) => have.has(c.field)) && p.values.length > 0
    && p.values.every((v) => (v.field === '' && v.agg === 'count') || have.has(v.field))
}

function candidateOf(it: unknown, config: ChartConfig): ChartCandidate {
  const o = isObj(it) ? (it as any) : {}
  const title = typeof o.title === 'string' ? (o.title as string).slice(0, MAX_LABEL) : ''
  const summary = typeof o.summary === 'string' ? o.summary.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, MAX_SUMMARY) : ''
  return summary ? { title, summary, config } : { title, config }
}

export function parseInterpretation(text: string, opts: { truncated: boolean }): Parsed<{ markdown: string }> {
  if (opts.truncated) return fail('truncated')
  const md = text.trim()
  if (md === '') return fail('empty')
  if (md.length > MAX_OUTPUT_CHARS) return fail('too-long')
  return { ok: true, value: { markdown: md }, warnings: [] }
}

export type ChartReply = { schemes: ChartCandidate[]; replaced: 'one' | 'all'; index?: number; question?: string }

const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
const NUM = '(?:\\d+|[一二两三四五])'
const SEP = '(?:和|与|及|,|，|、|and|or|&|/)'
const SCHEME_REF = new RegExp(`(?:方案|schemes?|options?)\\s*#?\\s*(${NUM})((?:\\s*${SEP}\\s*(?:方案|schemes?|options?)?\\s*#?\\s*${NUM})*)(?![\\w.])`, 'gi')
const ORDINAL_REF = new RegExp(`第\\s*(${NUM})\\s*(?:个|种|套|张|版)`, 'g')
const HASH_REF = /(?<![\w#])#\s*(\d+)(?![\w])/g
const HASH_CONTEXT = /scheme|option|方案|图|chart/i
const toNum = (x: string): number => ZH_NUM[x] ?? Number(x)

export function detectSchemeTarget(text: string): 'all' | 1 | 2 | 3 {
  const found = new Set<number>()
  let m: RegExpExecArray | null
  for (m of text.matchAll(SCHEME_REF)) {
    found.add(toNum(m[1]))
    for (const x of m[2].match(new RegExp(NUM, 'g')) ?? []) found.add(toNum(x))
  }
  for (m of text.matchAll(ORDINAL_REF)) found.add(toNum(m[1]))
  for (m of text.matchAll(HASH_REF)) {
    const i = m.index ?? 0
    if (HASH_CONTEXT.test(text.slice(Math.max(0, i - 12), i + m[0].length + 12))) found.add(Number(m[1]))
  }
  if (found.size !== 1) return 'all'
  const n = [...found][0]
  return n === 1 || n === 2 || n === 3 ? n : 'all'
}

const MAX_QUESTION = 2000
const CHART_QUESTION = /^[\s*`]*(?:question|ask|问题|反问)[\s*`]*[:：][\s*`]*/i

export function parseChartReply(
  text: string,
  ctx: { columns: string[]; truncated: boolean; current: ChartCandidate[]; selected: number | null; numbered?: boolean },
): Parsed<ChartReply> {
  if (ctx.truncated) return fail('truncated')
  if (text.trim() === '') return fail('empty')
  const trimmed = text.trim()
  const q = CHART_QUESTION.exec(trimmed)
  const qText = q ? trimmed.slice(q[0].length).trim().slice(0, MAX_QUESTION) : undefined
  const asQuestion = (warnings: string[]): Parsed<ChartReply> => ({ ok: true, value: { schemes: [], replaced: 'all', question: qText }, warnings })
  if (q && !/^[ \t]*```/m.test(trimmed)) return qText ? asQuestion([]) : fail('empty')
  const j = extractJson(text)
  if (!j.ok) return qText && j.reason === 'unparseable' ? asQuestion([]) : j
  const items = Array.isArray(j.value) ? j.value : [j.value]
  const warnings: string[] = []
  const sel = ctx.selected !== null && ctx.selected >= 0 && ctx.selected < ctx.current.length ? ctx.selected : null
  const out: ChartCandidate[] = []
  const useItems = sel !== null && ctx.numbered ? items.slice(0, 1) : items
  for (const it of useItems) {
    const config = buildConfig(it, ctx.columns, warnings)
    if (!config) { warnings.push('candidate dropped: invalid'); continue }
    out.push(candidateOf(it, config))
  }
  if (out.length === 0) return qText ? asQuestion(warnings) : fail('unparseable')
  const qv = qText ? { question: qText } : {}
  const isSet = items.length >= 2
  // One-versus-set is decided by the reply's shape (items it contained), never by how many survive validation.
  if (sel !== null && isSet && !ctx.numbered && out.length < 2) return fail('incomplete')
  if (isSet && out.length < items.length && sel === null) warnings.push(`only ${out.length} of ${items.length} schemes were valid`)
  if (sel !== null && (!isSet || ctx.numbered)) {
    if (items.length > 1) warnings.push(`scheme ${sel + 1}: reply had ${items.length} configurations, only the first is used`)
    const schemes = ctx.current.slice()
    schemes[sel] = out[0]
    return { ok: true, value: { schemes, replaced: 'one', index: sel, ...qv }, warnings }
  }
  if (out.length > MAX_CANDIDATES) warnings.push(`${out.length} candidates: only the first ${MAX_CANDIDATES} are used`)
  return { ok: true, value: { schemes: out.slice(0, MAX_CANDIDATES), replaced: 'all', ...qv }, warnings }
}
