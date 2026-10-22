import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import NotebookView from '../src/shell/NotebookView.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createHistoryActions } from '../src/shell/historyActions'
import { HistoryActionsKey, SelectedKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

beforeEach(() => setLocale('en'))
afterEach(() => { document.body.innerHTML = '' })
function view() {
  const store = useNotebookStore()
  const actions = createHistoryActions(store as any, { fallbackFocus: () => document.querySelector<HTMLElement>('[data-test=notebook-view]') })
  const w = mount(NotebookView, { attachTo: document.body, global: { provide: { [StoreKey as symbol]: store, [SelectedKey as symbol]: ref(null), [HistoryActionsKey as symbol]: actions } } })
  return { store, actions, w }
}

describe('focus after undo/redo', () => {
  it('undo of a delete does not move focus into the restored (empty markdown) block', async () => {
    const { store, actions } = view()
    const a = store.addBlock('markdown', null); store.updateContent(a, 'keep')
    const b = store.addBlock('markdown', a)   // empty: autofocuses on mount normally
    await flushPromises()
    const outside = document.createElement('button'); document.body.appendChild(outside); outside.focus()
    store.removeBlock(b); await flushPromises()
    outside.focus()
    actions.undo(); await flushPromises(); await new Promise((r) => setTimeout(r, 5))
    expect(store.nb.value.blocks.some((x) => x.id === b)).toBe(true)
    expect(document.activeElement).toBe(outside)
  })
  it('focus on a still-existing element is untouched by undo/redo', async () => {
    const { store, actions } = view()
    const a = store.addBlock('markdown', null); store.updateContent(a, 'k'); await flushPromises()
    const btn = document.querySelector<HTMLElement>('[data-test=add-md]')!
    btn.focus()
    store.addBlock('input', a); await flushPromises(); btn.focus()
    actions.undo(); await flushPromises()
    expect(document.activeElement).toBe(btn)
    actions.redo(); await flushPromises()
    expect(document.activeElement).toBe(btn)
  })
  it('when the focused block is undone away, focus falls back to the notebook container (focusable, not a block)', async () => {
    const { store, actions } = view()
    const a = store.addBlock('markdown', null); store.updateContent(a, 'k')
    const b = store.addBlock('input', a); await flushPromises()
    document.querySelector<HTMLElement>(`[data-block-id=${b}] [data-test=var-name]`)!.focus()
    expect(document.activeElement?.closest(`[data-block-id=${b}]`)).not.toBeNull()
    actions.undo(); await flushPromises()
    expect(store.nb.value.blocks.some((x) => x.id === b)).toBe(false)
    const root = document.querySelector<HTMLElement>('[data-test=notebook-view]')!
    expect(document.activeElement).toBe(root)
    expect(root.getAttribute('tabindex')).toBe('-1')
  })
})
