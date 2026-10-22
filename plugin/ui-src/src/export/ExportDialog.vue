<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { createImeGuard } from '../ui/imeEnter'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type BlockOptions, type ExportOptions, type TransposeMode } from './options'
import { TRANSPOSE_MAX_ROWS, type ExportModel, type TableSection } from './model'
import { exportHints } from './estimate'
import ColumnBreakPicker from './ColumnBreakPicker.vue'
import { baseName, joinPath, validateBaseName } from './exportPath'

const DEFAULT_N = 100
const props = defineProps<{
  model: ExportModel
  browser: { found: boolean; path?: string; checking: boolean }
  busy: boolean
  progress?: string
  error?: string
  initial?: ExportOptions
  running?: boolean
  initialFolder?: string
  initialName?: string
  pickFolder?: (defaultPath?: string) => Promise<{ path: string } | { cancelled: true }>
  manualPath?: string
  /** undefined = not fetched yet, null = unavailable (switch hidden). */
  exporterName?: string | null
}>()
const emit = defineEmits<{
  (e: 'export', o: ExportOptions, path: string): void
  (e: 'cancel'): void
  (e: 'close'): void
  (e: 'setBrowser', path: string): void
  (e: 'optionsChange', o: ExportOptions): void
}>()

const start = normalizeExportOptions(props.initial ?? DEFAULT_EXPORT_OPTIONS)
const format = ref(start.format)
const includeSql = ref(start.includeSql)
const header = ref({ ...start.header })
const note = ref(start.note)
const limitMode = ref<'all' | 'n'>(start.rowLimit === 'all' ? 'all' : 'n')
const limitText = ref(String(start.rowLimit === 'all' ? DEFAULT_N : start.rowLimit))
const orientation = ref(start.orientation)
const repeatText = ref(String(start.repeatCols))
const filtersLine = ref(start.filtersLine)
const breaks = ref<Record<string, number[]>>(Object.fromEntries(Object.entries(start.columnBreaks).map(([k, v]) => [k, [...v]])))
const blockOpts = ref<Record<string, BlockOptions>>(Object.fromEntries(Object.entries(start.blocks).map(([k, v]) => [k, { ...v }])))
const tab = ref<'general' | 'blocks'>('general')
const TABS = ['general', 'blocks'] as const
const uid = Math.random().toString(36).slice(2, 8)
const tabId = (k: string) => `exp-tab-${k}-${uid}`
const panelId = (k: string) => `exp-panel-${k}-${uid}`
const root = ref<HTMLElement | null>(null)
const settingsOpen = ref(false)
const manualText = ref(props.manualPath ?? '')
watch(() => props.manualPath, (v) => { manualText.value = v ?? '' })

const tables = computed(() => props.model.sections.filter((s): s is TableSection => s.kind === 'table'))
const catalog = computed(() => props.model.catalog ?? [])
const maxCols = computed(() => tables.value.reduce((m, s) => Math.max(m, s.columns.length), 0))
const repeatMax = computed(() => Math.max(0, Math.min(5, maxCols.value - 1)))
const pdfDisabled = computed(() => !props.browser.found && !props.browser.checking)

function limitValue(): number {
  const n = Math.trunc(Number(limitText.value))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000000) : DEFAULT_N
}
function repeatValue(): number {
  const n = Math.trunc(Number(repeatText.value))
  return Number.isFinite(n) ? Math.min(Math.max(0, n), repeatMax.value) : 0
}
const current = computed<ExportOptions>(() => ({
  format: pdfDisabled.value ? 'html' : format.value,
  includeSql: includeSql.value,
  header: { ...header.value },
  note: note.value,
  rowLimit: limitMode.value === 'all' ? 'all' : limitValue(),
  orientation: orientation.value,
  repeatCols: repeatValue(),
  filtersLine: filtersLine.value,
  columnBreaks: Object.fromEntries(Object.entries(breaks.value).map(([k, v]) => [k, [...v]])),
  blocks: Object.fromEntries(Object.entries(blockOpts.value).filter(([, v]) => !v.include || v.transpose !== 'follow').map(([k, v]) => [k, { ...v }])),
}))
const folder = ref(props.initialFolder ?? '')
const fileBase = ref(baseName(props.initialName ?? ''))
const nameProblem = computed(() => validateBaseName(fileBase.value))
const ext = computed(() => current.value.format)
const fileName = computed(() => `${fileBase.value.replace(/\.(pdf|html)$/i, '').trim()}.${ext.value}`)
const hasTarget = computed(() => !!folder.value && nameProblem.value === null)
async function choose() {
  if (props.busy || !props.pickFolder) return
  try {
    const r = await props.pickFolder(folder.value || undefined)
    if ('path' in r && r.path) folder.value = r.path
  } catch { /* keep the current folder */ }
}
const hints = computed(() => exportHints(props.model, current.value))

watch(pdfDisabled, (d) => { if (d) format.value = 'html' }, { immediate: true })
watch(current, (o) => emit('optionsChange', o), { deep: true })

function normalizeLimit() { limitText.value = String(limitValue()) }
function normalizeRepeat() { repeatText.value = String(repeatValue()) }
function setBreaks(id: string, v: number[]) { breaks.value = { ...breaks.value, [id]: v } }
const bo = (id: string): BlockOptions => blockOpts.value[id] ?? { include: true, transpose: 'follow' }
function setBlock(id: string, patch: Partial<BlockOptions>) { blockOpts.value = { ...blockOpts.value, [id]: { ...bo(id), ...patch } } }
function setMode(id: string, manual: boolean, auto: number[] | undefined) {
  if (manual) setBreaks(id, [...(auto ?? [])])
  else { const { [id]: _drop, ...rest } = breaks.value; breaks.value = rest }
}
function setTranspose(id: string, v: TransposeMode) {
  setBlock(id, { transpose: v })
  setMode(id, false, undefined)
}
const canTranspose = (s: TableSection) => s.shownRows >= 1 && s.shownRows <= TRANSPOSE_MAX_ROWS
const origCols = (s: TableSection) => s.rowNames?.length ?? s.columns.length
function selectTab(k: typeof TABS[number], focus = false) {
  tab.value = k
  if (focus) void nextTick(() => root.value?.querySelector<HTMLElement>(`#${tabId(k)}`)?.focus())
}
function onTabKey(e: KeyboardEvent) {
  const i = TABS.indexOf(tab.value)
  let n = -1
  if (e.key === 'ArrowRight') n = (i + 1) % TABS.length
  else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length
  else if (e.key === 'Home') n = 0
  else if (e.key === 'End') n = TABS.length - 1
  if (n < 0) return
  e.preventDefault(); selectTab(TABS[n], true)
}
const ime = createImeGuard()
function onNameEnter(e: KeyboardEvent) { e.preventDefault(); if (!ime.isImeEnter(e)) go() }
function go() { if (props.model.exportable && hasTarget.value && !props.busy && !props.running) emit('export', current.value, joinPath(folder.value, fileName.value)) }
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); if (props.busy) emit('cancel'); else emit('close') }
  else if (e.key === 'Tab' && root.value) {
    const els = Array.from(root.value.querySelectorAll<HTMLElement>('input, button, textarea, select')).filter((el) => !(el as HTMLInputElement).disabled && !el.closest('[hidden]') && el.getAttribute('tabindex') !== '-1')
    if (!els.length) return
    const i = els.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1)
    e.preventDefault(); els[next].focus()
  }
}
const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
onBeforeUnmount(() => { opener?.focus?.() })
onMounted(async () => { await nextTick(); root.value?.querySelector<HTMLElement>('input:not([disabled])')?.focus() })
</script>

<template>
  <div class="ed-backdrop">
    <div ref="root" class="ed" role="dialog" aria-modal="true" :aria-label="t('exp.title')" @keydown="onKey">
      <h3>{{ t('exp.title') }}</h3>
      <div class="ed-tabs" role="tablist" :aria-label="t('exp.tabs')">
        <button v-for="k in TABS" :id="tabId(k)" :key="k" type="button" role="tab" :data-test="`tab-${k}`" :aria-selected="tab === k" :aria-controls="panelId(k)" :tabindex="tab === k ? 0 : -1" class="ed-tab" :class="{ on: tab === k }" @click="selectTab(k)" @keydown="onTabKey">{{ t(k === 'general' ? 'exp.tabGeneral' : 'exp.tabBlocks') }}</button>
      </div>
      <div class="ed-body">
        <div :id="panelId('general')" role="tabpanel" :aria-labelledby="tabId('general')" class="ed-panel" :hidden="tab !== 'general'">
        <fieldset :disabled="busy" class="ed-group">
          <legend>{{ t('exp.format') }}</legend>
          <div class="ed-line" data-test="format-row">
            <div class="ed-grow ed-radios">
              <label><input v-model="format" data-test="fmt-pdf" type="radio" name="exp-fmt" value="pdf" :disabled="busy || pdfDisabled" /> PDF</label>
              <label><input v-model="format" data-test="fmt-html" :disabled="busy" type="radio" name="exp-fmt" value="html" /> HTML</label>
            </div>
            <button type="button" data-test="browser-settings-btn" class="ed-btn ed-small" :aria-expanded="settingsOpen" :aria-controls="`exp-bset-${uid}`" :disabled="busy" @click="settingsOpen = !settingsOpen">{{ t('exp.settings') }}</button>
          </div>
          <div v-if="!browser.found && !browser.checking" data-test="browser-hint" class="ed-line">
            <p class="ed-hint ed-grow">{{ t('exp.noBrowser') }}</p>
            <button type="button" data-test="browser-hint-open" class="ed-btn ed-small" :disabled="busy" @click="settingsOpen = true">{{ t('exp.settings') }}</button>
          </div>
          <p v-else-if="browser.checking" class="ed-hint">{{ t('exp.checking') }}</p>
          <div v-if="settingsOpen" :id="`exp-bset-${uid}`" data-test="browser-settings" class="ed-bset" role="group" :aria-label="t('exp.browserSettings')">
            <label class="ed-col">{{ t('exp.detectedBrowser') }}
              <input :value="browser.path ?? ''" data-test="browser-path" readonly type="text" class="ed-wide" />
            </label>
            <p data-test="browser-status" class="ed-hint" role="status">{{ browser.checking ? t('exp.checking') : browser.found ? t('exp.browserFound') : t('exp.browserNotFound') }}</p>
            <label class="ed-col">{{ t('exp.manualBrowser') }}
              <span class="ed-line" data-test="manual-row">
                <input v-model="manualText" data-test="browser-manual" :disabled="busy" type="text" class="ed-wide ed-grow" :placeholder="t('exp.browserPathPlaceholder')" />
                <button type="button" data-test="browser-apply" class="ed-btn" :disabled="busy" @click="emit('setBrowser', manualText.trim())">{{ t('exp.browserApply') }}</button>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset :disabled="busy" class="ed-group">
          <legend>{{ t('exp.content') }}</legend>
          <div class="ed-cols" data-test="header-cols">
            <div data-test="col-left" role="group" :aria-label="t('exp.colQuery')">
              <label><input v-model="includeSql" data-test="opt-sql" :disabled="busy" type="checkbox" /> {{ t('exp.sql') }}</label>
              <label><input v-model="filtersLine" data-test="opt-filters" :disabled="busy" type="checkbox" /> {{ t('exp.filters') }}</label>
            </div>
            <div data-test="col-right" role="group" :aria-label="t('exp.colHeader')">
              <label v-if="exporterName !== null"><input v-model="header.exporter" data-test="opt-exporter" :disabled="busy" type="checkbox" /> {{ t('exp.hExporter') }}</label>
              <label><input v-model="header.exportedAt" data-test="opt-exported-at" :disabled="busy" type="checkbox" /> {{ t('exp.hExportedAt') }}</label>
              <label><input v-model="header.dataSource" data-test="opt-datasource" :disabled="busy" type="checkbox" /> {{ t('exp.hDataSource') }}</label>
              <label><input v-model="header.dataRunAt" data-test="opt-run-at" :disabled="busy" type="checkbox" /> {{ t('exp.hRunAt') }}</label>
            </div>
          </div>
          <label class="ed-col">{{ t('exp.note') }}
            <textarea v-model="note" data-test="note" :disabled="busy" rows="2" :placeholder="t('exp.notePlaceholder')" />
          </label>
        </fieldset>

        <fieldset :disabled="busy" class="ed-group">
          <legend>{{ t('exp.rows') }}</legend>
          <label><input v-model="limitMode" data-test="row-limit-all" :disabled="busy" type="radio" name="exp-rows" value="all" /> {{ t('exp.rowsAll') }}</label>
          <label>
            <input v-model="limitMode" data-test="row-limit-n" :disabled="busy" type="radio" name="exp-rows" value="n" /> {{ t('exp.rowsFirst') }}
            <input v-model="limitText" data-test="row-limit-value" :aria-label="t('exp.rowsCount')" class="ed-num" type="text" inputmode="numeric" :disabled="busy || limitMode !== 'n'" @change="normalizeLimit" />
          </label>
        </fieldset>

        <fieldset :disabled="busy" class="ed-group">
          <legend>{{ t('exp.layout') }}</legend>
          <label><input v-model="orientation" data-test="orient-portrait" :disabled="busy" type="radio" name="exp-orient" value="portrait" /> {{ t('exp.portrait') }}</label>
          <label><input v-model="orientation" data-test="orient-landscape" :disabled="busy" type="radio" name="exp-orient" value="landscape" /> {{ t('exp.landscape') }}</label>
          <label>{{ t('exp.repeatCols') }}
            <input v-model="repeatText" data-test="repeat-cols" class="ed-num" :disabled="busy" type="number" min="0" :max="repeatMax" @change="normalizeRepeat" />
          </label>
        </fieldset>
        </div>

        <div :id="panelId('blocks')" role="tabpanel" :aria-labelledby="tabId('blocks')" class="ed-panel" :hidden="tab !== 'blocks'">
          <p v-if="!catalog.length" class="ed-hint">{{ t('exp.blocksEmpty') }}</p>
          <p v-else class="ed-hint">{{ t('exp.blocksHint') }}</p>
          <fieldset v-for="c in catalog" :key="c.blockId" :disabled="busy" class="ed-group" :data-test="`blk-${c.blockId}`">
            <legend>{{ t(`exp.type.${c.type}` as any) }}</legend>
            <label><input :checked="bo(c.blockId).include" :data-test="`blk-include-${c.blockId}`" type="checkbox" @change="setBlock(c.blockId, { include: ($event.target as HTMLInputElement).checked })" /> {{ c.label }}</label>
            <template v-if="c.table">
              <div :data-test="`blk-info-${c.blockId}`" class="ed-hint">{{ t('exp.blockInfo', { rows: c.table.shownRows, cols: origCols(c.table) }) }}</div>
              <label class="ed-row">{{ t('exp.transpose') }}
                <select :value="bo(c.blockId).transpose" :data-test="`transpose-${c.blockId}`" :disabled="busy || !canTranspose(c.table)" :aria-label="t('exp.transpose')" @change="setTranspose(c.blockId, ($event.target as HTMLSelectElement).value as TransposeMode)">
                  <option value="follow">{{ t('exp.tFollow') }}</option>
                  <option value="on">{{ t('exp.tOn') }}</option>
                  <option value="off">{{ t('exp.tOff') }}</option>
                </select>
              </label>
              <div class="ed-row" role="group" :aria-label="t('exp.pagination')">
                <span>{{ t('exp.pagination') }}</span>
                <label><input :checked="breaks[c.blockId] === undefined" :data-test="`pag-auto-${c.blockId}`" type="radio" :name="`pag-${c.blockId}`" @change="setMode(c.blockId, false, c.table.autoBreaks)" /> {{ t('exp.pagAuto') }}</label>
                <label><input :checked="breaks[c.blockId] !== undefined" :data-test="`pag-manual-${c.blockId}`" type="radio" :name="`pag-${c.blockId}`" @change="setMode(c.blockId, true, c.table.autoBreaks)" /> {{ t('exp.pagManual') }}</label>
              </div>
              <div v-if="breaks[c.blockId] === undefined" class="ed-hint">{{ t('exp.autoPages', { n: (c.table.autoBreaks?.length ?? 0) + 1 }) }}</div>
              <div v-else :data-test="`picker-${c.blockId}`">
                <ColumnBreakPicker :columns="c.table.columns" :breaks="breaks[c.blockId]" @update="setBreaks(c.blockId, $event)" />
              </div>
            </template>
          </fieldset>
        </div>

        <p v-if="hints.skipped.length" data-test="hint-skipped" class="ed-warn">
          {{ t('exp.skipped') }}{{ hints.skipped.map((s) => s.label).join(t('exp.listSep')) }}
        </p>
        <p v-if="hints.stale" data-test="hint-stale" class="ed-hint">{{ t('exp.stale') }}</p>
        <p v-if="hints.bigTables.length" data-test="hint-big" class="ed-warn">{{ t('exp.big') }}</p>
        <p v-if="!model.exportable" class="ed-warn">{{ t('exp.nothing') }}</p>
        <p v-if="running" data-test="hint-running" class="ed-warn" role="status">{{ t('exp.running') }}</p>
        <p v-if="busy && progress" class="ed-hint" role="status">{{ progress }}</p>
      </div>
      <p v-if="error" data-test="err" class="ed-err ed-errbox" role="alert"><span class="ed-sel">{{ error }}</span></p>
      <div class="ed-file" data-test="file-row">
        <div class="ed-hint">{{ t('exp.saveTo') }}</div>
        <div class="ed-line ed-fileline" data-test="folder-row">
          <div data-test="file-folder" class="ed-sel ed-path ed-grow" :title="folder">{{ t('exp.folder') }}{{ folder || '—' }}</div>
          <button type="button" data-test="choose" class="ed-btn" :disabled="busy || !pickFolder" @click="choose">{{ t('exp.choose') }}</button>
        </div>
        <label class="ed-line ed-fileline" data-test="name-row">
          <span class="ed-lbl">{{ t('exp.fileName') }}</span>
          <input v-model="fileBase" data-test="file-name" type="text" class="ed-name" :disabled="busy" :aria-invalid="nameProblem === 'invalid'" :aria-label="t('exp.fileName')" spellcheck="false" @keydown.enter="onNameEnter" @compositionstart="ime.onCompositionStart()" @compositionend="ime.onCompositionEnd()" @compositioncancel="ime.onReset()" @blur="ime.onReset()" />
          <span data-test="file-ext" class="ed-ext">.{{ ext }}</span>
        </label>
        <p v-if="nameProblem === 'invalid'" data-test="name-error" class="ed-err" role="alert">{{ t('exp.nameInvalid') }}</p>
        <p v-else-if="nameProblem === 'empty'" data-test="name-error" class="ed-warn" role="status">{{ t('exp.nameEmpty') }}</p>
        <p v-if="!folder" data-test="file-hint" class="ed-warn" role="status">{{ t('exp.chooseFirst') }}</p>
      </div>
      <div class="ed-actions">
        <button v-if="busy" type="button" data-test="stop" class="ed-btn" @click="emit('cancel')">{{ t('exp.stop') }}</button>
        <button v-else type="button" class="ed-btn" data-test="close" @click="emit('close')">{{ t('exp.close') }}</button>
        <button type="button" data-test="go" class="ed-btn ed-primary" :aria-busy="busy" :disabled="!model.exportable || !hasTarget || busy || running" @click="go">
          <span v-if="busy" data-test="spinner" class="ed-spin" aria-hidden="true"></span>{{ busy ? t('exp.exporting') : t('exp.go') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ed-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ed { background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 8px; padding: 16px 20px; width: 460px; max-width: 94vw; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0, 0, 0, .25); }
.ed h3 { margin: 0 0 8px; font-size: 15px; }
.ed-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); margin-bottom: 8px; }
.ed-tab { font: inherit; font-size: 13px; padding: 4px 12px; border: 1px solid transparent; border-bottom: 0; border-radius: 4px 4px 0 0; background: transparent; color: var(--color-muted-foreground); cursor: pointer; }
.ed-tab.on { color: var(--color-foreground); background: var(--color-muted); border-color: var(--color-border); }
.ed-panel { display: flex; flex-direction: column; gap: 8px; }
.ed-panel[hidden] { display: none; }
.ed-line { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; min-width: 0; }
.ed-grow { flex: 1 1 auto; min-width: 0; }
.ed-radios { display: flex; gap: 12px; align-items: center; }
.ed-line > .ed-btn { flex: none; white-space: nowrap; }
.ed-small { padding: 1px 8px; font-size: 12px; }
.ed-bset { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--color-border); border-radius: 6px; padding: 6px 8px; }
.ed-wide { width: 100%; min-width: 0; background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 6px; font: inherit; box-sizing: border-box; }
.ed-file { margin-top: 10px; border-top: 1px solid var(--color-border); padding-top: 6px; }
.ed-fileline { font-size: 13px; }
.ed-lbl { flex: none; }
.ed-name { flex: 1; min-width: 0; background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 6px; font: inherit; box-sizing: border-box; }
.ed-ext { flex: none; color: var(--color-muted-foreground); }
.ed-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ed select { background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 6px; font: inherit; }
.ed-body { overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.ed-group { border: 1px solid var(--color-border); border-radius: 6px; margin: 0; padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.ed-group legend { color: var(--color-muted-foreground); font-size: 12px; padding: 0 4px; }
.ed-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
.ed-cols > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ed-cols label { min-width: 0; overflow-wrap: anywhere; }
.ed-col { display: flex; flex-direction: column; gap: 2px; }
.ed textarea, .ed-num { background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 6px; font: inherit; box-sizing: border-box; }
.ed textarea { width: 100%; resize: vertical; }
.ed-num { width: 5em; }
.ed-hint { margin: 2px 0; font-size: 12px; color: var(--color-muted-foreground); }
.ed-path { word-break: break-all; }
.ed-errbox { margin: 8px 0 0; padding: 4px 8px; border: 1px solid var(--color-destructive); border-radius: 4px; max-height: 7em; overflow: auto; flex: none; }
.ed-warn { margin: 2px 0; font-size: 12px; color: var(--color-warning); }
.ed-err { margin: 2px 0; font-size: 12px; color: var(--color-destructive); }
.ed-warnlist { margin: 2px 0; padding-left: 18px; font-size: 12px; }
.ed-sel { user-select: text; word-break: break-word; }
.ed-actions { display: flex; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.ed-actions .ed-btn { flex: none; white-space: nowrap; }
.ed-btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.ed-btn:disabled { opacity: .5; cursor: not-allowed; }
.ed-primary { background: var(--color-primary); color: var(--color-primary-foreground); border-color: transparent; }
.ed-spin { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: -2px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ed-spin .8s linear infinite; }
@keyframes ed-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ed-spin { animation: none; border-right-color: currentColor; opacity: .6; } }
.ed :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
