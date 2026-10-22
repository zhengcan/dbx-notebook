<script setup lang="ts">
import { computed } from 'vue'
import { GRAINS, AGGS, type Agg, type FieldRef, type Grain, type NumberFormat, type ValueSpec } from '@sqlnb/format'
import { t } from '../i18n'
import type { SourceColumn } from './sql'

type Item = FieldRef & Partial<ValueSpec>
const props = defineProps<{ modelValue: FieldRef[] | ValueSpec[]; fields: SourceColumn[]; kind: 'dimension' | 'value'; multiple: boolean; max?: number; label?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: any[]): void }>()

const items = computed(() => props.modelValue as Item[])
const kindOf = (name: string) => props.fields.find((f) => f.name === name)?.kind
const missing = (name: string) => name !== '' && !props.fields.some((f) => f.name === name)
const full = computed(() => props.multiple && props.max !== undefined && items.value.length >= props.max)
const available = computed(() => (props.kind === 'dimension' && props.multiple ? props.fields.filter((f) => !items.value.some((x) => x.field === f.name)) : props.fields))
const COUNT = '\u0000count'

function commit(next: Item[]) { emit('update:modelValue', next) }
function patch(i: number, p: Partial<Item>) {
  const next = items.value.map((x, k) => (k === i ? { ...x, ...p } : x))
  commit(next)
}
function add(e: Event) {
  const sel = e.target as HTMLSelectElement
  const v = sel.value
  sel.value = ''
  if (!v) return
  if (props.kind === 'dimension' && items.value.some((x) => x.field === v)) return
  let item: Item
  if (props.kind === 'dimension') item = { field: v }
  else if (v === COUNT) item = { field: '', agg: 'count' }
  else item = { field: v, agg: kindOf(v) === 'number' ? 'sum' : 'count' }
  commit(props.multiple ? [...items.value, item] : [item])
}
function remove(i: number) { commit(items.value.filter((_, k) => k !== i)) }
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= items.value.length) return
  const next = [...items.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  commit(next)
}
function setGrain(i: number, v: string) {
  const { grain: _g, ...rest } = items.value[i]
  commit(items.value.map((x, k) => (k === i ? (v ? { ...rest, grain: v as Grain } : rest) : x)))
}
function aggDisabled(it: Item, a: Agg): boolean {
  const k = kindOf(it.field)
  if (it.field === '') return a !== 'count'
  if (a === 'sum' || a === 'avg' || a === 'median') return k !== 'number'
  if (a === 'min' || a === 'max') return k === 'boolean'
  return false
}
function setFormat(i: number, kind: string, decimals?: number) {
  const cur = items.value[i].format
  const f: NumberFormat = { kind: kind as NumberFormat['kind'] }
  const d = decimals ?? cur?.decimals
  if (d !== undefined) f.decimals = d
  patch(i, { format: f })
}
function onDecimals(i: number, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const n = Math.min(6, Math.max(0, Math.round(Number(raw))))
  setFormat(i, items.value[i].format?.kind ?? 'plain', raw === '' || !Number.isFinite(n) ? undefined : n)
}
const name = (it: Item) => (it.field === '' ? t('fp.countAll') : it.field)
const lbl = computed(() => props.label ?? '')
</script>

<template>
  <div class="fp" :data-kind="kind" role="group" :aria-label="lbl">
    <span v-if="lbl" class="fp-label">{{ lbl }}</span>
    <span v-for="(it, i) in items" :key="i" class="fp-chip" :class="{ miss: missing(it.field) }" data-test="fp-chip">
      <span class="fp-name">{{ name(it) }}<span v-if="missing(it.field)"> {{ t('fp.missing') }}</span></span>
      <select v-if="kind === 'dimension' && kindOf(it.field) === 'temporal'" data-test="fp-grain" :aria-label="t('fp.grain')" :value="it.grain ?? ''" @change="setGrain(i, ($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('fp.grain.none') }}</option>
        <option v-for="g in GRAINS" :key="g" :value="g">{{ t('fp.grain.' + g) }}</option>
      </select>
      <template v-if="kind === 'value'">
        <select data-test="fp-agg" :aria-label="t('fp.agg')" :value="it.agg" @change="patch(i, { agg: ($event.target as HTMLSelectElement).value as Agg })">
          <option v-for="a in AGGS" :key="a" :value="a" :disabled="aggDisabled(it, a)">{{ t('fp.agg.' + a) }}</option>
        </select>
        <select data-test="fp-fmt" :aria-label="t('fp.format')" :value="it.format?.kind ?? 'plain'" @change="setFormat(i, ($event.target as HTMLSelectElement).value)">
          <option v-for="f in ['plain', 'thousands', 'percent']" :key="f" :value="f">{{ t('fp.fmt.' + f) }}</option>
        </select>
        <input data-test="fp-dec" type="number" min="0" max="6" class="fp-dec" :aria-label="t('fp.decimals')" :value="it.format?.decimals ?? ''" @change="onDecimals(i, $event)" />
      </template>
      <button v-if="multiple" type="button" data-test="fp-up" :disabled="i === 0" :aria-label="t('fp.up', { name: name(it) })" :title="t('fp.up', { name: name(it) })" @click="move(i, -1)">‹</button>
      <button v-if="multiple" type="button" data-test="fp-down" :disabled="i === items.length - 1" :aria-label="t('fp.down', { name: name(it) })" :title="t('fp.down', { name: name(it) })" @click="move(i, 1)">›</button>
      <button type="button" data-test="fp-remove" :aria-label="t('fp.remove', { name: name(it) })" :title="t('fp.remove', { name: name(it) })" @click="remove(i)">×</button>
    </span>
    <select v-if="!full" data-test="fp-add" :aria-label="t('fp.add') + (lbl ? ' · ' + lbl : '')" @change="add">
      <option value="">＋ {{ t('fp.add') }}</option>
      <option v-if="kind === 'value'" :value="COUNT">{{ t('fp.countAll') }}</option>
      <option v-for="f in available" :key="f.name" :value="f.name">{{ f.name }}</option>
    </select>
  </div>
</template>

<style scoped>
.fp { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.fp-label { color: var(--color-muted-foreground, #777); font-size: 12px; }
.fp-chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 4px; border: 1px solid var(--color-border, #ccc); border-radius: 10px; font-size: 12px; background: var(--color-muted, transparent); }
.fp-chip.miss { border-color: var(--color-destructive, #c00); color: var(--color-destructive, #c00); }
.fp-chip button { border: 0; background: transparent; cursor: pointer; padding: 0 3px; color: inherit; }
.fp-chip select, .fp-chip input { font-size: 11px; max-width: 90px; }
.fp-dec { width: 3.2em; }
</style>
