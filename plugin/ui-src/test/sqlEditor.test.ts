import { describe, it, expect, vi } from 'vitest'
import { dialectForDbType, extractTableNames, createColumnCompletion } from '../src/editor/sqlEditor'

describe('dialectForDbType', () => {
  it.each([
    ['postgres', 'PostgreSQL'], ['PostgreSQL', 'PostgreSQL'], ['cockroach', 'PostgreSQL'], ['redshift', 'PostgreSQL'], ['greenplum', 'PostgreSQL'],
    ['mysql', 'MySQL'], ['mariadb', 'MySQL'], ['tidb', 'MySQL'], ['doris', 'MySQL'], ['starrocks', 'MySQL'],
    ['sqlite', 'SQLite'], ['sqlserver', 'MSSQL'], ['mssql', 'MSSQL'], ['oracle', 'StandardSQL'], ['', 'StandardSQL'],
  ])('%s -> %s', (db, d) => expect(dialectForDbType(db)).toBe(d))
})

describe('extractTableNames', () => {
  it('finds from/join/update/into', () => {
    expect(extractTableNames('select * from a join b on 1=1; update c set x=1; insert into d values (1)')).toEqual(['a', 'b', 'c', 'd'])
  })
  it('handles schema.table and quoting', () => {
    expect(extractTableNames('select 1 from public.users u join "My T" on 1 join `x` join [dbo].[y]')).toEqual(['public.users', 'My T', 'x', 'dbo.y'])
  })
  it('ignores comments and strings; dedups', () => {
    const sql = "select 'x from fake' as s, 1 -- from c1\n from t /* from c2 */ join t on 1 where a = 'join z'"
    expect(extractTableNames(sql)).toEqual(['t'])
  })
})

describe('extractTableNames robustness', () => {
  it('dollar-quoted strings', () => {
    expect(extractTableNames('select $$ from hid $$ from real')).toEqual(['real'])
    expect(extractTableNames('select $t$ from hid $t$ from real2')).toEqual(['real2'])
  })
  it('backslash-escaped quotes', () => {
    expect(extractTableNames("select 'it\\'s from hid' from real")).toEqual(['real'])
    expect(extractTableNames("select 'a\\' from real")).toEqual(['real'])
  })
  it('nested comments', () => {
    expect(extractTableNames('select /* a /* from x */ from y */ 1 from real')).toEqual(['real'])
  })
  it('comma lists', () => {
    expect(extractTableNames('select 1 from a, b x, c as y where 1')).toEqual(['a', 'b', 'c'])
    expect(extractTableNames('select 1 from a join b on 1 group by 1')).toEqual(['a', 'b'])
  })
  it('function FROM and FOR UPDATE', () => {
    expect(extractTableNames('select extract(year FROM col), substring(x FROM 1), trim(both FROM x) from t for update')).toEqual(['t'])
  })
})

describe('column completion', () => {
  it('offers columns, caches, and clears', async () => {
    const columnsFor = vi.fn(async (_t: string) => ['id', 'name'])
    const c = createColumnCompletion({ columnsFor })
    const a = await c.names('select * from users')
    expect(a.map((x) => x.label)).toEqual(['id', 'name'])
    await c.names('select * from users')
    expect(columnsFor).toHaveBeenCalledTimes(1)
    c.clearCache()
    await c.names('select * from users')
    expect(columnsFor).toHaveBeenCalledTimes(2)
  })
  it('stale in-flight rejection after clearCache does not evict the new entry', async () => {
    let rejectOld!: (e: Error) => void
    const columnsFor = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((_r, rej) => { rejectOld = rej }))
      .mockImplementation(async () => ['new'])
    const c = createColumnCompletion({ columnsFor })
    const old = c.names('select * from t')
    c.clearCache()
    expect((await c.names('select * from t')).map((x) => x.label)).toEqual(['new'])
    rejectOld(new Error('late'))
    await old
    expect((await c.names('select * from t')).map((x) => x.label)).toEqual(['new'])
    expect(columnsFor).toHaveBeenCalledTimes(2)
  })
  it('swallows errors', async () => {
    const c = createColumnCompletion({ columnsFor: async () => { throw new Error('x') } })
    await expect(c.names('select * from users')).resolves.toEqual([])
  })
  it('includes completionTables', async () => {
    const c = createColumnCompletion({ completionTables: async () => ['orders'] })
    expect((await c.names('select')).map((x) => x.label)).toEqual(['orders'])
  })
})
