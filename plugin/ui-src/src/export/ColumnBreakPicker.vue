<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { suggestColumnBreaks } from './model'

const props = defineProps<{ columns: string[]; breaks: number[] }>()
const emit = defineEmits<{ (e: 'update', breaks: number[]): void }>()
const parts = ref('2')

function toggle(i: number, on: boolean) {
  const set = new Set(props.breaks)
  if (on) set.add(i); else set.delete(i)
  emit('update', [...set].sort((a, b) => a - b))
}
function apply() {
  const n = Math.trunc(Number(parts.value))
  emit('update', suggestColumnBreaks(props.columns.length, Number.isFinite(n) && n >= 1 ? n : 2))
}
</script>

<template>
  <div class="cbp">
    <div class="cbp-split">
      <label>{{ t('exp.splitEven') }}
        <input v-model="parts" data-test="parts-value" type="text" inputmode="numeric" class="cbp-n" />
      </label>
      <button type="button" data-test="parts-apply" class="cbp-btn" @click="apply">{{ t('exp.splitApply') }}</button>
    </div>
    <ul class="cbp-cols">
      <li v-for="(c, i) in columns" :key="i">
        <span class="cbp-name">{{ c }}</span>
        <label v-if="i < columns.length - 1" class="cbp-brk">
          <input type="checkbox" :data-test="`break-${i}`" :aria-label="t('exp.breakAfterCol', { col: c })" :checked="breaks.includes(i)" @change="toggle(i, ($event.target as HTMLInputElement).checked)" />
          {{ t('exp.breakAfter') }}
        </label>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cbp { margin-top: 4px; font-size: 12px; }
.cbp-split { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.cbp-n { width: 3em; background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; padding: 1px 4px; }
.cbp-btn { font: inherit; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.cbp-cols { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow: auto; border: 1px solid var(--color-border); border-radius: 4px; }
.cbp-cols li { display: flex; justify-content: space-between; gap: 8px; padding: 1px 6px; }
.cbp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbp-brk { color: var(--color-muted-foreground); white-space: nowrap; }
</style>
