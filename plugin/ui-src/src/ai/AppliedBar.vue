<script setup lang="ts">
import { computed, inject, onBeforeUnmount, watch } from 'vue'
import { StoreKey } from '../injection'
import { t } from '../i18n'

const props = defineProps<{ blockId: string }>()
const store = inject(StoreKey)
if (!store) throw new Error('AppliedBar: missing provided StoreKey')

const DISMISS_MS = 8000
const notice = computed(() => {
  const n = store.appliedNotice.value
  if (!n || n.blockId !== props.blockId || n.revision !== store.revision.value) return null
  return n
})

let timer: ReturnType<typeof setTimeout> | undefined
function clear() { if (timer) { clearTimeout(timer); timer = undefined } }
watch(() => store.appliedNotice.value, (n) => {
  clear()
  if (n && n.blockId === props.blockId) {
    timer = setTimeout(() => { if (store.appliedNotice.value === n) store.appliedNotice.value = null }, DISMISS_MS)
  }
}, { immediate: true })
onBeforeUnmount(clear)

const outcomeText = computed(() => {
  const o = notice.value?.outcome
  if (!o) return ''
  if (o.kind === 'ran') return t('ai.autoRan')
  if (o.kind === 'failed') return t('ai.autoRanFailed', { message: o.message })
  return t(`ai.noRun.${o.reason}`, { name: o.detail ?? '' })
})
function undo() { store.undo() }
</script>

<template>
  <div v-if="notice" class="applied-bar" data-test="ai-applied-bar" :role="notice.conflict ? 'alert' : 'status'">
    <template v-if="notice.conflict">{{ t('ai.undoConflict') }}</template>
    <template v-else>
      <span>{{ t('ai.applied') }} ·</span>
      <button type="button" data-test="ai-undo" @click="undo">{{ t('ai.undo') }}</button>
      <span v-if="outcomeText" class="outcome" :class="{ failed: notice.outcome?.kind === 'failed' }" data-test="ai-outcome" :role="notice.outcome?.kind === 'failed' ? 'alert' : undefined">{{ outcomeText }}</span>
    </template>
  </div>
</template>

<style scoped>
.applied-bar { display: flex; gap: 6px; align-items: center; margin: 2px 0 4px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--nb-border); border-radius: 6px; background: var(--nb-muted); color: var(--nb-fg); }
.applied-bar[role='alert'] { border-color: var(--color-destructive, #d33); }
.applied-bar .outcome.failed { color: var(--color-destructive, #d33); }
.applied-bar button { cursor: pointer; background: none; border: none; color: var(--color-primary, #2563eb); text-decoration: underline; padding: 0; font: inherit; }
</style>
