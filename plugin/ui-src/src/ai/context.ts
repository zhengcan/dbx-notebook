import type { HostBridge, QueryResult } from '../host/bridge'
import { catalogDialectOf, validCatalogScope } from './catalog'

const MAX_REFS = 20

function blank(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
    } else if (c === '/' && d === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
      out += ' '
    } else if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue } break }
        i++
      }
      i++
      out += ' '
    } else { out += c; i++ }
  }
  return out
}

const IDENT = '(?:"(?:[^"]|"")+"|`[^`]+`|\\[[^\\]]+\\]|[\\p{L}\\p{N}_$]+)'
const NAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})*`
const REF_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}_$.])(?:from|join|update|into)\\s+(${NAME})`, 'giu')
const CTE_RE = new RegExp(`(?:\\bwith\\s+(?:recursive\\s+)?|,\\s*)(${IDENT})\\s*(?:\\([^)]*\\)\\s*)?as\\s*(?:not\\s+materialized\\s*|materialized\\s*)?\\(`, 'giu')
const PART_RE = new RegExp(IDENT, 'gu')

function unquote(p: string): string {
  if (p.startsWith('"')) return p.slice(1, -1).replace(/""/g, '"')
  if (p.startsWith('`') || p.startsWith('[')) return p.slice(1, -1)
  return p
}
const parts = (name: string) => (name.match(PART_RE) ?? []).map(unquote)

// Best-effort, regex based: only the first table of `FROM a, b` comma lists is found, and
// `EXTRACT(x FROM col)` yields `col`. Extra context is harmless; missing tables just mean less schema.
export function extractTableRefs(sql: string): string[] {
  const s = blank(sql ?? '')
  const ctes = new Set<string>()
  for (const m of s.matchAll(CTE_RE)) ctes.add(unquote(m[1]).toLowerCase())
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of s.matchAll(REF_RE)) {
    const p = parts(m[1])
    if (!p.length) continue
    if (p.length === 1 && ctes.has(p[0].toLowerCase())) continue
    const ref = p.join('.')
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
    if (out.length >= MAX_REFS) break
  }
  return out
}

export interface TableSchema { name: string; columns: { name: string; dataType: string; nullable: boolean }[] }

export function createSchemaCache(bridge: Pick<HostBridge, 'getTableMetadata'>): {
  get(conn: { connectionId: string; dbType?: string; database?: string; schema?: string }, table: string): Promise<TableSchema | null>
  clear(): void
} {
  const cache = new Map<string, TableSchema>()
  return {
    async get(conn, table) {
      // `a.b` is split here (never in SQL): the qualifier is whitelisted and goes to the host's schema/database parameter
      let { database, schema } = conn
      let tbl = table
      const dot = table.indexOf('.')
      const d = conn.dbType ? catalogDialectOf(conn.dbType) : null
      if (dot > 0 && dot < table.length - 1 && (d === 'postgres' || d === 'mysql') && validCatalogScope(table.slice(0, dot)) && !table.slice(0, dot).includes('.')) {
        if (d === 'postgres') schema = table.slice(0, dot)
        else { database = table.slice(0, dot); schema = undefined }
        tbl = table.slice(dot + 1)
      }
      const key = `${conn.connectionId}|${database ?? ''}|${schema ?? ''}|${tbl}`
      const hit = cache.get(key)
      if (hit) return { ...hit, name: table }
      try {
        const md = await bridge.getTableMetadata({ connectionId: conn.connectionId, database, schema, table: tbl })
        const s: TableSchema = { name: table, columns: md.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable })) }
        cache.set(key, s)
        return s
      } catch {
        return null
      }
    },
    clear() { cache.clear() },
  }
}

export interface ColumnStat { name: string; dataType?: string; nulls: number; distinct: number; min?: string; max?: string }
export interface ResultSummary { totalRows: number; shownRows: number; columns: ColumnStat[]; rows: string[][]; truncatedAtRun: boolean }

function text(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') {
    try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v) } catch { return String(v) }
  }
  return String(v)
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = s.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut + '…'
}

const isNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint'

export function summarizeResult(r: QueryResult, opts: { maxRows?: number; maxCell?: number } = {}): ResultSummary {
  const maxRows = opts.maxRows ?? 50
  const maxCell = opts.maxCell ?? 200
  const columns: ColumnStat[] = r.columns.map((c, ci) => {
    let nulls = 0
    const seen = new Set<string>()
    let min: unknown, max: unknown
    let allNum = true
    const vals: unknown[] = []
    for (const row of r.rows) {
      const v = row[ci]
      if (v === null || v === undefined) { nulls++; continue }
      seen.add((typeof v) + ':' + text(v))
      vals.push(v)
      if (!isNum(v)) allNum = false
    }
    if (vals.length) {
      const cmp = allNum
        ? (a: unknown, b: unknown) => (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
        : (a: unknown, b: unknown) => { const x = text(a), y = text(b); return x < y ? -1 : x > y ? 1 : 0 }
      min = vals[0]; max = vals[0]
      for (const v of vals) { if (cmp(v, min) < 0) min = v; if (cmp(v, max) > 0) max = v }
    }
    const st: ColumnStat = { name: c.name, nulls, distinct: seen.size }
    if (c.dataType) st.dataType = c.dataType
    if (vals.length) { st.min = clip(text(min), maxCell); st.max = clip(text(max), maxCell) }
    return st
  })
  const rows = r.rows.slice(0, maxRows).map((row) => r.columns.map((_, i) => clip(text(row[i]), maxCell)))
  return { totalRows: r.rows.length, shownRows: rows.length, columns, rows, truncatedAtRun: !!r.truncated }
}
