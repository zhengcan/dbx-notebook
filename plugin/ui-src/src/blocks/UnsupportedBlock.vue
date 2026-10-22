<script setup lang="ts">
import { computed, inject } from 'vue'
import { StoreKey } from '../injection'
import { t } from '../i18n'

const MAX = 4000
const props = defineProps<{ blockId: string }>()
const store = inject(StoreKey)!
const block = computed(() => store.nb.value.blocks.find((b) => b.id === props.blockId))
const json = computed(() => {
  const s = JSON.stringify(block.value ?? null, null, 2) ?? ''
  return s.length > MAX ? s.slice(0, MAX) + '\n…' : s
})
</script>

<template>
  <div class="unsupported-block">
    <div class="title">{{ t('unsupported.title', { type: String(block?.type ?? '') }) }}</div>
    <pre class="json">{{ json }}</pre>
  </div>
</template>

<style scoped>
.unsupported-block { padding: 6px 8px; border: 1px dashed var(--color-border, #ccc); color: var(--color-muted-foreground, #888); }
.json { max-height: 160px; overflow: auto; margin: 4px 0 0; font-size: 12px; user-select: text; }
</style>
