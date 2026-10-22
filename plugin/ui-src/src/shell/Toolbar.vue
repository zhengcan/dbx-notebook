<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConnectionPicker from './ConnectionPicker.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { CanRunKey, SelectedKey, StoreKey } from '../injection'
import { t } from '../i18n'

defineProps<{ running: boolean; stopping?: boolean }>()
const emit = defineEmits<{ (e: 'home'): void; (e: 'new'): void; (e: 'open'): void; (e: 'save'): void; (e: 'saveAs'): void; (e: 'runAll'): void; (e: 'runFrom'): void; (e: 'stop'): void; (e: 'export'): void }>()
const store = inject(StoreKey)!
const canRun = inject(CanRunKey, computed(() => true))
const selected = inject(SelectedKey, ref<string | null>(null))

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
const mod = isMac ? '⌘' : 'Ctrl+'
const fileName = computed(() => (store.path.value ? store.path.value.split(/[\\/]/).pop() : t('shell.noFile')))
const hasSelected = computed(() => !!selected.value && store.nb.value.blocks.some((b) => b.id === selected.value))

type Mode = 'separate' | 'inline' | 'none'
const mode = computed(() => store.nb.value.settings.outputs ?? 'separate')
const modeSel = ref<HTMLSelectElement | null>(null)
const confirmNone = ref(false)
const hasSaved = () => [...store.runs.values()].some((r) => r.status === 'ok' || r.status === 'error')
function onMode(e: Event) {
  const v = (e.target as HTMLSelectElement).value as Mode
  if (v === 'none' && mode.value !== 'none' && hasSaved()) { confirmNone.value = true; return }
  store.setOutputsMode(v)
}
function onConfirm(id: string) {
  confirmNone.value = false
  if (id === 'confirm') store.setOutputsMode('none')
  if (modeSel.value) modeSel.value.value = mode.value
}
function onKey(e: KeyboardEvent) {
  if (document.querySelector('[role=dialog][aria-modal=true]')) return
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    emit('save')
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="tb tb-sticky" data-test="toolbar">
    <span class="tb-file" data-test="filename">{{ fileName }}<span v-if="store.dirty.value" class="tb-dot" data-test="dirty" :title="t('shell.dirty')">●</span></span>
    <button type="button" data-test="home" :title="t('tb.home')" @click="emit('home')">⌂ {{ t('tb.home') }}</button>
    <button type="button" data-test="new" :title="`${t('tb.new')}`" @click="emit('new')">{{ t('tb.new') }}</button>
    <button type="button" data-test="open" :title="`${t('tb.open')}`" @click="emit('open')">{{ t('tb.open') }}</button>
    <button type="button" data-test="save" :disabled="!store.dirty.value && !!store.path.value" :title="`${t('tb.save')} (${mod}S)`" @click="emit('save')">{{ t('tb.save') }}</button>
    <button type="button" data-test="save-as" :title="t('tb.saveAs')" @click="emit('saveAs')">{{ t('tb.saveAs') }}</button>
    <button type="button" data-test="run-all" :title="t('tb.runAll')" :disabled="!canRun || running" @click="emit('runAll')">▶ {{ t('tb.runAll') }}</button>
    <button type="button" data-test="run-from" :title="t('tb.runFrom')" :disabled="!canRun || running || !hasSelected" @click="emit('runFrom')">▶ {{ t('tb.runFrom') }}</button>
    <button v-if="running" type="button" data-test="stop" :title="t('tb.stopTip')" :disabled="stopping" @click="emit('stop')">■ {{ stopping ? t('tb.stopping') : t('tb.stop') }}</button>
    <button type="button" data-test="export" :title="running ? t('tb.exportRunning') : t('tb.export')" :aria-label="running ? t('tb.exportRunning') : t('tb.export')" :disabled="!store.nb.value.blocks.length || running" @click="emit('export')">{{ t('tb.export') }}</button>
    <div class="tb-settings" data-test="results-settings">
      <label class="tb-set">{{ t('set.save') }}
        <select ref="modeSel" data-test="outputs-mode" :value="mode" @change="onMode">
          <option value="separate">{{ t('set.saveSeparate') }}</option>
          <option value="inline">{{ t('set.saveInline') }}</option>
          <option value="none">{{ t('set.saveNone') }}</option>
        </select>
      </label>
    </div>
    <ConnectionPicker class="tb-picker" />
    <Teleport to="body">
      <ConfirmDialog :open="confirmNone" :title="t('set.noneTitle')" :message="t('set.noneMsg')" :buttons="[{ id: 'cancel', label: t('set.cancel') }, { id: 'confirm', label: t('set.confirm'), variant: 'danger' }]" @choose="onConfirm" />
    </Teleport>
  </div>
</template>

<style scoped>
.tb-sticky { position: sticky; top: 0; z-index: 50; background: var(--nb-bg, var(--color-background, #fff)); border-bottom: 1px solid var(--nb-border, var(--color-border, #ddd)); box-shadow: 0 1px 4px var(--nb-border, var(--color-border, #ddd)); }
.tb { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--color-border, #ddd); }
.tb-file { font-size: 12px; color: var(--color-muted-foreground, #777); }
.tb-dot { color: var(--color-warning, #b80); margin-left: 4px; }
.tb-settings { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 12px; }
.tb-set { display: flex; gap: 4px; align-items: center; color: var(--color-muted-foreground, #777); }
</style>
