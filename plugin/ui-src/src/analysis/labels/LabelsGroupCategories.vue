<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../../i18n'
import LabelRow from './LabelRow.vue'
import type { Group, Row } from './useLabelRows'

const props = defineProps<{ group: Group; uid: string; invalid: Record<string, boolean>; numbers?: Map<string, number> }>()
const emit = defineEmits<{ (e: 'commit', row: Row, value: string): void; (e: 'reset', row: Row): void; (e: 'escape', row: Row): void; (e: 'focus', row: Row): void; (e: 'toggle', key: string): void; (e: 'search', key: string, q: string): void }>()
const input = ref<HTMLInputElement | null>(null)
function clear() { emit('search', props.group.key, ''); input.value?.focus() }
const slug = (k: string) => k.replace(/\W/g, '_')
</script>

<template>
  <section :id="`lp-${uid}-g-${slug(group.key)}`" class="lp-group" :data-group="group.key" role="group" :aria-labelledby="`lp-${uid}-h-${slug(group.key)}`">
    <h4 :id="`lp-${uid}-h-${slug(group.key)}`" class="lp-h" :title="group.title">{{ group.title }}</h4>
    <div v-if="group.search" class="lp-search" role="search">
      <label :for="`lp-${uid}-s-${slug(group.key)}`" class="lp-sl">{{ t('label.search', { field: group.search.field }) }}</label>
      <div class="lp-sw">
        <input :id="`lp-${uid}-s-${slug(group.key)}`" ref="input" type="search" class="lp-si" data-test="label-search" autocomplete="off" :value="group.search.query" @input="emit('search', group.key, ($event.target as HTMLInputElement).value)" />
        <button v-if="group.search.query" type="button" class="lp-more" data-test="label-search-clear" :aria-label="t('label.search.clear')" @click="clear">×</button>
      </div>
      <span class="lp-sc" role="status" aria-live="polite" data-test="label-search-count">{{ group.search.query.trim() ? t('label.search.count', { n: group.search.matched, total: group.search.total }) : '' }}</span>
      <span v-if="group.search.capped" class="lp-sc" data-test="label-search-capped">{{ t('label.search.capped', { n: 200 }) }}</span>
      <span v-if="group.search.query.trim() && group.search.matched === 0" class="lp-sc" role="status" data-test="label-search-empty">{{ t('label.search.none') }}</span>
    </div>
    <LabelRow
      v-for="r in group.rows" :key="r.id" :row="r" :input-id="`lp-${uid}-${r.id}`" :invalid="!!invalid[r.id]" :number="numbers?.get(r.id)"
      @commit="(row, v) => emit('commit', row, v)" @reset="(row) => emit('reset', row)" @escape="(row) => emit('escape', row)" @focus="(row) => emit('focus', row)"
    />
    <button v-if="group.more" type="button" class="lp-more" data-test="label-showall" :aria-expanded="group.more.all ? 'true' : 'false'" :aria-controls="`lp-${uid}-g-${slug(group.key)}`" @click="emit('toggle', group.key)">{{ group.more.all ? t('label.showFewer') : t('label.showAll', { n: group.more.n }) }}</button>
  </section>
</template>

<style scoped>
.lp-group { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.lp-h { margin: 2px 0 0; font-size: 12px; font-weight: 600; color: var(--color-muted-foreground, #777); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-more { align-self: flex-start; border: 1px solid var(--color-border, #ccc); background: transparent; color: var(--color-foreground, inherit); border-radius: 3px; cursor: pointer; font-size: 12px; }
.lp-search { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lp-sl, .lp-sc { font-size: 12px; color: var(--color-muted-foreground, #777); overflow-wrap: anywhere; }
.lp-sw { display: flex; gap: 4px; min-width: 0; }
.lp-si { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; border: 1px solid var(--color-border, #ccc); background: transparent; color: var(--color-foreground, inherit); border-radius: 3px; }
.lp-si::-webkit-search-cancel-button { display: none; }
</style>
