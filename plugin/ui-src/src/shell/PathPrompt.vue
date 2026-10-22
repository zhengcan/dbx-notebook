<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import { createImeGuard } from '../ui/imeEnter'

const props = defineProps<{ open: boolean; initial?: string; title?: string; placeholder?: string }>()
const emit = defineEmits<{ (e: 'submit', path: string): void; (e: 'cancel'): void }>()
const value = ref(props.initial ?? '')
const root = ref<HTMLElement | null>(null)
watch(() => props.open, async (o) => {
  if (!o) return
  value.value = props.initial ?? ''
  await nextTick()
  root.value?.querySelector<HTMLElement>('input')?.focus()
}, { immediate: true, flush: 'post' })
function submit() {
  const v = value.value.trim()
  if (v) emit('submit', v)
}
const ime = createImeGuard()
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement && ime.isImeEnter(e)) { e.preventDefault(); return }
  if (e.key === 'Escape') { e.preventDefault(); emit('cancel') }
  else if (e.key === 'Tab' && root.value) {
    const els = Array.from(root.value.querySelectorAll<HTMLElement>('input, button'))
    if (!els.length) return
    const i = els.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1)
    e.preventDefault(); els[next].focus()
  }
}
</script>

<template>
  <div v-if="open" class="pp-backdrop">
    <form ref="root" class="pp" role="dialog" aria-modal="true" @submit.prevent="submit" @keydown="onKey">
      <h3>{{ title ?? t('dlg.pathTitle') }}</h3>
      <input v-model="value" data-test="path-input" type="text" @compositionstart="ime.onCompositionStart()" @compositionend="ime.onCompositionEnd()" @compositioncancel="ime.onReset()" @blur="ime.onReset()" :placeholder="placeholder ?? t('start.pathPlaceholder')" />
      <div class="pp-actions">
        <button type="button" data-test="path-cancel" @click="emit('cancel')">{{ t('dlg.cancel') }}</button>
        <button type="submit" data-test="path-ok">{{ t('dlg.ok') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.pp-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.pp { background: var(--color-background, #fff); color: var(--color-foreground, #111); border: 1px solid var(--color-border, #ccc); border-radius: 8px; padding: 16px 20px; min-width: 360px; }
.pp h3 { margin: 0 0 8px; font-size: 15px; }
.pp input { width: 100%; box-sizing: border-box; padding: 4px 8px; }
.pp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
