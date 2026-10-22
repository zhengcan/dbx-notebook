<script setup lang="ts">
import { computed, inject } from 'vue'
import { StoreKey } from '../injection'
import { t } from '../i18n'

const store = inject(StoreKey)
if (!store) throw new Error('UndoConflictNotice: missing provided StoreKey')

// AppliedBar shows the conflict under its block; this covers entries whose block is gone (nothing renders a bar for them).
const orphaned = computed(() => {
  const n = store.appliedNotice.value
  return !!n && n.conflict && n.revision === store.revision.value && !store.nb.value.blocks.some((b) => b.id === n.blockId)
})
</script>

<template>
  <div v-if="orphaned" class="undo-conflict" data-test="ai-undo-conflict" role="alert">{{ t('ai.undoConflict') }}</div>
</template>

<style scoped>
.undo-conflict { margin: 4px 0; padding: 4px 10px; font-size: 12px; border: 1px solid var(--color-destructive); border-radius: 6px; background: var(--color-muted); color: var(--color-foreground); }
</style>
