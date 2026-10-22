import { getCurrentInstance, onBeforeUnmount } from 'vue'
import type { useNotebookStore } from '../state/notebookStore'

type Store = Pick<ReturnType<typeof useNotebookStore>, 'undo' | 'redo'> & { sealHistory?: () => void; history: { canUndo: { value: boolean }; canRedo: { value: boolean } } }

const IGNORED = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

function ignoredTarget(e: KeyboardEvent): boolean {
  const t = (e.composedPath?.()[0] ?? e.target) as Element | null
  if (!t || typeof t.matches !== 'function') return false
  return t.matches(IGNORED) || !!t.closest(IGNORED) || !!t.closest('.cm-editor')
}

export function useHistoryShortcuts(store: Store, target: Document = document, actions?: { undo(): unknown; redo(): unknown }): () => void {
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.altKey) return
    const k = e.key.toLowerCase()
    // non-Latin layouts: the physical key (event.code) counts when event.key is not an ASCII letter
    const is = (ch: string) => k === ch || (!/^[a-z]$/.test(k) && e.code === `Key${ch.toUpperCase()}`)
    const mod = e.metaKey || e.ctrlKey
    let dir: 'undo' | 'redo' | null = null
    if (mod && is('z')) dir = e.shiftKey ? 'redo' : 'undo'
    else if (e.ctrlKey && !e.metaKey && !e.shiftKey && is('y')) dir = 'redo'
    if (!dir) return
    if (ignoredTarget(e)) return
    if (target.querySelector('[aria-modal="true"]')) return
    if (!(dir === 'undo' ? store.history.canUndo.value : store.history.canRedo.value)) return
    e.preventDefault()
    if (actions) { if (dir === 'undo') actions.undo(); else actions.redo(); return }
    store.sealHistory?.()
    if (dir === 'undo') store.undo(); else store.redo()
  }
  target.addEventListener('keydown', onKey)
  const stop = () => target.removeEventListener('keydown', onKey)
  if (getCurrentInstance()) onBeforeUnmount(stop)
  return stop
}
