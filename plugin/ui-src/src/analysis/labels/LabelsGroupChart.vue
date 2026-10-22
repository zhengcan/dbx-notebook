<script setup lang="ts">
import LabelRow from './LabelRow.vue'
import type { Group, Row } from './useLabelRows'

defineProps<{ group: Group; uid: string; invalid: Record<string, boolean>; numbers?: Map<string, number>; scalesId?: string }>()
const emit = defineEmits<{ (e: 'commit', row: Row, value: string): void; (e: 'reset', row: Row): void; (e: 'escape', row: Row): void; (e: 'focus', row: Row): void }>()
</script>

<template>
  <section :id="`lp-${uid}-g-${group.key.replace(/\W/g, '_')}`" class="lp-group" :data-group="group.key">
    <LabelRow
      v-for="r in group.rows" :key="r.id" :row="r" :input-id="`lp-${uid}-${r.id}`" :invalid="!!invalid[r.id]" :number="numbers?.get(r.id)" :scales-id="scalesId"
      @commit="(row, v) => emit('commit', row, v)" @reset="(row) => emit('reset', row)" @escape="(row) => emit('escape', row)" @focus="(row) => emit('focus', row)"
    />
  </section>
</template>

<style scoped>
.lp-group { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
</style>
