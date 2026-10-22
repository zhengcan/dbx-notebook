import { describe, it, expect, vi } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { HistoryStack, createHistory, type HistoryEntry } from '../src/state/history'
import { useNotebookStore } from '../src/state/notebookStore'

function entry(id: string, log: string[], check: 'ok' | 'conflict' = 'ok'): HistoryEntry {
  return { id, label: id, source: 'test', blockIds: [], check: () => check, undo: () => { log.push(`u${id}`) }, redo: () => { log.push(`r${id}`) } }
}

describe('HistoryStack', () => {
  it('undo/redo order and can flags', () => {
    const log: string[] = []
    const s = new HistoryStack()
    s.push(entry('a', log)); s.push(entry('b', log))
    expect(s.canUndo()).toBe(true); expect(s.canRedo()).toBe(false)
    expect(s.undo().ok).toBe(true); expect(s.undo().ok).toBe(true)
    expect(log).toEqual(['ub', 'ua'])
    expect(s.canUndo()).toBe(false); expect(s.canRedo()).toBe(true)
    s.redo(); s.redo()
    expect(log).toEqual(['ub', 'ua', 'ra', 'rb'])
  })
  it('push clears redo', () => {
    const s = new HistoryStack(); const log: string[] = []
    s.push(entry('a', log)); s.undo()
    expect(s.redoDepth).toBe(1)
    s.push(entry('b', log))
    expect(s.redoDepth).toBe(0)
  })
  it('caps at 200 dropping oldest', () => {
    const s = new HistoryStack(); const log: string[] = []
    for (let i = 0; i < 201; i++) s.push(entry(String(i), log))
    expect(s.undoDepth).toBe(200)
    for (let i = 0; i < 200; i++) s.undo()
    expect(log).not.toContain('u0')
    expect(log[log.length - 1]).toBe('u1')
    expect(s.undo()).toEqual({ ok: false, reason: 'empty' })
  })
  it('conflict: not executed, dropped, earlier entry still undoable', () => {
    const s = new HistoryStack(); const log: string[] = []
    s.push(entry('a', log)); s.push(entry('b', log, 'conflict'))
    const r = s.undo()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('conflict')
    expect(log).toEqual([])
    expect(s.undoDepth).toBe(1); expect(s.redoDepth).toBe(0)
    expect(s.undo().ok).toBe(true)
    expect(log).toEqual(['ua'])
  })
  it('redo conflict drops entry', () => {
    const s = new HistoryStack(); const log: string[] = []
    let c: 'ok' | 'conflict' = 'ok'
    s.push({ ...entry('a', log), check: (d) => (d === 'redo' ? c : 'ok') })
    s.undo(); c = 'conflict'
    const r = s.redo()
    expect(!r.ok && r.reason).toBe('conflict')
    expect(s.redoDepth).toBe(0); expect(log).toEqual(['ua'])
  })
  it('clear and onChange', () => {
    const onChange = vi.fn()
    const s = new HistoryStack({ onChange }); const log: string[] = []
    s.push(entry('a', log)); s.undo()
    expect(onChange).toHaveBeenCalledTimes(2)
    s.push(entry('b', log)); s.undo()
    s.clear()
    expect(s.undoDepth + s.redoDepth).toBe(0)
    expect(onChange).toHaveBeenCalledTimes(5)
  })
  it('createHistory is reactive', () => {
    const h = createHistory(); const log: string[] = []
    expect(h.canUndo.value).toBe(false)
    h.stack.push(entry('a', log))
    expect(h.undoDepth.value).toBe(1); expect(h.canUndo.value).toBe(true); expect(h.lastLabel.value).toBe('a')
    h.stack.undo()
    expect(h.canRedo.value).toBe(true); expect(h.lastLabel.value).toBe(null)
  })
})

describe('store history integration', () => {
  const fresh = () => { const s = useNotebookStore(); s.load(serializeNotebook(createEmptyNotebook()), null, null); return s }
  it('undo success touches; conflict/empty do not', () => {
    const s = fresh(); const log: string[] = []
    expect(s.undo()).toEqual({ ok: false, reason: 'empty' })
    expect(s.dirty.value).toBe(false)
    s.history.stack.push(entry('a', log))
    s.history.stack.push(entry('c', log, 'conflict'))
    s.history.stack.markSavepoint()
    const r0 = s.revision.value
    expect(s.undo().ok).toBe(false)
    expect(s.revision.value).toBe(r0); expect(s.dirty.value).toBe(false)
    expect(s.undo().ok).toBe(true)
    expect(s.revision.value).toBe(r0 + 1); expect(s.dirty.value).toBe(true)
    expect(s.redo().ok).toBe(true)
    expect(s.dirty.value).toBe(false)
  })
  it('load clears, plain save keeps', () => {
    const s = fresh(); const log: string[] = []
    s.history.stack.push(entry('a', log))
    s.markSaved('/p', 1)
    expect(s.history.undoDepth.value).toBe(1)
    s.load(serializeNotebook(createEmptyNotebook()), null, null)
    expect(s.history.undoDepth.value).toBe(0)
  })
})

describe('history vs file actions', () => {
  async function mk(current: string | null) {
    const { createFakeBridge } = await import('../src/host/fakeBridge')
    const { createFileActions } = await import('../src/shell/fileActions')
    const bridge = createFakeBridge({ invokeHandlers: { 'notebook/pickSave': () => ({ path: '/n.sqlnb' }), 'notebook/touchRecent': () => ({}), 'notebook/exists': () => ({ exists: false }), 'notebook/write': () => ({ mtimeMs: 3 }) } })
    const store = useNotebookStore()
    store.load(serializeNotebook(createEmptyNotebook()), current, 1)
    const fa = createFileActions({ bridge, store, notify: vi.fn(), confirm: vi.fn(async () => 'discard'), askExternalChange: vi.fn(async () => 'cancel'), pickPath: async () => '/n.sqlnb' } as any)
    const id = store.addBlock('sql', null)
    store.history.clear()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'select 1') })
    return { store, fa }
  }
  it('save-as clears history', async () => {
    const { store, fa } = await mk(null)
    expect(store.history.undoDepth.value).toBe(1)
    await fa.saveAs()
    expect(store.history.undoDepth.value).toBe(0)
  })
  it('plain save keeps history and undo re-dirties', async () => {
    const { store, fa } = await mk('/n.sqlnb')
    await fa.save()
    expect(store.dirty.value).toBe(false)
    expect(store.history.undoDepth.value).toBe(1)
    expect(store.undo().ok).toBe(true)
    expect(store.dirty.value).toBe(true)
  })
})

describe('step failure keeps entry', () => {
  it('undo()/redo() throwing does not lose the entry', () => {
    const s = new HistoryStack()
    let fail = true
    const e: HistoryEntry = { id: 'a', label: 'a', source: 't', blockIds: [], check: () => 'ok', undo: () => { if (fail) throw new Error('x') }, redo: () => { if (fail) throw new Error('y') } }
    s.push(e)
    expect(() => s.undo()).toThrow('x')
    expect(s.undoDepth).toBe(1); expect(s.redoDepth).toBe(0)
    fail = false
    expect(s.undo().ok).toBe(true)
    fail = true
    expect(() => s.redo()).toThrow('y')
    expect(s.redoDepth).toBe(1); expect(s.undoDepth).toBe(0)
  })
})

import type { DocEntry } from '../src/state/history'
function doc(id: string, bytes = 10, key?: string, at = 0): DocEntry {
  const z = { blocks: new Map() }
  return { id, label: id, source: 'user', blockIds: [], check: () => 'ok', undo() {}, redo() {}, seq: 0, before: z, after: z, bytes, sealed: false, key, at }
}
describe('HistoryStack budget, savepoint, coalescing', () => {
  it('push beyond 16 MB drops oldest until under; oversized single entry kept alone', () => {
    const s = new HistoryStack()
    const mb = 1024 * 1024
    s.push(doc('a', 6 * mb)); s.push(doc('b', 6 * mb)); s.push(doc('c', 6 * mb))
    expect(s.undoDepth).toBe(2)
    s.push(doc('big', 20 * mb))
    expect(s.undoDepth).toBe(1)
    expect(s.peekUndo()?.id).toBe('big')
  })
  it('savepoint: at top, undo leaves, redo returns', () => {
    const s = new HistoryStack()
    s.push(doc('a')); s.markSavepoint()
    expect(s.isAtSavepoint()).toBe(true)
    s.undo(); expect(s.isAtSavepoint()).toBe(false)
    s.redo(); expect(s.isAtSavepoint()).toBe(true)
  })
  it('savepoint trimmed by cap never true again', () => {
    const s = new HistoryStack({ cap: 2 })
    s.push(doc('a')); s.markSavepoint()
    s.push(doc('b')); s.push(doc('c'))
    expect(s.savepoint).toBeNull()
    while (s.canUndo()) s.undo()
    expect(s.isAtSavepoint()).toBe(false)
  })
  it('new push after undo past savepoint makes savepoint unreachable', () => {
    const s = new HistoryStack()
    s.push(doc('a')); s.markSavepoint(); s.undo(); s.push(doc('b')); s.undo()
    expect(s.isAtSavepoint()).toBe(false)
  })
  it('clear sets savepoint to the empty baseline', () => {
    const s = new HistoryStack()
    s.push(doc('a')); s.clear()
    expect(s.isAtSavepoint()).toBe(true)
  })
  it('coalesceInto merges only same key, in window, unsealed', () => {
    const s = new HistoryStack(); const d2 = { blocks: new Map<string, any>([['a', { id: 'a' }]]) }
    s.push(doc('a', 10, 'k', 1000))
    expect(s.coalesceInto('other', 1100, 800, d2)).toBe(false)
    expect(s.coalesceInto('k', 1900, 800, d2)).toBe(false)
    expect(s.coalesceInto('k', 1500, 800, d2)).toBe(true)
    expect(s.undoDepth).toBe(1)
    s.seal()
    expect(s.coalesceInto('k', 1600, 800, d2)).toBe(false)
    s.push(doc('b', 10, 'k', 2000)); s.markSavepoint()
    expect(s.coalesceInto('k', 2100, 800, d2)).toBe(false)
  })
  it('coalesce window slides with the last merge', () => {
    const s = new HistoryStack(); const d = { blocks: new Map<string, any>([['a', { id: 'a' }]]) }
    s.push(doc('a', 10, 'k', 0))
    expect(s.coalesceInto('k', 700, 800, d)).toBe(true)
    expect(s.coalesceInto('k', 1400, 800, d)).toBe(true)
  })
})

describe('coalesce back to the original pops the entry', () => {
  const D = (v: string) => ({ blocks: new Map<string, any>([['a', { id: 'a', type: 'markdown', content: v }]]) })
  const e = (id: string, from: string, to: string, key: string | undefined, at: number): DocEntry => ({ ...doc(id, 10, key, at), before: D(from), after: D(to) })
  it('merged burst equal to its start removes the entry; savepoint underneath becomes current', () => {
    const s = new HistoryStack()
    s.push(e('x', 'a', 'b', undefined, 0)); s.markSavepoint()
    s.push(e('y', 'b', 'c', 'k', 10))
    expect(s.isAtSavepoint()).toBe(false)
    expect(s.coalesceInto('k', 20, 800, D('b'))).toBe(true)
    expect(s.undoDepth).toBe(1)
    expect(s.isAtSavepoint()).toBe(true)
  })
  it('burst returning to the start after an earlier unsaved edit keeps that edit, not at savepoint', () => {
    const s = new HistoryStack()
    s.push(e('x', 'a', 'b', undefined, 0))
    s.push(e('y', 'b', 'c', 'k', 10))
    s.coalesceInto('k', 20, 800, D('b'))
    expect(s.undoDepth).toBe(1); expect(s.isAtSavepoint()).toBe(false)
  })
  it('a sealed entry never merges (no pop across a seal)', () => {
    const s = new HistoryStack()
    s.push(e('y', 'b', 'c', 'k', 10)); s.seal()
    expect(s.coalesceInto('k', 20, 800, D('b'))).toBe(false)
    expect(s.undoDepth).toBe(1)
  })
})
