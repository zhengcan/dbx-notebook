import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

function mk() {
  const s = useNotebookStore()
  const nb = createEmptyNotebook()
  s.load(serializeNotebook(nb), '/x.sqlnb', 1)
  const id = s.addBlock('markdown', null)
  s.markSaved('/x.sqlnb', 2, s.revision.value)
  s.history.clear()
  return { s, id }
}
const edit = (s: ReturnType<typeof mk>['s'], id: string, v: string) =>
  s.recordEdit('e', 'user', { ids: [id] }, () => { s.nb.value.blocks.find((b) => b.id === id)!.content = v })

describe('store dirty (savepoint)', () => {
  it('recordEdit → undo ⇒ clean → redo ⇒ dirty', () => {
    const { s, id } = mk()
    expect(s.dirty.value).toBe(false)
    edit(s, id, 'x'); expect(s.dirty.value).toBe(true)
    s.undo(); expect(s.dirty.value).toBe(false)
    s.redo(); expect(s.dirty.value).toBe(true)
  })
  it('save then undo ⇒ dirty; redo back ⇒ clean', () => {
    const { s, id } = mk()
    edit(s, id, 'x')
    s.markSaved('/x.sqlnb', 3, s.revision.value)
    expect(s.dirty.value).toBe(false)
    s.undo(); expect(s.dirty.value).toBe(true)
    s.redo(); expect(s.dirty.value).toBe(false)
  })
  it('save with a stale revision stays dirty', () => {
    const { s, id } = mk()
    edit(s, id, 'x')
    const r = s.revision.value
    edit(s, id, 'y')
    s.markSaved('/x.sqlnb', 3, r)
    expect(s.dirty.value).toBe(true)
  })
  it('non-history writer keeps dirty through undo', () => {
    const { s, id } = mk()
    edit(s, id, 'x')
    s.updateMeta(id, { k: 1 })
    s.undo(); expect(s.dirty.value).toBe(true)
  })
  it('load with repair ⇒ dirty, undo of nothing stays dirty', () => {
    const s = useNotebookStore()
    const nb = createEmptyNotebook()
    nb.blocks = [{ id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'L'.repeat(500) } } as any]
    s.load(serializeNotebook(nb), '/x.sqlnb', 1)
    expect(s.loadNotices.value).toContain('n1')
    expect(s.dirty.value).toBe(true)
    s.undo(); expect(s.dirty.value).toBe(true)
  })
  it('clear ⇒ dirty false (after load/save-as)', () => {
    const { s, id } = mk()
    edit(s, id, 'x')
    s.markSaved('/x.sqlnb', 3, s.revision.value)
    s.history.clear()
    expect(s.dirty.value).toBe(false)
  })
  it('AI entry: apply ⇒ dirty, undo ⇒ clean', () => {
    const { s, id } = mk()
    s.applyAiEdit({ label: 'AI', run: (tx) => tx.updateContent(id, 'z') })
    expect(s.dirty.value).toBe(true)
    s.undo(); expect(s.dirty.value).toBe(false)
  })
  it('stale-revision save: undoing everything keeps dirty (file holds a state no undo reaches)', () => {
    const { s, id } = mk()
    edit(s, id, 'x')
    const r = s.revision.value
    edit(s, id, 'y')
    s.markSaved('/x.sqlnb', 3, r)
    s.undo(); s.undo()
    expect(s.dirty.value).toBe(true)
  })
  it('undoing an AI-inserted SQL block drops its run/analysis/bigNumber/transposed caches', () => {
    const { s, id } = mk()
    let nid = ''
    s.applyAiEdit({ label: 'AI', run: (tx) => { nid = tx.insertAfter('sql', id, 'select 1') } })
    s.runs.set(nid, { status: 'ok' } as any)
    s.analysis.set(nid, {} as any)
    s.bigNumbers.set(nid, {} as any)
    s.transposed.set(nid, true)
    s.undo()
    expect(s.runs.has(nid)).toBe(false); expect(s.analysis.has(nid)).toBe(false)
    expect(s.bigNumbers.has(nid)).toBe(false); expect(s.transposed.has(nid)).toBe(false)
  })
  it('markClean: an auto-created notebook is clean; edit then undo returns to clean', () => {
    const s = useNotebookStore()
    s.load(serializeNotebook(createEmptyNotebook()), null, null)
    s.setDefaultConnection('pg', 'postgres')
    expect(s.dirty.value).toBe(true)
    s.markClean()
    expect(s.dirty.value).toBe(false)
    const id = s.addBlock('markdown', null)
    expect(s.dirty.value).toBe(true)
    s.history.stack.markSavepoint()
    s.markClean()
    s.updateContent(id, 'x'); expect(s.dirty.value).toBe(true)
    s.undo(); expect(s.dirty.value).toBe(false)
  })
})
