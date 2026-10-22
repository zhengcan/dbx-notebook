import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import NotebookView from '../src/shell/NotebookView.vue'
import AppliedBar from '../src/ai/AppliedBar.vue'
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { SelectedKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

afterEach(() => { document.body.innerHTML = '' })

function view() {
  setLocale('en')
  const store = useNotebookStore()
  const selected = ref<string | null>(null)
  const w = mount(NotebookView, { attachTo: document.body, global: { provide: { [StoreKey as symbol]: store, [SelectedKey as symbol]: selected } } })
  return { store, selected, w }
}

describe('reference holders when a block disappears via undo/delete', () => {
  it('selection is cleared when the selected block is removed or its add is undone; never re-selected by undo of a delete', async () => {
    const { store, selected, w } = view()
    const a = store.addBlock('markdown', null)
    const b = store.addBlock('markdown', a)
    store.updateContent(b, 'keep') // an empty markdown block autofocuses its editor when mounted (existing behaviour)
    await flushPromises()
    await w.find(`[data-block-id=${b}]`).trigger('mousedown')
    expect(selected.value).toBe(b)
    store.undo(); store.undo(); await flushPromises()
    expect(selected.value).toBeNull()
    store.redo(); store.redo(); await flushPromises()
    await w.find(`[data-block-id=${b}]`).trigger('mousedown')
    store.removeBlock(b); await flushPromises()
    expect(selected.value).toBeNull()
    store.undo(); await flushPromises()
    expect(selected.value).toBeNull()
    expect(w.find(`[data-block-id=${b}]`).exists()).toBe(true)
  })
  it('the delete-confirm dialog closes when its block vanishes through undo', async () => {
    const { store, w } = view()
    const a = store.addBlock('markdown', null)
    store.updateContent(a, 'text'); await flushPromises()
    await w.find(`[data-block-id=${a}] [data-test=del]`).trigger('click'); await flushPromises()
    expect(document.body.querySelector('.cd')).not.toBeNull()
    store.undo(); store.undo(); await flushPromises()
    expect(document.body.querySelector('.cd')).toBeNull()
    expect(store.nb.value.blocks).toHaveLength(0)
  })
  it('chart labels dialog closes when the chart block is undone away', async () => {
    setLocale('en')
    const store = useNotebookStore()
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } } as any)
    store.runs.set('s1', { status: 'ok', executedAt: 'T', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['a', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    const id = store.addBlock('chart', 's1')
    store.setAnalysis(id, { data: 'sales', pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] } as any })
    const w = mount(AnalysisBlock, { props: { blockId: id }, attachTo: document.body, global: { provide: { [StoreKey as symbol]: store } } })
    await w.find('[data-test=ab-labels-open]').trigger('click'); await flushPromises()
    expect(document.body.querySelector('[data-test=labels-dialog], .labels-dialog, [role=dialog]')).not.toBeNull()
    store.undo(); store.undo(); await flushPromises()
    expect(store.nb.value.blocks.some((b) => b.id === id)).toBe(false)
    expect(document.body.querySelector('[role=dialog]')).toBeNull()
    w.unmount()
  })
})

describe('AppliedBar with user steps on top', () => {
  function bar() {
    setLocale('en')
    const store = useNotebookStore()
    const a = store.addBlock('markdown', null)
    store.updateContent(a, 'orig'); store.history.clear()
    store.applyAiEdit({ label: 'AI', run: (tx) => tx.updateContent(a, 'ai') })
    const w = mount(AppliedBar, { props: { blockId: a }, global: { provide: { [StoreKey as symbol]: store } } })
    return { store, a, w }
  }
  it('shown right after the AI apply; the button undoes the AI entry', async () => {
    const { store, a, w } = bar()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(true)
    await w.find('[data-test=ai-undo]').trigger('click')
    expect(store.nb.value.blocks[0].content).toBe('orig')
    expect(a).toBeTruthy()
  })
  it('a user step on top hides the bar (chronological undo is via the shortcut, never a skipped step)', async () => {
    const { store, w } = bar()
    store.addBlock('markdown', null); await flushPromises()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(false)
    expect(store.history.stack.peekUndo()?.source).toBe('user')
  })
})
