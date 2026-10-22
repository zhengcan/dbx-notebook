import type { HostBridge } from '../host/bridge'

export interface CatalogConn { id: string; dialect: string; database?: string }
export interface CatalogSql { databases?: string; schemas?: string }

const PG = {
  databases: 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname',
  schemas: "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY schema_name",
}
const SHOW = { databases: 'SHOW DATABASES' }
const MSSQL = { databases: 'SELECT name FROM sys.databases ORDER BY name', schemas: 'SELECT name FROM sys.schemas ORDER BY name' }
const TABLE: Record<string, CatalogSql> = {}
for (const k of ['postgres', 'postgresql', 'cockroach', 'cockroachdb', 'redshift', 'greenplum']) TABLE[k] = PG
for (const k of ['mysql', 'mariadb', 'tidb', 'doris', 'starrocks', 'clickhouse']) TABLE[k] = SHOW
for (const k of ['sqlserver', 'mssql']) TABLE[k] = MSSQL

const NO_SCHEMA = new Set(['mysql', 'mariadb', 'tidb', 'doris', 'starrocks', 'clickhouse', 'sqlite'])

export function dialectHasSchemas(dbType: string): boolean | undefined {
  const k = (dbType ?? '').toLowerCase()
  if (NO_SCHEMA.has(k)) return false
  return TABLE[k] ? true : undefined
}

const MAX = 500

export function dialectCatalogSql(dbType: string): CatalogSql | null {
  const s = TABLE[(dbType ?? '').toLowerCase()]
  return s ? { ...s } : null
}

async function run(bridge: Pick<HostBridge, 'queryData'>, conn: CatalogConn, sql: string | undefined, database?: string): Promise<string[]> {
  if (!sql) return []
  const r = await bridge.queryData({ connectionId: conn.id, database, schema: undefined, sql, maxRows: MAX })
  const seen = new Set<string>()
  for (const row of r.rows) {
    const v = row[0]
    if (v === null || v === undefined) continue
    const s = String(v).trim()
    if (s !== '') seen.add(s)
    if (seen.size >= MAX) break
  }
  return [...seen]
}

export function listDatabases(bridge: Pick<HostBridge, 'queryData'>, conn: CatalogConn): Promise<string[]> {
  return run(bridge, conn, dialectCatalogSql(conn.dialect)?.databases)
}

export function listSchemas(bridge: Pick<HostBridge, 'queryData'>, conn: CatalogConn, database?: string): Promise<string[]> {
  return run(bridge, conn, dialectCatalogSql(conn.dialect)?.schemas, database ?? conn.database)
}

export function createCatalogCache(bridge: Pick<HostBridge, 'queryData'>) {
  const dbs = new Map<string, Promise<string[]>>()
  const schemas = new Map<string, Promise<string[]>>()
  const cached = (m: Map<string, Promise<string[]>>, key: string, load: () => Promise<string[]>) => {
    const hit = m.get(key)
    if (hit) return hit
    const p = load()
    m.set(key, p)
    p.catch(() => { if (m.get(key) === p) m.delete(key) })
    return p
  }
  return {
    getDatabases: (conn: CatalogConn) => cached(dbs, conn.id, () => listDatabases(bridge, conn)),
    getSchemas: (conn: CatalogConn, database?: string) =>
      cached(schemas, JSON.stringify([conn.id, database ?? conn.database ?? null]), () => listSchemas(bridge, conn, database)),
    clear(connectionId?: string) {
      if (connectionId === undefined) { dbs.clear(); schemas.clear(); return }
      dbs.delete(connectionId)
      for (const k of [...schemas.keys()]) if ((JSON.parse(k) as unknown[])[0] === connectionId) schemas.delete(k)
    },
  }
}
