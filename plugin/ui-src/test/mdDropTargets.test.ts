import { describe, expect, it } from 'vitest'
import { createDropTargets, pickDropTarget, type DropTarget } from '../src/blocks/mdDropTargets'

const mk = (id: string, editing = false): DropTarget => ({ id, el: null, isEditing: () => editing, insert: async () => {} })

describe('pickDropTarget', () => {
  it('editing wins over recent', () => {
    const a = mk('a'), b = mk('b', true)
    const r = pickDropTarget([a, b], 'a')
    expect(r).toEqual({ target: b, reason: 'editing' })
  })
  it('recent wins over sole/none', () => {
    const a = mk('a'), b = mk('b')
    expect(pickDropTarget([a, b], 'b')).toEqual({ target: b, reason: 'recent' })
  })
  it('sole block when none touched', () => {
    const a = mk('a')
    expect(pickDropTarget([a], null)).toEqual({ target: a, reason: 'sole' })
  })
  it('several, none touched → none', () => {
    expect(pickDropTarget([mk('a'), mk('b')], null)).toEqual({ target: null, reason: 'none' })
  })
  it('no blocks → none', () => {
    expect(pickDropTarget([], null)).toEqual({ target: null, reason: 'none' })
  })
  it('stale lastActiveId not in list is ignored', () => {
    expect(pickDropTarget([mk('a'), mk('b')], 'gone').reason).toBe('none')
  })
  it('two editing → most recently touched', () => {
    const reg = createDropTargets()
    const a = mk('a', true), b = mk('b', true)
    reg.register(a); reg.register(b)
    reg.touch('b'); reg.touch('a')
    expect(pickDropTarget(reg.list(), reg.lastActiveId()).target).toBe(a)
    reg.touch('b')
    expect(pickDropTarget(reg.list(), reg.lastActiveId()).target).toBe(b)
  })
})

describe('createDropTargets', () => {
  it('unregistered block is never returned and clears lastActiveId', () => {
    const reg = createDropTargets()
    const a = mk('a'), b = mk('b')
    const offA = reg.register(a); reg.register(b)
    reg.touch('a')
    expect(reg.lastActiveId()).toBe('a')
    offA()
    expect(reg.lastActiveId()).toBeNull()
    expect(reg.list()).toEqual([b])
    expect(pickDropTarget(reg.list(), reg.lastActiveId())).toEqual({ target: b, reason: 'sole' })
  })
  it('touching an unknown id is ignored', () => {
    const reg = createDropTargets()
    reg.touch('zzz')
    expect(reg.lastActiveId()).toBeNull()
  })
})
