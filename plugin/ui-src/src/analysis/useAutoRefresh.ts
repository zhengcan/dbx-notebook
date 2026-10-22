import { watch } from 'vue'

// Computes a block's result when it has none yet and its source is ready (immediately, or once the
// source result arrives after mount, e.g. loaded from .out). An existing result is never replaced
// here (reruns of the source only mark it stale). One attempt per source version: a failed attempt
// is not retried until the key changes, the block becomes unrunnable and runnable again, or the
// user presses refresh.
export function useAutoRefresh(o: { key: () => string | null; runnable: () => boolean; hasResult: () => boolean; refresh: () => void }) {
  let tried: string | null = null
  watch(() => [o.runnable(), o.hasResult(), o.key()] as const, ([runnable, has, key]) => {
    if (!runnable || key === null) { tried = null; return }
    if (has || tried === key) return
    tried = key
    o.refresh()
  }, { immediate: true })
}
