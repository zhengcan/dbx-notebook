<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

import type { DialogButton } from './dialogTypes'
export type { DialogButton }
const props = defineProps<{ open: boolean; title: string; message: string; buttons: DialogButton[]; initialFocus?: string; error?: string }>()
const emit = defineEmits<{ (e: 'choose', id: string): void }>()
const root = ref<HTMLElement | null>(null)

let prev: HTMLElement | null = null
const rid = Math.random().toString(36).slice(2, 8)
const titleId = `cd-title-${rid}`
const msgId = `cd-msg-${rid}`
watch(() => props.open, async (o) => {
  if (o) {
    prev = document.activeElement as HTMLElement | null
    await nextTick(); const bs = Array.from(root.value?.querySelectorAll<HTMLElement>('button') ?? [])
    const i = props.initialFocus ? props.buttons.findIndex((b) => b.id === props.initialFocus) : -1
    ;(bs[i] ?? bs[0])?.focus()
  } else if (prev) { prev.focus?.(); prev = null }
}, { immediate: true, flush: 'post' })

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    const esc = props.buttons.find((b) => b.id === 'cancel') ?? props.buttons.find((b) => b.escape)
    if (esc) { e.preventDefault(); e.stopPropagation(); emit('choose', esc.id) }
  } else if (e.key === 'Tab' && root.value) {
    const bs = Array.from(root.value.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (!bs.length) return
    const i = bs.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i === bs.length - 1 ? 0 : i + 1)
    e.preventDefault(); bs[next].focus()
  }
}
</script>

<template>
  <div v-if="open" class="cd-backdrop">
    <div ref="root" class="cd" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="msgId" @keydown="onKey">
      <h3 :id="titleId" class="cd-title">{{ title }}</h3>
      <p :id="msgId" class="cd-msg">{{ message }}</p>
      <slot />
      <p v-if="error" class="cd-error" data-test="cd-error" role="alert">{{ error }}</p>
      <div class="cd-actions">
        <button v-for="b in buttons" :key="b.id" type="button" :class="['cd-btn', b.variant && `cd-${b.variant}`]" :disabled="b.disabled" :aria-describedby="b.disabled ? b.describedby : undefined" :data-test="`cd-${b.id}`" @click="emit('choose', b.id)">{{ b.label }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.cd { background: var(--color-background, #fff); color: var(--color-foreground, #111); border: 1px solid var(--color-border, #ccc); border-radius: 8px; padding: 16px 20px; min-width: 320px; max-width: 480px; box-shadow: 0 8px 32px rgba(0, 0, 0, .25); }
.cd-title { margin: 0 0 8px; font-size: 15px; }
.cd-msg { margin: 0 0 16px; font-size: 13px; white-space: pre-wrap; }
.cd-error { margin: -8px 0 12px; font-size: 13px; color: var(--color-destructive, #b91c1c); }
.cd-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cd-btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border, #ccc); background: var(--color-muted, #f3f3f3); color: inherit; cursor: pointer; }
.cd-primary { background: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #fff); border-color: transparent; }
.cd-btn:disabled { opacity: .5; cursor: not-allowed; }
.cd-danger { background: var(--color-destructive, #dc2626); color: #fff; border-color: transparent; }
</style>
