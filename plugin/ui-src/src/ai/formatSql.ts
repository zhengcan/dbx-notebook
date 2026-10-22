import { analyzeSql } from './sqlSafety'

export const FORMAT_MAX_CHARS = 200_000
export const FORMAT_TIMEOUT_MS = 2000

export type FormatReason = 'empty' | 'too-long' | 'xml' | 'multiple' | 'timeout' | 'failed' | 'changed-semantics'
export type FormatResult = { ok: true; sql: string } | { ok: false; sql: string; reason: FormatReason }
export type FormatterLanguage = 'mysql' | 'postgresql' | 'sqlite' | 'transactsql' | 'sql'
export type FormatFn = (sql: string, cfg: Record<string, unknown>) => string
export interface FormatOptions { load?: () => Promise<{ format: FormatFn }>; timeoutMs?: number }

const LANG: Record<string, FormatterLanguage> = {
  postgres: 'postgresql', postgresql: 'postgresql', cockroach: 'postgresql', redshift: 'postgresql', greenplum: 'postgresql',
  mysql: 'mysql', mariadb: 'mysql', tidb: 'mysql', doris: 'mysql', starrocks: 'mysql',
  sqlite: 'sqlite', sqlserver: 'transactsql', mssql: 'transactsql',
}
export function formatterLanguage(dbType: string): FormatterLanguage {
  return LANG[dbType.toLowerCase()] ?? 'sql'
}

// Plugin parameter syntax (see findParamRefs in @sqlnb/format), kept byte-identical by the formatter.
const PARAM_REGEX = '\\{\\{\\s*[A-Za-z_][A-Za-z0-9_]{0,62}\\s*\\}\\}'

/**
 * Whitespace-free token stream: whitespace removed, case folded outside quotes/comments.
 * Cheap guard that the formatter only changed layout and keyword case.
 */
export function normalizeSql(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      let j = i
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++
      out += sql.slice(i, j).replace(/\s+/g, '') + '\n'
      i = j
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2)
      const j = e < 0 ? n : e + 2
      out += sql.slice(i, j).replace(/\s+/g, '')
      i = j
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && sql[j] !== c) j++
      out += sql.slice(i, j + 1)
      i = j + 1
    } else {
      if (!/\s/.test(c)) out += c.toLowerCase()
      i++
    }
  }
  return out
}

const defaultLoad = () => import('sql-formatter') as Promise<{ format: FormatFn }>

export async function formatAiSql(sql: string, dbType: string, opts: FormatOptions = {}): Promise<FormatResult> {
  const fail = (reason: FormatReason): FormatResult => ({ ok: false, sql, reason })
  try {
    if (sql.trim() === '') return fail('empty')
    if (sql.length > FORMAT_MAX_CHARS) return fail('too-long')
    if (/^\s*</.test(sql)) return fail('xml')
    const before = analyzeSql(sql)
    if (before.statements > 1) return fail('multiple')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), opts.timeoutMs ?? FORMAT_TIMEOUT_MS) })
    const work = (async () => {
      const mod = await (opts.load ?? defaultLoad)()
      return mod.format(sql, {
        language: formatterLanguage(dbType), keywordCase: 'upper', tabWidth: 2, expressionWidth: 120,
        logicalOperatorNewline: 'before', linesBetweenQueries: 1, indentStyle: 'standard',
        paramTypes: { custom: [{ regex: PARAM_REGEX }] },
      })
    })()
    work.catch(() => {})
    let out: string | null
    try { out = await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
    if (out === null) return fail('timeout')
    if (typeof out !== 'string' || out.trim() === '') return fail('failed')
    const after = analyzeSql(out)
    if (after.readOnly !== before.readOnly || after.reason !== before.reason || after.statements !== before.statements) return fail('changed-semantics')
    if (normalizeSql(out) !== normalizeSql(sql)) return fail('changed-semantics')
    return { ok: true, sql: out }
  } catch {
    return fail('failed')
  }
}
