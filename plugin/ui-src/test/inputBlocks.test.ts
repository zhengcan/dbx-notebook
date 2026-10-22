import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'
import { isValidVariableName } from '../src/state/inputVars'
import full from '../../../spec/examples/full.sqlnb?raw'

function fresh() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  s.load(serializeNotebook(createEmptyNotebook()), null, null)
  return s
}
const blk = (s: ReturnType<typeof fresh>, id: string) => s.nb.value.blocks.find((b) => b.id === id)!

describe('input blocks in store', () => {
  it('addBlock input defaults, unique names, positioning, dirty/revision', () => {
    const s = fresh()
    const a = s.addBlock('input', null)
    expect(blk(s, a)).toEqual({ id: a, type: 'input', metadata: { variable: 'var1', inputType: 'text', value: '' } })
    const sq = s.addBlock('sql', a)
    const b = s.addBlock('input', a)
    expect(s.nb.value.blocks.map((x) => x.id)).toEqual([a, b, sq])
    expect(blk(s, b).metadata!.variable).toBe('var2')
    s.updateMeta(a, { variable: 'x' })
    expect(blk(s, s.addBlock('input', null)).metadata!.variable).toBe('var1')
    s.dirty.value = false
    const r = s.revision.value
    s.addBlock('input', null)
    expect(s.dirty.value).toBe(true); expect(s.revision.value).toBe(r + 1)
  })
  it('inputVars order, skipping, duplicates', () => {
    const s = fresh()
    const a = s.addBlock('input', null)
    const b = s.addBlock('input', a)
    const c = s.addBlock('input', b)
    const d = s.addBlock('input', c)
    s.addBlock('sql', null)
    s.updateMeta(a, { variable: 'p', inputType: 'number', value: 3 })
    s.updateMeta(b, { variable: 'q', inputType: 'select', value: ['x'], multiple: true })
    s.updateMeta(c, { inputType: 'bogus' })
    s.updateMeta(d, { variable: 7 })
    expect(s.inputVars()).toEqual([
      { name: 'p', inputType: 'number', value: 3, multiple: undefined },
      { name: 'q', inputType: 'select', value: ['x'], multiple: true },
    ])
    s.updateMeta(c, { inputType: 'text', variable: 'p' })
    expect(s.inputVars().map((v) => v.name)).toEqual(['p', 'q', 'p'])
  })
  it('duplicate rename chain; non-input unchanged; dirty', () => {
    const s = fresh()
    const a = s.addBlock('input', null)
    s.updateMeta(a, { variable: 'a' })
    const d1 = s.duplicateBlock(a)
    expect(blk(s, d1).metadata!.variable).toBe('a_2')
    const r = s.revision.value
    const d2 = s.duplicateBlock(a)
    expect(blk(s, d2).metadata!.variable).toBe('a_3')
    expect(s.revision.value).toBe(r + 1); expect(s.dirty.value).toBe(true)
    const q = s.addBlock('sql', null)
    s.updateMeta(q, { resultName: 'r' })
    expect(blk(s, s.duplicateBlock(q)).metadata!.resultName).toBe('r_copy')
  })
  it('uniqueVariableName & validity; remove just removes', () => {
    const s = fresh()
    const a = s.addBlock('input', null)
    s.updateMeta(a, { variable: 'v' })
    expect(s.uniqueVariableName('v')).toBe('v_2')
    expect(s.uniqueVariableName('v', a)).toBe('v')
    expect(isValidVariableName('a_1')).toBe(true)
    expect(isValidVariableName('1a')).toBe(false)
    expect(isValidVariableName('a'.repeat(64))).toBe(false)
    s.addBlock('sql', a)
    s.removeBlock(a)
    expect(s.nb.value.blocks).toHaveLength(1)
  })
  it('full.sqlnb round-trips input metadata', () => {
    const s = useNotebookStore()
    s.load(full, null, null)
    const before = s.inputVars()
    expect(before.length).toBeGreaterThanOrEqual(2)
    const t = s.toText()
    const s2 = useNotebookStore(); s2.load(t, null, null)
    expect(s2.inputVars()).toEqual(before)
    const sel = s2.nb.value.blocks.find((b) => b.metadata?.variable === 'statuses')!
    expect(sel.metadata!.options).toEqual(['refunded', 'partial', 'disputed'])
  })

  it('inputVars returns clones of array values', () => {
    const store = useNotebookStore()
    const id = store.addBlock('input', null)
    store.updateMeta(id, { inputType: 'select', multiple: true, value: ['a'] })
    const v = store.inputVars()[0].value as string[]
    v.push('zzz')
    expect(store.nb.value.blocks[0].metadata!.value).toEqual(['a'])
    expect('isValidVariableName' in store).toBe(false)
  })
})
