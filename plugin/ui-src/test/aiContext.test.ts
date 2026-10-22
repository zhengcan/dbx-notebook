import { describe, it, expect, vi } from 'vitest'
import { extractTableRefs, createSchemaCache, summarizeResult } from '../src/ai/context'
import type { QueryResult } from '../src/host/bridge'

const qr = (rows: unknown[][], cols = ['a'], truncated = false): QueryResult =>
  ({ columns: cols.map((name) => ({ name })), rows, truncated, elapsedMs: 1, dbType: 'sqlite' })

describe('extractTableRefs', () => {
  it('handles from/join with quoting', () => {
    expect(extractTableRefs('SELECT * FROM a JOIN "b"."c" x ON 1=1')).toEqual(['a', 'b.c'])
    expect(extractTableRefs('select * from `db`.`t1` join [dbo].[t2] on 1')).toEqual(['db.t1', 'dbo.t2'])
  })
  it('update/into', () => {
    expect(extractTableRefs('INSERT INTO x(a) VALUES (1)')).toEqual(['x'])
    expect(extractTableRefs('UPDATE y SET a=1')).toEqual(['y'])
  })
  it('subqueries and CTE names', () => {
    expect(extractTableRefs('select * from (select * from inner_t) s')).toEqual(['inner_t'])
    expect(extractTableRefs('with c as (select 1 from real_t) select * from c')).toEqual(['real_t'])
  })
  it('ignores comments and strings', () => {
    expect(extractTableRefs("select 'from zzz' -- from yyy\n from a /* join www */")).toEqual(['a'])
  })
  it('order by is not a table; dedupes; CJK', () => {
    expect(extractTableRefs('select * from a order by b')).toEqual(['a'])
    expect(extractTableRefs('select * from 订单 join 订单')).toEqual(['订单'])
  })
  it('known limitation: FROM a, b comma lists only yield the first table', () => {
    expect(extractTableRefs('select * from a, b')).toEqual(['a'])
  })
  it('caps at 20', () => {
    const sql = Array.from({ length: 25 }, (_, i) => `join t${i} on 1`).join(' ')
    expect(extractTableRefs('select * from t_first ' + sql)).toHaveLength(20)
  })
})

describe('schema cache', () => {
  const md = { columns: [{ name: 'id', dataType: 'int', nullable: false }] }
  it('caches by key', async () => {
    const getTableMetadata = vi.fn(async () => md)
    const c = createSchemaCache({ getTableMetadata })
    const conn = { connectionId: 'c', database: 'd', schema: 's' }
    expect(await c.get(conn, 't')).toEqual({ name: 't', columns: md.columns })
    await c.get(conn, 't')
    expect(getTableMetadata).toHaveBeenCalledTimes(1)
    await c.get({ connectionId: 'c', database: 'd2', schema: 's' }, 't')
    await c.get({ connectionId: 'c', database: 'd', schema: 's2' }, 't')
    expect(getTableMetadata).toHaveBeenCalledTimes(3)
    c.clear()
    await c.get(conn, 't')
    expect(getTableMetadata).toHaveBeenCalledTimes(4)
  })
  it('failure returns null and is retried', async () => {
    const getTableMetadata = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(md)
    const c = createSchemaCache({ getTableMetadata })
    expect(await c.get({ connectionId: 'c' }, 't')).toBeNull()
    expect(await c.get({ connectionId: 'c' }, 't')).not.toBeNull()
    expect(getTableMetadata).toHaveBeenCalledTimes(2)
  })
  describe('qualified names', () => {
    const mk = () => { const g = vi.fn(async (_r: any) => md); return { g, c: createSchemaCache({ getTableMetadata: g }) } }
    it('postgres: sales.orders → schema param split from the name', async () => {
      const { g, c } = mk()
      const r = await c.get({ connectionId: 'c', dbType: 'postgres', database: 'd', schema: 's' }, 'sales.orders')
      expect(g).toHaveBeenCalledWith({ connectionId: 'c', database: 'd', schema: 'sales', table: 'orders' })
      expect(r?.name).toBe('sales.orders')
    })
    it('mysql: qualifier is the database, not the schema', async () => {
      const { g, c } = mk()
      await c.get({ connectionId: 'c', dbType: 'mysql', database: 'd' }, 'shop.orders')
      expect(g).toHaveBeenCalledWith({ connectionId: 'c', database: 'shop', schema: undefined, table: 'orders' })
    })
    it('unqualified / unknown dialect / hostile qualifier / empty table: conn target, name untouched', async () => {
      const { g, c } = mk()
      await c.get({ connectionId: 'c', dbType: 'postgres', schema: 's' }, 'orders')
      expect(g).toHaveBeenLastCalledWith({ connectionId: 'c', database: undefined, schema: 's', table: 'orders' })
      await c.get({ connectionId: 'c', dbType: 'oracle', schema: 's' }, 'a.b')
      expect(g).toHaveBeenLastCalledWith({ connectionId: 'c', database: undefined, schema: 's', table: 'a.b' })
      await c.get({ connectionId: 'c', dbType: 'postgres', schema: 's' }, "x'y.t")
      expect(g).toHaveBeenLastCalledWith({ connectionId: 'c', database: undefined, schema: 's', table: "x'y.t" })
      await c.get({ connectionId: 'c', dbType: 'postgres', schema: 's' }, 'a.')
      expect(g).toHaveBeenLastCalledWith({ connectionId: 'c', database: undefined, schema: 's', table: 'a.' })
    })
    it('cache key uses the resolved pair', async () => {
      const { g, c } = mk()
      await c.get({ connectionId: 'c', dbType: 'postgres', schema: 'sales' }, 'orders')
      await c.get({ connectionId: 'c', dbType: 'postgres', schema: 'other' }, 'sales.orders')
      expect(g).toHaveBeenCalledTimes(1)
    })
  })
})

describe('summarizeResult', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [i])
  it('50/51 rows', () => {
    const s = summarizeResult(qr(rows(51)))
    expect([s.shownRows, s.totalRows, s.rows.length]).toEqual([50, 51, 50])
    const t = summarizeResult(qr(rows(50)))
    expect([t.shownRows, t.totalRows]).toEqual([50, 50])
  })
  it('cell limits', () => {
    expect(summarizeResult(qr([['x'.repeat(200)]])).rows[0][0]).toBe('x'.repeat(200))
    expect(summarizeResult(qr([['x'.repeat(201)]])).rows[0][0]).toBe('x'.repeat(200) + '…')
  })
  it('value text', () => {
    const s = summarizeResult(qr([[null, 10n, { k: 1 }, '中文']], ['a', 'b', 'c', 'd']))
    expect(s.rows[0]).toEqual(['NULL', '10', '{"k":1}', '中文'])
  })
  it('column stats', () => {
    const s = summarizeResult(qr([[3], [10], [null], [3]]))
    expect(s.columns[0]).toMatchObject({ name: 'a', nulls: 1, distinct: 2, min: '3', max: '10' })
    const t = summarizeResult(qr([['b'], ['a']]))
    expect(t.columns[0]).toMatchObject({ min: 'a', max: 'b' })
  })
  it('stats cover all rows, not just shown', () => {
    const s = summarizeResult(qr(rows(100)))
    expect(s.columns[0].distinct).toBe(100)
    expect(s.columns[0].max).toBe('99')
  })
  it('0 rows and truncated flag', () => {
    const s = summarizeResult(qr([], ['a', 'b'], true))
    expect(s.rows).toEqual([])
    expect(s.columns.map((c) => c.name)).toEqual(['a', 'b'])
    expect(s.truncatedAtRun).toBe(true)
    expect(summarizeResult(qr([])).truncatedAtRun).toBe(false)
  })
})
