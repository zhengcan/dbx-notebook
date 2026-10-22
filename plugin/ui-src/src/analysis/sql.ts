import { isAgg, isGrain } from '@sqlnb/format'
import type { MetricFilter, MetricCompare } from './bigNumberConfig'
import type { Agg, ColumnInfo, FieldRef, PivotConfig } from '@sqlnb/format'

export interface SourceColumn { name: string; kind: ColumnInfo['kind'] }
export type SqlErrorCode = 'BAD_FIELD' | 'BAD_AGG' | 'BAD_GRAIN' | 'EMPTY' | 'TYPE' | 'FILTER' | 'COMPARE'
export interface SqlError { error: { code: SqlErrorCode; message: string; field?: string } }
export interface AggregateQuery { sql: string; dims: string[]; measures: string[]; nullDateColumns: string[] }

export class SqlGenError extends Error {
  constructor(message: string) { super(message); this.name = 'SqlGenError' }
}

const MAX_IDENT = 256
const TS_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

const NUM_STR_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
const NUMBER_TYPE = /^(u?int\d*|tinyint|smallint|mediumint|bigint|integer|serial\d*|smallserial|bigserial|float\d*|double( precision)?|real|numeric|decimal|dec|number|money|smallmoney|fixed)$/
const TEMPORAL_TYPE = /^(date|datetime\d*|datetime2|smalldatetime|timestamp(tz)?)$/
const TEXT_TYPE = /^(n?var)?char\d*$|^(n|tiny|medium|long)?text$|^(string|uuid|json|jsonb|clob|enum|set|bytea|(var)?binary|(tiny|medium|long)?blob|xml|citext|inet|cidr|name|bpchar)$/

// Real DBX columns carry raw database type names (int8, NUMERIC(10,2), timestamptz, ...).
export function columnKind(dataType?: string, sample?: unknown): ColumnInfo['kind'] {
  const raw = typeof dataType === 'string' ? dataType.trim().toLowerCase() : ''
  if (raw !== '') {
    if (raw.endsWith('[]') || raw.startsWith('_')) return 'text'
    const base = raw.replace(/\([^)]*\)/g, '').replace(/\b(unsigned|signed|zerofill)\b/g, '')
      .replace(/\bwith(out)? time zone\b/g, '').replace(/\s+/g, ' ').trim()
    const stem = base.replace(/ /g, '')
    if (NUMBER_TYPE.test(base)) return 'number'
    if (TEMPORAL_TYPE.test(stem) || /^timestamp\b/.test(base) || /^datetime\b/.test(base)) return 'temporal'
    if (base === 'bool' || base === 'boolean' || base === 'bit') return 'boolean'
    if (TEXT_TYPE.test(base)) return 'text'
  }
  if (typeof sample === 'number') return 'number'
  if (typeof sample === 'boolean') return 'boolean'
  if (typeof sample === 'string' && TS_RE.test(sample)) return 'temporal'
  if (typeof sample === 'string' && NUM_STR_RE.test(sample)) return 'number'
  return 'text'
}

export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new SqlGenError('identifier is empty')
  if (name.length > MAX_IDENT) throw new SqlGenError('identifier too long')
  if (name.includes('\u0000')) throw new SqlGenError('identifier contains NUL')
  return `"${name.replace(/"/g, '""')}"`
}

const fail = (code: SqlErrorCode, message: string, field?: string): SqlError =>
  ({ error: field === undefined ? { code, message } : { code, message, field } })

const validName = (n: string) => typeof n === 'string' && n.length > 0 && n.length <= MAX_IDENT && !n.includes('\u0000')
const findCol = (cols: SourceColumn[], name: string) => (validName(name) ? cols.find((c) => c.name === name) : undefined)

// date_trunc raises on unparseable text, so only well-formed ISO values reach it (others become NULL).
function tsGuard(c: string): string {
  const zone = (r: string) => `(${r} = 'Z' OR (${r} GLOB '[+-][0-2][0-9]:[0-5][0-9]' AND substr(${r}, 2, 2) <= '23'))`
  const frac = `substr(${c}, 21)`
  const core = `(CASE WHEN ${frac} GLOB '*Z' THEN substr(${frac}, 1, length(${frac}) - 1) ` +
    `WHEN ${frac} GLOB '*[+-][0-2][0-9]:[0-5][0-9]' AND substr(${frac}, -5, 2) <= '23' THEN substr(${frac}, 1, length(${frac}) - 6) ` +
    `ELSE ${frac} END)`
  return `typeof(${c}) = 'text' AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' ` +
    `AND date(substr(${c}, 1, 10)) = substr(${c}, 1, 10) AND (length(${c}) = 10 OR ` +
    `(substr(${c}, 11, 1) IN (' ', 'T') AND substr(${c}, 12, 5) GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(${c}, 12, 2) <= '23' AND ` +
    `(length(${c}) = 16 OR ${zone(`substr(${c}, 17)`)} OR ` +
    `(substr(${c}, 17, 1) = ':' AND substr(${c}, 18, 2) GLOB '[0-5][0-9]' AND (length(${c}) = 19 OR ${zone(`substr(${c}, 20)`)} OR ` +
    `(substr(${c}, 20, 1) = '.' AND ${core} GLOB '[0-9]*' AND ${core} NOT GLOB '*[^0-9]*'))))))`
}

interface Dim { expr: string; alias: string; temporal: boolean; field: string }

function buildDims(rows: FieldRef[], cols: FieldRef[], source: SourceColumn[]): Dim[] | SqlError {
  const out: Dim[] = []
  const seen = new Set<string>()
  const groups: [string, FieldRef[]][] = [['r', rows], ['c', cols]]
  for (const [prefix, refs] of groups) {
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]
      const col = findCol(source, ref.field)
      if (!col) return fail('BAD_FIELD', `Unknown field: ${String(ref.field).slice(0, 64)}`, ref.field)
      const key = JSON.stringify([ref.field, ref.grain ?? null])
      if (seen.has(key)) return fail('BAD_FIELD', `Duplicate dimension: ${ref.field}`, ref.field)
      seen.add(key)
      const q = quoteIdent(col.name)
      let expr = q
      if (col.kind === 'temporal' && ref.grain !== undefined) {
        if (!isGrain(ref.grain)) return fail('BAD_GRAIN', 'Unsupported time grain', ref.field)
        expr = `CASE WHEN ${tsGuard(q)} THEN date_trunc('${ref.grain}', ${q}) END`
      }
      out.push({ expr, alias: `__sqlnb_${prefix}${i}`, temporal: col.kind === 'temporal', field: col.name })
    }
  }
  return out
}

const AGG_FN: Record<Agg, string> = { sum: 'sum', count: 'count', countDistinct: 'count', avg: 'avg', min: 'min', max: 'max', median: 'median' }

function measureExpr(agg: unknown, field: string, cols: SourceColumn[]): string | SqlError {
  if (!isAgg(agg)) return fail('BAD_AGG', 'Unsupported aggregate', field)
  if (agg === 'count' && field === '') return 'count(*)'
  const col = findCol(cols, field)
  if (!col) return fail('BAD_FIELD', `Unknown field: ${String(field).slice(0, 64)}`, field)
  const q = quoteIdent(col.name)
  if ((agg === 'sum' || agg === 'avg' || agg === 'median') && col.kind !== 'number')
    return fail('TYPE', `${agg} requires a numeric field`, field)
  if ((agg === 'min' || agg === 'max') && col.kind !== 'number' && col.kind !== 'temporal' && col.kind !== 'text')
    return fail('TYPE', `${agg} requires a number, date or text field`, field)
  return agg === 'countDistinct' ? `count(DISTINCT ${q})` : `${AGG_FN[agg]}(${q})`
}

const isErr = (x: unknown): x is SqlError => typeof x === 'object' && x !== null && 'error' in x

function assemble(table: string, dims: Dim[], values: PivotConfig['values'], cols: SourceColumn[]): AggregateQuery | SqlError {
  const t = quoteIdent(table)
  if (!values || values.length === 0) return fail('EMPTY', 'No values configured')
  const measures: string[] = []
  for (let i = 0; i < values.length; i++) {
    const m = measureExpr(values[i].agg, values[i].field, cols)
    if (isErr(m)) return m
    measures.push(`${m} AS __sqlnb_v${i}`)
  }
  const select = [...dims.map((d) => `${d.expr} AS ${d.alias}`), ...measures].join(', ')
  const temporal = dims.filter((d) => d.temporal)
  let sql = `SELECT ${select} FROM ${t}`
  if (temporal.length) sql += ` WHERE ${temporal.map((d) => `${d.expr} IS NOT NULL`).join(' AND ')}`
  if (dims.length) {
    sql += ` GROUP BY ${dims.map((_, i) => i + 1).join(', ')}`
    sql += ` ORDER BY ${dims.map((d) => `${d.expr} IS NULL, ${d.expr}`).join(', ')}`
  }
  return {
    sql,
    dims: dims.map((d) => d.alias),
    measures: values.map((_, i) => `__sqlnb_v${i}`),
    nullDateColumns: temporal.map((d) => d.field),
  }
}

export function buildAggregateSql(table: string, cfg: PivotConfig, cols: SourceColumn[]): AggregateQuery | SqlError {
  const dims = buildDims(cfg.rows, cfg.columns, cols)
  if (isErr(dims)) return dims
  return assemble(table, dims, cfg.values, cols)
}

export function buildExcludedCountSql(table: string, cfg: PivotConfig, cols: SourceColumn[]): { sql: string } | SqlError | null {
  const dims = buildDims(cfg.rows, cfg.columns, cols)
  if (isErr(dims)) return dims
  const temporal = dims.filter((d) => d.temporal)
  if (!temporal.length) return null
  return { sql: `SELECT count(*) FROM ${quoteIdent(table)} WHERE ${temporal.map((d) => `${d.expr} IS NULL`).join(' OR ')}` }
}

const BIG_AGG: Record<string, string> = {
  sum: 'sum', avg: 'avg', mean: 'avg', average: 'avg', min: 'min', max: 'max', count: 'count', median: 'median',
}

const MAX_FILTERS = 5
const MAX_IN = 50

// The single place a user-supplied value becomes SQL text.
export function sqlLiteral(v: unknown): string {
  if (typeof v === 'string') {
    if (v.includes('\u0000')) throw new SqlGenError('literal contains NUL')
    return `'${v.replace(/'/g, "''")}'`
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SqlGenError('literal is not finite')
    return v < 0 ? `(${v})` : String(v)
  }
  if (typeof v === 'bigint') return v < 0n ? `(${v})` : v.toString()
  if (typeof v === 'boolean') return v ? '1' : '0'
  throw new SqlGenError('unsupported literal')
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
const NO_VALUE_OPS = ['isNull', 'notNull']
const CMP_OPS: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=' }

function typedLiteral(kind: ColumnInfo['kind'], v: unknown): string | null {
  const okType = kind === 'number' ? typeof v === 'number' || typeof v === 'bigint'
    : kind === 'boolean' ? typeof v === 'boolean' : typeof v === 'string'
  if (!okType) return null
  try { return sqlLiteral(v) } catch { return null }
}

// Conditions joined by AND, without the WHERE keyword ('' when there are no filters).
export function buildFilterWhere(filters: MetricFilter[] | undefined, cols: SourceColumn[]): { where: string } | SqlError {
  if (filters === undefined || filters.length === 0) return { where: '' }
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) return fail('FILTER', 'Too many filters')
  const parts: string[] = []
  for (const f of filters) {
    const field = f?.field
    const col = findCol(cols, field)
    if (!col) return fail('FILTER', `Unknown filter field: ${String(field).slice(0, 64)}`, field)
    const q = quoteIdent(col.name)
    const op = f.op
    const bad = (m: string) => fail('FILTER', `${m}: ${col.name.slice(0, 64)}`, col.name)
    if (typeof op !== 'string') return bad('Unsupported filter operator')
    if (op === 'isNull' || op === 'notNull') {
      if (f.value !== undefined) return bad('Operator takes no value')
      parts.push(`${q} IS ${op === 'isNull' ? '' : 'NOT '}NULL`)
    } else if (Object.prototype.hasOwnProperty.call(CMP_OPS, op)) {
      if (col.kind === 'boolean' && op !== '=' && op !== '!=') return bad('Operator not valid for boolean field')
      const lit = Array.isArray(f.value) ? null : typedLiteral(col.kind, f.value)
      if (lit === null) return bad('Filter value does not match the field type')
      parts.push(`${q} ${CMP_OPS[op]} ${lit}`)
    } else if (op === 'in' || op === 'notIn') {
      const vals = f.value
      if (!Array.isArray(vals) || vals.length === 0 || vals.length > MAX_IN) return bad('List needs 1 to 50 values')
      const lits = vals.map((v) => typedLiteral(col.kind, v))
      if (lits.some((l) => l === null)) return bad('Filter value does not match the field type')
      parts.push(`${q} ${op === 'in' ? 'IN' : 'NOT IN'} (${lits.join(', ')})`)
    } else if (op === 'contains') {
      if (col.kind !== 'text') return bad('contains requires a text field')
      if (typeof f.value !== 'string' || f.value === '') return bad('Filter value does not match the field type')
      parts.push(`${q} LIKE ${sqlLiteral(`%${likeEscape(f.value)}%`)} ESCAPE '\\'`)
    } else return bad('Unsupported filter operator')
  }
  return { where: parts.join(' AND ') }
}

type BigMetric = { field: string; aggregate?: string; filter?: MetricFilter[] }

function bigNumberSql(table: string, m: BigMetric, cols: SourceColumn[], extra?: string): { sql: string } | SqlError {
  const t = quoteIdent(table)
  const field = m.field
  const fw = buildFilterWhere(m.filter, cols)
  if ('error' in fw) return fw
  const conds = [fw.where, extra ?? ''].filter((x) => x !== '')
  const w = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  let agg = m.aggregate
  if (agg === undefined) {
    if (field === '') agg = 'count'
    else { const c = findCol(cols, field); agg = c?.kind === 'number' ? 'sum' : 'count' }
  }
  const has = Object.prototype.hasOwnProperty
  if (agg === 'count' && field === '') return { sql: `SELECT count(*) FROM ${t}${w}` }
  if (agg !== 'first' && agg !== 'last' && agg !== 'distinct' && !has.call(BIG_AGG, agg)) return fail('BAD_AGG', 'Unsupported aggregate', field)
  const col = findCol(cols, field)
  if (!col) return fail('BAD_FIELD', `Unknown field: ${String(field).slice(0, 64)}`, field)
  const q = quoteIdent(col.name)
  if (agg === 'first') return { sql: `SELECT ${q} FROM ${t}${w} ORDER BY rowid LIMIT 1` }
  if (agg === 'last') return { sql: `SELECT ${q} FROM ${t}${w} ORDER BY rowid DESC LIMIT 1` }
  if (agg === 'distinct') return { sql: `SELECT count(DISTINCT ${q}) FROM ${t}${w}` }
  const fn = BIG_AGG[agg]
  if ((fn === 'sum' || fn === 'avg' || fn === 'median') && col.kind !== 'number') return fail('TYPE', `${agg} requires a numeric field`, field)
  if ((fn === 'min' || fn === 'max') && col.kind === 'boolean') return fail('TYPE', `${agg} requires a number, date or text field`, field)
  return { sql: `SELECT ${fn}(${q}) FROM ${t}${w}` }
}

export function buildBigNumberSql(table: string, m: BigMetric, cols: SourceColumn[]): { sql: string } | SqlError {
  return bigNumberSql(table, m, cols)
}

// Month of a date as written (first 7 chars of a well-formed ISO value; no timezone conversion).
// Numbers, unparseable text and NULL give NULL.
const monthExpr = (q: string) => `CASE WHEN ${tsGuard(q)} THEN substr(${q}, 1, 7) END`

export function buildCompareSql(
  table: string, m: BigMetric & { compare?: MetricCompare }, cols: SourceColumn[],
): { periodSql: string; valueSql: (ym: string) => string } | SqlError {
  const c = m.compare
  if (!c || (c.kind !== 'mom' && c.kind !== 'yoy')) return fail('COMPARE', 'Unsupported comparison kind')
  const col = findCol(cols, c.dateField)
  if (!col) return fail('COMPARE', `Unknown date field: ${String(c.dateField).slice(0, 64)}`, c.dateField)
  if (col.kind !== 'temporal') return fail('COMPARE', 'Comparison requires a date field', col.name)
  const base = bigNumberSql(table, m, cols)
  if ('error' in base) return base
  const fw = buildFilterWhere(m.filter, cols)
  if ('error' in fw) return fw
  const month = monthExpr(quoteIdent(col.name))
  const where = fw.where === '' ? '' : ` WHERE ${fw.where}`
  const periodSql = `SELECT max(${month}) FROM ${quoteIdent(table)}${where}`
  const valueSql = (ym: string): string => {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new SqlGenError('invalid period')
    const r = bigNumberSql(table, m, cols, `(${month}) = ${sqlLiteral(ym)}`)
    if ('error' in r) throw new SqlGenError(r.error.message)
    return r.sql
  }
  return { periodSql, valueSql }
}
