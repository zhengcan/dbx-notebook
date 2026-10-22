import { describe, expect, it } from 'vitest'
import type { PivotConfig } from '@sqlnb/format'
import fixtureRaw from '../../backend/result-engine/tests/fixtures/analysis_sql.json?raw'
import { fixtureCases } from './sqlFixtureCases'
import {
  SqlGenError, buildAggregateSql, buildBigNumberSql, buildExcludedCountSql, buildCompareSql, buildFilterWhere, sqlLiteral, columnKind, quoteIdent,
} from '../src/analysis/sql'

const cols = [
  { name: 'region', kind: 'text' as const },
  { name: 'city', kind: 'text' as const },
  { name: 'created at', kind: 'temporal' as const },
  { name: 'amount', kind: 'number' as const },
  { name: 'flag', kind: 'boolean' as const },
  { name: '金额', kind: 'number' as const },
  { name: 'order', kind: 'text' as const },
  { name: '😀', kind: 'text' as const },
]
const cfg = (p: Partial<PivotConfig>): PivotConfig => ({ rows: [], columns: [], values: [], ...p })
const ok = (r: any) => { if ('error' in r) throw new Error(JSON.stringify(r)); return r }
const err = (r: any) => { expect(r && 'error' in r).toBe(true); return r.error }

// splits SQL on double quotes; odd segments are inside a quoted identifier
function outside(sql: string): string {
  const parts = sql.split('"')
  const out: string[] = []
  for (let i = 0; i < parts.length; i += 2) out.push(parts[i])
  // doubled quotes produce empty odd segments sitting between two quoted parts: fine for our asserts
  return out.join('')
}

describe('quoteIdent', () => {
  it('quotes and escapes', () => {
    expect(quoteIdent('a b')).toBe('"a b"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
    expect(quoteIdent('select')).toBe('"select"')
    expect(quoteIdent('金额')).toBe('"金额"')
    expect(quoteIdent('😀')).toBe('"😀"')
  })
  it('rejects NUL, empty, too long', () => {
    for (const n of ['a\u0000b', '', 'x'.repeat(257)]) {
      expect(() => quoteIdent(n)).toThrow(SqlGenError)
    }
    expect(quoteIdent('x'.repeat(256))).toHaveLength(258)
  })
})

describe('columnKind', () => {
  it('maps data types', () => {
    expect(columnKind('integer')).toBe('number')
    expect(columnKind('real')).toBe('number')
    expect(columnKind('decimal')).toBe('number')
    expect(columnKind('date')).toBe('temporal')
    expect(columnKind('timestamp')).toBe('temporal')
    expect(columnKind('boolean')).toBe('boolean')
    expect(columnKind('text')).toBe('text')
    expect(columnKind('blob')).toBe('text')
  })
  it('infers from sample when unknown', () => {
    expect(columnKind('unknown', 3)).toBe('number')
    expect(columnKind(undefined, true)).toBe('boolean')
    expect(columnKind(undefined, '2024-01-05')).toBe('temporal')
    expect(columnKind('unknown', '2024-01-05T10:20:30.5+08:00')).toBe('temporal')
    expect(columnKind('unknown', '2024-01-05 10:20')).toBe('temporal')
    expect(columnKind('unknown', 'hello')).toBe('text')
    expect(columnKind('unknown', null)).toBe('text')
    expect(columnKind(undefined)).toBe('text')
  })
})

describe('columnKind real DB types', () => {
  it('numeric names are numbers (case/precision/unsigned insensitive)', () => {
    for (const t of ['int2', 'INT4', 'int8', 'bigint', 'smallint', 'numeric', 'NUMERIC(10,2)', 'decimal(10, 2)', 'float4', 'float8', 'double precision', 'real', 'money', 'serial', 'bigserial', 'number', 'tinyint', 'mediumint', 'int unsigned', 'BIGINT UNSIGNED', 'double', 'float', 'fixed', 'int', 'tinyint(1) unsigned'])
      expect([t, columnKind(t, 'x')]).toEqual([t, 'number'])
  })
  it('temporal / boolean names', () => {
    for (const t of ['timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone', 'datetime', 'DATE', 'datetime(6)'])
      expect([t, columnKind(t)]).toEqual([t, 'temporal'])
    for (const t of ['bool', 'boolean', 'bit']) expect([t, columnKind(t)]).toEqual([t, 'boolean'])
  })
  it('text-like and arrays are text; declared text is never reinterpreted', () => {
    for (const t of ['varchar', 'varchar(20)', 'char', 'uuid', 'int4[]', '_int4', 'jsonb']) expect([t, columnKind(t, '12.5')]).toEqual([t, 'text'])
  })
  it('numeric strings count as number only when the type is missing/unknown', () => {
    expect(columnKind(undefined, '12.50')).toBe('number')
    expect(columnKind('unknown', '-3')).toBe('number')
    expect(columnKind('weirdtype', '1e5')).toBe('number')
    expect(columnKind(undefined, 'abc')).toBe('text')
    expect(columnKind('text', '12.50')).toBe('text')
  })
})

describe('buildAggregateSql', () => {
  it('basic non-temporal multi row/col/value, exact', () => {
    const r = ok(buildAggregateSql('sales', cfg({
      rows: [{ field: 'region' }, { field: 'city' }],
      columns: [{ field: 'order' }],
      values: [{ field: 'amount', agg: 'sum' }, { field: '', agg: 'count' }],
    }), cols))
    expect(r.sql).toBe(
      'SELECT "region" AS __sqlnb_r0, "city" AS __sqlnb_r1, "order" AS __sqlnb_c0, sum("amount") AS __sqlnb_v0, count(*) AS __sqlnb_v1 FROM "sales" ' +
      'GROUP BY 1, 2, 3 ORDER BY "region" IS NULL, "region", "city" IS NULL, "city", "order" IS NULL, "order"')
    expect(r.dims).toEqual(['__sqlnb_r0', '__sqlnb_r1', '__sqlnb_c0'])
    expect(r.measures).toEqual(['__sqlnb_v0', '__sqlnb_v1'])
    expect(r.nullDateColumns).toEqual([])
  })
  it('no column dims', () => {
    const r = ok(buildAggregateSql('t', cfg({ rows: [{ field: 'region' }], values: [{ field: 'amount', agg: 'avg' }] }), cols))
    expect(r.sql).toBe('SELECT "region" AS __sqlnb_r0, avg("amount") AS __sqlnb_v0 FROM "t" GROUP BY 1 ORDER BY "region" IS NULL, "region"')
    expect(r.dims).toEqual(['__sqlnb_r0'])
  })
  it('no dims at all: no GROUP BY', () => {
    const r = ok(buildAggregateSql('t', cfg({ values: [{ field: 'amount', agg: 'sum' }] }), cols))
    expect(r.sql).toBe('SELECT sum("amount") AS __sqlnb_v0 FROM "t"')
  })
  it('every agg', () => {
    const expected: Record<string, string> = {
      sum: 'sum("amount")', count: 'count("amount")', countDistinct: 'count(DISTINCT "amount")',
      avg: 'avg("amount")', min: 'min("amount")', max: 'max("amount")', median: 'median("amount")',
    }
    for (const [agg, e] of Object.entries(expected)) {
      const r = ok(buildAggregateSql('t', cfg({ values: [{ field: 'amount', agg: agg as any }] }), cols))
      expect(r.sql).toBe(`SELECT ${e} AS __sqlnb_v0 FROM "t"`)
    }
  })
  it('every grain wraps date_trunc with a guard and excludes null buckets', () => {
    for (const g of ['day', 'week', 'month', 'quarter', 'year'] as const) {
      const r = ok(buildAggregateSql('t', cfg({
        rows: [{ field: 'created at', grain: g }], values: [{ field: 'amount', agg: 'sum' }],
      }), cols))
      expect(r.sql).toContain(`THEN date_trunc('${g}', "created at") END AS __sqlnb_r0`)
      expect(r.sql).toMatch(/^SELECT CASE WHEN typeof\("created at"\) = 'text' AND /)
      expect(r.sql).toContain(' IS NOT NULL GROUP BY 1 ORDER BY ')
      expect(r.sql).toContain(' WHERE CASE WHEN ')
      expect(r.nullDateColumns).toEqual(['created at'])
    }
  })
  it('temporal without grain is raw; null excluded', () => {
    const r = ok(buildAggregateSql('t', cfg({ rows: [{ field: 'created at' }], values: [{ field: 'amount', agg: 'sum' }] }), cols))
    expect(r.sql).toBe(
      'SELECT "created at" AS __sqlnb_r0, sum("amount") AS __sqlnb_v0 FROM "t" WHERE "created at" IS NOT NULL ' +
      'GROUP BY 1 ORDER BY "created at" IS NULL, "created at"')
  })
  it('non-temporal ignores grain and keeps NULL groups', () => {
    const r = ok(buildAggregateSql('t', cfg({ rows: [{ field: 'region', grain: 'month' }], values: [{ field: 'amount', agg: 'sum' }] }), cols))
    expect(r.sql).toBe('SELECT "region" AS __sqlnb_r0, sum("amount") AS __sqlnb_v0 FROM "t" GROUP BY 1 ORDER BY "region" IS NULL, "region"')
  })
  it('min/max accept number/temporal/text; count accepts any', () => {
    for (const f of ['amount', 'created at', 'region']) {
      ok(buildAggregateSql('t', cfg({ values: [{ field: f, agg: 'min' }, { field: f, agg: 'max' }] }), cols))
    }
    ok(buildAggregateSql('t', cfg({ values: [{ field: 'flag', agg: 'count' }, { field: 'region', agg: 'countDistinct' }] }), cols))
  })
  it('odd identifiers', () => {
    const r = ok(buildAggregateSql('my table', cfg({
      rows: [{ field: '😀' }, { field: 'order' }], values: [{ field: '金额', agg: 'sum' }],
    }), cols))
    expect(r.sql).toBe(
      'SELECT "😀" AS __sqlnb_r0, "order" AS __sqlnb_r1, sum("金额") AS __sqlnb_v0 FROM "my table" GROUP BY 1, 2 ' +
      'ORDER BY "😀" IS NULL, "😀", "order" IS NULL, "order"')
  })
  it('hostile column and table names stay inside one quoted identifier', () => {
    const evil = 'a"; DROP TABLE t; --'
    const c2 = [...cols, { name: evil, kind: 'text' as const }]
    const r = ok(buildAggregateSql(evil, cfg({ rows: [{ field: evil }], values: [{ field: '', agg: 'count' }] }), c2))
    expect(r.sql).toContain(quoteIdent(evil))
    expect(r.sql).toBe(
      'SELECT "a""; DROP TABLE t; --" AS __sqlnb_r0, count(*) AS __sqlnb_v0 FROM "a""; DROP TABLE t; --" GROUP BY 1 ' +
      'ORDER BY "a""; DROP TABLE t; --" IS NULL, "a""; DROP TABLE t; --"')
    // remove every properly quoted identifier ("" is an escaped quote inside); nothing dangerous may remain
    const stripped = r.sql.replace(/"(?:[^"]|"")*"/g, '""')
    expect(stripped).not.toMatch(/DROP|;|--/)
    expect(outside(r.sql)).not.toContain(';')
  })
  it('tampered grain / agg', () => {
    const v = [{ field: 'amount', agg: 'sum' as const }]
    for (const g of ['month; DROP', 'MONTH', '', "month'"]) {
      expect(err(buildAggregateSql('t', cfg({ rows: [{ field: 'created at', grain: g as any }], values: v }), cols)).code).toBe('BAD_GRAIN')
    }
    for (const a of ['sum)', 'SUM', 'sum(1); --', '']) {
      expect(err(buildAggregateSql('t', cfg({ values: [{ field: 'amount', agg: a as any }] }), cols)).code).toBe('BAD_AGG')
    }
  })
  it('errors', () => {
    expect(err(buildAggregateSql('t', cfg({ rows: [{ field: 'region' }] }), cols)).code).toBe('EMPTY')
    const e = err(buildAggregateSql('t', cfg({ values: [{ field: 'region', agg: 'sum' }] }), cols))
    expect(e.code).toBe('TYPE'); expect(e.field).toBe('region'); expect(typeof e.message).toBe('string')
    for (const a of ['avg', 'median'] as const) {
      expect(err(buildAggregateSql('t', cfg({ values: [{ field: 'created at', agg: a }] }), cols)).code).toBe('TYPE')
    }
    expect(err(buildAggregateSql('t', cfg({ values: [{ field: 'flag', agg: 'min' }] }), cols)).code).toBe('TYPE')
    expect(err(buildAggregateSql('t', cfg({ values: [{ field: 'nope', agg: 'sum' }] }), cols))).toMatchObject({ code: 'BAD_FIELD', field: 'nope' })
    expect(err(buildAggregateSql('t', cfg({ rows: [{ field: 'nope' }], values: [{ field: '', agg: 'count' }] }), cols)).code).toBe('BAD_FIELD')
    expect(err(buildAggregateSql('t', cfg({ values: [{ field: '', agg: 'countDistinct' }] }), cols)).code).toBe('BAD_FIELD')
    expect(err(buildAggregateSql('t', cfg({ rows: [{ field: '' }], values: [{ field: '', agg: 'count' }] }), cols)).code).toBe('BAD_FIELD')
  })
  it('duplicate dims and length limits', () => {
    expect(err(buildAggregateSql('t', cfg({ rows: [{ field: 'region' }], columns: [{ field: 'region' }], values: [{ field: '', agg: 'count' }] }), cols)).code).toBe('BAD_FIELD')
    expect(() => buildAggregateSql('x'.repeat(257), cfg({ values: [{ field: '', agg: 'count' }] }), cols)).toThrow(SqlGenError)
    expect(() => buildAggregateSql('', cfg({ values: [{ field: '', agg: 'count' }] }), cols)).toThrow(SqlGenError)
    const long = [{ name: 'x'.repeat(257), kind: 'number' as const }]
    expect(err(buildAggregateSql('t', cfg({ values: [{ field: 'x'.repeat(257), agg: 'sum' }] }), long)).code).toBe('BAD_FIELD')
  })
})

describe('buildExcludedCountSql', () => {
  it('null without temporal dims', () => {
    expect(buildExcludedCountSql('t', cfg({ rows: [{ field: 'region' }], values: [{ field: '', agg: 'count' }] }), cols)).toBeNull()
  })
  it('raw temporal', () => {
    expect(buildExcludedCountSql('t', cfg({ rows: [{ field: 'created at' }], values: [{ field: '', agg: 'count' }] }), cols))
      .toEqual({ sql: 'SELECT count(*) FROM "t" WHERE "created at" IS NULL' })
  })
  it('grain: guard, OR of several', () => {
    const r = buildExcludedCountSql('t', cfg({
      rows: [{ field: 'created at', grain: 'month' }], columns: [{ field: 'created at', grain: 'year' }],
      values: [{ field: '', agg: 'count' }],
    }), cols) as { sql: string }
    expect(r.sql).toMatch(/^SELECT count\(\*\) FROM "t" WHERE CASE WHEN .* THEN date_trunc\('month', "created at"\) END IS NULL OR CASE WHEN .* THEN date_trunc\('year', "created at"\) END IS NULL$/)
  })
  it('errors surface', () => {
    expect(err(buildExcludedCountSql('t', cfg({ rows: [{ field: 'nope' }] }), cols))).toMatchObject({ code: 'BAD_FIELD' })
  })
})

describe('summaries are client-side', () => {
  it('the totals SQL builder is gone', async () => {
    expect('buildTotalsSql' in (await import('../src/analysis/sql'))).toBe(false)
  })
})

describe('buildBigNumberSql', () => {
  it('aggregates', () => {
    const m: Record<string, string> = {
      sum: 'sum("amount")', avg: 'avg("amount")', mean: 'avg("amount")', average: 'avg("amount")',
      min: 'min("amount")', max: 'max("amount")', count: 'count("amount")', median: 'median("amount")',
    }
    for (const [a, e] of Object.entries(m)) {
      expect(buildBigNumberSql('t', { field: 'amount', aggregate: a }, cols)).toEqual({ sql: `SELECT ${e} FROM "t"` })
    }
  })
  it('first / last', () => {
    expect(buildBigNumberSql('t', { field: 'region', aggregate: 'first' }, cols)).toEqual({ sql: 'SELECT "region" FROM "t" ORDER BY rowid LIMIT 1' })
    expect(buildBigNumberSql('t', { field: 'region', aggregate: 'last' }, cols)).toEqual({ sql: 'SELECT "region" FROM "t" ORDER BY rowid DESC LIMIT 1' })
  })
  it('defaults', () => {
    expect(buildBigNumberSql('t', { field: 'amount' }, cols)).toEqual({ sql: 'SELECT sum("amount") FROM "t"' })
    expect(buildBigNumberSql('t', { field: 'region' }, cols)).toEqual({ sql: 'SELECT count("region") FROM "t"' })
    expect(buildBigNumberSql('t', { field: '' }, cols)).toEqual({ sql: 'SELECT count(*) FROM "t"' })
    expect(buildBigNumberSql('t', { field: '', aggregate: 'count' }, cols)).toEqual({ sql: 'SELECT count(*) FROM "t"' })
  })
  it('errors', () => {
    expect(err(buildBigNumberSql('t', { field: 'region', aggregate: 'sum' }, cols)).code).toBe('TYPE')
    expect(err(buildBigNumberSql('t', { field: 'amount', aggregate: 'sum)' }, cols)).code).toBe('BAD_AGG')
    expect(err(buildBigNumberSql('t', { field: 'nope', aggregate: 'sum' }, cols)).code).toBe('BAD_FIELD')
    expect(err(buildBigNumberSql('t', { field: '', aggregate: 'sum' }, cols)).code).toBe('BAD_FIELD')
  })
  it('hostile', () => {
    const evil = 'a"; DROP TABLE t; --'
    expect(buildBigNumberSql(evil, { field: '', aggregate: 'count' }, cols)).toEqual({ sql: 'SELECT count(*) FROM "a""; DROP TABLE t; --"' })
  })
})

describe('alias collisions', () => {
  const odd = [
    { name: 'r0', kind: 'text' as const }, { name: 'c0', kind: 'text' as const },
    { name: 'v0', kind: 'number' as const }, { name: '__sqlnb_r0', kind: 'text' as const },
  ]
  it('source columns named like old aliases are unaffected', () => {
    const r = ok(buildAggregateSql('t', cfg({
      rows: [{ field: 'r0' }, { field: '__sqlnb_r0' }], columns: [{ field: 'c0' }],
      values: [{ field: 'v0', agg: 'sum' }],
    }), odd))
    expect(r.sql).toBe(
      'SELECT "r0" AS __sqlnb_r0, "__sqlnb_r0" AS __sqlnb_r1, "c0" AS __sqlnb_c0, sum("v0") AS __sqlnb_v0 FROM "t" ' +
      'GROUP BY 1, 2, 3 ORDER BY "r0" IS NULL, "r0", "__sqlnb_r0" IS NULL, "__sqlnb_r0", "c0" IS NULL, "c0"')
  })
})

describe('columnKind offsets', () => {
  it('only accepts +hh:mm offsets (matches the date_trunc guard)', () => {
    expect(columnKind('unknown', '2024-01-05T10:20:30+08:00')).toBe('temporal')
    expect(columnKind('unknown', '2024-01-05T10:20:30+0800')).toBe('text')
  })
})

describe('rust fixture', () => {
  it('is in sync with the generator', () => {
    const onDisk = JSON.parse(fixtureRaw)
    expect(onDisk, 'Rust fixture is stale: run `npm run gen:sql-fixture -w plugin/ui-src` and commit it').toEqual(fixtureCases())
  })
})

describe('big-number distinct, filters and compare SQL', () => {
  const sql = (m: any) => ok(buildBigNumberSql('t', m, cols)).sql as string
  const code = (r: any) => err(r).code
  it('distinct', () => {
    expect(sql({ field: 'region', aggregate: 'distinct' })).toBe('SELECT count(DISTINCT "region") FROM "t"')
    expect(code(buildBigNumberSql('t', { field: '', aggregate: 'distinct' }, cols))).toBe('BAD_FIELD')
  })
  it('each op', () => {
    const w = (f: any) => ok(buildFilterWhere([f], cols)).where
    expect(w({ field: 'amount', op: '=', value: 5 })).toBe('"amount" = 5')
    expect(w({ field: 'amount', op: '!=', value: -5 })).toBe('"amount" <> (-5)')
    expect(w({ field: 'region', op: 'in', value: ['a', 'b'] })).toBe(`"region" IN ('a', 'b')`)
    expect(w({ field: 'region', op: 'notIn', value: ['a'] })).toBe(`"region" NOT IN ('a')`)
    expect(w({ field: 'region', op: 'isNull' })).toBe('"region" IS NULL')
    expect(w({ field: 'region', op: 'notNull' })).toBe('"region" IS NOT NULL')
    expect(w({ field: 'flag', op: '=', value: true })).toBe('"flag" = 1')
    expect(w({ field: 'region', op: 'contains', value: "50%_\\'" })).toBe(String.raw`"region" LIKE '%50\%\_\\''%' ESCAPE '\'`)
    expect(ok(buildFilterWhere(undefined, cols)).where).toBe('')
    expect(sql({ field: 'amount', aggregate: 'sum', filter: [{ field: 'region', op: '=', value: 'a' }, { field: 'amount', op: '>', value: 1 }] }))
      .toBe(`SELECT sum("amount") FROM "t" WHERE "region" = 'a' AND "amount" > 1`)
  })
  it('quotes strings and neutralises injection', () => {
    expect(ok(buildFilterWhere([{ field: 'region', op: '=', value: "O'Brien" }], cols)).where).toBe(`"region" = 'O''Brien'`)
    const q = sql({ field: '', filter: [{ field: 'region', op: '=', value: "'; DROP TABLE t; --" }] })
    expect(q).toBe(`SELECT count(*) FROM "t" WHERE "region" = '''; DROP TABLE t; --'`)
    expect(q.startsWith('SELECT')).toBe(true)
  })
  it('type checks and rejects bad input', () => {
    const f = (x: any) => code(buildFilterWhere([x], cols))
    expect(f({ field: 'amount', op: '=', value: 'x' })).toBe('FILTER')
    expect(f({ field: 'region', op: 'in', value: [] })).toBe('FILTER')
    expect(f({ field: 'region', op: 'in', value: Array(51).fill('a') })).toBe('FILTER')
    expect(f({ field: 'region', op: 'regex; DROP', value: 'a' })).toBe('FILTER')
    expect(f({ field: 'nope', op: '=', value: 'a' })).toBe('FILTER')
    expect(f({ field: 'amount', op: 'contains', value: '1' })).toBe('FILTER')
    expect(f({ field: 'amount', op: '=', value: NaN })).toBe('FILTER')
    expect(f({ field: 'amount', op: '=', value: Infinity })).toBe('FILTER')
    expect(f({ field: 'region', op: 'isNull', value: 'a' })).toBe('FILTER')
    expect(code(buildFilterWhere(Array(6).fill({ field: 'region', op: 'isNull' }), cols))).toBe('FILTER')
    expect(() => sqlLiteral(NaN)).toThrow(SqlGenError)
    expect(sqlLiteral(12345678901234567890n)).toBe('12345678901234567890')
    expect(ok(buildFilterWhere([{ field: 'amount', op: '=', value: 9007199254740993n as any }], cols)).where).toBe('"amount" = 9007199254740993')
  })
  it('quotes field names with double quotes', () => {
    const c = [{ name: 'a"b', kind: 'text' as const }]
    expect(ok(buildFilterWhere([{ field: 'a"b', op: 'isNull' }], c)).where).toBe('"a""b" IS NULL')
  })
  it('compare SQL', () => {
    const r = ok(buildCompareSql('t', { field: 'amount', aggregate: 'sum', filter: [{ field: 'region', op: '=', value: 'a' }], compare: { kind: 'mom', dateField: 'created at' } }, cols))
    expect(r.periodSql).toMatch(/^SELECT max\(CASE WHEN .* THEN substr\("created at", 1, 7\) END\) FROM "t" WHERE "region" = 'a'$/)
    expect(r.valueSql('2026-09')).toMatch(/^SELECT sum\("amount"\) FROM "t" WHERE "region" = 'a' AND \(CASE WHEN .*\) = '2026-09'$/)
    expect(() => r.valueSql("2026-09' OR 1=1")).toThrow(SqlGenError)
    expect(code(buildCompareSql('t', { field: 'amount', compare: { kind: 'qoq', dateField: 'created at' } } as any, cols))).toBe('COMPARE')
    expect(code(buildCompareSql('t', { field: 'amount', compare: { kind: 'mom', dateField: 'region' } }, cols))).toBe('COMPARE')
    expect(code(buildCompareSql('t', { field: 'amount', compare: { kind: 'mom', dateField: 'missing' } }, cols))).toBe('COMPARE')
  })
})
