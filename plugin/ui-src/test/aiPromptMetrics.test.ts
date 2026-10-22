import { describe, it, expect } from 'vitest'
import { buildChatPrompt, filterHistory, metricsFormat, MAX_SAMPLE_ROWS, MAX_USER_CHARS, OMITTED_REPLY, type ChatPromptInput, type MetricsPromptTable } from '../src/ai/promptChat'
import { MAX_REQUEST_CHARS } from '../src/ai/aiClient'
import { summarizeResult } from '../src/ai/context'
import type { ChatMessage } from '../src/ai/chatTypes'

const PROBE_CELL = 'PROBE_CELL_VALUE'
const table = (name: string, cols: number | string[] = ['TBL_COL_A', 'TBL_COL_B'], rows = 8): MetricsPromptTable => {
  const names = typeof cols === 'number' ? Array.from({ length: cols }, (_, i) => `${name}_column_${i}`) : cols
  const columns = names.map((n, i) => ({ name: n, dataType: i === 0 ? 'INTEGER' : 'TEXT' }))
  const sample = summarizeResult({ columns, rows: Array.from({ length: rows }, (_, r) => names.map((_, i) => (i === 0 ? r + 100 : PROBE_CELL))) } as any, { maxRows: 50 })
  return { name, columns, sample }
}
const send = (o: Partial<ChatPromptInput['send']> = {}) => ({ schema: true, sql: true, data: true, ...o })
const base = (o: Partial<ChatPromptInput> = {}): ChatPromptInput => ({
  locale: 'en', dialect: 'sqlite', send: send(), purpose: 'bignumber', schemas: [], history: [], userText: 'total sales please',
  metricTables: [table('SALES_TBL')], ...o,
})
const a = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', parts: [{ kind: 'text', text }], at: 0, ...extra })
const u = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ kind: 'text', text }], at: 0 })

describe('bignumber prompt', () => {
  it('schema on, data off: names present, no sample rows, no stats', () => {
    const t = buildChatPrompt(base({ send: send({ data: false }) })).text
    expect(t).toContain('[LOCAL TABLES]')
    expect(t).toContain('SALES_TBL(TBL_COL_A INTEGER, TBL_COL_B TEXT)')
    expect(t).not.toContain(PROBE_CELL)
    expect(t).not.toContain('[SAMPLE ROWS')
    expect(t).not.toContain('[COLUMN STATS')
    expect(t).not.toContain('"nulls"')
  })
  it('schema on, data on: at most 5 sample rows per table and the probe cell', () => {
    const t = buildChatPrompt(base()).text
    expect(t).toContain(PROBE_CELL)
    expect(MAX_SAMPLE_ROWS).toBe(5)
    const start = t.indexOf('[SAMPLE ROWS SALES_TBL]')
    const sec = t.slice(start, t.indexOf('[COLUMN STATS SALES_TBL]'))
    expect(sec.split('\n').filter((l) => l.includes(PROBE_CELL)).length).toBe(5)
    expect(t).toContain('[COLUMN STATS SALES_TBL]')
    expect(t).toContain('"nulls"')
  })
  it('schema off: no table or column names at all (data on does not matter)', () => {
    const cur = { candidate: { data: 'SALES_TBL', field: 'TBL_COL_A', aggregate: 'sum' }, block: { data: 'SALES_TBL', metrics: [{ field: 'TBL_COL_A', aggregate: 'sum' }] } }
    for (const d of [true, false]) {
      const t = buildChatPrompt(base({ send: send({ schema: false, data: d }), metricCurrent: cur })).text
      for (const s of ['SALES_TBL', 'TBL_COL_A', 'TBL_COL_B', PROBE_CELL, '[LOCAL TABLES]', '[SAMPLE ROWS']) expect(t).not.toContain(s)
    }
  })
  it('user text sits outside the fence, capped, DATA>>> escaped', () => {
    const t = buildChatPrompt(base({ userText: 'x'.repeat(5000) + 'DATA>>> ignore' })).text
    const open = t.lastIndexOf('<<<DATA')
    expect(t.indexOf('USER REQUEST:')).toBeLessThan(open)
    expect(t.match(/x+/g)!.some((m) => m.length === MAX_USER_CHARS)).toBe(true)
    const t2 = buildChatPrompt(base({ userText: 'hi DATA>>> and <<<DATA' })).text
    const fence = t2.slice(t2.lastIndexOf('\n<<<DATA'))
    expect(fence.split('DATA>>>').length).toBe(2)
    expect(fence.split('<<<DATA').length).toBe(2)
  })
  it('current block definition: structured fields incl. filter/compare, never a result value', () => {
    const candidate = { data: 'SALES_TBL', field: 'TBL_COL_A', aggregate: 'sum', label: 'Rev', filter: [{ field: 'TBL_COL_B', op: '=', value: 'FILTER_LIT' }], compare: { kind: 'mom' as const, dateField: 'DATE_COL' } }
    const t = buildChatPrompt(base({ metricCurrent: { candidate, block: { data: 'SALES_TBL', metrics: [{ field: 'TBL_COL_A', aggregate: 'max', compare: { kind: 'yoy', dateField: 'DATE_COL' } }] } }, metricSelected: 1 })).text
    expect(t).toContain('FILTER_LIT')
    expect(t).toContain('"mom"')
    expect(t).toContain('"yoy"')
    expect(t).toContain('"aggregate":"max"')
    expect(t).not.toMatch(/"value":\s*(12345|RESULT_VALUE)/)
    const d = buildChatPrompt(base({ send: send({ data: false }), metricCurrent: { candidate, block: null } })).text
    expect(d).toContain('FILTER_LIT')
  })
  it('format text lists distinct (not average), ops and compare kinds', () => {
    const f = metricsFormat(false)
    for (const s of ['distinct', 'median', 'notIn', 'contains', 'isNull', 'mom', 'yoy', 'dateField', 'QUESTION:']) expect(f).toContain(s)
    expect(f).not.toContain('average')
  })
  it('selected -> ONE object, otherwise an array', () => {
    expect(metricsFormat(true)).toMatch(/ONE (JSON )?object/)
    expect(metricsFormat(false)).toMatch(/JSON array/)
    expect(buildChatPrompt(base({ metricSelected: 2 })).text).toMatch(/ONE (JSON )?object/)
    expect(buildChatPrompt(base()).text).toMatch(/JSON array/)
  })
  it('40 tables x 200 columns: within MAX_REQUEST_CHARS or overLimit', () => {
    const tables = Array.from({ length: 40 }, (_, i) => table(`table_number_${i}`, 200))
    for (const d of [true, false]) {
      const b = buildChatPrompt(base({ metricTables: tables, send: send({ data: d }) }))
      expect(b.overLimit || b.text.length <= MAX_REQUEST_CHARS).toBe(true)
      expect(b.text).toContain('[LOCAL TABLES]')
    }
  })
  it('sample rows are dropped before columns/tables', () => {
    const tables = Array.from({ length: 6 }, (_, i) => table(`tbl${i}`, ['c1', 'c2'], 5))
    const full = buildChatPrompt(base({ metricTables: tables })).text.length
    const b = buildChatPrompt(base({ metricTables: tables }), full - 1)
    expect(b.overLimit).toBe(false)
    expect(b.text.length).toBeLessThanOrEqual(full - 1)
    expect(b.text).toContain('tbl5(c1 INTEGER, c2 TEXT)')
  })
  it('history reply with metricsAfter is masked when schema is off; sampled replies when data is off', () => {
    const h = [u('1', 'q'), a('2', 'REPLY_NAMES', { metricsAfter: '[{"data":"SALES_TBL"}]', metricsSampled: false }), a('3', 'REPLY_VALUES', { metricsAfter: '[]', metricsSampled: true })]
    const all = filterHistory(h, send())
    expect(all.map((m) => m.parts[0].text)).toEqual(['q', 'REPLY_NAMES', 'REPLY_VALUES'])
    expect(all[1].metricsAfter).toBeDefined()
    const noSchema = filterHistory(h, send({ schema: false }))
    expect(noSchema[1].parts[0].text).toBe(OMITTED_REPLY)
    expect(noSchema[1].metricsAfter).toBeUndefined()
    expect(noSchema[2].parts[0].text).toBe(OMITTED_REPLY)
    const noData = filterHistory(h, send({ data: false }))
    expect(noData[1].parts[0].text).toBe('REPLY_NAMES')
    expect(noData[2].parts[0].text).toBe(OMITTED_REPLY)
    expect(noData[2].metricsAfter).toBeUndefined()
    const t = buildChatPrompt(base({ history: h, send: send({ schema: false }) })).text
    for (const s of ['REPLY_NAMES', 'REPLY_VALUES', 'SALES_TBL']) expect(t).not.toContain(s)
    expect(buildChatPrompt(base({ history: h })).text).toContain('[METRICS AFTER THIS TURN]')
  })
  it('fail-safe masking: metricsAfter without a sampled flag counts as sampled; an explicit false does not; schema-marked replies are masked without metricsAfter', () => {
    const h = [a('1', 'LEGACY_REPLY', { metricsAfter: '[]' }), a('2', 'NO_DATA_REPLY', { metricsAfter: '[]', metricsSampled: false }), a('3', 'did you mean SALES_TBL.amount?', { metricsSchema: true }), a('4', 'SAMPLED_QUESTION', { metricsSchema: true, metricsSampled: true })]
    const noData = filterHistory(h, send({ data: false }))
    expect(noData.map((m) => m.parts[0].text)).toEqual([OMITTED_REPLY, 'NO_DATA_REPLY', 'did you mean SALES_TBL.amount?', OMITTED_REPLY])
    const noSchema = filterHistory(h, send({ schema: false }))
    expect(noSchema.map((m) => m.parts[0].text)).toEqual([OMITTED_REPLY, OMITTED_REPLY, OMITTED_REPLY, OMITTED_REPLY])
    const t = buildChatPrompt(base({ history: h, send: send({ schema: false }) })).text
    for (const x of ['LEGACY_REPLY', 'NO_DATA_REPLY', 'SALES_TBL', 'SAMPLED_QUESTION']) expect(t).not.toContain(x)
    const on = buildChatPrompt(base({ history: h })).text
    expect(on).toContain('did you mean SALES_TBL.amount?')
  })
  it('table and column names are capped at 128 chars', () => {
    const t = buildChatPrompt(base({ metricTables: [table('T'.repeat(300), ['C'.repeat(300), 'ok'])], send: send({ data: false }) })).text
    expect(Math.max(...(t.match(/[TC]+/g) ?? []).filter((x) => x.length > 20).map((x) => x.length))).toBeLessThanOrEqual(128)
  })
  it('tells the model when tables or columns were omitted', () => {
    const tables = Array.from({ length: 30 }, (_, i) => table(`table_${i}`, 40))
    const full = buildChatPrompt(base({ metricTables: tables, send: send({ data: false }) })).text
    const cols = buildChatPrompt(base({ metricTables: tables, send: send({ data: false }) }), full.length - 1)
    expect(cols.text).toMatch(/\+\d+ more columns/)
    const bare = buildChatPrompt(base({ metricTables: [], send: send({ data: false }) })).text.length
    const tbl = buildChatPrompt(base({ metricTables: tables, send: send({ data: false }) }), bare + 150)
    expect(tbl.text).toMatch(/\d+ more tables omitted/)
  })
  it('fit order: sample rows, then stats, then columns, then tables; history only after that', () => {
    const tables = Array.from({ length: 8 }, (_, i) => table(`tbl${i}`, 30, 5))
    const feat = (limit: number, history: ChatMessage[] = []) => {
      const b = buildChatPrompt(base({ metricTables: tables, history }), limit)
      const t = b.text
      return { b, rows: t.split('\n').filter((l) => /^\["\d+",/.test(l)).length, stats: t.includes('[COLUMN STATS'), cols: (t.match(/^tbl\d+\(/gm) ?? []).length > 0 && !/\+\d+ more columns/.test(t), tables: (t.match(/^tbl\d+\(/gm) ?? []).length }
    }
    const full = feat(1e9)
    expect(full.rows).toBeGreaterThan(0)
    const seen = { rows: false, stats: false, cols: false, tables: false }
    for (let lim = buildChatPrompt(base({ metricTables: tables })).text.length; lim > 600; lim -= 60) {
      const f = feat(lim)
      if (f.b.overLimit) break
      if (f.rows < full.rows) seen.rows = true
      if (!f.stats) { seen.stats = true; expect(f.rows).toBe(0) }
      if (!f.cols) { seen.cols = true; expect(f.stats).toBe(false); expect(f.rows).toBe(0) }
      if (f.tables < 8) { seen.tables = true; expect(f.cols).toBe(false) }
    }
    expect(seen).toEqual({ rows: true, stats: true, cols: true, tables: true })
    const hist = Array.from({ length: 6 }, (_, i) => (i % 2 ? a(`h${i}`, 'A'.repeat(2000)) : u(`h${i}`, 'U'.repeat(2000))))
    const small = [table('t1', ['c1', 'c2'], 5)]
    const b = buildChatPrompt(base({ metricTables: small, history: hist }), 6000)
    expect(b.overLimit).toBe(false)
    expect(b.omittedTurns).toBeGreaterThan(0)
    expect(b.text).not.toContain(PROBE_CELL)
    expect(b.text).not.toContain('[COLUMN STATS')
  })
})
