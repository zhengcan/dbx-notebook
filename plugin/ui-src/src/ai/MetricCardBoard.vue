<script setup lang="ts">
import { computed } from 'vue'
import type { MetricCandidate } from './parseMetrics'
import type { Preview } from './metricsAiGate'
import { t } from '../i18n'

export interface MetricCardItem { cand: MetricCandidate; problem?: { code: string; text: string }; preview: Preview | 'loading'; checked: boolean; group?: number }
const props = defineProps<{ items: MetricCardItem[]; selected: number }>()
const emit = defineEmits<{ select: [i: number]; toggle: [i: number]; toggleAll: [v: boolean] }>()

const label = (c: MetricCandidate) => c.label || `${c.aggregate}(${c.field || '*'})`
const source = (c: MetricCandidate) => {
  const parts = [`${c.data} · ${c.aggregate}(${c.field || '*'})`]
  if (c.filter?.length) parts.push(c.filter.map((f) => `${f.field} ${f.op}${f.value === undefined ? '' : ' ' + JSON.stringify(f.value)}`).join(', '))
  if (c.compare) parts.push(`${c.compare.kind.toUpperCase()} (${c.compare.dateField})`)
  return parts.join(' · ')
}
const usable = computed(() => props.items.filter((x) => !x.problem))
const allOn = computed(() => usable.value.length > 0 && usable.value.every((x) => x.checked))
</script>

<template>
  <div class="board" data-test="bn-board">
    <label v-if="usable.length > 1" class="all"><input type="checkbox" :checked="allOn" @change="emit('toggleAll', ($event.target as HTMLInputElement).checked)" /> {{ t('drawer.bn.selectAll') }}</label>
    <div
      v-for="(it, i) in items" :key="i" class="card" :class="{ on: i === selected, bad: !!it.problem }" role="group" data-test="bn-card"
      :aria-label="t('drawer.bn.card', { n: i + 1, label: label(it.cand) })" :aria-current="i === selected ? 'true' : undefined"
    >
      <div class="head">
        <input type="checkbox" :checked="it.checked" :disabled="!!it.problem" :aria-label="label(it.cand)" data-test="bn-card-check" @change="emit('toggle', i)" />
        <button type="button" class="pick" data-test="bn-card-pick" :aria-label="t('drawer.bn.pick', { n: i + 1 })" @click="emit('select', i)">{{ i + 1 }}. {{ label(it.cand) }}</button>
        <span v-if="it.group !== undefined" class="grp" data-test="bn-card-group">{{ t('drawer.bn.group', { k: it.group }) }}</span>
      </div>
      <p class="src" data-test="bn-card-source">{{ source(it.cand) }}</p>
      <p v-if="it.problem" class="err" data-test="bn-card-error" role="note">⚠ {{ it.problem.text }}</p>
      <template v-else>
        <p v-if="it.preview === 'loading'" class="load" data-test="bn-card-preview" aria-busy="true">{{ t('drawer.bn.loading') }}</p>
        <template v-else>
          <p v-if="it.preview.text !== null" class="val" data-test="bn-card-preview">{{ it.preview.text }}</p>
          <p v-else-if="it.preview.error" class="err" data-test="bn-card-error" role="note">⚠ {{ t('drawer.bn.previewFailed') }}: {{ it.preview.error }}</p>
          <p v-if="it.preview.compare" class="cmp" data-test="bn-card-compare">{{ it.preview.compare }}</p>
        </template>
      </template>
      <p v-if="it.cand.note" class="note">{{ it.cand.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 8px; }
.all { font-size: 12px; color: var(--color-muted-foreground); display: flex; gap: 6px; align-items: center; }
.card { padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-background); }
.card.on { border-color: var(--color-primary); box-shadow: 0 0 0 1px var(--color-primary); }
.card.bad { border-color: var(--color-destructive); }
.head { display: flex; gap: 8px; align-items: center; }
.pick { flex: 1; min-width: 0; text-align: left; font: inherit; font-weight: 600; font-size: 12px; background: none; border: 0; color: inherit; cursor: pointer; padding: 0; overflow-wrap: anywhere; }
.grp { font-size: 12px; color: var(--color-muted-foreground); white-space: nowrap; }
.src, .note, .cmp, .load { margin: 2px 0 0; font-size: 12px; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
.val { margin: 2px 0 0; font-size: 20px; font-weight: 600; }
.err { margin: 2px 0 0; font-size: 12px; color: var(--color-destructive); font-weight: 600; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
