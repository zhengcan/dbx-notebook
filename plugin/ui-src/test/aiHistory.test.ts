import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

function setup() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  s.load(serializeNotebook(createEmptyNotebook()), null, null)
  const a = s.addBlock('sql', null)
  s.updateContent(a, 'select 1')
  const b = s.addBlock('sql', a)
  s.updateContent(b, 'select 2')
  const c = s.addBlock('markdown', b)
  s.history.clear()
  return { s, a, b, c }
}
const ser = (s: ReturnType<typeof setup>['s']) => serializeNotebook(JSON.parse(JSON.stringify(s.nb.value)))

describe('applyAiEdit', () => {
  it('one entry, source ai; undo/redo are byte exact incl. inserted block', () => {
    const { s, a } = setup()
    const before = ser(s)
    let newId = ''
    s.applyAiEdit({ label: 'AI: rewrite', run: (tx) => { tx.updateContent(a, 'select 10'); newId = tx.insertAfter('sql', a, 'select 11') } })
    expect(s.history.undoDepth.value).toBe(1)
    expect(s.history.stack.peekUndo()?.source).toBe('ai')
    expect(s.history.stack.peekUndo()?.label).toBe('AI: rewrite')
    expect(s.history.stack.peekUndo()?.blockIds).toEqual(expect.arrayContaining([a, newId]))
    const after = ser(s)
    expect(after).not.toBe(before)
    expect(s.nb.value.blocks[1].id).toBe(newId)
    expect(s.undo().ok).toBe(true)
    expect(ser(s)).toBe(before)
    expect(s.redo().ok).toBe(true)
    expect(ser(s)).toBe(after)
    expect(s.nb.value.blocks[1].id).toBe(newId)
    expect(s.dirty.value).toBe(true)
  })
  it('two applications → two undos', () => {
    const { s, a } = setup()
    const b0 = ser(s)
    s.applyAiEdit({ label: '1', run: (tx) => tx.updateContent(a, 'x1') })
    const b1 = ser(s)
    s.applyAiEdit({ label: '2', run: (tx) => tx.updateContent(a, 'x2') })
    expect(s.history.undoDepth.value).toBe(2)
    s.undo(); expect(ser(s)).toBe(b1)
    s.undo(); expect(ser(s)).toBe(b0)
  })
  it('setAnalysis undo restores metadata byte-exact', () => {
    const { s, a } = setup()
    const ch = s.addBlock('chart', a)
    s.nb.value.blocks.find((b) => b.id === ch)!.metadata = { zeta: 1, data: '', alpha: { q: 1 }, spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } }
    const before = ser(s)
    s.applyAiEdit({ label: 'chart', run: (tx) => tx.setAnalysis(ch, { chartOptions: { type: 'line' } }) })
    expect(ser(s)).not.toBe(before)
    s.undo()
    expect(ser(s)).toBe(before)
  })
  it('no change → no entry', () => {
    const { s } = setup()
    s.applyAiEdit({ label: 'noop', run: () => {} })
    expect(s.history.undoDepth.value).toBe(0)
  })
  describe('conflicts', () => {
    // a writer that bypasses history, so the AI entry's expected state diverges
    const manual = (s: ReturnType<typeof setup>['s'], id: string, v: string) => { s.nb.value.blocks.find((x) => x.id === id)!.content = v }
    it('user edit after an AI edit is its own step; undo order is chronological', () => {
      const { s, a, b } = setup()
      s.applyAiEdit({ label: 'e', run: (tx) => tx.updateContent(a, 'ai') })
      s.updateContent(a, 'mine'); s.updateContent(b, 'other')
      s.undo(); expect(s.nb.value.blocks[1].content).toBe('select 2')
      s.undo(); expect(s.nb.value.blocks[0].content).toBe('ai')
      s.undo(); expect(s.nb.value.blocks[0].content).toBe('select 1')
    })
    it('manual edit of same block → conflict, content kept, entry dropped, earlier entry undoable', () => {
      const { s, a, b } = setup()
      s.applyAiEdit({ label: 'e1', run: (tx) => tx.updateContent(b, 'e1') })
      s.applyAiEdit({ label: 'e2', run: (tx) => tx.updateContent(a, 'e2') })
      manual(s, a, 'mine')
      const rev = s.revision.value
      const r = s.undo()
      expect(r.ok).toBe(false); expect(!r.ok && r.reason).toBe('conflict')
      expect(s.nb.value.blocks[0].content).toBe('mine')
      expect(s.revision.value).toBe(rev)
      expect(s.history.undoDepth.value).toBe(1)
      expect(s.undo().ok).toBe(true)
      expect(s.nb.value.blocks[1].content).toBe('select 2')
    })
    it('manual edit of inserted block → conflict', () => {
      const { s, a } = setup()
      let n = ''
      s.applyAiEdit({ label: 'ins', run: (tx) => { n = tx.insertAfter('sql', a, 'new') } })
      manual(s, n, 'edited')
      expect(s.undo().ok).toBe(false)
      expect(s.nb.value.blocks.some((b) => b.id === n && b.content === 'edited')).toBe(true)
    })
    it('unrelated block edit → still undoable', () => {
      const { s, a, b } = setup()
      s.applyAiEdit({ label: 'e', run: (tx) => tx.updateContent(a, 'ai') })
      manual(s, b, 'other')
      expect(s.undo().ok).toBe(true)
      expect(s.nb.value.blocks[0].content).toBe('select 1')
      expect(s.nb.value.blocks[1].content).toBe('other')
    })
    it('edit then revert to applied content → undo allowed', () => {
      const { s, a } = setup()
      s.applyAiEdit({ label: 'e', run: (tx) => tx.updateContent(a, 'ai') })
      manual(s, a, 'tmp'); manual(s, a, 'ai')
      expect(s.undo().ok).toBe(true)
      expect(s.nb.value.blocks[0].content).toBe('select 1')
    })
    it('edit after undo → redo conflict', () => {
      const { s, a } = setup()
      s.applyAiEdit({ label: 'e', run: (tx) => tx.updateContent(a, 'ai') })
      s.undo()
      manual(s, a, 'mine')
      const r = s.redo()
      expect(!r.ok && r.reason).toBe('conflict')
      expect(s.nb.value.blocks[0].content).toBe('mine')
    })
    it('deleted inserted block → conflict', () => {
      const { s, a } = setup()
      let n = ''
      s.applyAiEdit({ label: 'ins', run: (tx) => { n = tx.insertAfter('sql', a, 'new') } })
      s.nb.value.blocks.splice(s.nb.value.blocks.findIndex((x) => x.id === n), 1)
      expect(s.undo().ok).toBe(false)
    })
  })
})

describe('applyAiEdit rollback (I1)', () => {
  const boom = new Error('boom')
  function check(build: (s: ReturnType<typeof setup>['s'], ids: ReturnType<typeof setup>) => (tx: any) => void) {
    const env = setup()
    const { s } = env
    const ch = s.addBlock('chart', env.a)
    s.history.clear()
    s.dirty.value = false
    const before = ser(s), rev = s.revision.value
    const fn = build(s, { ...env, ch } as any)
    expect(() => s.applyAiEdit({ label: 'x', run: fn })).toThrow(boom)
    expect(ser(s)).toBe(before)
    expect(s.history.undoDepth.value).toBe(0)
    expect(s.revision.value).toBe(rev)
    expect(s.dirty.value).toBe(false)
    expect(s.appliedNotice.value).toBeNull()
  }
  it('throw after updateContent', () => check((_s, e) => (tx) => { tx.updateContent(e.a, 'zzz'); throw boom }))
  it('throw after insertAfter', () => check((_s, e) => (tx) => { tx.updateContent(e.a, 'zzz'); tx.insertAfter('sql', e.a, 'n'); tx.insertAfter('markdown', e.b, 'm'); throw boom }))
  it('throw after setAnalysis', () => check((_s, e: any) => (tx) => { tx.setAnalysis(e.ch, { chartOptions: { type: 'line' } }); throw boom }))
})

describe('redo with multiple inserts (I2)', () => {
  it('same anchor twice and before/after anchors', () => {
    const { s, a, b } = setup()
    s.applyAiEdit({ label: 'x', run: (tx) => { tx.insertAfter('sql', a, 'n1'); tx.insertAfter('sql', a, 'n2'); tx.insertAfter('markdown', b, 'n3') } })
    const after = ser(s)
    const order = s.nb.value.blocks.map((x) => x.id)
    s.undo(); s.redo()
    expect(ser(s)).toBe(after)
    expect(s.nb.value.blocks.map((x) => x.id)).toEqual(order)
  })
})
