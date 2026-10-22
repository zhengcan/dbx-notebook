import { describe, it, expect } from 'vitest'
import { analyzeSql, isAutoRunnableSql, findUnresolvedParams } from '../src/ai/sqlSafety'

const ok = (s: string) => {
  const r = analyzeSql(s)
  expect(r, s).toMatchObject({ statements: 1, readOnly: true })
  expect(isAutoRunnableSql(s)).toBe(true)
}
const bad = (s: string, reason: string) => {
  const r = analyzeSql(s)
  expect(r.readOnly, s).toBe(false)
  expect(r.reason, s).toBe(reason)
  expect(isAutoRunnableSql(s)).toBe(false)
}

describe('analyzeSql', () => {
  it('accepts single SELECT / WITH…SELECT (Rust single_statement_variants_ok parity)', () => {
    for (const s of [
      'SELECT 1', 'select 1;', 'SELECT 1;;', 'SELECT 1;  \n\t ', 'SELECT 1; -- comment', 'SELECT 1; /* a */ -- b\n',
      'SELECT 1 /* ; DROP TABLE t */', '/* lead */ SELECT 1 -- x', 'SELECT * FROM "t" WHERE name = \'a;b\'',
      "SELECT 'it''s; ok'", 'SELECT 1 AS "a;b"', 'SELECT 1 AS [a;b]', 'SELECT 1 -- ; DROP', '/* ; */ SELECT 1',
      'WITH a AS (SELECT 1) SELECT * FROM a', 'WITH x AS (SELECT 1 AS v) SELECT v FROM x',
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5) SELECT count(*) FROM c',
      "SELECT 1 AS \"名前\" FROM t WHERE name <> '日本;'", 'SELECT 1 `a;b`',
      "SELECT replace(a, 'x', 'y') FROM t", "WITH a AS (SELECT replace(a,'x','y') r FROM t) SELECT * FROM a",
      "SELECT 'DELETE; INSERT' AS s", 'SELECT "update" FROM t',
    ]) ok(s)
  })
  it('empty', () => {
    for (const s of ['', '   ', '-- only comment', '/* c */', ';', ' ; ', '/* unterminated']) {
      expect(analyzeSql(s), s).toEqual({ statements: 0, readOnly: false, reason: 'empty' })
    }
  })
  it('multiple statements', () => {
    for (const s of ['SELECT 1; SELECT 2', '; DROP TABLE t', '; SELECT 1', 'SELECT 1; DROP TABLE t', 'SELECT 1; -- c\nSELECT 2', 'SELECT 1;;SELECT 2']) {
      bad(s, 'multiple')
      expect(analyzeSql(s).statements).toBeGreaterThan(1)
    }
  })
  it('full-width semicolon is not a separator', () => {
    expect(analyzeSql('SELECT 1；DROP TABLE t')).toMatchObject({ statements: 1, readOnly: true })
  })
  it('non-select statements', () => {
    for (const s of [
      'DROP TABLE t', 'CREATE TABLE z(a)', 'CREATE VIEW v AS SELECT 1', 'INSERT INTO t VALUES (1)', 'UPDATE t SET id=1', 'DELETE FROM t',
      'PRAGMA table_info(t)', 'ATTACH DATABASE x AS y', 'REPLACE INTO t VALUES (1)', 'EXPLAIN SELECT 1', 'VACUUM', 'BEGIN',
      "WITH x AS (SELECT 1) INSERT INTO t VALUES (1,'a')", 'WITH x AS (SELECT 1) DELETE FROM t', 'WITH x AS (SELECT 1) UPDATE t SET id=0',
      'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'with x as (insert into t values (1) returning id) select * from x',
      'WITH x AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM x', 'WITH x AS (SELECT 1) MERGE INTO t USING x ON 1=1 WHEN MATCHED THEN DELETE',
      'WITH x AS (SELECT 1) SELECT * FROM x; ', 
    ].filter((s) => !s.endsWith('; '))) bad(s, 'not-select')
  })
  it('SELECT INTO and locking clauses', () => {
    for (const s of ['SELECT * INTO new_t FROM t', 'select a into b from t', 'WITH a AS (SELECT 1) SELECT * INTO n FROM a',
      'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR SHARE', 'SELECT * FROM t FOR NO KEY UPDATE', 'SELECT * FROM t FOR KEY SHARE',
      'SELECT * FROM t\nFOR\n  UPDATE NOWAIT', 'SELECT * FROM t LOCK IN SHARE MODE']) bad(s, 'not-select')
  })
  it('comment tricks do not hide or fake keywords', () => {
    bad('SELECT 1 /* x */; /* y */ DROP TABLE t', 'multiple')
    bad('/**/DROP/**/TABLE t', 'not-select')
    bad("WITH x AS (SELECT 1) /* hi */ DELETE /* */ FROM t", 'not-select')
    ok('SELECT 1 /* DELETE INSERT */ -- UPDATE')
  })
  it('does not hang on huge input', () => {
    const t0 = Date.now()
    analyzeSql('SELECT ' + "'a;'||".repeat(200000) + "'z'")
    analyzeSql('SELECT ' + "(".repeat(300000))
    analyzeSql("SELECT '" + 'x'.repeat(1_000_000))
    expect(Date.now() - t0).toBeLessThan(3000)
  })
  it('params', () => {
    expect(findUnresolvedParams('SELECT {{ a }}, {{b}}, {{a}}', [])).toEqual(['a', 'b'])
    expect(findUnresolvedParams('SELECT {{ a }}, {{b}}', ['a'])).toEqual(['b'])
    expect(findUnresolvedParams('SELECT 1', [])).toEqual([])
  })

  it('rejects dialect syntax the scanner cannot model (fail closed)', () => {
    const risky = [
      "SELECT $$'$$; DROP TABLE t; SELECT $$'$$", 'SELECT $tag$x$tag$', 'SELECT $a', 'SELECT 1 $$',
      "SELECT '\\''; DROP TABLE t; SELECT '\\''", "SELECT E'\\'; DROP TABLE t; --'", 'SELECT 1 \\ ',
      'SELECT 1 /*!; DROP TABLE t */', 'SELECT 1 /*!50000 ; DROP TABLE t */', 'SELECT /*+ HINT */ 1', 'SELECT 1 /*+ x */',
      'SELECT 1 --;DROP TABLE t', 'SELECT 1 --DROP', 'SELECT 1 --\u00a0;DROP TABLE t', 'select 1 --x\nfrom t', 'SELECT 1 ---x',
    ]
    for (const s of risky) bad(s, 'unsupported-syntax')
  })
  it('allows -- followed by whitespace/control/end', () => {
    for (const s of ['SELECT 1 -- ok', 'SELECT 1 --\tok', 'SELECT 1 --\nFROM t', 'SELECT 1 --', 'SELECT 1 --\r\n']) ok(s)
  })
  it('unterminated quote or block comment after code is unsupported; lone unterminated comment stays empty', () => {
    bad("SELECT 'abc; DROP TABLE t", 'unsupported-syntax')
    bad('SELECT "abc', 'unsupported-syntax')
    bad('SELECT 1 /* ; DROP TABLE t', 'unsupported-syntax')
    expect(analyzeSql('/* unterminated').reason).toBe('empty')
  })
  it('params ignore strings and comments', () => {
    expect(findUnresolvedParams("SELECT '{{a}}', {{b}} -- {{c}}\n/* {{d}} */", [])).toEqual(['b'])
  })
  it('CR / U+2028 / U+2029 / U+0085 end -- comments', () => {
    for (const nl of ['\r', '\u2028', '\u2029', '\u0085']) {
      expect(analyzeSql(`SELECT 1 -- x${nl}; DROP TABLE t`).reason, JSON.stringify(nl)).toBe('multiple')
      expect(analyzeSql(`SELECT 1 --${nl};DROP TABLE t`).readOnly).toBe(false)
      expect(analyzeSql(`SELECT 1 -- ${nl};DROP`).readOnly).toBe(false)
    }
    ok('SELECT 1 -- x\r\n')
    ok('SELECT 1 -- x\r\nFROM t')
    ok('SELECT 1 -- x; y')
  })
})
