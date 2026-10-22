import { findParamRefs } from '@sqlnb/format'

export interface SqlSafety { statements: number; readOnly: boolean; reason?: 'multiple' | 'not-select' | 'empty' | 'unsupported-syntax' }

// Same scanning rules as result-engine `check_single_statement`: comments skipped, quoted runs
// (' " ` [ ]) opaque, one trailing ';' (or several) allowed, a leading ';' before code is "multiple".
const LINE_END = new Set(['\n', '\r', '\u2028', '\u2029', '\u0085'])

function split(sql: string): { segments: string[]; all: string[]; leadSemi: boolean; unterminated: boolean } {
  const segments: string[] = []
  let cur = ''
  let seen = false
  let leadSemi = false
  let unterminated = false
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && !LINE_END.has(sql[i])) i++
      cur += ' '
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      if (i >= n) unterminated = true
      i += 2
      cur += ' '
    } else if (c === ';') {
      if (seen) { segments.push(cur); cur = '' } else leadSemi = true
      i++
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      i++
      while (i < n && sql[i] !== close) i++
      if (i >= n) unterminated = true
      i++
      cur += ' Q '
      seen = true
    } else {
      if (!/\s/.test(c)) seen = true
      cur += c
      i++
    }
  }
  segments.push(cur)
  return { segments: segments.filter((s) => s.trim() !== ''), all: segments, leadSemi, unterminated }
}

const DML = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|ATTACH|PRAGMA)\b|\bREPLACE\b(?!\s*\()/i
const LOCKING = /\bINTO\b|\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b|\bKEY\s+SHARE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i

// Dialect syntax the scanner cannot model faithfully: dollar quoting, backslash escapes, MySQL
// executable comments / hints, and `--` without following whitespace (not a comment in MySQL).
const UNSUPPORTED = /\$[A-Za-z0-9_$]|\\|\/\*[!+]|--(?![ \t\r\n\x00-\x1f]|$)/

export function analyzeSql(sql: string): SqlSafety {
  if (UNSUPPORTED.test(sql)) return { statements: 1, readOnly: false, reason: 'unsupported-syntax' }
  const { segments, leadSemi, unterminated } = split(sql)
  if (segments.length === 0) return { statements: 0, readOnly: false, reason: 'empty' }
  if (unterminated) return { statements: segments.length, readOnly: false, reason: 'unsupported-syntax' }
  if (segments.length > 1 || leadSemi) {
    return { statements: segments.length + (leadSemi ? 1 : 0), readOnly: false, reason: 'multiple' }
  }
  const s = segments[0]
  const first = /^\s*([A-Za-z]+)/.exec(s)?.[1].toUpperCase()
  const notSelect = { statements: 1, readOnly: false, reason: 'not-select' as const }
  if (first !== 'SELECT' && first !== 'WITH') return notSelect
  if (LOCKING.test(s)) return notSelect
  if (first === 'WITH' && (DML.test(s) || !/\bSELECT\b/i.test(s))) return notSelect
  return { statements: 1, readOnly: true }
}

export function isAutoRunnableSql(sql: string): boolean {
  return analyzeSql(sql).readOnly
}

export function findUnresolvedParams(sql: string, known: string[]): string[] {
  const have = new Set(known)
  const out: string[] = []
  for (const r of findParamRefs(split(sql).all.join(';'))) if (!have.has(r.name) && !out.includes(r.name)) out.push(r.name)
  return out
}

export function isBalancedSql(sql: string): boolean {
  const { all, unterminated } = split(sql)
  if (unterminated) return false
  let depth = 0
  for (const c of all.join(';')) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
  }
  return depth === 0
}
