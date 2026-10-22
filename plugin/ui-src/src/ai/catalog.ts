import { mapHostError, type HostBridge } from '../host/bridge'
import { extractTableRefs } from './context'

export const CATALOG_ROW_CAP = 300
export const MAX_NEED_TABLES = 8
const MAX_NOTEBOOK_TABLES = 100

export type CatalogDialect = 'postgres' | 'mysql' | 'sqlite'

export function catalogDialectOf(dbType: string): CatalogDialect | null {
  switch (String(dbType ?? '').toLowerCase()) {
    case 'postgres': case 'postgresql': case 'pg': return 'postgres'
    case 'mysql': case 'mariadb': return 'mysql'
    case 'sqlite': return 'sqlite'
    default: return null
  }
}

export function validCatalogScope(s: string): boolean {
  return typeof s === 'string' && /^[\p{L}\p{N}_$ .-]{1,64}$/u.test(s)
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The only place catalog SQL is built: fixed statements, the sole variable part is one escaped string literal. */
export function buildCatalogQuery(d: CatalogDialect, scope?: string, effective?: { database?: string; schema?: string }): { sql: string } | null {
  const pick = (v?: string) => (v !== undefined && v !== '' ? v : undefined)
  const sc = pick(scope) ?? (d === 'postgres' ? pick(effective?.schema) : d === 'mysql' ? pick(effective?.database) : undefined)
  if (sc !== undefined && !validCatalogScope(sc)) return null
  const limit = `ORDER BY 1 LIMIT ${CATALOG_ROW_CAP + 1}`
  if (d === 'postgres') {
    if (sc !== undefined) return { sql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${lit(sc)} ${limit}` }
    return { sql: `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') AND table_schema NOT LIKE 'pg\\_temp\\_%' AND table_schema NOT LIKE 'pg\\_toast\\_temp\\_%' ${limit}` }
  }
  if (d === 'mysql') {
    if (sc !== undefined) return { sql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${lit(sc)} ${limit}` }
    return { sql: `SELECT CONCAT(table_schema,'.',table_name) AS name FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ${limit}` }
  }
  return { sql: `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' ${limit}` }
}

/** `scope` is the label (explicit, else effective, else ''); `scoped` is false for the all-user-schemas fallback, whose names are already `schema.table`. */
export interface CatalogList { scope: string; names: string[]; truncated: boolean; scoped: boolean }
export type CatalogResult = { ok: true; list: CatalogList } | { ok: false; reason: 'unsupported' | 'invalid-scope' | 'denied' | 'failed' }

export function createCatalog(bridge: Pick<HostBridge, 'queryData'>): {
  listTables(conn: { connectionId: string; dbType: string; database?: string; schema?: string }, scope?: string): Promise<CatalogResult>
  /** Forgets transient failures: call at the start of every user turn (a denial stays remembered until clear()). */
  newTurn(): void
  clear(): void
} {
  const denied = new Set<string>()
  const failedThisTurn = new Map<string, 'failed'>()
  const cache = new Map<string, CatalogList>()
  let epoch = 0
  return {
    async listTables(conn, scope) {
      const d = catalogDialectOf(conn.dbType)
      if (!d) return { ok: false, reason: 'unsupported' }
      const sc = d === 'sqlite' ? '' : scope ?? ''
      const eff = d === 'postgres' ? conn.schema : d === 'mysql' ? conn.database : undefined
      const label = sc || (eff ?? '')
      const q = buildCatalogQuery(d, sc, { database: conn.database, schema: conn.schema })
      if (!q) return { ok: false, reason: 'invalid-scope' }
      const key = `${conn.connectionId}|${conn.database ?? ''}|${conn.schema ?? ''}|${sc}|${label}`
      const hit = cache.get(key)
      if (hit) return { ok: true, list: hit }
      if (denied.has(conn.connectionId)) return { ok: false, reason: 'denied' }
      if (failedThisTurn.has(key)) return { ok: false, reason: 'failed' }
      const mine = epoch
      try {
        const r = await bridge.queryData({ connectionId: conn.connectionId, database: conn.database, schema: conn.schema, sql: q.sql, maxRows: CATALOG_ROW_CAP + 1 })
        const all = r.rows.map((row) => String(row[0] ?? '')).filter((n) => n !== '')
        const list: CatalogList = {
          scope: label,
          names: all.slice(0, CATALOG_ROW_CAP).map((n) => (sc ? `${sc}.${n}` : n)),
          truncated: all.length > CATALOG_ROW_CAP || !!r.truncated,
          scoped: d === 'sqlite' || label !== '',
        }
        if (mine === epoch) cache.set(key, list)
        return { ok: true, list }
      } catch (e) {
        if (mapHostError(e).code === 'NOT_GRANTED') {
          if (mine === epoch) denied.add(conn.connectionId)
          return { ok: false, reason: 'denied' }
        }
        if (mine === epoch) failedThisTurn.set(key, 'failed')
        return { ok: false, reason: 'failed' }
      }
    },
    newTurn() { failedThisTurn.clear() },
    clear() { epoch++; cache.clear(); denied.clear(); failedThisTurn.clear() },
  }
}

export function notebookTables(blocks: { type: string; content?: string }[]): string[] {
  const seen = new Set<string>()
  for (const b of blocks) {
    if (b.type !== 'sql') continue
    for (const r of extractTableRefs(b.content ?? '')) { seen.add(r); if (seen.size >= MAX_NOTEBOOK_TABLES) return [...seen] }
  }
  return [...seen]
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function mentionedTables(userText: string, names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    if (!n) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${reEsc(n)}(?![\\p{L}\\p{N}_$])`, 'iu')
    if (re.test(userText)) { out.push(n); if (out.length >= MAX_NEED_TABLES) break }
  }
  return out
}
