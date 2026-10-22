import { describe, it, expect } from 'vitest'
import { hashSql } from '../src/state/hash'
import { mkStore } from './undoHelpers'

const mk = () => mkStore([
  { id: 'i1', type: 'input', metadata: { variable: 'v', inputType: 'number', value: 1 } },
  { id: 's1', type: 'sql', content: 'select {{v}}', metadata: { resultName: 'src' } },
  { id: 'l1', type: 'sql', content: 'select * from src', metadata: { source: 'results' } },
])

describe('undo and dependents', () => {
  it('undoing an input value edit toggles dependent staleness by the existing rules (no auto-run)', () => {
    const { s } = mk()
    s.runs.set('s1', { status: 'ok', executedAt: 'T', ranSqlHash: hashSql('select {{v}}'), params: { v: 1 }, result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'x' } } as any)
    expect(s.isStale('s1')).toBe(false)
    s.updateMeta('i1', { value: 2 })
    expect(s.isStale('s1')).toBe(true)
    s.undo(); expect(s.isStale('s1')).toBe(false)
    s.redo(); expect(s.isStale('s1')).toBe(true)
  })
  it('deleting and restoring an input block updates staleness without extra invalidation', () => {
    const { s } = mk()
    s.runs.set('s1', { status: 'ok', executedAt: 'T', ranSqlHash: hashSql('select {{v}}'), params: { v: 1 }, result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'x' } } as any)
    s.removeBlock('i1')
    expect(s.isStale('s1')).toBe(true)
    s.undo(); expect(s.isStale('s1')).toBe(false)
  })
  it('local SQL: source deleted then restored', () => {
    const { s } = mk()
    const res = { status: 'ok', executedAt: 'T', ranSqlHash: hashSql('select {{v}}'), params: { v: 1 }, result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'x' } } as any
    s.runs.set('s1', res)
    s.runs.set('l1', { status: 'ok', executedAt: 'T2', ranSqlHash: hashSql('select * from src'), ranSource: 'results', upstream: { src: 'T' }, result: res.result } as any)
    const before = s.isStale('l1')
    s.removeBlock('s1')
    expect(s.isStale('l1')).toBe(true)
    s.undo()
    s.runs.set('s1', res)
    expect(s.isStale('l1')).toBe(before)
  })
})
