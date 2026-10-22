import { describe, it, expect } from 'vitest'
import { mkStore } from './undoHelpers'

describe('store.replaceMarkdown', () => {
  it('records exactly one sealed entry labelled mdFormat; undo/redo restore exact text', () => {
    const { s, blk } = mkStore()
    s.replaceMarkdown('m1', '**hello**')
    expect(blk('m1').content).toBe('**hello**')
    expect(s.history.undoDepth.value).toBe(1)
    expect(s.history.lastLabel.value).toBe('history.label.mdFormat')
    expect((s.history.stack.peekUndo() as any).sealed).toBe(true)
    expect(s.dirty.value).toBe(true)
    s.undo(); expect(blk('m1').content).toBe('hello'); expect(s.dirty.value).toBe(false)
    s.redo(); expect(blk('m1').content).toBe('**hello**')
  })
  it('never merges with typing before or after', () => {
    const { s, clock, blk } = mkStore()
    s.updateContent('m1', 'hello1', { coalesce: true }); clock.t += 10
    s.replaceMarkdown('m1', '**hello1**'); clock.t += 10
    s.updateContent('m1', blk('m1').content + 'z', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(3)
    expect((s.history.stack as any).undoStack[0].sealed).toBe(true)
    s.undo(); expect(blk('m1').content).toBe('**hello1**')
    s.undo(); expect(blk('m1').content).toBe('hello1')
    s.undo(); expect(blk('m1').content).toBe('hello')
  })
  it('two consecutive actions stay two steps (no coalescing)', () => {
    const { s, clock, blk } = mkStore()
    s.replaceMarkdown('m1', '*hello*'); clock.t += 10
    s.replaceMarkdown('m1', '**hello**')
    expect(s.history.undoDepth.value).toBe(2)
    s.undo(); expect(blk('m1').content).toBe('*hello*')
  })
  it('unchanged content or unknown id: no entry, no revision bump', () => {
    const { s } = mkStore()
    const rev = s.revision.value
    s.replaceMarkdown('m1', 'hello')
    s.replaceMarkdown('nope', 'x')
    expect(s.history.undoDepth.value).toBe(0)
    expect(s.revision.value).toBe(rev)
    expect(s.dirty.value).toBe(false)
  })
})
