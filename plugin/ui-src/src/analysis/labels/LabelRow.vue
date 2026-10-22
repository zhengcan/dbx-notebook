<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n'
import type { Row } from './useLabelRows'

const props = defineProps<{ row: Row; inputId: string; invalid: boolean; scalesId?: string; number?: number }>()
const emit = defineEmits<{ (e: 'commit', row: Row, value: string): void; (e: 'reset', row: Row): void; (e: 'escape', row: Row): void; (e: 'focus', row: Row): void }>()

const describedBy = computed(() => {
  const ids = [props.row.affects ? `${props.inputId}-aff` : '', props.row.overridden && !props.row.unused ? `${props.inputId}-cust` : '', props.invalid ? `${props.inputId}-err` : ''].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
})
// `:value` would be forced onto the DOM on every re-render (Vue always patches it) and wipe a mid-edit value when only
// unrelated data (an analysis re-run) changed; sync from the store value only when that value itself changes.
const el = ref<HTMLInputElement | null>(null)
const shown = computed(() => (props.row.overridden ? props.row.value : ''))
onMounted(() => { if (el.value) el.value.value = shown.value })
watch(shown, (v) => { if (el.value) el.value.value = v })
const SPLIT = new Set(['rowName', 'columnName', 'measureName', 'unit', 'scale'])
const head = computed(() => {
  const n = props.row.name
  const i = SPLIT.has(props.row.target.kind) ? n.indexOf(' · ') : -1
  return i < 0 ? { title: n, field: '' } : { title: n.slice(0, i), field: n.slice(i) }
})
function onCommit(e: Event) { emit('commit', props.row, (e.target as HTMLInputElement).value) }
function onEscape(e: KeyboardEvent) {
  ;(e.target as HTMLInputElement).value = props.row.value
  emit('escape', props.row)
}
</script>

<template>
  <div class="lp-row" :class="{ unused: row.unused }" :data-label-target="row.id">
    <template v-if="row.unused">
      <span class="lp-l" :title="row.name">{{ row.name }}</span>
      <span class="lp-un">{{ row.value }} · {{ t('label.unused') }}</span>
      <button type="button" data-test="label-delete" :aria-label="t('label.deleteMap', { name: row.access ?? row.name })" :title="t('label.deleteMap', { name: row.access ?? row.name })" @click="emit('reset', row)">×</button>
    </template>
    <template v-else>
      <div class="lp-head">
        <span v-if="number !== undefined" class="lr-num" data-test="label-num" aria-hidden="true">{{ number }}</span>
        <label class="lp-l" :for="inputId" :title="row.name"><span class="lp-t">{{ head.title }}</span><span v-if="head.field" class="lp-f">{{ head.field }}</span></label>
        <span v-if="row.overridden" :id="`${inputId}-cust`" class="lr-pill" data-test="label-custom">{{ t('label.customised') }}</span>
      </div>
      <input
        :id="inputId" ref="el" type="text" data-test="label-input" :class="{ ovi: row.overridden }"
        :placeholder="row.placeholder" :maxlength="row.maxlength" :disabled="row.disabled"
        :title="row.disabled ? t('label.percentNoScale') : undefined"
        :inputmode="row.scale ? 'decimal' : undefined" :list="row.scale ? scalesId : undefined"
        :aria-label="row.access" :aria-invalid="invalid ? 'true' : undefined" :aria-describedby="describedBy"
        @change="onCommit" @keydown.enter="onCommit" @keydown.esc.stop.prevent="onEscape"
        @focus="emit('focus', row)"
      />
      <button type="button" data-test="label-reset" :disabled="!row.overridden" :aria-label="t('label.reset', { name: row.name })" :title="t('label.reset', { name: row.name })" @click="emit('reset', row)">↺</button>
      <span v-if="invalid" :id="`${inputId}-err`" class="lp-err" role="alert">{{ t('label.invalidScale') }}</span>
      <span v-if="row.affects" :id="`${inputId}-aff`" class="lp-aff">{{ row.affects }}</span>
    </template>
  </div>
</template>

<style scoped>
.lp-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; align-items: center; min-width: 0; padding-bottom: 6px; border-bottom: 1px solid var(--color-border, #ccc); }
.lp-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.lr-num { flex: 0 0 auto; min-width: 1.5em; box-sizing: border-box; text-align: center; font-size: 11px; font-weight: 700; line-height: 1.5; border-radius: 999px; padding: 0 4px; background: var(--color-warning, #b80); color: var(--color-background, #fff); border: 1px solid var(--color-foreground, #000); }
.lp-l { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground, #777); }
.lp-t { color: var(--color-foreground, inherit); font-weight: 600; }
.lr-pill { flex: 0 0 auto; font-size: 11px; line-height: 1.4; padding: 0 6px; border: 1px solid var(--color-warning, #b80); border-radius: 999px; color: var(--color-warning, #b80); white-space: nowrap; }
.lp-row input { min-width: 0; box-sizing: border-box; width: 100%; font-size: 12px; background: var(--color-background, transparent); color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ccc); border-left-width: 3px; border-radius: 3px; padding: 2px 4px; text-overflow: ellipsis; }
.lp-row input::placeholder { color: var(--color-muted-foreground, #777); opacity: 1; }
.lp-row input.ovi { border-left-color: var(--color-warning, #b80); }
.lp-row input[aria-invalid='true'] { border-color: var(--color-destructive, #c00); }
.lp-row button { border: 0; background: transparent; cursor: pointer; padding: 0 4px; color: var(--color-foreground, inherit); }
.lp-row button:disabled { opacity: 0.35; cursor: default; }
.lp-row.unused { grid-template-columns: minmax(0, 40%) minmax(0, 1fr) auto; opacity: 0.6; }
.lp-un { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-err { grid-column: 1 / -1; color: var(--color-destructive, #c00); }
.lp-aff { grid-column: 1 / -1; font-size: 11px; color: var(--color-muted-foreground, #777); overflow-wrap: anywhere; }
</style>
