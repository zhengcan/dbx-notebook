import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, newBlockId, type Block, type Notebook } from '@sqlnb/format'
import { cloneTouched, applyDelta, sameDelta } from '../src/state/docHistory'

const blk = (id: string, content: string, md: Record<string, unknown> = {}): Block => ({ id, type: 'markdown', content, metadata: md } as unknown as Block)
function nbOf(...bs: Block[]): Notebook { const n = createEmptyNotebook(); n.blocks = bs; return n }

describe('docHistory', () => {
  it('cloneTouched shares nothing with the live block', () => {
    const n = nbOf(blk('a', 'x', { k: { deep: 1 } }))
    const d = cloneTouched(n, { ids: ['a'] })
    ;(n.blocks[0].metadata as any).k.deep = 2
    n.blocks[0].content = 'y'
    expect((d.blocks.get('a') as Block).content).toBe('x')
    expect(((d.blocks.get('a') as Block).metadata as any).k.deep).toBe(1)
  })
  it('applyDelta restores id, index and key order for remove/add/move', () => {
    const n = nbOf(blk('a', '1', { z: 1, a: 2 }), blk('b', '2'), blk('c', '3'))
    const orig = JSON.stringify(n)
    const before = cloneTouched(n, { ids: ['a', 'new'], order: true })
    n.blocks.splice(0, 1); n.blocks.push(blk('new', 'n'))
    const after = cloneTouched(n, { ids: ['a', 'new'], order: true })
    applyDelta(n, before)
    expect(JSON.stringify(n)).toBe(orig)
    applyDelta(n, after)
    expect(n.blocks.map((b) => b.id)).toEqual(['b', 'c', 'new'])
    const m = nbOf(blk('a', '1'), blk('b', '2'), blk('c', '3'))
    const b2 = cloneTouched(m, { ids: [], order: true })
    m.blocks.reverse()
    applyDelta(m, b2)
    expect(m.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(newBlockId).toBeTruthy()
  })
  it('doc-level fields round-trip', () => {
    const n = nbOf()
    const d = cloneTouched(n, { ids: [], doc: ['connections'] })
    n.connections = [{ name: 'x' }]
    applyDelta(n, d)
    expect(n.connections).toEqual([])
  })
  it('sameDelta true for equal content, false otherwise', () => {
    const n = nbOf(blk('a', 'x'))
    const d1 = cloneTouched(n, { ids: ['a'] }), d2 = cloneTouched(n, { ids: ['a'] })
    expect(sameDelta(d1, d2)).toBe(true)
    n.blocks[0].content = 'y'
    expect(sameDelta(d1, cloneTouched(n, { ids: ['a'] }))).toBe(false)
  })
})
