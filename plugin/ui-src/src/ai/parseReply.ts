import { parseNeed } from './parseNeed'
import { parseSqlOutput, MAX_OUTPUT_CHARS, type Parsed } from './parse'

export type SqlReply =
  | { kind: 'sql'; sql: string; message?: string }
  | { kind: 'question'; message: string }

const MARKER = /^[\s*`]*(?:question|ask|问题|反问)[\s*`]*[:：][\s*`]*/i
const MARKER_LINE = /^[ \t]*[*`]*(?:question|ask|问题|反问)[*`]*[ \t]*[:：]/im
const FENCE = /^[ \t]*```/m
const ID = '[\\w."`\\[\\]$]+'
const SHAPED = [
  /^\s*select\s*$/i,
  new RegExp(`^\\s*select\\s+(?:distinct\\s+)?(?:\\*|\\d|['"\`(-]|${ID}\\s*\\(|${ID}(?:\\s+as\\s+${ID})?\\s*(?:,|;|$)|${ID}(?:\\s+as\\s+${ID})?\\s+from\\b|${ID}\\s*[-+/*=<>])`, 'i'),
  /^\s*insert\s+(?:or\s+\w+\s+)?into\s+\S/i,
  /^\s*update\s+\S+\s+set\s+\S/i,
  /^\s*delete\s+from\s+\S/i,
  /^\s*merge\s+into\s+\S/i,
  /^\s*replace\s+into\s+\S/i,
  /^\s*create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unique|materialized|virtual)\s+)*(?:table|view|index|schema|database|sequence|function|trigger)\s+\S/i,
  /^\s*drop\s+(?:table|view|index|schema|database|sequence|function|trigger)\s+\S/i,
  /^\s*alter\s+(?:table|view|index|schema|database|sequence)\s+\S/i,
  /^\s*truncate\s+(?:table\s+)?\S+\s*;?\s*$/i,
  /^\s*explain\s+(?:(?:analyze|verbose|query\s+plan)\s+)*(?:select|with|insert|update|delete)\b\s*\S/i,
  /^\s*pragma\s+\w+/i,
  /^\s*attach\s+\S+\s+as\s+\S/i,
  /^\s*values\s*\(/i,
  /^\s*with\s+(?:recursive\s+)?\S+\s*(?:\([^)]*\)\s*)?as\s*(?:\(|$)/i,
  /^\s*with\s+(?:recursive\s+)?\S+\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/i,
]
const looksLikeSql = (line: string): boolean => SHAPED.some((r) => r.test(line))
const anyLineLooksLikeSql = (src: string): boolean => src.split('\n').some(looksLikeSql)

const question = (message: string): Parsed<SqlReply> => ({ ok: true, value: { kind: 'question', message }, warnings: [] })

export function parseSqlReply(text: string, opts: { truncated: boolean }): Parsed<SqlReply> {
  if (opts.truncated) return { ok: false, reason: 'truncated' }
  text = parseNeed(text).rest
  if (text.trim() === '') return { ok: false, reason: 'empty' }
  if (text.length > MAX_OUTPUT_CHARS) return { ok: false, reason: 'too-long' }
  const src = text.replace(/\r\n?/g, '\n').trim()
  const fenced = FENCE.test(src)
  const marked = MARKER.exec(src)
  if (marked && !fenced) {
    const message = src.slice(marked[0].length).trim()
    return message ? question(message) : { ok: false, reason: 'empty' }
  }
  if (fenced) {
    const p = parseSqlOutput(src, { truncated: false })
    if (!p.ok) return p
    return { ok: true, value: { kind: 'sql', sql: p.value.sql, message: marked ? src : p.value.explanation }, warnings: p.warnings }
  }

  // Unfenced: cut at a later question-marker line, drop leading comment lines.
  let body = src
  let tail = ''
  const cut = MARKER_LINE.exec(src)
  if (cut && cut.index > 0) { body = src.slice(0, cut.index).trim(); tail = src.slice(cut.index).trim() }
  body = body.replace(/^(?:[ \t]*--[^\n]*\n)+/, '').trim()
  const p = body === '' ? null : parseSqlOutput(body, { truncated: false })
  if (p && p.ok) {
    if (looksLikeSql(p.value.sql.split('\n')[0]) || /;\s*$/.test(p.value.sql) && anyLineLooksLikeSql(p.value.sql)) {
      const message = [p.value.explanation, tail].filter(Boolean).join('\n') || undefined
      const value: SqlReply = message ? { kind: 'sql', sql: p.value.sql, message } : { kind: 'sql', sql: p.value.sql }
      return { ok: true, value, warnings: p.warnings }
    }
    return anyLineLooksLikeSql(src) ? { ok: false, reason: 'unparseable' } : question(src)
  }
  if (p && p.reason !== 'unparseable') return p
  return anyLineLooksLikeSql(src) ? { ok: false, reason: 'unparseable' } : question(src)
}
