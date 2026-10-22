import type { AiSendOptions } from './aiSettings'
import type { TableSchema, ResultSummary } from './context'
import type { ChatMessage } from './chatTypes'
import { MAX_REQUEST_CHARS } from './aiClient'
import { INTERPRET_MARKERS } from './parseInterpret'
import { NEED_MARKERS } from './parseNeed'
import { BIG_AGGS, FILTER_OPS, type Metric } from '../analysis/bigNumberConfig'
import type { MetricCandidate } from './parseMetrics'
import { esc, head, fitToLimit, chartFormat, type AiLocale, type BuiltPrompt, type PromptInput, type PromptParts, type TableListPart } from './prompt'

export const MAX_USER_CHARS = 2000

export const SQL_REPLY_FORMAT =
  'Start the answer with the SQL statement itself: output only the SQL as plain text (it may span several lines; optionally wrapped in one ```sql fence), with no text before it. Then, optionally, one short line starting with "Why: " explaining it. If you need clarification instead, reply with exactly one line beginning "QUESTION: " and NO SQL. Keep the whole answer under 2048 tokens.'

export const NEED_FORMAT_NOTE = `If you need the table list of a schema/database of the current connection, reply with a line ${NEED_MARKERS.list} <schema name> (empty = the current one). If you need the structure of tables, reply with a line ${NEED_MARKERS.tables} a, b (at most 8 names). Reply with ONLY those lines and no SQL; the data is then added and you are asked again automatically.`

const INTERPRET_FORMAT = `Return concise Markdown (headings and bullet points allowed, no HTML). Every reply must start with ${INTERPRET_MARKERS.answer} or ${INTERPRET_MARKERS.update}. Use ${INTERPRET_MARKERS.answer} to answer the user without changing the interpretation (an ${INTERPRET_MARKERS.answer} reply must not repeat the interpretation). Use ${INTERPRET_MARKERS.update} followed by the full revised Markdown interpretation whenever the user asks to change, shorten, extend, redo, regenerate, apply something to the interpretation itself, or writes in Chinese phrases such as 重新解读 / 重新生成 / 重做 (there is no Regenerate button, so these requests must be answered with ${INTERPRET_MARKERS.update}). A reply without a marker is treated as ${INTERPRET_MARKERS.answer} and will not change the interpretation. Keep the whole answer under 2048 tokens.`
const INTERPRET_FORCE_FORMAT = `Return concise Markdown (headings and bullet points allowed, no HTML). Start the reply with ${INTERPRET_MARKERS.update} followed by the full Markdown interpretation. Keep the whole answer under 2048 tokens.`

export const MAX_SAMPLE_ROWS = 5
const MAX_NAME_CHARS = 128

export interface MetricsPromptTable { name: string; columns: { name: string; dataType?: string }[]; sample?: ResultSummary }

export interface ChatPromptInput {
  locale: AiLocale; dialect: string; send: AiSendOptions
  purpose: 'sql' | 'interpret' | 'chart' | 'bignumber'
  baseline?: string
  draft?: string
  schemas: TableSchema[]; result?: ResultSummary
  tableList?: TableListPart
  chart?: PromptParts['chart']
  /** 1-based index of the selected scheme; the chart's current content is then that scheme only. */
  chartSelected?: number
  /** Local result tables (columns/types only while the schema switch is on; `sample` only with the data switch too). */
  metricTables?: MetricsPromptTable[]
  /** Structured definition only, never values. */
  metricCurrent?: { candidate: MetricCandidate | null; block: { data: string; metrics: Metric[] } | null }
  /** 1-based index of the selected candidate; the reply must then be ONE object. */
  metricSelected?: number
  history: ChatMessage[]
  userText: string
  forceUpdate?: boolean
  /** The drawer can answer NEED_ lines (only honored when send.schema is on). */
  catalogNeed?: boolean
  /** Notes about catalog data that could not be read (names already sanitized). */
  notes?: string[]
}

export interface BuiltChatPrompt extends BuiltPrompt {
  omittedTurns: number; dataPartsDropped: boolean
  /** Catalog data the prompt was given (names only): the reply may quote it, so it must be masked later when schema is off. */
  usedCatalog: { list: boolean; tables: string[] }
  /** The big-number section carried sample rows or column statistics (cell-derived data). */
  metricsData?: boolean
}

export const OMITTED_REPLY = '[earlier reply omitted]'

// a reply with metricsAfter and no explicit flag predates the flag (or its writer forgot it): treat it as built from samples
const sampled = (m: ChatMessage): boolean => m.metricsSampled === true || (m.metricsAfter !== undefined && m.metricsSampled === undefined)

export function filterHistory(history: ChatMessage[], send: AiSendOptions): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of history) {
    let parts = send.data ? m.parts : m.parts.filter((p) => p.kind !== 'data')
    // an assistant reply's text can carry the SQL / interpretation / chart config it produced: treat it as that content
    const derived = m.role === 'assistant' && ((!send.schema && m.catalog !== undefined) || (!send.sql && m.sqlAfter !== undefined) || (!send.data && (m.markdownAfter !== undefined || m.chartAfter !== undefined)) || (!send.schema && (m.metricsAfter !== undefined || m.metricsSchema === true)) || (!send.data && sampled(m)))
    if (derived && parts.some((p) => p.kind === 'text')) parts = [{ kind: 'text', text: OMITTED_REPLY }]
    const sqlAfter = send.sql ? m.sqlAfter : undefined
    const markdownAfter = send.data ? m.markdownAfter : undefined
    const chartAfter = send.data ? m.chartAfter : undefined
    const metricsAfter = (send.schema || m.metricsAfter === undefined) && (send.data || !sampled(m)) ? m.metricsAfter : undefined
    if (parts.length === 0 && sqlAfter === undefined && markdownAfter === undefined && chartAfter === undefined && metricsAfter === undefined) continue
    const c: ChatMessage = { ...m, parts }
    if (!send.schema) delete c.catalog
    if (chartAfter === undefined) delete c.chartAfter
    if (sqlAfter === undefined) delete c.sqlAfter
    if (markdownAfter === undefined) delete c.markdownAfter
    if (metricsAfter === undefined) delete c.metricsAfter
    if (!send.schema) delete c.metricsSchema
    if (!send.data) delete c.metricsSampled
    out.push(c)
  }
  return out
}

// table names may come from the user's SQL: they are listed only while SQL is sent too
function renderHistory(msgs: ChatMessage[], withNames: boolean): string {
  const lines = msgs.map((m) => {
    const text = m.parts.map((p) => p.text).join('\n')
    const after = m.sqlAfter !== undefined ? `\n[SQL AFTER THIS TURN]\n${m.sqlAfter}` : ''
    const md = m.markdownAfter !== undefined ? `\n[INTERPRETATION AFTER THIS TURN]\n${m.markdownAfter}` : ''
    const mx = m.metricsAfter !== undefined ? `\n[METRICS AFTER THIS TURN]\n${m.metricsAfter}` : ''
    const cat = m.catalog && (m.catalog.list || m.catalog.tables?.length)
      ? `\n[CATALOG READ: ${[m.catalog.list ? 'table list' : '', m.catalog.tables?.length ? (withNames ? `tables: ${m.catalog.tables.join(', ')}` : 'table structures') : ''].filter(Boolean).join('; ')}]`
      : ''
    return `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}${after}${md}${mx}${cat}`
  })
  return `[CONVERSATION SO FAR]\n${lines.join('\n\n')}`
}

const TASKS = {
  sql: 'Write or rewrite a single SQL statement according to the user request, using the schemas, current SQL and conversation so far in the data region when present.',
  interpret: 'Interpret the query result in the data region according to the user request and conversation so far: summarize key findings, notable patterns and caveats (the rows are a sample; statistics cover the whole result).',
  chart: 'Configure the chart for the result in the data region according to the user request and conversation so far.',
  bignumber: 'Propose big-number metrics (single values, optionally filtered and compared with the previous period) computed from the local result tables listed in the data region, according to the user request and conversation so far.',
}

export const CHART_QUESTION_NOTE = 'If you need clarification before proposing, reply with exactly one line beginning "QUESTION: " and NO JSON.'

export function chartChatFormat(selected: boolean, columns = true): string {
  return `${chartFormat(selected ? 'selected' : 'candidates', { columns })}\n${CHART_QUESTION_NOTE}`
}

export function metricsFormat(selected: boolean): string {
  const aggs = BIG_AGGS.filter((x) => x !== 'average')
  const lead = selected
    ? 'Return ONE JSON object replacing the selected metric, inside one ```json code block. Only if the user explicitly asks for other or several metrics, return a JSON array instead (at most 12 items).'
    : 'Return a JSON array of metrics (at most 12 items), inside one ```json code block.'
  return [
    lead,
    'Each metric is a JSON object with only these fields: data (table name), field (column name; may be empty only for count), aggregate, label? (short text), format? ({"kind":"plain"|"thousands"|"percent","decimals"?:number}), filter? (list of conditions, at most 5, AND-combined), compare? ({"kind":"mom"|"yoy","dateField":<column>}), note? (one short sentence).',
    `aggregate: ${JSON.stringify(aggs)} (distinct = number of distinct non-null values; it needs a field). sum/mean/median need a numeric column.`,
    `filter entry: {"field":<column>,"op":<op>,"value"?:...}; op: ${JSON.stringify(FILTER_OPS)}. Use a number value for number columns, a string for text/date columns (dates as YYYY-MM-DD), a boolean for boolean columns; in/notIn take an array of at most 50 values; isNull/notNull take no value; contains is for text columns only.`,
    'compare: mom = latest calendar month vs the previous month, yoy = latest month vs the same month a year earlier; dateField must be a date/time column of the same table.',
    'Use only tables and columns listed under LOCAL TABLES. If no suitable table exists, reply with exactly one line beginning "QUESTION: " suggesting the user ask the SQL assistant to create a result table first, and NO JSON. The same applies if you need clarification.',
    'Keep the whole answer under 2048 tokens.',
  ].join('\n')
}

function renderMetrics(i: ChatPromptInput, rows: number, stats: boolean, cols: number | null, tableCount: number): string | undefined {
  if (!i.send.schema) return undefined
  const out: string[] = []
  const tables = (i.metricTables ?? []).slice(0, tableCount)
  const one = (s: string) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  if (tables.length) {
    out.push('[LOCAL TABLES]\n' + tables.map((t) => {
      const c = cols === null ? t.columns : t.columns.slice(0, cols)
      return `${one(t.name)}(${c.map((x) => (x.dataType ? `${one(x.name)} ${one(x.dataType)}` : one(x.name))).join(', ')}${c.length < t.columns.length ? `, … (+${t.columns.length - c.length} more columns)` : ''})`
    }).join('\n') + ((i.metricTables?.length ?? 0) > tables.length ? `\n(${(i.metricTables?.length ?? 0) - tables.length} more tables omitted)` : ''))
    if (i.send.data) {
      for (const t of tables) {
        const s = t.sample
        if (!s) continue
        const keep = new Set((cols === null ? t.columns : t.columns.slice(0, cols)).map((x) => x.name))
        const idx = s.columns.map((c, k) => (keep.has(c.name) ? k : -1)).filter((k) => k >= 0)
        if (rows > 0 && s.rows.length) out.push(`[SAMPLE ROWS ${one(t.name)}]\n${s.rows.slice(0, Math.min(rows, MAX_SAMPLE_ROWS)).map((r) => JSON.stringify(idx.map((k) => r[k]))).join('\n')}`)
        if (stats) out.push(`[COLUMN STATS ${one(t.name)}] totalRows=${s.totalRows}\n${idx.map((k) => JSON.stringify(s.columns[k])).join('\n')}`)
      }
    }
  }
  const cur = i.metricCurrent
  if (cur?.candidate) out.push(`[${i.metricSelected !== undefined ? `SELECTED METRIC ${i.metricSelected}` : 'CURRENT METRIC'}]\n${JSON.stringify(defOf(cur.candidate as unknown as Record<string, unknown>))}`)
  if (cur?.block) out.push(`[CURRENT BLOCK]\n${JSON.stringify({ data: cur.block.data, metrics: cur.block.metrics.map(defOf) })}`)
  return out.length ? out.join('\n\n') : undefined
}

// structured definition only: whitelisted keys, so a stray value or internal flag can never leak
function defOf(m: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of ['data', 'field', 'aggregate', 'label', 'format', 'filter', 'compare']) if (m[k] !== undefined) o[k] = m[k]
  return o
}

export function buildChatPrompt(i: ChatPromptInput, limit: number = MAX_REQUEST_CHARS): BuiltChatPrompt {
  const format = i.purpose === 'sql' ? (i.catalogNeed && i.send.schema ? `${SQL_REPLY_FORMAT} ${NEED_FORMAT_NOTE}` : SQL_REPLY_FORMAT) : i.purpose === 'interpret' ? (i.forceUpdate ? INTERPRET_FORCE_FORMAT : INTERPRET_FORMAT) : i.purpose === 'bignumber' ? metricsFormat(i.metricSelected !== undefined) : chartChatFormat(i.chartSelected !== undefined, i.send.data)
  const pin: PromptInput = { locale: i.locale, dialect: i.dialect, send: i.send, schemas: [] }
  const h = head(pin, TASKS[i.purpose], format)
  const hist = filterHistory(i.history, i.send)
  const dataPartsDropped = !i.send.data && i.history.some((m) => m.parts.some((p) => p.kind === 'data'))
  const user = i.userText.slice(0, MAX_USER_CHARS)
  const usedCatalog = { list: !!i.send.schema && !!i.tableList && (i.tableList.names.length > 0 || !!i.tableList.fallback || !!i.tableList.schemas?.length), tables: i.send.schema ? i.schemas.map((x) => x.name).slice(0, 8) : [] }

  type Level = { rows: number; stats: boolean; cols: number | null; tables: number }
  const nTables = i.metricTables?.length ?? 0
  const maxCols = Math.max(0, ...(i.metricTables ?? []).map((t) => t.columns.length))
  let lv: Level = { rows: MAX_SAMPLE_ROWS, stats: true, cols: null, tables: nTables }
  const metricsAt = (l: Level) => renderMetrics(i, l.rows, l.stats, l.cols, l.tables)
  const attempt = (dropped: number, withBaseline: boolean): BuiltChatPrompt => {
    const kept = hist.slice(dropped)
    const extra: string[] = i.send.schema ? [...(i.notes ?? [])] : []
    if (dropped > 0) extra.push(`${dropped} earlier turn(s) were omitted to fit the size limit.`)
    if (!withBaseline && i.send.sql && i.baseline !== undefined) extra.push('The baseline SQL was omitted to fit the size limit.')
    const parts: PromptParts = {
      head: h,
      sql: i.send.sql && i.draft !== undefined ? i.draft : undefined,
      baseline: withBaseline && i.send.sql ? i.baseline : undefined,
      schemas: i.send.schema ? i.schemas : [],
      tableList: i.send.schema ? i.tableList : undefined,
      result: i.send.data ? i.result : undefined,
      chart: i.send.data && i.chart ? (i.chartSelected !== undefined ? { ...i.chart, label: `SELECTED SCHEME ${i.chartSelected}` } : i.chart) : undefined,
      metrics: i.purpose === 'bignumber' ? metricsAt(lv) : undefined,
      history: kept.length ? renderHistory(kept, i.send.sql) : undefined,
      user,
      extraNotes: extra,
    }
    const b = fitToLimit(parts, limit)
    return { ...b, notes: [...extra, ...b.notes], omittedTurns: dropped, dataPartsDropped, usedCatalog, metricsData: !!parts.metrics && /\[(SAMPLE ROWS|COLUMN STATS) /.test(parts.metrics) }
  }

  const levels: Level[] = []
  if (i.purpose === 'bignumber' && i.send.schema) {
    for (const rows of [3, 1, 0]) levels.push({ rows, stats: true, cols: null, tables: nTables })
    levels.push({ rows: 0, stats: false, cols: null, tables: nTables })
    for (let c = 64; c >= 0; c = c > 8 ? c >> 1 : c - 1) if (c < maxCols) levels.push({ rows: 0, stats: false, cols: c, tables: nTables })
    for (let n = nTables >> 1; n >= 0; n = n > 0 ? n >> 1 : -1) levels.push({ rows: 0, stats: false, cols: 0, tables: n })
  }
  const base = lv
  const first = attempt(0, true)
  if (first.overLimit && levels.length) {
    for (const l of levels) {
      lv = l
      const b = attempt(0, true)
      if (!b.overLimit) return b
    }
    lv = levels.find((l) => !l.stats && l.cols === null) ?? base
  }
  if (!first.overLimit) return first
  const pairs = Math.ceil(hist.length / 2)
  const drop = (j: number) => Math.min(hist.length, j * 2)
  const search = (withBaseline: boolean): BuiltChatPrompt | null => {
    if (attempt(drop(pairs), withBaseline).overLimit) return null
    let lo = 1, hi = pairs
    while (lo < hi) { const mid = (lo + hi) >> 1; if (attempt(drop(mid), withBaseline).overLimit) lo = mid + 1; else hi = mid }
    return attempt(drop(lo), withBaseline)
  }
  return search(true) ?? search(false) ?? attempt(hist.length, false)
}
