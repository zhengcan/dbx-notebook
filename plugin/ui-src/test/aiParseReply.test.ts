import { describe, it, expect } from 'vitest'
import { parseSqlReply } from '../src/ai/parseReply'
import { MAX_OUTPUT_CHARS } from '../src/ai/parse'

const T = { truncated: false }
const val = (t: string, o = T) => {
  const r = parseSqlReply(t, o)
  if (!r.ok) throw new Error('fail ' + r.reason)
  return r.value
}
const reason = (t: string, o = T) => {
  const r = parseSqlReply(t, o)
  return r.ok ? 'ok' : r.reason
}

describe('parseSqlReply', () => {
  it('bare SQL + Why: -> sql with message', () => {
    const v = val('SELECT * FROM t;\nWhy: all rows')
    expect(v).toEqual({ kind: 'sql', sql: 'SELECT * FROM t;', message: 'Why: all rows' })
  })
  it('bare SQL only has no message', () => {
    expect(val('SELECT 1')).toEqual({ kind: 'sql', sql: 'SELECT 1' })
  })
  it('fenced sql block + prose -> sql', () => {
    const v = val('Here:\n```sql\nSELECT 1\n```\nDone.')
    expect(v.kind).toBe('sql')
    if (v.kind === 'sql') expect(v.sql).toBe('SELECT 1')
  })
  it('QUESTION: -> question', () => {
    expect(val('QUESTION: which year?')).toEqual({ kind: 'question', message: 'which year?' })
  })
  it('Chinese markers -> question', () => {
    expect(val('问题：哪一年？')).toEqual({ kind: 'question', message: '哪一年？' })
    expect(val('反问：哪一年？')).toEqual({ kind: 'question', message: '哪一年？' })
  })
  it('bold / backtick / ASK / lowercase variants -> question', () => {
    expect(val('**QUESTION:** which year?')).toEqual({ kind: 'question', message: 'which year?' })
    expect(val('`ASK:` which year?').kind).toBe('question')
    expect(val('question: which?').kind).toBe('question')
  })
  it('prose without marker or SQL -> question', () => {
    expect(val('Could you tell me which table?')).toEqual({ kind: 'question', message: 'Could you tell me which table?' })
  })
  it('prose line then SQL -> sql', () => {
    const v = val('Here is the query:\nSELECT 1')
    expect(v.kind).toBe('sql')
  })
  it('unbalanced -> truncated; truncated flag; empty', () => {
    expect(reason('SELECT (a FROM t')).toBe('truncated')
    expect(reason('SELECT 1', { truncated: true })).toBe('truncated')
    expect(reason('')).toBe('empty')
  })
  it('QUESTION: then fenced SQL -> sql', () => {
    const v = val('QUESTION: maybe this?\n```sql\nSELECT 1\n```')
    expect(v.kind).toBe('sql')
    if (v.kind === 'sql') { expect(v.sql).toBe('SELECT 1'); expect(v.message).toContain('QUESTION') }
  })
  it('too long -> too-long', () => {
    expect(reason('x'.repeat(MAX_OUTPUT_CHARS + 1))).toBe('too-long')
  })
  it('SQL keyword line that is unparseable stays failure, not question', () => {
    expect(reason('Sure thing\nSELECT 1 FROM t\nand more text then SELECT 2')).toBe('unparseable')
  })
  it('unclosed fence -> truncated', () => {
    expect(reason('```sql\nSELECT 1')).toBe('truncated')
  })
  it('bare QUESTION: with nothing -> empty', () => {
    expect(reason('QUESTION:')).toBe('empty')
  })
  it.each([
    'Select the year you want to filter on',
    'Create a new table first?',
    'With which table should I join?',
    'Values for which column?',
    'Update me on which column to change?',
    'Drop the duplicates or keep them?',
    'Explain what you mean by recent',
    'Replace which value?',
  ])('keyword-leading prose %s -> question', (t) => {
    expect(val(t)).toEqual({ kind: 'question', message: t })
  })
  it.each([
    'SELECT 1', 'SELECT now()', 'SELECT * FROM t WHERE a = 1', 'WITH x AS (SELECT 1) SELECT * FROM x',
    'SELECT a FROM t', 'SELECT a, b', 'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t',
    'CREATE TABLE t (a int)', 'EXPLAIN SELECT 1', 'DROP TABLE t', 'SELECT\n  a\nFROM t',
  ])('bare sql %s -> sql (with Why)', (q) => {
    const v = val(q + '\nWhy: because')
    expect(v.kind).toBe('sql')
    if (v.kind === 'sql') { expect(v.sql).toBe(q); expect(v.message).toBe('Why: because') }
    expect(val(q).kind).toBe('sql')
  })
  it('CRLF', () => {
    expect(val('QUESTION: x\r\n')).toEqual({ kind: 'question', message: 'x' })
    const v = val('```sql\r\nSELECT 1\r\n```\r\nok')
    expect(v.kind).toBe('sql')
  })
  it('SELECT 1; then QUESTION: -> sql + message', () => {
    expect(val('SELECT 1;\nQUESTION: x')).toEqual({ kind: 'sql', sql: 'SELECT 1;', message: 'QUESTION: x' })
    expect(val('SELECT 1\nQUESTION: which year?')).toEqual({ kind: 'sql', sql: 'SELECT 1', message: 'QUESTION: which year?' })
  })
  it('marker inside comment or string is not a question', () => {
    expect(val('-- QUESTION: x\nSELECT 1').kind).toBe('sql')
    expect(val("SELECT 'QUESTION: x'").kind).toBe('sql')
  })
  it('multiple fences -> first sql', () => {
    const v = val('```sql\nSELECT 1\n```\nor\n```sql\nSELECT 2\n```')
    expect(v.kind === 'sql' && v.sql).toBe('SELECT 1')
  })
})
