<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { cellText } from './grid/format'
import { t } from '../i18n'

const LIMIT = 100000
const PARSE_LIMIT = 1000000
const props = defineProps<{ open: boolean; column: string; value: unknown }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const root = ref<HTMLElement | null>(null)
const copyFailed = ref(false)

const isNull = computed(() => props.value === null || props.value === undefined)
const full = computed(() => {
  const v = props.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') {
    const s = v.trimStart()
    if (v.length <= PARSE_LIMIT && (s[0] === '{' || s[0] === '[')) {
      try { return JSON.stringify(JSON.parse(v), null, 2) } catch { /* plain */ }
    }
    return v
  }
  if (typeof v === 'object' && !(v instanceof Date)) {
    try {
      const j = JSON.stringify(v, null, 2)
      if (typeof j === 'string') return j
    } catch { /* fall back */ }
  }
  return cellText(v)
})
const truncated = computed(() => full.value.length > LIMIT)
const shown = computed(() => (truncated.value ? full.value.slice(0, LIMIT) : full.value))

let prev: HTMLElement | null = null
let listening = false
function listen(on: boolean) {
  if (on === listening) return
  listening = on
  if (on) window.addEventListener('keydown', onKey, true)
  else window.removeEventListener('keydown', onKey, true)
}
watch(() => props.open, async (o) => {
  copyFailed.value = false
  listen(o)
  if (o) {
    prev = document.activeElement as HTMLElement | null
    await nextTick(); root.value?.querySelector<HTMLElement>('button')?.focus()
  } else if (prev) { prev.focus?.(); prev = null }
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => listen(false))

async function copy() {
  const txt = full.value
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); copyFailed.value = false; return }
  } catch { /* fall through */ }
  let ok = false
  try {
    if (typeof document.execCommand === 'function') {
      const ta = document.createElement('textarea')
      ta.value = txt
      document.body.appendChild(ta)
      ta.select()
      ok = !!document.execCommand('copy')
      ta.remove()
    }
  } catch { /* ignore */ }
  copyFailed.value = !ok
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('close') }
  else if (e.key === 'Tab' && root.value) {
    const fs = Array.from(root.value.querySelectorAll<HTMLElement>('button, pre'))
    if (!fs.length) return
    const i = fs.indexOf(document.activeElement as HTMLElement)
    const next = i < 0 ? 0 : e.shiftKey ? (i === 0 ? fs.length - 1 : i - 1) : (i === fs.length - 1 ? 0 : i + 1)
    if (i >= 0 && next === i + (e.shiftKey ? -1 : 1)) return
    e.preventDefault(); fs[next].focus()
  }
}
</script>

<template>
  <div v-if="open" class="cdt-backdrop" @click.self="emit('close')">
    <div ref="root" class="cdt" role="dialog" aria-modal="true" :aria-label="column" tabindex="-1">
      <div class="cdt-head">
        <span class="cdt-title">{{ column }}</span>
        <button type="button" class="cdt-btn" data-test="copy" @click="copy">{{ t('cell.copy') }}</button>
      </div>
      <div v-if="isNull" class="cdt-null" data-test="null">{{ t('cell.null') }}</div>
      <pre v-else class="cdt-pre" tabindex="0">{{ shown }}</pre>
      <div v-if="truncated" class="cdt-note" data-test="truncated">{{ t('cell.truncated') }}</div>
      <div v-if="copyFailed" class="cdt-note">{{ t('result.copyFailed') }}</div>
    </div>
  </div>
</template>

<style scoped>
.cdt-backdrop { position: fixed; inset: 0; background: var(--color-overlay, rgba(0, 0, 0, .4)); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.cdt { background: var(--color-background, #fff); color: var(--color-foreground, #111); border: 1px solid var(--color-border, #ccc); border-radius: 8px; padding: 12px 16px; width: min(720px, 90vw); max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0, 0, 0, .25); }
.cdt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.cdt-title { font-weight: 600; font-size: 14px; }
.cdt-btn { font: inherit; padding: 2px 10px; border-radius: 4px; border: 1px solid var(--color-border, #ccc); background: var(--color-muted, #f3f3f3); color: inherit; cursor: pointer; }
.cdt-pre { margin: 0; overflow: auto; flex: 1; user-select: text; white-space: pre-wrap; word-break: break-word; font-family: monospace; font-size: 12px; }
.cdt-null { color: var(--color-muted-foreground, #888); font-style: italic; }
.cdt-note { margin-top: 6px; font-size: 12px; color: var(--color-warning, #b80); }
</style>
