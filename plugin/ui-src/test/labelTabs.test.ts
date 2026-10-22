import { describe, it, expect } from 'vitest'
import { TAB_KEYS, tabOf, tabAffectText, numberRows } from '../src/analysis/labelTabs'
import type { LabelTarget } from '../src/analysis/labelResolve'
import { setLocale } from '../src/i18n'

const ALL: LabelTarget[] = [
  { kind: 'rowName', index: 3 }, { kind: 'columnName', index: 2 }, { kind: 'measureName', index: 1 }, { kind: 'summary' },
  { kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' },
  { kind: 'unit', index: 4 }, { kind: 'scale', index: 4 },
  { kind: 'category', axis: 'row', index: 1, key: 'k70' }, { kind: 'category', axis: 'column', index: 0, key: '' },
  { kind: 'nullLabel', axis: 'row', index: 0 }, { kind: 'nullLabel', axis: 'column', index: 1 },
]
const EXPECT: Record<string, string> = { rowName: 'table', columnName: 'table', measureName: 'table', summary: 'table', title: 'chart', axis: 'chart', unit: 'numbers', scale: 'numbers', category: 'categories', nullLabel: 'categories' }

describe('labelTabs', () => {
  it('TAB_KEYS order', () => expect(TAB_KEYS).toEqual(['table', 'chart', 'numbers', 'categories']))
  it('every kind maps to exactly one (expected) tab', () => {
    for (const t of ALL) {
      expect(TAB_KEYS.filter((k) => k === tabOf(t))).toHaveLength(1)
      expect(tabOf(t)).toBe(EXPECT[t.kind])
    }
    expect(new Set(ALL.map((t) => t.kind)).size).toBe(Object.keys(EXPECT).length)
  })
  it('tabAffectText zh chart tab, no duplicates; empty → ""', () => {
    setLocale('zh')
    const txt = tabAffectText([{ target: { kind: 'title' } }, { target: { kind: 'axis', axis: 'x' } }, { target: { kind: 'axis', axis: 'y' } }])
    expect(txt.startsWith('此页影响：')).toBe(true)
    const parts = txt.slice('此页影响：'.length).split(' · ')
    expect(new Set(parts).size).toBe(parts.length)
    expect(parts).toContain('图表标题'); expect(parts).toContain('X 轴')
    expect(tabAffectText([])).toBe('')
  })
  it('tabAffectText en', () => {
    setLocale('en')
    expect(tabAffectText([{ target: { kind: 'summary' } }])).toBe('This page affects: Totals row · Export')
    setLocale('zh')
  })
  it('numberRows 1..n in order, duplicate keeps first', () => {
    const m = numberRows([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }])
    expect([...m]).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(numberRows([]).size).toBe(0)
  })
  it('multi-field refs: numbering follows display order', () => {
    const ids = ['rowName:0', 'rowName:1', 'columnName:0', 'columnName:1', 'measureName:0', 'summary']
    const m = numberRows(ids.map((id) => ({ id })))
    expect(ids.map((i) => m.get(i))).toEqual([1, 2, 3, 4, 5, 6])
    const sub = numberRows(ids.filter((_, i) => i % 2).map((id) => ({ id })))
    expect([...sub.values()]).toEqual([1, 2, 3])
  })
})
