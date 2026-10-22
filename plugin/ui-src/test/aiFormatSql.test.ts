import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatAiSql, formatterLanguage, FORMAT_MAX_CHARS, normalizeSql } from '../src/ai/formatSql'
import { analyzeSql } from '../src/ai/sqlSafety'

const ok = async (sql: string, db = 'postgres') => {
  const r = await formatAiSql(sql, db)
  if (!r.ok) throw new Error('format failed: ' + r.reason)
  return r.sql
}
afterEach(() => vi.useRealTimers())

describe('formatAiSql', () => {
  it('applies defaults', async () => {
    const out = await ok('select a,b from t where x=1 and y=2')
    expect(out).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2')
  })
  it('keeps placeholders byte-identical', async () => {
    for (const s of ['select * from t where d >= {{ from_date }}', 'select * from t where a={{x}} and b in ({{ ys }})', 'select a_1 from t where z = {{  v_2  }}']) {
      const out = await ok(s)
      for (const m of s.match(/\{\{[^}]*\}\}/g)!) expect(out).toContain(m)
    }
  })
  it('leaves strings and comments untouched', async () => {
    const out = await ok("select 'a {{ x }} -- b' as s from t -- note {{ y }}\nwhere  1=1")
    expect(out).toContain("'a {{ x }} -- b'")
    expect(out).toContain('-- note {{ y }}')
  })
  it('is idempotent', async () => {
    const once = await ok('select a,b from t where x={{ p }} and y in (select 1)')
    expect(await ok(once)).toBe(once)
  })
  it('maps dialects', () => {
    const t: [string, string][] = [['postgres', 'postgresql'], ['postgresql', 'postgresql'], ['cockroach', 'postgresql'], ['redshift', 'postgresql'], ['greenplum', 'postgresql'],
      ['mysql', 'mysql'], ['mariadb', 'mysql'], ['tidb', 'mysql'], ['doris', 'mysql'], ['starrocks', 'mysql'], ['sqlite', 'sqlite'], ['sqlserver', 'transactsql'], ['mssql', 'transactsql'], ['clickhouse', 'sql'], ['weird', 'sql']]
    for (const [a, b] of t) expect(formatterLanguage(a)).toBe(b)
  })
  it('over-cap returns original without importing', async () => {
    const load = vi.fn()
    const s = 'select ' + '1,'.repeat(FORMAT_MAX_CHARS)
    expect(await formatAiSql(s, 'postgres', { load })).toEqual({ ok: false, sql: s, reason: 'too-long' })
    expect(load).not.toHaveBeenCalled()
  })
  it('returns original on throw, empty, multi-statement, xml', async () => {
    const boom = { load: async () => ({ format: () => { throw new Error('x') } }) }
    expect(await formatAiSql('select 1', 'sql', boom)).toEqual({ ok: false, sql: 'select 1', reason: 'failed' })
    expect(await formatAiSql('  ', 'sql')).toMatchObject({ ok: false, reason: 'empty' })
    expect(await formatAiSql('select 1; select 2', 'sql')).toMatchObject({ ok: false, sql: 'select 1; select 2', reason: 'multiple' })
    expect(await formatAiSql('<a>select</a>', 'sql')).toMatchObject({ ok: false, sql: '<a>select</a>', reason: 'xml' })
  })
  it('times out on a hanging formatter', async () => {
    vi.useFakeTimers()
    const p = formatAiSql('select 1', 'sql', { load: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(2001)
    expect(await p).toEqual({ ok: false, sql: 'select 1', reason: 'timeout' })
  })
  it('rejects a formatter that changes semantics', async () => {
    const evil = { load: async () => ({ format: (s: string) => s.replace(/select/i, 'DELETE') }) }
    expect(await formatAiSql('SELECT * FROM t', 'sql', evil)).toEqual({ ok: false, sql: 'SELECT * FROM t', reason: 'changed-semantics' })
  })
  it('rejects a token-changing formatter even with equal classification', async () => {
    const evil = { load: async () => ({ format: (s: string) => s.replace('a', 'b') }) }
    expect(await formatAiSql('SELECT a FROM t', 'sql', evil)).toMatchObject({ ok: false, reason: 'changed-semantics' })
  })
  it('normalizeSql ignores whitespace and keyword case but not quoted case', () => {
    expect(normalizeSql("Select  'A' \n from T")).toBe("select'A'fromt")
  })
  it('keeps classification over a corpus', async () => {
    const corpus = ['select 1', 'select a,b from t where x=1', 'with c as (select 1) select * from c', 'with c as (delete from t returning *) select * from c',
      'insert into t values (1)', 'update t set a=1 where b=2', 'delete from t', 'drop table t', '-- hi\nselect 1', '/* c */ select 1', 'select 1; select 2',
      'select * from t for update', 'select * into x from t', 'select "A" from `b`', 'select * from t where a = {{ p }}', 'truncate t', 'select a from t order by 1 limit 5', 'create table x (a int)']
    expect(corpus.length).toBeGreaterThanOrEqual(15)
    for (const s of corpus) {
      const r = await formatAiSql(s, 'postgres')
      expect(analyzeSql(r.sql)).toEqual(analyzeSql(s))
    }
  })
})
