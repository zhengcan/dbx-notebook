import { describe, it, expect, vi } from 'vitest'
import { dialectHasSchemas, listDatabases, listSchemas, dialectCatalogSql, createCatalogCache } from '../src/run/catalog'
import { HostError } from '../src/host/bridge'

const res = (rows: unknown[][]) => ({ columns: [{ name: 'x' }], rows, truncated: false, elapsedMs: 0, dialect: 'x' })
const mk = (impl?: (req: any) => any) => {
  const queryData = vi.fn(async (req: any) => (impl ? impl(req) : res([['a']])))
  return { bridge: { queryData } as any, queryData }
}
const pg = { id: 'c1', dialect: 'postgres' }

describe('dialectCatalogSql', () => {
  it('postgres family', () => {
    for (const d of ['postgres', 'PostgreSQL', 'cockroach', 'cockroachdb', 'redshift', 'greenplum']) {
      expect(dialectCatalogSql(d)).toEqual({
        databases: 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname',
        schemas: "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' ORDER BY schema_name",
      })
    }
  })
  it('mysql family and clickhouse: databases only', () => {
    for (const d of ['mysql', 'mariadb', 'tidb', 'doris', 'starrocks', 'clickhouse']) {
      expect(dialectCatalogSql(d)).toEqual({ databases: 'SHOW DATABASES' })
    }
  })
  it('sqlserver', () => {
    for (const d of ['sqlserver', 'mssql']) {
      expect(dialectCatalogSql(d)).toEqual({ databases: 'SELECT name FROM sys.databases ORDER BY name', schemas: 'SELECT name FROM sys.schemas ORDER BY name' })
    }
  })
  it('sqlite and unknown are null', () => {
    expect(dialectCatalogSql('sqlite')).toBeNull()
    expect(dialectCatalogSql('oracle')).toBeNull()
  })
})

describe('listDatabases / listSchemas', () => {
  it('postgres databases query with maxRows 500', async () => {
    const { bridge, queryData } = mk()
    expect(await listDatabases(bridge, pg)).toEqual(['a'])
    expect(queryData).toHaveBeenCalledWith({
      connectionId: 'c1', database: undefined, schema: undefined,
      sql: 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname', maxRows: 500,
    })
  })
  it('schemas pass the chosen database', async () => {
    const { bridge, queryData } = mk()
    await listSchemas(bridge, { ...pg, database: 'conn_db' }, 'biz')
    expect(queryData.mock.calls[0][0]).toMatchObject({ connectionId: 'c1', database: 'biz', maxRows: 500 })
    await listSchemas(bridge, { ...pg, database: 'conn_db' })
    expect(queryData.mock.calls[1][0].database).toBe('conn_db')
  })
  it('sqlite never calls queryData', async () => {
    const { bridge, queryData } = mk()
    expect(await listDatabases(bridge, { id: 's', dialect: 'sqlite' })).toEqual([])
    expect(await listSchemas(bridge, { id: 's', dialect: 'sqlite' })).toEqual([])
    expect(queryData).not.toHaveBeenCalled()
  })
  it('mysql has no schema list', async () => {
    const { bridge, queryData } = mk()
    expect(await listSchemas(bridge, { id: 'm', dialect: 'mysql' })).toEqual([])
    expect(queryData).not.toHaveBeenCalled()
  })
  it('first column, stringify, trim, drop empty, dedupe, cap 500', async () => {
    const { bridge } = mk(() => res([[' a ', 1], ['', 2], [null, 3], ['a', 4], [7, 5], ['b']]))
    expect(await listDatabases(bridge, pg)).toEqual(['a', '7', 'b'])
    const many = mk(() => res(Array.from({ length: 800 }, (_, i) => [`d${i}`])))
    expect((await listDatabases(many.bridge, pg)).length).toBe(500)
  })
  it('throws HostError on failure', async () => {
    const { bridge } = mk(() => { throw new HostError('NOT_OPEN', 'no') })
    await expect(listDatabases(bridge, pg)).rejects.toMatchObject({ code: 'NOT_OPEN' })
  })
})

describe('createCatalogCache', () => {
  it('caches successes, shares concurrent requests', async () => {
    const { bridge, queryData } = mk()
    const c = createCatalogCache(bridge)
    const [a, b] = await Promise.all([c.getDatabases(pg), c.getDatabases(pg)])
    expect(a).toEqual(b)
    await c.getDatabases(pg)
    expect(queryData).toHaveBeenCalledTimes(1)
    await c.getSchemas(pg, 'x'); await c.getSchemas(pg, 'x'); await c.getSchemas(pg, 'y')
    expect(queryData).toHaveBeenCalledTimes(3)
  })
  it('does not cache failures', async () => {
    let fail = true
    const { bridge, queryData } = mk(() => { if (fail) throw new HostError('UNKNOWN', 'x'); return res([['a']]) })
    const c = createCatalogCache(bridge)
    await expect(c.getDatabases(pg)).rejects.toBeTruthy()
    fail = false
    expect(await c.getDatabases(pg)).toEqual(['a'])
    expect(queryData).toHaveBeenCalledTimes(2)
  })
  it('clear(connectionId) and clear()', async () => {
    const { bridge, queryData } = mk()
    const c = createCatalogCache(bridge)
    await c.getDatabases(pg); await c.getDatabases({ id: 'c2', dialect: 'postgres' })
    c.clear('c1')
    await c.getDatabases(pg); await c.getDatabases({ id: 'c2', dialect: 'postgres' })
    expect(queryData).toHaveBeenCalledTimes(3)
    c.clear()
    await c.getDatabases(pg)
    expect(queryData).toHaveBeenCalledTimes(4)
  })
})

describe('dialectHasSchemas', () => {
  it('table', () => {
    for (const d of ['postgres', 'PostgreSQL', 'redshift', 'sqlserver', 'mssql']) expect(dialectHasSchemas(d)).toBe(true)
    for (const d of ['mysql', 'mariadb', 'tidb', 'doris', 'starrocks', 'clickhouse', 'sqlite']) expect(dialectHasSchemas(d)).toBe(false)
    expect(dialectHasSchemas('oracle')).toBeUndefined()
  })
})
