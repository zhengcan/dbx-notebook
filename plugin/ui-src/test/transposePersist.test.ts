import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

function nbText(meta: Record<string, unknown> = {}) {
  const nb: any = createEmptyNotebook()
  nb.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: meta })
  return serializeNotebook(nb)
}
const saved = (store: any) => store.toText()

describe('transposed persisted in the notebook', () => {
  it('loads from clients.dbx.transposed', () => {
    const store = useNotebookStore()
    store.load(nbText({ clients: { dbx: { transposed: true } } }), null, null)
    expect(store.transposed.get('b1')).toBe(true)
    expect(store.dirty.value).toBe(false)
  })
  it('set true marks dirty and saves the key; false removes it, keeping unknown clients', () => {
    const store = useNotebookStore()
    store.load(nbText({ clients: { other: { x: 1 }, dbx: { keep: 'y' } } }), null, null)
    store.setTransposed('b1', true)
    expect(store.dirty.value).toBe(true)
    expect(store.transposed.get('b1')).toBe(true)
    let text = saved(store)
    expect(text).toContain('transposed: true')
    expect(text).toContain('x: 1')
    store.setTransposed('b1', false)
    text = saved(store)
    expect(text).not.toContain('transposed')
    expect(text).toContain('x: 1')
    expect(text).toContain('keep: "y"')
    expect(store.transposed.get('b1')).not.toBe(true)
  })
  it('removes empty clients containers when false', () => {
    const store = useNotebookStore()
    store.load(nbText(), null, null)
    store.setTransposed('b1', true)
    store.setTransposed('b1', false)
    expect(saved(store)).not.toContain('clients')
  })
  it('no-op when unchanged does not dirty', () => {
    const store = useNotebookStore()
    store.load(nbText(), null, null)
    store.setTransposed('b1', false)
    expect(store.dirty.value).toBe(false)
  })
  it('duplicate copies the preference', () => {
    const store = useNotebookStore()
    store.load(nbText({ clients: { dbx: { transposed: true } } }), null, null)
    const copy = store.duplicateBlock('b1')
    expect(store.transposed.get(copy)).toBe(true)
  })
  it('round trips through reload', () => {
    const a = useNotebookStore()
    a.load(nbText(), null, null)
    a.setTransposed('b1', true)
    const b = useNotebookStore()
    b.load(saved(a), null, null)
    expect(b.transposed.get('b1')).toBe(true)
  })
})
