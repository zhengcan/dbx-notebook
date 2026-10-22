import { nextTick, ref, watch, type Ref } from 'vue'
import type { useNotebookStore } from '../state/notebookStore'

type Store = ReturnType<typeof useNotebookStore>
export type DrawerSpec = { purpose: 'sql' | 'interpret' | 'chart' | 'bignumber'; blockId: string }
/**
 * Close contract: the host (App.vue) renders the registered body for `purpose` with prop `spec` and calls
 * `close()` itself on the body's `close` event, so a body that forgets cannot wedge the app.
 */
export interface DrawerManager {
  current: Readonly<Ref<DrawerSpec | null>>
  open(spec: DrawerSpec): boolean
  close(): void
}

/** `hasBody` (optional) lets open() refuse purposes with no registered body so the app is never locked by an empty drawer. */
export function createDrawerManager(store: Store, hasBody?: (purpose: DrawerSpec['purpose']) => boolean): DrawerManager {
  const current = ref<DrawerSpec | null>(null)
  let opener: HTMLElement | null = null
  function close() {
    if (!current.value) return
    current.value = null
    const el = opener
    opener = null
    void nextTick(() => { if (el?.isConnected) el.focus?.() })
  }
  function open(spec: DrawerSpec): boolean {
    if (current.value || (hasBody && !hasBody(spec.purpose))) return false
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    current.value = { ...spec }
    return true
  }
  watch(() => store.generation.value, () => close())
  return { current, open, close }
}
