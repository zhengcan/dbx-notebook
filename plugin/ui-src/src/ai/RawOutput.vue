<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'

const MAX_SHOWN = 4000
const props = defineProps<{ text: string }>()
const shown = computed(() => props.text.slice(0, MAX_SHOWN))
const cut = computed(() => props.text.length > MAX_SHOWN)
</script>

<template>
  <details v-if="text.trim() !== ''" class="raw" data-test="raw-output">
    <summary data-test="raw-output-summary">{{ t('ai.raw.show') }}</summary>
    <p class="hint">{{ t('ai.raw.hint') }}</p>
    <pre class="body" data-test="raw-output-text" tabindex="0" :aria-label="t('ai.raw.label')">{{ shown }}</pre>
    <p v-if="cut" class="hint" data-test="raw-output-cut">{{ t('ai.raw.cut', { shown: MAX_SHOWN, total: text.length }) }}</p>
  </details>
</template>

<style scoped>
.raw { font-size: 12px; color: var(--color-muted-foreground); }
.raw summary { cursor: pointer; }
.hint { margin: 4px 0; }
.body { margin: 4px 0 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; user-select: text; padding: 6px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-background); color: var(--color-foreground); font-family: ui-monospace, monospace; }
</style>
