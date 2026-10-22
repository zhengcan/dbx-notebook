import { describe, it, expect } from 'vitest'
import { runToEntry, entryToRun } from '../src/state/outputs'
import type { BlockRunState } from '../src/state/notebookStore'
import type { Block } from '@sqlnb/format'

const sql: Block = { id: 'a', type: 'sql', content: 'select 1' }
const okRun = (): BlockRunState => ({
  status: 'ok',
  result: { columns: [{ name: 'x', dataType: 'int' }, { name: 'y' }], rows: [[1, 'a']], truncated: true, elapsedMs: 7, dbType: 'pg' },
  ranSqlHash: 'h',
})

describe('outputs conversion', () => {
  it('ok run to entry; omits type when undefined', () => {
    const e = runToEntry(sql, okRun(), '2026-01-01T00:00:00.000Z')!
    expect(e.columns).toEqual([{ name: 'x', type: 'int' }, { name: 'y' }])
    expect('type' in e.columns[1]).toBe(false)
    expect(e).toMatchObject({ rows: [[1, 'a']], truncated: true, elapsedMs: 7, sqlHash: 'fnv1a32:h', executedAt: '2026-01-01T00:00:00.000Z' })
    expect('params' in e).toBe(false)
    expect('upstream' in e).toBe(false)
  })
  it('run.executedAt wins; params and upstream carried', () => {
    const r = { ...okRun(), executedAt: 'E', params: { p: 1 }, upstream: { q: 'z' } }
    const e = runToEntry(sql, r, 'ARG')!
    expect(e.executedAt).toBe('E')
    expect(e.params).toEqual({ p: 1 })
    expect(e.upstream).toEqual({ q: 'z' })
    expect('params' in runToEntry(sql, { ...okRun(), params: {} }, 'A')!).toBe(false)
  })
  it('error run', () => {
    const e = runToEntry(sql, { status: 'error', error: { code: 'UNKNOWN', message: 'boom' } }, 'T')!
    expect(e).toMatchObject({ error: 'boom', columns: [], rows: [], truncated: false, elapsedMs: 0 })
    const r = entryToRun(e)
    expect(r.status).toBe('error')
    expect(r.result).toBeUndefined()
    expect(r.error).toEqual({ code: 'UNKNOWN', message: 'boom' })
    expect(r.fromFile).toBe(true)
  })
  it('reads sqlHash with or without the fnv1a32: prefix', () => {
    const base = { columns: [], rows: [], executedAt: 'T', elapsedMs: 0, truncated: false }
    expect(entryToRun({ ...base, sqlHash: 'fnv1a32:0a1b2c3d' }).ranSqlHash).toBe('0a1b2c3d')
    expect(entryToRun({ ...base, sqlHash: '0a1b2c3d' }).ranSqlHash).toBe('0a1b2c3d')
  })
  it('null for non-sql / idle / running', () => {
    expect(runToEntry({ id: 'm', type: 'markdown', content: '' }, okRun(), 'T')).toBeNull()
    expect(runToEntry(sql, { status: 'idle' }, 'T')).toBeNull()
    expect(runToEntry(sql, { status: 'running' }, 'T')).toBeNull()
  })
  it('round trip', () => {
    const r0 = { ...okRun(), params: { p: 1 }, upstream: { u: 'h2' } }
    const r = entryToRun(runToEntry(sql, r0, 'T')!, 'pg')
    expect(r).toMatchObject({ status: 'ok', ranSqlHash: 'h', params: { p: 1 }, upstream: { u: 'h2' }, executedAt: 'T', fromFile: true })
    expect(r.result).toEqual({ columns: [{ name: 'x', dataType: 'int' }, { name: 'y', dataType: undefined }], rows: [[1, 'a']], truncated: true, elapsedMs: 7, dbType: 'pg' })
    expect(entryToRun({ columns: [], rows: [], executedAt: 'T', elapsedMs: 0, truncated: false }).result!.dbType).toBe('')
    expect(entryToRun({ columns: [], rows: [], executedAt: 'T', elapsedMs: 0, truncated: false }).ranSqlHash).toBeUndefined()
  })
  it('writer never emits empty error; empty-message error run stays an error', () => {
    const e = runToEntry(sql, { status: 'error', error: { code: 'E1', message: '' } } as unknown as BlockRunState, 'T')!
    expect(e.error).toBe('E1')
    const e2 = runToEntry(sql, { status: 'error', error: { code: '', message: '' } } as unknown as BlockRunState, 'T')!
    expect(e2.error).toBe('error')
    const e3 = runToEntry(sql, { status: 'error' } as unknown as BlockRunState, 'T')!
    expect(e3.error).toBe('error')
    expect(entryToRun(e, undefined).status).toBe('error')
  })
  it('entryToRun leaves dbType empty when not given', () => {
    const r = entryToRun({ columns: [], rows: [], executedAt: 'T', elapsedMs: 0, truncated: false }, undefined)
    expect(r.result?.dbType).toBe('')
  })
})
