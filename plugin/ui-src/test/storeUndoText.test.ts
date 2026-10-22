import { describe, it, expect } from 'vitest'
import { mkStore } from './undoHelpers'

describe('undo: text edits and coalescing', () => {
  it('10 keystrokes within 800 ms = 1 step; spaced 900 ms = 2', () => {
    const { s, clock, blk } = mkStore()
    for (let i = 0; i < 10; i++) { clock.t += 100; s.updateContent('s1', 'select ' + i, { coalesce: true }) }
    expect(s.history.undoDepth.value).toBe(1)
    clock.t += 900; s.updateContent('s1', 'later', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(2)
    s.undo(); expect(blk('s1').content).toBe('select 9')
    s.undo(); expect(blk('s1').content).toBe('select 1')
    expect(s.dirty.value).toBe(false)
  })
  it('sealHistory (blur) starts a new step; different block or field never merges', () => {
    const { s, clock } = mkStore()
    s.updateContent('s1', 'a', { coalesce: true }); clock.t += 10
    s.updateContent('s1', 'ab', { coalesce: true }); expect(s.history.undoDepth.value).toBe(1)
    s.sealHistory(); clock.t += 10
    s.updateContent('s1', 'abc', { coalesce: true }); expect(s.history.undoDepth.value).toBe(2)
    s.updateContent('m1', 'x', { coalesce: true }); expect(s.history.undoDepth.value).toBe(3)
    s.updateMeta('s1', { resultName: 'r1' }, { coalesce: 'resultName' }); expect(s.history.undoDepth.value).toBe(4)
    s.updateMeta('s1', { resultName: 'r12' }, { coalesce: 'resultName' }); expect(s.history.undoDepth.value).toBe(4)
    s.updateMeta('s1', { connection: 'd' }); expect(s.history.undoDepth.value).toBe(5)
  })
  it('identical content / meta pushes nothing', () => {
    const { s, blk } = mkStore()
    s.updateContent('s1', blk('s1').content, { coalesce: true })
    s.updateMeta('s1', { connection: 'c' })
    s.removeMetaKey('s1', 'nope')
    expect(s.history.undoDepth.value).toBe(0)
    expect(s.dirty.value).toBe(false)
  })
  it('undo of SQL text does not echo back into a new entry', () => {
    const { s, blk } = mkStore()
    s.updateContent('s1', 'new')
    s.undo()
    expect(blk('s1').content).toBe('select 1')
    expect(s.history.undoDepth.value).toBe(0)
    expect(s.history.redoDepth.value).toBe(1)
  })
  it('undo seals: typing after undo/redo is a new step', () => {
    const { s, clock } = mkStore()
    s.updateContent('m1', 'a', { coalesce: true }); clock.t += 10
    s.updateContent('m1', 'ab', { coalesce: true })
    s.undo(); s.redo(); clock.t += 10
    s.updateContent('m1', 'abc', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(2)
  })
  it('save seals the burst', () => {
    const { s, clock } = mkStore()
    s.updateContent('m1', 'a', { coalesce: true }); clock.t += 10
    s.markSaved('/x.sqlnb', 2, s.revision.value)
    s.updateContent('m1', 'ab', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(2)
    s.undo(); expect(s.dirty.value).toBe(false)
  })
  it('typing then deleting within the window leaves no entry and stays clean', () => {
    const { s, clock, blk } = mkStore()
    s.updateContent('m1', 'hello2', { coalesce: true }); clock.t += 50
    expect(s.dirty.value).toBe(true)
    s.updateContent('m1', 'hello', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(0)
    expect(s.dirty.value).toBe(false)
    expect(blk('m1').content).toBe('hello')
  })
  it('same burst after an earlier unsaved edit keeps dirty', () => {
    const { s, clock } = mkStore()
    s.updateMeta('s1', { maxRows: 5 })
    s.updateContent('m1', 'hello2', { coalesce: true }); clock.t += 50
    s.updateContent('m1', 'hello', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(1)
    expect(s.dirty.value).toBe(true)
  })
})
