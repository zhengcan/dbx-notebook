import { ref, type Ref } from 'vue'
import type { HistoryResult } from '../state/history'
import { t } from '../i18n'

interface Store {
  undo(): HistoryResult
  redo(): HistoryResult
  sealHistory(): void
}
export interface HistoryActions {
  undo(): HistoryResult
  redo(): HistoryResult
  message: Ref<{ text: string; seq: number }>
}

let restoring = false
/** True while an undo/redo (and the render it triggers) is in progress: restored blocks must not steal focus. */
export const isHistoryRestoring = () => restoring

const labelText = (l: string) => (l.startsWith('history.label.') ? t(l as 'history.label.editSql') : l)

export function createHistoryActions(store: Store, opts: { fallbackFocus?: () => HTMLElement | null } = {}): HistoryActions {
  const message = ref({ text: '', seq: 0 })
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  function run(dir: 'undo' | 'redo'): HistoryResult {
    store.sealHistory()
    restoring = true
    const focused = document.activeElement
    let r: HistoryResult
    try { r = dir === 'undo' ? store.undo() : store.redo() } finally { setTimeout(() => { restoring = false }, 0) }
    if (r.ok) {
      message.value = { text: t(dir === 'undo' ? 'history.undone' : 'history.redone', { label: labelText(r.entry.label) }), seq: message.value.seq + 1 }
      clearTimeout(clearTimer)
      clearTimer = setTimeout(() => { message.value = { text: '', seq: message.value.seq + 1 } }, 5000)
      void Promise.resolve().then(() => Promise.resolve()).then(() => {
        const a = document.activeElement
        const gone = !a || a === document.body || (focused && !focused.isConnected && a === document.body)
        if (gone) opts.fallbackFocus?.()?.focus({ preventScroll: true })
      })
    }
    return r
  }
  return { undo: () => run('undo'), redo: () => run('redo'), message }
}
