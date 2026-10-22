<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import ConfirmDialog from '../shell/ConfirmDialog.vue'

const props = defineProps<{ title: string; subtitle?: string; confirmLabel?: string; dirty: boolean; confirmDisabledReason?: string; busy: boolean; closeRequest?: boolean; hideConfirm?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm'): void; (e: 'discard'): void; (e: 'close-request'): void }>()
const uid = Math.random().toString(36).slice(2, 8)
const root = ref<HTMLElement | null>(null)
const askDiscard = ref(false)
const FOCUSABLE = 'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'

function visible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
    if (!d.open && !(el.closest('summary')?.parentElement === d)) return false
  }
  return true
}
let prevOverflow = ''
onMounted(async () => {
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKey)
  await nextTick()
  const el = root.value?.querySelector<HTMLElement>('[data-test=chat-input]') ?? root.value?.querySelector<HTMLElement>(FOCUSABLE)
  el?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = prevOverflow
})
function requestClose() {
  if (props.closeRequest) emit('close-request')
  else if (props.dirty) askDiscard.value = true
  else emit('close')
}
let downOnBackdrop = false
let upOnBackdrop = false
function onBackdropUp(e: MouseEvent) {
  upOnBackdrop = e.target === e.currentTarget
}
function onBackdropClick() {
  const ok = downOnBackdrop && upOnBackdrop
  downOnBackdrop = false
  upOnBackdrop = false
  if (ok && !askDiscard.value) requestClose()
}
function onChoose(id: string) {
  askDiscard.value = false
  if (id === 'discard') emit('close')
}
// Document-level so Esc/Tab keep working when focus falls to <body> (e.g. a focused button was removed).
// Handled events (nested CodeMirror autocomplete/search) are left alone. Tab inside a `.cm-editor` is never
// trapped: the editor owns Tab; the trap only applies to the surrounding controls.
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || askDiscard.value) return
  if (e.key === 'Escape') { e.preventDefault(); requestClose() }
  else if (e.key === 'Tab' && root.value) {
    const target = e.target as HTMLElement | null
    if (target?.closest?.('.cm-editor')) return
    const els = Array.from(root.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible)
    if (!els.length) return
    e.preventDefault()
    const step = e.shiftKey ? -1 : 1
    let i = els.indexOf(document.activeElement as HTMLElement)
    for (let n = 0; n < els.length; n++) {
      i = i < 0 ? (e.shiftKey ? els.length - 1 : 0) : (i + step + els.length) % els.length
      els[i].focus()
      if (document.activeElement === els[i]) return
    }
  }
}
</script>

<template>
  <div class="dr-backdrop" data-test="ai-drawer" @mousedown="downOnBackdrop = $event.target === $event.currentTarget" @mouseup="onBackdropUp" @click.self="onBackdropClick">
    <div ref="root" class="dr" role="dialog" aria-modal="true" :aria-labelledby="`dr-title-${uid}`">
      <header class="dr-head">
        <div>
          <h2 :id="`dr-title-${uid}`" class="dr-title">{{ title }}</h2>
          <p v-if="subtitle" class="dr-sub" data-test="drawer-subtitle">{{ subtitle }}</p>
        </div>
        <button type="button" class="btn" data-test="drawer-close" :aria-label="t('ai.close')" @click="requestClose">✕</button>
      </header>
      <div class="dr-body">
        <div class="dr-left" data-test="drawer-left"><slot name="left" /></div>
        <div class="dr-right" data-test="drawer-right"><slot name="chat" /></div>
      </div>
      <footer class="dr-foot">
        <slot name="footer-extra" />
        <span class="spacer" />
        <span v-if="confirmDisabledReason" :id="`dr-why-${uid}`" class="why" data-test="drawer-confirm-reason">{{ confirmDisabledReason }}</span>
        <button type="button" class="btn" data-test="drawer-discard" @click="emit('discard')">{{ t('drawer.discard') }}</button>
        <button
          v-if="!hideConfirm" type="button" class="btn primary" data-test="drawer-confirm" :disabled="busy || !!confirmDisabledReason"
          :aria-describedby="confirmDisabledReason ? `dr-why-${uid}` : undefined" @click="emit('confirm')"
        >{{ confirmLabel ?? t('drawer.confirm') }}</button>
      </footer>
    </div>
    <slot />
    <ConfirmDialog
      :open="askDiscard" :title="t('drawer.discardTitle')" :message="t('drawer.discardMsg')" initial-focus="cancel" @choose="onChoose"
      :buttons="[{ id: 'discard', label: t('drawer.discardDraft'), variant: 'danger' }, { id: 'cancel', label: t('drawer.keep') }]"
    />
  </div>
</template>

<style scoped>
.dr-backdrop { position: fixed; inset: 0; background: var(--color-overlay, color-mix(in srgb, var(--color-background) 40%, transparent)); z-index: 900; overscroll-behavior: contain; display: flex; justify-content: flex-end; }
.dr { width: 80%; max-width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--color-background); color: var(--color-foreground); border-left: 1px solid var(--color-border); box-shadow: -8px 0 32px color-mix(in srgb, var(--color-foreground) 25%, transparent); }
.dr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--color-border); }
.dr-title { margin: 0; font-size: 15px; }
.dr-sub { margin: 2px 0 0; font-size: 12px; color: var(--color-muted-foreground); }
.dr-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
.dr-left { min-width: 0; overflow: auto; padding: 12px 14px; border-right: 1px solid var(--color-border); }
.dr-right { min-width: 0; min-height: 0; padding: 12px 14px; }
.dr-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--color-border); }
.spacer { flex: 1; }
.why { font-size: 12px; color: var(--color-muted-foreground); }
.btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.btn.primary { background: var(--color-primary); color: var(--color-primary-foreground); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
