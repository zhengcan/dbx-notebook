import { describe, it, expect } from 'vitest'
import { parseSqlOutput, parseChartReply, parseInterpretation, MAX_OUTPUT_CHARS } from '../src/ai/parse'

// The live chart parser is parseChartReply; these helpers view it as one config / a list of candidates.
const parseChartConfig = (text: string, ctx: { columns: string[]; truncated: boolean }): any => {
  const r = parseChartReply(text, { ...ctx, current: [], selected: null })
  return r.ok ? { ok: true, value: r.value.schemes[0].config, warnings: r.warnings } : r
}
const parseChartCandidates = (text: string, ctx: { columns: string[]; truncated: boolean }): any => {
  const r = parseChartReply(text, { ...ctx, current: [], selected: null })
  return r.ok ? { ok: true, value: r.value.schemes, warnings: r.warnings } : r
}

const T = { truncated: false }
const fail = (r: any, reason: string) => { expect(r.ok).toBe(false); expect(r.reason).toBe(reason) }

describe('parseSqlOutput', () => {
  it('standard fence', () => {
    const r: any = parseSqlOutput('```sql\nSELECT 1\n```', T)
    expect(r.ok).toBe(true); expect(r.value.sql).toBe('SELECT 1'); expect(r.value.explanation).toBeUndefined()
  })
  it('explanation around fence', () => {
    const r: any = parseSqlOutput('Here you go:\n```sql\nSELECT 1;\n```\nThis selects one.', T)
    expect(r.value.sql).toBe('SELECT 1;'); expect(r.value.explanation).toContain('Here you go')
    expect(r.value.explanation).toContain('selects one')
  })
  it('first fence wins with warning', () => {
    const r: any = parseSqlOutput('```sql\nSELECT 1\n```\n```sql\nSELECT 2\n```', T)
    expect(r.value.sql).toBe('SELECT 1'); expect(r.warnings.length).toBe(1)
  })
  it('unclosed fence → truncated', () => fail(parseSqlOutput('```sql\nSELECT 1 FROM', T), 'truncated'))
  it('opts.truncated → truncated even if well formed', () => fail(parseSqlOutput('```sql\nSELECT 1\n```', { truncated: true }), 'truncated'))
  it('prose without any SQL → unparseable', () => fail(parseSqlOutput('Sorry, I cannot help with that.', T), 'unparseable'))
  it('empty text → empty; empty fence → empty', () => {
    fail(parseSqlOutput('  ', T), 'empty'); fail(parseSqlOutput('```sql\n\n```', T), 'empty')
  })
  it('multi-statement still ok', () => {
    const r: any = parseSqlOutput('```sql\nSELECT 1; DROP TABLE t\n```', T)
    expect(r.ok).toBe(true); expect(r.value.sql).toBe('SELECT 1; DROP TABLE t')
  })
  it('CRLF and CJK', () => {
    const r: any = parseSqlOutput('```sql\r\n-- 查询\r\nSELECT 1\r\n```\r\n', T)
    expect(r.ok).toBe(true); expect(r.value.sql).toBe('-- 查询\nSELECT 1')
  })
  it('``` inside a SQL string is data, not the closing fence', () => {
    const r: any = parseSqlOutput("```sql\nSELECT '```' ;\n```", T)
    expect(r.ok).toBe(true); expect(r.value.sql).toBe("SELECT '```' ;")
  })
  it('closing fence must be on its own line, else truncated', () => {
    fail(parseSqlOutput("```sql\nSELECT '```' ;", T), 'truncated')
    fail(parseSqlOutput('```sql\nSELECT 1```', T), 'truncated')
    expect((parseSqlOutput('```sql\nSELECT 1\n```  \ntail', T) as any).ok).toBe(true)
    expect((parseSqlOutput('```sql\nSELECT 1\n```', T) as any).value.sql).toBe('SELECT 1')
  })
  it('opening fence mid-line is not a fence', () => {
    fail(parseSqlOutput('x ```sql\nSELECT 1```', T), 'unparseable')
    fail(parseSqlOutput('x ```sql\nSELECT 1\n```', T), 'unparseable')
  })
  it('unbalanced extracted SQL is truncated, never ok', () => {
    fail(parseSqlOutput("```sql\nSELECT '\n```\n';\n```", T), 'truncated')
    fail(parseSqlOutput('```sql\nSELECT (1 + 2\n```', T), 'truncated')
    fail(parseSqlOutput('```sql\nSELECT 1 /* x\n```', T), 'truncated')
    expect((parseSqlOutput('```sql\nSELECT (1 + (2)) FROM t WHERE a = \'(\'\n```', T) as any).ok).toBe(true)
  })
  it('too long', () => fail(parseSqlOutput('```sql\n' + 'x'.repeat(MAX_OUTPUT_CHARS + 1) + '\n```', T), 'too-long'))
})

describe('parseSqlOutput: realistic model outputs (host command-generation preset: bare command + "Why:")', () => {
  const ok = (text: string) => { const r: any = parseSqlOutput(text, T); expect(r.ok, text).toBe(true); return r.value as { sql: string; explanation?: string } }
  it('H1 bare SQL then "Why:" line', () => {
    const v = ok('SELECT region, SUM(amount) FROM sales GROUP BY region;\nWhy: totals per region.')
    expect(v.sql).toBe('SELECT region, SUM(amount) FROM sales GROUP BY region;'); expect(v.explanation).toBe('Why: totals per region.')
  })
  it('H1 bare multi-line SQL then Why', () => {
    const v = ok('SELECT region,\n       SUM(amount) AS total\nFROM sales\nGROUP BY region\nORDER BY total DESC\nWhy: sorted totals.')
    expect(v.sql).toBe('SELECT region,\n       SUM(amount) AS total\nFROM sales\nGROUP BY region\nORDER BY total DESC'); expect(v.explanation).toContain('sorted')
  })
  it('H1 bare SQL only, no semicolon', () => expect(ok('SELECT 1 FROM t').sql).toBe('SELECT 1 FROM t'))
  it('H1 zh explanation markers', () => {
    const v = ok('SELECT 1;\n说明：返回常量 1。'); expect(v.sql).toBe('SELECT 1;'); expect(v.explanation).toContain('返回常量')
  })
  it('H1 WITH CTE bare', () => expect(ok('WITH a AS (SELECT 1 x)\nSELECT * FROM a;').sql).toContain('WITH a AS'))
  it('H1 any statement kind is parsed (gate decides later)', () => expect(ok('DELETE FROM t WHERE id = 1;').sql).toBe('DELETE FROM t WHERE id = 1;'))
  it('H3 fence tag case/dialect variants', () => {
    for (const tag of ['SQL', 'Sql', 'postgresql', 'pgsql', 'mysql', 'sqlite', 'tsql', 'plsql', '']) expect(ok('```' + tag + '\nSELECT 1\n```').sql).toBe('SELECT 1')
  })
  it('H3 indented fences and trailing space', () => expect(ok('  ```sql  \n  SELECT 1\n  ```  \n').sql).toBe('SELECT 1'))
  it('H3 CRLF with uppercase tag', () => expect(ok('```SQL\r\nSELECT 1\r\n```\r\n').sql).toBe('SELECT 1'))
  it('H3 closing fence followed by text on the same line', () => expect(ok('```sql\nSELECT 1\n``` This returns one.').sql).toBe('SELECT 1'))
  it('H3 leading paragraph before fence', () => expect(ok('Sure! Here is the query you asked for.\n\n```sql\nSELECT 1\n```').explanation).toContain('Sure!'))
  it('H3 non-sql fence tag still rejected', () => fail(parseSqlOutput('```python\nprint(1)\n```', T), 'unparseable'))
  it('H4 balance check accepts apostrophes in comments, $1, backslashes, CJK punctuation', () => {
    expect(ok("```sql\n-- don't count test rows\nSELECT * FROM t WHERE id = $1 AND name = 'a\\\\b' -- 注意：（全角\n```").sql).toContain('$1')
    expect(ok("```sql\n/* it's fine */ SELECT 'x（y）' AS \"列：名\"\n```").sql).toContain('x（y）')
  })
  it('H5 <sql> tags', () => expect(ok('<sql>\nSELECT 1\n</sql>').sql).toBe('SELECT 1'))
  it('H5 plain "sql" label line', () => expect(ok('sql\nSELECT 1').sql).toBe('SELECT 1'))
  it('H6 SQL then unmarked prose paragraph after the semicolon', () => {
    const v = ok('SELECT id FROM users;\n\nThis query lists all user ids.'); expect(v.sql).toBe('SELECT id FROM users;'); expect(v.explanation).toContain('lists all user ids')
  })
  it('H6 leading "Here is" line followed by clear SQL start', () => {
    const v = ok('Here is the query:\nSELECT 1;'); expect(v.sql).toBe('SELECT 1;'); expect(v.explanation).toContain('Here is')
  })
  it('semicolon inside string/comment does not cut', () => expect(ok("SELECT 'a;b' -- x; y\nFROM t;").sql).toBe("SELECT 'a;b' -- x; y\nFROM t;"))
  it('two real statements stay together (gate flags multiple)', () => expect(ok('SELECT 1;\nSELECT 2;').sql).toBe('SELECT 1;\nSELECT 2;'))
  it('safety: unbalanced bare SQL → truncated', () => {
    fail(parseSqlOutput('SELECT (1 + 2 FROM t', T), 'truncated')
    fail(parseSqlOutput("SELECT 'abc FROM t", T), 'truncated')
    fail(parseSqlOutput('SELECT 1 /* x', T), 'truncated')
  })
  it('safety: bare SQL with opts.truncated → truncated', () => fail(parseSqlOutput('SELECT 1', { truncated: true }), 'truncated'))
  it('safety: stray fence in unfenced text never ok', () => {
    fail(parseSqlOutput('SELECT 1\n```', T), 'unparseable')
  })
  it('prose starting with "With"/"Update" words is not SQL', () => {
    fail(parseSqlOutput('With this change the query gets faster.', T), 'unparseable')
  })
  it('preamble without clear lead-in is rejected', () => fail(parseSqlOutput('I think maybe\nSELECT 1', T), 'unparseable'))
})

const cols = ['region', 'amount', 'day']
const good = { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar' } }
const cfg = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```'
const C = { columns: cols, truncated: false }

describe('parseChartConfig', () => {
  it('valid fenced and bare', () => {
    for (const txt of [cfg(good), JSON.stringify(good), 'Sure: ' + JSON.stringify(good) + ' done']) {
      const r: any = parseChartConfig(txt, C)
      expect(r.ok, txt).toBe(true)
      expect(r.value.pivot.values[0]).toEqual({ field: 'amount', agg: 'sum' })
      expect(r.value.chartOptions.type).toBe('bar')
    }
  })
  it('drops unknown fields', () => {
    const r: any = parseChartConfig(cfg({ ...good, evil: { a: 1 }, pivot: { ...good.pivot, rows: [{ field: 'region', extra: 1 }] } }), C)
    expect(r.ok).toBe(true)
    expect(r.value.evil).toBeUndefined()
    expect(r.value.pivot.rows[0]).toEqual({ field: 'region' })
    expect(JSON.stringify(r.value)).not.toContain('extra')
  })
  it('invalid chart type falls back to bar with a warning (normalizeAnalysis behavior)', () => {
    const r: any = parseChartConfig(cfg({ ...good, chartOptions: { type: 'sankey' } }), C)
    expect(r.ok).toBe(true); expect(r.value.chartOptions.type).toBe('bar'); expect(r.warnings.join()).toMatch(/type/)
  })
  it('unknown columns dropped with warning; all values gone → unparseable', () => {
    const r: any = parseChartConfig(cfg({ ...good, pivot: { ...good.pivot, rows: [{ field: 'nope' }, { field: 'region' }] } }), C)
    expect(r.value.pivot.rows).toEqual([{ field: 'region' }]); expect(r.warnings.join()).toMatch(/nope/)
    fail(parseChartConfig(cfg({ ...good, pivot: { ...good.pivot, values: [{ field: 'ghost', agg: 'sum' }] } }), C), 'unparseable')
  })
  it('count may use no field', () => {
    const r: any = parseChartConfig(cfg({ pivot: { rows: [{ field: 'region' }], values: [{ field: '', agg: 'count' }] } }), C)
    expect(r.ok).toBe(true)
  })
  it('truncated / garbage / empty', () => {
    fail(parseChartConfig('```json\n{"pivot":{"rows":[{"field":"reg', C), 'truncated')
    fail(parseChartConfig('{"pivot":{"rows":[', C), 'truncated')
    fail(parseChartConfig(cfg(good), { ...C, truncated: true }), 'truncated')
    fail(parseChartConfig('no json here', C), 'unparseable')
    fail(parseChartConfig('```json\n{bad json}\n```', C), 'unparseable')
    fail(parseChartConfig('[1,2]', C), 'unparseable')
    fail(parseChartConfig('', C), 'empty')
  })
  it('__proto__ and deep nesting are safe', () => {
    const r: any = parseChartConfig('{"__proto__":{"polluted":1},"pivot":{"rows":[],"values":[{"field":"amount","agg":"sum"}]}}', C)
    expect(({} as any).polluted).toBeUndefined()
    expect(r.ok === true ? (r.value as any).polluted : undefined).toBeUndefined()
    const deep = '{"a":' + '['.repeat(10000) + ']'.repeat(10000) + '}'
    expect(() => parseChartConfig(deep, C)).not.toThrow()
    expect(parseChartConfig(deep, C).ok).toBe(false)
    expect(() => parseChartConfig('{"a":' + '{"a":'.repeat(10000) + '1' + '}'.repeat(10001), C)).not.toThrow()
  })
  it('huge string fields are limited or rejected', () => {
    const r: any = parseChartConfig(cfg({ ...good, chartOptions: { type: 'bar', title: 'x'.repeat(100000) } }), C)
    if (r.ok) expect(r.value.chartOptions.title.length).toBeLessThanOrEqual(120)
    else expect(r.reason).toBe('too-long')
    const l: any = parseChartConfig(cfg({ pivot: { rows: [], values: [{ field: 'amount', agg: 'sum', label: 'y'.repeat(500) }] } }), C)
    if (l.ok) expect((l.value.pivot.values[0].label ?? '').length).toBeLessThanOrEqual(120)
  })
})

describe('extractJson fallback', () => {
  it('tries later starts when the first brace is prose', () => {
    const r: any = parseChartConfig('Use {braces} like so: ' + JSON.stringify(good), C)
    expect(r.ok).toBe(true)
  })
  it('still fails closed', () => {
    fail(parseChartConfig('{oops} and [x]', C), 'unparseable')
    fail(parseChartConfig('prose {not json} {"pivot":{"rows":[', C), 'truncated')
  })
})

describe('parseChartCandidates', () => {
  const cand = (title?: string) => ({ ...(title === undefined ? {} : { title }), ...good })
  it('two items', () => {
    const r: any = parseChartCandidates(cfg([{ title: 'A', ...good }, { title: 'B', ...good }]), C)
    expect(r.ok).toBe(true); expect(r.value.map((c: any) => c.title)).toEqual(['A', 'B'])
    expect(r.value[0].config.pivot.values[0].field).toBe('amount')
  })
  it('five → three + warning', () => {
    const r: any = parseChartCandidates(cfg(Array.from({ length: 5 }, (_, i) => cand('t' + i))), C)
    expect(r.value.length).toBe(3); expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('invalid items dropped individually; all invalid → unparseable', () => {
    const bad = { title: 'bad', pivot: { rows: [], values: [{ field: 'zzz', agg: 'sum' }] } }
    const r: any = parseChartCandidates(cfg([cand('ok'), bad, 5]), C)
    expect(r.value.length).toBe(1)
    fail(parseChartCandidates(cfg([bad, bad]), C), 'unparseable')
  })
  it('single object is treated as one candidate', () => {
    const r: any = parseChartCandidates(cfg(cand('solo')), C)
    expect(r.ok).toBe(true); expect(r.value.length).toBe(1)
  })
  it('missing title → empty string', () => {
    const r: any = parseChartCandidates(cfg([cand()]), C)
    expect(r.value[0].title).toBe('')
  })
  it('title length limited; unknown fields dropped', () => {
    const r: any = parseChartCandidates(cfg([{ ...cand('x'.repeat(1000)), evil: 1 }]), C)
    expect(r.value[0].title.length).toBeLessThanOrEqual(120); expect(r.value[0].evil).toBeUndefined()
  })
  it('truncated / empty / garbage', () => {
    fail(parseChartCandidates('[{"title":"a","pivot":{"rows":[', C), 'truncated')
    fail(parseChartCandidates(cfg([cand('a')]), { ...C, truncated: true }), 'truncated')
    fail(parseChartCandidates('', C), 'empty')
    fail(parseChartCandidates('sorry', C), 'unparseable')
  })
})

describe('parseInterpretation', () => {
  it('empty / whitespace', () => { fail(parseInterpretation('', T), 'empty'); fail(parseInterpretation(' \n ', T), 'empty') })
  it('trims, keeps html', () => {
    const r: any = parseInterpretation('  hi <script>alert(1)</script>\n', T)
    expect(r.value.markdown).toBe('hi <script>alert(1)</script>')
  })
  it('truncated and too long', () => {
    fail(parseInterpretation('abc', { truncated: true }), 'truncated')
    fail(parseInterpretation('a'.repeat(MAX_OUTPUT_CHARS + 1), T), 'too-long')
    expect(parseInterpretation('a'.repeat(MAX_OUTPUT_CHARS), T).ok).toBe(true)
  })
})
