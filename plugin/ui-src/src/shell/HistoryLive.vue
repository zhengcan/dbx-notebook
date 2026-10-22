<script setup lang="ts">
import type { HistoryActions } from './historyActions'
defineProps<{ actions: Pick<HistoryActions, 'message'> }>()
</script>

<template>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-test="history-live"><span :key="actions.message.value.seq">{{ actions.message.value.text }}</span></div>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
