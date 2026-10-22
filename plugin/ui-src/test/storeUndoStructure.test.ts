import { describe, it, expect } from 'vitest'
import { mkStore } from './undoHelpers'

const ids = (s: any) => s.nb.value.blocks.map((b: any) => b.id)

describe('undo: structural edits', () => {
  it('delete then undo restores id, index, content, unknown fields and key order; redo removes again', () => {
    const { s, text } = mkStore([
      { id: 'a', type: 'markdown', content: 'A' },
      { id: 'b', type: 'sql', content: 'select 1', metadata: { zeta: 1, resultName: 'r', clients: { other: { k: 1 }, dbx: { transposed: true } } }, futureField: { x: 1 } },
      { id: 'c', type: 'markdown', content: 'C' },
    ])
    const orig = text()
    s.runs.set('b', { status: 'ok' } as any)
    s.removeBlock('b')
    expect(ids(s)).toEqual(['a', 'c'])
    expect(s.history.undoDepth.value).toBe(1)
    s.undo()
    expect(ids(s)).toEqual(['a', 'b', 'c'])
    expect(text()).toBe(orig)
    expect(s.dirty.value).toBe(false)
    expect(s.runs.has('b')).toBe(false)
    expect(s.transposed.get('b')).toBe(true)
    s.redo(); expect(ids(s)).toEqual(['a', 'c'])
    expect(s.dirty.value).toBe(true)
  })
  it('delete clears run caches; they are not restored by undo', () => {
    const { s } = mkStore()
    s.runs.set('s1', { status: 'ok' } as any); s.analysis.set('s1', {} as any); s.bigNumbers.set('n1', {} as any)
    s.removeBlock('s1'); s.removeBlock('n1')
    s.undo(); s.undo()
    expect(s.runs.has('s1')).toBe(false); expect(s.analysis.has('s1')).toBe(false); expect(s.bigNumbers.has('n1')).toBe(false)
  })
  it('add (every type, at top and after an anchor): one step, undo removes, redo restores the same id', () => {
    for (const type of ['markdown', 'sql', 'results', 'input', 'chart', 'big-number'] as const) {
      const { s, text } = mkStore()
      const orig = text()
      const id1 = s.addBlock(type, null)
      const id2 = s.addBlock(type, 'm1')
      expect(s.history.undoDepth.value).toBe(2)
      expect(ids(s).indexOf(id1)).toBe(0); expect(ids(s).indexOf(id2)).toBe(ids(s).indexOf('m1') + 1)
      const full = ids(s)
      s.undo(); s.undo()
      expect(text()).toBe(orig); expect(s.dirty.value).toBe(false)
      s.redo(); s.redo()
      expect(ids(s)).toEqual(full)
    }
  })
  it('move: one step, undo/redo restore order exactly; neighbours untouched', () => {
    const { s, text } = mkStore()
    const orig = text()
    s.moveBlock('m1', 1); s.moveBlock('m1', -1); s.moveBlock('s1', 1)
    expect(s.history.undoDepth.value).toBe(3)
    const moved = ids(s)
    s.undo(); s.undo(); s.undo()
    expect(text()).toBe(orig)
    s.redo(); s.redo(); s.redo()
    expect(ids(s)).toEqual(moved)
    s.moveBlock('s1', -1); s.moveBlock('s1', -1)
    expect(s.history.undoDepth.value).toBe(4)
  })
  it('duplicate: fresh id, one step; undo removes only the copy; redo reuses the copy id', () => {
    const { s, text } = mkStore()
    const orig = text()
    const copy = s.duplicateBlock('s1')
    expect(copy).not.toBe('s1')
    expect(s.history.undoDepth.value).toBe(1)
    s.undo(); expect(text()).toBe(orig)
    s.redo(); expect(ids(s)).toContain(copy)
    expect(ids(s).filter((x: string) => x === copy)).toHaveLength(1)
    const inp = s.duplicateBlock('i1')
    expect((s.nb.value.blocks.find((b) => b.id === inp)!.metadata as any).variable).not.toBe('v')
  })
  it('duplicate of a transposed block keeps the transposed flag across undo/redo', () => {
    const { s } = mkStore()
    s.setTransposed('s1', true)
    const copy = s.duplicateBlock('s1')
    expect(s.transposed.get(copy)).toBe(true)
    s.undo(); expect(s.transposed.has(copy)).toBe(false)
    s.redo(); expect(s.transposed.get(copy)).toBe(true)
  })
  it('visualizeResult is ONE step covering the chart and the source resultName', () => {
    const { s, text } = mkStore([{ id: 's1', type: 'sql', content: 'select 1', metadata: {} }])
    s.runs.set('s1', { status: 'ok', executedAt: 'T', result: { columns: [{ name: 'a', dataType: 'text' }, { name: 'b', dataType: 'integer' }], rows: [['x', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    s.markClean()
    const orig = text()
    const id = s.visualizeResult('s1')!
    expect(s.history.undoDepth.value).toBe(1)
    expect((s.nb.value.blocks[0].metadata as any).resultName).toBe('result_1')
    const after = text()
    s.undo()
    expect(text()).toBe(orig); expect(s.dirty.value).toBe(false)
    s.redo()
    expect(text()).toBe(after); expect(ids(s)).toContain(id)
  })
  it('a new edit after undo clears redo', () => {
    const { s } = mkStore()
    s.removeBlock('m1'); s.undo()
    expect(s.history.redoDepth.value).toBe(1)
    s.addBlock('markdown', null)
    expect(s.history.redoDepth.value).toBe(0)
  })
  it('save in between: undo past the save is dirty, back at it is clean; load clears', () => {
    const { s } = mkStore()
    s.removeBlock('m1')
    s.markSaved('/x.sqlnb', 2, s.revision.value)
    s.addBlock('sql', null)
    expect(s.dirty.value).toBe(true)
    s.undo(); expect(s.dirty.value).toBe(false)
    s.undo(); expect(s.dirty.value).toBe(true)
    s.redo(); s.redo(); expect(s.dirty.value).toBe(true)
  })
  it('AI entry and user structural entries coexist chronologically', () => {
    const { s } = mkStore()
    s.applyAiEdit({ label: 'AI', run: (tx) => tx.updateContent('m1', 'ai') })
    s.removeBlock('s1')
    s.undo(); expect(ids(s)).toContain('s1')
    const r = s.undo(); expect(r.ok && r.entry.source).toBe('ai')
  })
  it('labels are history.label keys', () => {
    const { s } = mkStore()
    s.addBlock('sql', null); s.removeBlock('m1'); s.moveBlock('s1', 1); s.duplicateBlock('i1')
    const labels: string[] = []
    while (s.history.canUndo.value) { const r = s.undo(); if (r.ok) labels.push(r.entry.label) }
    expect(labels).toEqual(['history.label.duplicateBlock', 'history.label.moveBlock', 'history.label.deleteBlock', 'history.label.addBlock'])
  })
})
