import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import HistoryLive from '../src/shell/HistoryLive.vue'
import { createHistoryActions } from '../src/shell/historyActions'
import { useNotebookStore } from '../src/state/notebookStore'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { setLocale, messages } from '../src/i18n'

beforeEach(() => { setLocale('en'); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })
function mk() {
  const store = useNotebookStore()
  store.load(serializeNotebook(createEmptyNotebook()), null, null)
  const actions = createHistoryActions(store as any)
  const w = mount(HistoryLive, { props: { actions } })
  return { store, actions, w }
}

describe('HistoryLive', () => {
  it('is a polite visually-hidden status region, empty until an action', () => {
    const { w } = mk()
    const el = w.find('[role=status]')
    expect(el.attributes('aria-live')).toBe('polite')
    expect(el.text()).toBe('')
    expect(el.classes()).toContain('sr-only')
  })
  it('announces Undone/Redone with the translated label once; silent when empty', async () => {
    const { store, actions, w } = mk()
    actions.undo(); await nextTick()
    expect(w.text()).toBe('')
    store.addBlock('markdown', null)
    actions.undo(); await nextTick()
    expect(w.text()).toBe('Undone: Add block')
    actions.redo(); await nextTick()
    expect(w.text()).toBe('Redone: Add block')
    vi.advanceTimersByTime(6000); await nextTick()
    expect(w.text()).toBe('')
  })
  it('zh-CN text and AI labels pass through', async () => {
    setLocale('zh-CN')
    const { store, actions, w } = mk()
    store.addBlock('markdown', null); actions.undo(); await nextTick()
    expect(w.text()).toBe('已撤销：添加块')
    store.history.clear()
    const a = store.addBlock('markdown', null)
    store.history.clear()
    store.applyAiEdit({ label: 'AI: x', run: (tx) => tx.updateContent(a, 'z') })
    actions.undo(); await nextTick()
    expect(w.text()).toBe('已撤销：AI: x')
  })
  it('history.undone / redone keys exist in both locales', () => {
    for (const l of ['zh-CN', 'en'] as const) { expect((messages as any)[l]['history.undone']).toBeTruthy(); expect((messages as any)[l]['history.redone']).toBeTruthy() }
  })
  it('seals the pending burst before undo/redo', () => {
    const order: string[] = []
    const a = createHistoryActions({ sealHistory: () => order.push('seal'), undo: () => { order.push('undo'); return { ok: false, reason: 'empty' } }, redo: () => { order.push('redo'); return { ok: false, reason: 'empty' } } } as any)
    a.undo(); a.redo()
    expect(order).toEqual(['seal', 'undo', 'seal', 'redo'])
  })
})
