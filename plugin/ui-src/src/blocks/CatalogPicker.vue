<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '../i18n'

const props = defineProps<{
  kind: 'database' | 'schema'
  modelValue?: string
  options: string[]
  loading: boolean
  error?: string
  placeholder?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: string | undefined]; open: [] }>()
const listId = `cat-${Math.random().toString(36).slice(2)}`
function onFocus() {
  if (props.options.length === 0 && !props.loading) emit('open')
}
const draft = ref(props.modelValue ?? '')
watch(() => props.modelValue, (v) => { draft.value = v ?? '' })
function commit(raw: string) {
  const v = raw.trim()
  emit('update:modelValue', v === '' ? undefined : v)
}
function onInput(e: Event) {
  const el = e.target as HTMLInputElement
  draft.value = el.value
  const typed = e instanceof InputEvent && (e.inputType === '' ? false : !e.inputType.startsWith('insertReplacement'))
  if (!typed) commit(el.value)
}
function onBlur() {
  draft.value = props.modelValue ?? ''
}
function onChange(e: Event) {
  commit((e.target as HTMLInputElement).value)
}
</script>

<template>
  <span class="catp" :data-kind="kind">
    <input
      :data-test="`cat-${kind}`"
      :list="listId"
      :value="draft"
      :placeholder="placeholder ?? t(kind === 'database' ? 'cat.database' : 'cat.schema')"
      :aria-label="t(kind === 'database' ? 'cat.database' : 'cat.schema')"
      :title="t(kind === 'database' ? 'cat.database' : 'cat.schema')"
      @focus="onFocus"
      @input="onInput"
      @change="onChange"
      @blur="onBlur"
    />
    <datalist :id="listId"><option v-for="o in options" :key="o" :value="o" /></datalist>
    <span v-if="loading" class="catp-note" data-test="cat-loading">{{ t('cat.loading') }}</span>
    <span v-else-if="error" class="catp-note" data-test="cat-error" :title="error">{{ t('cat.error') }}</span>
  </span>
</template>

<style scoped>
.catp { display: inline-flex; align-items: center; gap: 4px; }
.catp input { width: 120px; }
.catp-note { font-size: 11px; color: var(--color-muted-foreground, #777); white-space: nowrap; }
</style>
