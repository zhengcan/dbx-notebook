import { describe, it, expect, vi } from 'vitest'
import { HostError } from '../src/host/bridge'
import { buildCatalogQuery, catalogDialectOf, createCatalog, mentionedTables, notebookTables, validCatalogScope, CATALOG_ROW_CAP } from '../src/ai/catalog'
import * as safety from '../src/ai/sqlSafety'

const rows = (n: number) => Array.from({ length: n }, (_, i) => [`t${String(i).padStart(3, '0')}`])
const mk = (impl?: (req: any) => any) => {
  const queryData = vi.fn(async (req: any) => (impl ? impl(req) : { columns: [{ name: 'name' }], rows: [['a'], ['b']], truncated: false, elapsedMs: 1, dbType: 'postgres' }))
  return { queryData, cat: createCatalog({ queryData } as any) }
}
const conn = { connectionId: 'c1', dbType: 'postgres', database: 'db1', schema: 's1' }

describe('buildCatalogQuery', () => {
  const PG_ALL = "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') AND table_schema NOT LIKE 'pg\\_temp\\_%' AND table_schema NOT LIKE 'pg\\_toast\\_temp\\_%' ORDER BY 1 LIMIT 301"
  const MY_ALL = "SELECT CONCAT(table_schema,'.',table_name) AS name FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1 LIMIT 301"
  it('fixed statement per dialect and scope case; never current_schema()/DATABASE()', () => {
    expect(buildCatalogQuery('postgres')!.sql).toBe(PG_ALL)
    expect(buildCatalogQuery('mysql')!.sql).toBe(MY_ALL)
    expect(buildCatalogQuery('postgres', '', { schema: '' })!.sql).toBe(PG_ALL)
    expect(buildCatalogQuery('postgres', undefined, { database: 'db' })!.sql).toBe(PG_ALL)
    expect(buildCatalogQuery('sqlite')!.sql).toBe("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' ORDER BY 1 LIMIT 301")
    expect(buildCatalogQuery('postgres', 'public')!.sql).toBe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1 LIMIT 301")
    expect(buildCatalogQuery('postgres', undefined, { schema: 'analytics', database: 'x' })!.sql).toBe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'analytics' ORDER BY 1 LIMIT 301")
    expect(buildCatalogQuery('postgres', 'sales', { schema: 'analytics' })!.sql).toContain("'sales'")
    expect(buildCatalogQuery('mysql', 'my db')!.sql).toBe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'my db' ORDER BY 1 LIMIT 301")
    expect(buildCatalogQuery('mysql', undefined, { database: 'shop', schema: 'ignored' })!.sql).toBe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'shop' ORDER BY 1 LIMIT 301")
    expect(buildCatalogQuery('sqlite', 'ignored', { schema: 'x' })!.sql).toBe(buildCatalogQuery('sqlite')!.sql)
    for (const sql of [PG_ALL, MY_ALL]) expect(sql).not.toMatch(/current_schema|DATABASE\(\)/i)
  })
  it('hostile effective scopes are rejected too', () => {
    expect(buildCatalogQuery('postgres', undefined, { schema: "a'b" })).toBeNull()
    expect(buildCatalogQuery('mysql', undefined, { database: 'a"b' })).toBeNull()
  })
  it('rejects hostile scopes (quotes, semicolons, comments, backslash, control, >64)', () => {
    for (const s of ["o'brien", "x'; DROP TABLE t;--", 'a;b', 'a--b'.replace('--', '/*'), 'a\\b', '"q"', 'a\nb', 'x'.repeat(65), '`x`', 'a)b']) {
      expect(buildCatalogQuery('postgres', s), s).toBeNull()
      expect(buildCatalogQuery('mysql', s), s).toBeNull()
      expect(validCatalogScope(s)).toBe(false)
    }
    expect(buildCatalogQuery('postgres', 'x'.repeat(64))).not.toBeNull()
    expect(buildCatalogQuery('postgres', 'schéma_数据$1.a-b')!.sql).toContain("'schéma_数据$1.a-b'")
  })
  it('statement text has no input except the escaped literal', () => {
    const sql = buildCatalogQuery('postgres', 'Sales 2024')!.sql
    expect(sql).toBe("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'Sales 2024' ORDER BY 1 LIMIT 301")
    expect(sql.match(/'/g)!.length).toBe(2)
  })
})

describe('createCatalog: scope beyond the session schema (user report)', () => {
  const db: Record<string, string[][]> = { sales: [['orders'], ['items']], hr: [['staff']] }
  const bySql = (req: any) => {
    const m = /table_schema = '([^']*)'/.exec(req.sql)
    if (m) return { columns: [], rows: db[m[1]] ?? [], truncated: false }
    return { columns: [], rows: Object.entries(db).flatMap(([sc, ts]) => ts.map((t) => [`${sc}.${t[0]}`])), truncated: false }
  }
  it('block schema sales → only the sales tables, unprefixed, scoped', async () => {
    const { cat } = mk(bySql)
    const r = await cat.listTables({ connectionId: 'c1', dbType: 'postgres', schema: 'sales' })
    expect(r).toEqual({ ok: true, list: { scope: 'sales', names: ['orders', 'items'], truncated: false, scoped: true } })
  })
  it('no schema → prefixed names from several schemas, scoped false', async () => {
    const { cat } = mk(bySql)
    const r = await cat.listTables({ connectionId: 'c1', dbType: 'postgres' })
    expect(r.ok && r.list).toEqual({ scope: '', names: ['sales.orders', 'sales.items', 'hr.staff'], truncated: false, scoped: false })
  })
  it('explicit scope (NEED_LIST) prefixes; mysql uses the database; empty is ok with names []', async () => {
    const { queryData, cat } = mk(bySql)
    const r = await cat.listTables({ connectionId: 'c1', dbType: 'postgres', schema: 'sales' }, 'hr')
    expect(r.ok && r.list.names).toEqual(['hr.staff'])
    const e = await cat.listTables({ connectionId: 'c1', dbType: 'mysql', database: 'nothing' })
    expect(e).toEqual({ ok: true, list: { scope: 'nothing', names: [], truncated: false, scoped: true } })
    expect(queryData.mock.calls[1][0].sql).toContain("table_schema = 'nothing'")
  })
  it('hostile effective schema → invalid-scope, no query; scopes do not share cache entries', async () => {
    const { queryData, cat } = mk(bySql)
    expect(await cat.listTables({ connectionId: 'c1', dbType: 'postgres', schema: "a'b" })).toEqual({ ok: false, reason: 'invalid-scope' })
    expect(queryData).not.toHaveBeenCalled()
    await cat.listTables({ connectionId: 'c1', dbType: 'postgres', schema: 'sales' })
    await cat.listTables({ connectionId: 'c1', dbType: 'postgres', schema: 'hr' })
    expect(queryData).toHaveBeenCalledTimes(2)
  })
})

describe('catalogDialectOf', () => {
  it('maps and returns null for oracle/mssql', () => {
    expect(['postgres', 'PostgreSQL', 'pg'].map(catalogDialectOf)).toEqual(['postgres', 'postgres', 'postgres'])
    expect(['mysql', 'MariaDB'].map(catalogDialectOf)).toEqual(['mysql', 'mysql'])
    expect(catalogDialectOf('sqlite')).toBe('sqlite')
    expect(catalogDialectOf('oracle')).toBeNull()
    expect(catalogDialectOf('mssql')).toBeNull()
  })
})

describe('createCatalog.listTables', () => {
  it('sends one queryData with the connection id/database/schema and maxRows 301; caps to 300, truncated', async () => {
    const { queryData, cat } = mk(() => ({ columns: [], rows: rows(301), truncated: false }))
    const r = await cat.listTables(conn)
    expect(queryData).toHaveBeenCalledTimes(1)
    expect(queryData.mock.calls[0][0]).toEqual({ connectionId: 'c1', database: 'db1', schema: 's1', sql: buildCatalogQuery('postgres', '', { schema: 's1' })!.sql, maxRows: 301 })
    expect(r.ok && r.list.names.length).toBe(CATALOG_ROW_CAP)
    expect(r.ok && r.list.truncated).toBe(true)
  })
  it('exactly 300 rows is not truncated; scope qualifies names', async () => {
    const { cat } = mk(() => ({ columns: [], rows: rows(300), truncated: false }))
    const r = await cat.listTables(conn, 'sales')
    expect(r.ok && r.list.truncated).toBe(false)
    expect(r.ok && r.list.names[0]).toBe('sales.t000')
  })
  it('caches; clear() re-queries', async () => {
    const { queryData, cat } = mk()
    await cat.listTables(conn); await cat.listTables(conn)
    expect(queryData).toHaveBeenCalledTimes(1)
    await cat.listTables({ ...conn, schema: 's2' })
    expect(queryData).toHaveBeenCalledTimes(2)
    cat.clear()
    await cat.listTables(conn)
    expect(queryData).toHaveBeenCalledTimes(3)
  })
  it('never calls analyzeSql', async () => {
    const spy = vi.spyOn(safety, 'analyzeSql')
    const { cat } = mk()
    await cat.listTables(conn)
    expect(spy).not.toHaveBeenCalled()
  })
  it('unsupported dialect / invalid scope → ok:false, zero queryData', async () => {
    const { queryData, cat } = mk()
    expect(await cat.listTables({ ...conn, dbType: 'oracle' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(await cat.listTables(conn, "x';--")).toEqual({ ok: false, reason: 'invalid-scope' })
    expect(queryData).not.toHaveBeenCalled()
  })
  it('rejection → failed without throwing; NOT_GRANTED → denied; across turns failures are retried', async () => {
    let n = 0
    const { queryData, cat } = mk(() => { n++; if (n === 1) throw new Error('boom'); if (n === 2) throw new HostError('NOT_GRANTED', 'no'); return { columns: [], rows: [['a']], truncated: false } })
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'failed' })
    cat.newTurn()
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'denied' })
    cat.clear()
    expect((await cat.listTables(conn)).ok).toBe(true)
    expect(queryData).toHaveBeenCalledTimes(3)
  })
})

describe('denial and failure memory', () => {
  const deny = () => { throw new HostError('NOT_GRANTED', 'no') }
  it('denied is remembered per connection: later calls (any scope) do not query again; clear() forgets it', async () => {
    const { queryData, cat } = mk(deny)
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'denied' })
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'denied' })
    expect(await cat.listTables(conn, 'other')).toEqual({ ok: false, reason: 'denied' })
    cat.newTurn()
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'denied' })
    expect(queryData).toHaveBeenCalledTimes(1)
    cat.clear()
    await cat.listTables(conn)
    expect(queryData).toHaveBeenCalledTimes(2)
  })
  it('a denial of another connection is independent', async () => {
    const { queryData, cat } = mk(deny)
    await cat.listTables(conn)
    await cat.listTables({ ...conn, connectionId: 'c2' })
    expect(queryData).toHaveBeenCalledTimes(2)
  })
  it('a transient failure is not retried within the turn but is retried on the next turn', async () => {
    let n = 0
    const { queryData, cat } = mk(() => { n++; if (n === 1) throw new Error('boom'); return { columns: [], rows: [['a']], truncated: false } })
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'failed' })
    expect(await cat.listTables(conn)).toEqual({ ok: false, reason: 'failed' })
    expect(queryData).toHaveBeenCalledTimes(1)
    cat.newTurn()
    expect((await cat.listTables(conn)).ok).toBe(true)
    expect(queryData).toHaveBeenCalledTimes(2)
  })
})

describe('helpers', () => {
  it('mentionedTables matches whole words case-insensitively, caps at 8', () => {
    expect(mentionedTables('show me ORDERS and users_old', ['orders', 'users', 'order'])).toEqual(['orders'])
    expect(mentionedTables('a.b', ['a.b', 'a'])).toEqual(['a.b', 'a'])
    const names = Array.from({ length: 12 }, (_, i) => `t${i}`)
    expect(mentionedTables(names.join(' '), names)).toHaveLength(8)
  })
  it('notebookTables unions refs from sql blocks only', () => {
    expect(notebookTables([
      { type: 'sql', content: 'select * from a join b on 1' },
      { type: 'markdown', content: 'select * from md' },
      { type: 'sql', content: 'select * from a' },
    ])).toEqual(['a', 'b'])
  })
})
