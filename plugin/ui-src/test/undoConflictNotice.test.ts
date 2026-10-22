import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import UndoConflictNotice from '../src/ai/UndoConflictNotice.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

describe('UndoConflictNotice', () => {
  it('shows a global alert when the conflicting entry\'s block no longer exists', async () => {
    setLocale('en')
    const store = useNotebookStore()
    store.load(serializeNotebook(createEmptyNotebook()), null, null)
    const a = store.addBlock('sql', null)
    const w = mount(UndoConflictNotice, { global: { provide: { [StoreKey as symbol]: store } } })
    let newId = ''
    store.applyAiEdit({ label: 'x', run: (tx) => { newId = tx.insertAfter('sql', a, 'select 1') } })
    store.nb.value.blocks.splice(store.nb.value.blocks.findIndex((b) => b.id === newId), 1)
    expect(store.undo().ok).toBe(false)
    await nextTick()
    const n = w.find('[data-test=ai-undo-conflict]')
    expect(n.attributes('role')).toBe('alert')
    expect(n.text()).toMatch(/modified|undone/i)
  })
  it('stays hidden when the block is still rendered (AppliedBar handles it) or no conflict', async () => {
    const store = useNotebookStore()
    store.load(serializeNotebook(createEmptyNotebook()), null, null)
    const a = store.addBlock('sql', null)
    const w = mount(UndoConflictNotice, { global: { provide: { [StoreKey as symbol]: store } } })
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(a, 'ai') })
    await nextTick()
    expect(w.find('[data-test=ai-undo-conflict]').exists()).toBe(false)
    store.nb.value.blocks[0].content = 'mine'
    store.undo()
    await nextTick()
    expect(w.find('[data-test=ai-undo-conflict]').exists()).toBe(false)
  })
})
