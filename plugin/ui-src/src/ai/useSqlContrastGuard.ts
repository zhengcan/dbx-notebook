import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { applySqlContrastGuard, type SqlContrastGuard } from '../editor/sqlPalette'

// Keeps highlightSql() token colours readable on the real surface of `host` (the element that hosts the output).
// The host may appear after mount (e.g. a bubble that first renders while streaming), so the ref is watched.
export function useSqlContrastGuard(host: Ref<HTMLElement | null>): void {
  let guard: SqlContrastGuard | null = null
  let mounted = false
  const attach = (el: HTMLElement | null) => { guard?.dispose(); guard = el ? applySqlContrastGuard(el, el) : null }
  onMounted(() => { mounted = true; attach(host.value) })
  watch(host, (el) => { if (mounted) attach(el) }, { flush: 'post' })
  onBeforeUnmount(() => { guard?.dispose(); guard = null })
}
