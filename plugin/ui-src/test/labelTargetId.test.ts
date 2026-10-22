import { describe, it, expect } from 'vitest'
import { labelTargetId, parseLabelTargetId } from '../src/analysis/labelTargetId'
import type { LabelTarget } from '../src/analysis/labelResolve'

const all: LabelTarget[] = [
  { kind: 'rowName', index: 0 }, { kind: 'columnName', index: 2 }, { kind: 'measureName', index: 1 },
  { kind: 'summary' }, { kind: 'title' }, { kind: 'axis', axis: 'legend' }, { kind: 'unit', index: 3 }, { kind: 'scale', index: 0 },
  { kind: 'category', axis: 'row', index: 0, key: '0' }, { kind: 'category', axis: 'column', index: 1, key: 'a:b:c' },
  { kind: 'category', axis: 'row', index: 1, key: '华东：是' }, { kind: 'category', axis: 'row', index: 0, key: '' },
  { kind: 'nullLabel', axis: 'row', index: 0 }, { kind: 'nullLabel', axis: 'column', index: 2 },
]
describe('labelTargetId', () => {
  it('round-trips every kind incl. ":" and unicode keys', () => { for (const t of all) expect(parseLabelTargetId(labelTargetId(t))).toEqual(t) })
  it('uses the documented shapes', () => {
    expect(labelTargetId({ kind: 'rowName', index: 0 })).toBe('rowName:0')
    expect(labelTargetId({ kind: 'summary' })).toBe('summary')
    expect(labelTargetId({ kind: 'category', axis: 'row', index: 1, key: 'x:y' })).toBe('category:row:1:x:y')
    expect(labelTargetId({ kind: 'nullLabel', axis: 'row', index: 0 })).toBe('null:row:0')
  })
  it('rejects garbage', () => { for (const s of ['', 'rowName', 'rowName:x', 'rowName:-1', 'category:row:1', 'category:up:1:k', 'null:row', 'zzz:1', 'summary:1']) expect(parseLabelTargetId(s)).toBeNull() })
})
