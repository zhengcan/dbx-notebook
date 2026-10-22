<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { CHART_TYPES, VIEWS, normalizeAnalysis, buildRenderSpec, type FieldRef, type PivotConfig, type Summary, type View } from '@sqlnb/format'
import { AiClientKey, AiSettingsKey, BridgeKey, DrawerKey, StoreKey } from '../injection'
import { useAiRequest } from '../ai/useAiRequest'
import { chartAiGate } from '../ai/chartAiGate'
import { t } from '../i18n'
import { resultNameOf } from '../run/deps'
import { resolveSource } from './source'
import { useAutoRefresh } from './useAutoRefresh'
import { buildPivotModel, DEFAULT_SUMMARY } from './pivotModel'
import { resolveLabels } from './labelResolve'
import { resetRefOverrides } from './labelPatch'
import LabelsDialog from './LabelsDialog.vue'
import LabelsPreview from './LabelsPreview.vue'
import LabelPopover from './LabelPopover.vue'
import type { LabelTarget } from './labelResolve'
import { toChartRows, toHistogramRows } from './chartRows'
import FieldPicker from './FieldPicker.vue'
import PivotTable from './PivotTable.vue'
import ChartView from './ChartView.vue'
import { useComposingDraft } from '../ui/composing'

const props = defineProps<{ blockId: string }>()
const store = inject(StoreKey)!
const bridge = inject(BridgeKey, null)
const aiClient = inject(AiClientKey, null)
const aiSettings = inject(AiSettingsKey, null)

const block = computed(() => store.nb.value.blocks.find((b) => b.id === props.blockId))
const meta = computed(() => (block.value?.metadata ?? {}) as Record<string, unknown>)
const cfg = computed(() => normalizeAnalysis(meta.value))
const legacy = computed(() => cfg.value.pivot === null && meta.value.spec !== undefined && typeof meta.value.spec === 'object' && meta.value.spec !== null)
const pivot = computed<PivotConfig>(() => cfg.value.pivot ?? { rows: [], columns: [], values: [] })
const view = computed<View>(() => cfg.value.view)
const chart = computed(() => cfg.value.chart)
const data = computed(() => (typeof meta.value.data === 'string' ? meta.value.data : ''))

const sources = computed(() => store.nb.value.blocks.filter((b) => b.type === 'sql' && resultNameOf(b)))
const src = computed(() => resolveSource(store, data.value))
const srcOk = computed(() => ('error' in src.value ? null : src.value))
const fields = computed(() => srcOk.value?.columns ?? [])
const res = computed(() => store.analysis.get(props.blockId))
const stale = computed(() => store.staleReasons(props.blockId))
const isBar = computed(() => chart.value.type === 'bar' || chart.value.type === 'barHorizontal' || chart.value.type === 'area')
const stackOptions = computed(() => (chart.value.type === 'area' ? ['none', 'stacked', 'percent'] : ['grouped', 'stacked', 'percent']))
const showTimeAxis = computed(() => {
  const f = pivot.value.rows[0]
  const temporal = !!f && fields.value.find((c) => c.name === f.field)?.kind === 'temporal'
  return temporal && ['line', 'area', 'bar', 'barHorizontal'].includes(chart.value.type)
})
const hasSeries = computed(() => pivot.value.columns.length > 0 || pivot.value.values.length > 1)
const stackValue = computed(() => {
  let s = chart.value.stacking ?? 'stacked'
  if (s === 'none' && chart.value.type !== 'area') s = 'grouped'
  return stackOptions.value.includes(s) ? s : 'stacked'
})

const missingFields = computed(() => {
  const s = srcOk.value
  if (!s || !cfg.value.pivot) return []
  const have = new Set(s.columns.map((c) => c.name))
  const p = pivot.value
  const wanted = [...p.rows.map((r) => r.field), ...p.columns.map((c) => c.field), ...p.values.map((v) => v.field).filter((f) => f !== '')]
  return [...new Set(wanted.filter((f) => !have.has(f)))]
})

const message = computed<string | null>(() => {
  if (!data.value) return t('ab.noSource')
  const s = src.value
  if ('error' in s) return s.error.code === 'SOURCE_NOT_RUN' ? t('ab.notRun') : t('ab.err.NO_SOURCE')
  if (legacy.value) return null
  if (missingFields.value.length) return t('ab.missing', { fields: missingFields.value.join(', ') })
  if (refreshError.value) return t('ab.refreshFailed', { message: refreshError.value })
  const e = res.value?.error
  if (res.value?.status === 'error' && e) {
    if (e.code === 'NO_SOURCE') return t('ab.err.NO_SOURCE')
    if (e.code === 'SOURCE_NOT_RUN') return t('ab.notRun')
    return e.message
  }
  return null
})

const rawRows = computed(() => {
  const r = store.runs.get(sourceBlockId())?.result
  if (!r) return []
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
})
function sourceBlockId(): string {
  const key = data.value.toLowerCase()
  return sources.value.find((b) => resultNameOf(b)?.toLowerCase() === key)?.id ?? ''
}

const renderSpec = computed(() => {
  const s = srcOk.value
  if (!s || !cfg.value.pivot) return null
  const r = buildRenderSpec({ pivot: pivot.value, chart: chart.value, columns: s.columns })
  return 'error' in r ? null : r
})

const resolved = computed(() => resolveLabels({ pivot: pivot.value, chart: chart.value }, { empty: t('pivot.empty'), summary: t('pivot.summary') }))

const chartRows = computed<unknown[]>(() => {
  const rs = renderSpec.value
  const s = srcOk.value
  if (!rs || !s) return []
  if (rs.usesRawRows) return toHistogramRows(rawRows.value, pivot.value, chart.value, s.columns)
  const long = res.value?.long
  return long ? toChartRows(long, pivot.value, chart.value, s.columns, resolved.value) : []
})

const model = computed(() => (res.value && cfg.value.pivot ? buildPivotModel(res.value, pivot.value, { resolved: resolved.value }) : null))
const showTable = computed(() => view.value !== 'chart')
const showChart = computed(() => view.value !== 'table')

function setP(p: Partial<PivotConfig>) { store.setAnalysis(props.blockId, { pivot: p }) }
// Field/grain changes go through resetRefOverrides so the new ref and the surviving overrides are written in ONE setAnalysis call.
function setRefs(key: 'rows' | 'columns', next: FieldRef[]) {
  const old = pivot.value[key]
  setP({ [key]: next.map((n, i) => resetRefOverrides(old.find((o) => o.field === n.field) ?? old[i], n)) })
}
const labelCats = computed(() => {
  const out = { row: [] as string[][], column: [] as string[][] }
  const long = res.value?.status === 'ok' ? res.value.long : undefined
  const nr = pivot.value.rows.length, nc = pivot.value.columns.length
  if (!long) return out
  const collect = (from: number, n: number) => Array.from({ length: n }, (_, k) => {
    const seen = new Set<string>()
    for (const r of long.rows) { const v = (r as unknown[])[from + k]; if (v !== null && v !== undefined) seen.add(String(v)) }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  })
  out.row = collect(0, nr); out.column = collect(nr, nc)
  return out
})
const editable = computed(() => !legacy.value) // the app has no notebook-level read-only mode
const rootEl = ref<HTMLElement | null>(null)
const popover = ref<{ target: LabelTarget; anchor: HTMLElement; seq: number } | null>(null)
const popRef = ref<InstanceType<typeof LabelPopover> | null>(null)
let popSeq = 0
function onEditLabel(p: { target: LabelTarget; el: HTMLElement }) {
  if (!editable.value || labelsOpen.value) return
  popRef.value?.commitOutside()
  popover.value = { target: p.target, anchor: p.el, seq: ++popSeq }
}
function onPopClose() { popover.value = null }
function onPopCommit(patch: Parameters<typeof store.setAnalysis>[1]) { store.setAnalysis(props.blockId, patch) }
const titleCmp = useComposingDraft()
const labelsOpen = ref(false)
const labelsBtn = ref<HTMLElement | null>(null)
function openLabels() {
  popRef.value?.commitOutside()
  popover.value = null
  labelsOpen.value = true
}
watch(() => !editable.value || legacy.value || !srcOk.value || !block.value, (gone) => { if (gone) labelsOpen.value = false })
watch(() => props.blockId, () => { labelsOpen.value = false })
const previewCats = computed(() => ({ rows: labelCats.value.row, columns: labelCats.value.column }))
const labelCtx = computed(() => ({ empty: t('pivot.empty'), summary: t('pivot.summary') }))
const grandOk = computed(() => pivot.value.rows.length > 0 && pivot.value.columns.length > 0)
function setSummary(i: number, summary: Summary) {
  // The family default is the implicit state: store no key for it.
  setP({ values: pivot.value.values.map((v, k) => {
    if (k !== i) return v
    const { summary: _s, ...rest } = v
    return summary === DEFAULT_SUMMARY[v.agg] ? rest : { ...rest, summary }
  }) })
}
function setTotal(k: 'row' | 'column' | 'grand', v: boolean) { setP({ totals: { ...(pivot.value.totals ?? {}), [k]: v } }) }
const aiShown = computed(() => !!aiClient && !!aiSettings && !!bridge && bridge.capabilities().aiCompletion === true && !legacy.value)
const aiBusy = aiClient ? useAiRequest(aiClient).busy : ref(false)
const drawer = inject(DrawerKey, null)
// fail-closed: stays all-off until aiSettings.sendOptions() resolves; never read aiSettings.send directly
const sendOpts = ref({ schema: false, sql: false, data: false })
let sendSeq = 0
async function refreshSend() {
  if (!aiSettings) return
  const seq = ++sendSeq
  let o = { schema: false, sql: false, data: false }
  try { o = await aiSettings.sendOptions() } catch { /* stay closed */ }
  if (seq === sendSeq) sendOpts.value = o
}
onMounted(() => { void refreshSend() })
watch(() => srcOk.value?.executedAt, () => { void refreshSend() })
const aiGate = computed(() => chartAiGate({
  caps: bridge?.capabilities() ?? ({ aiCompletion: false } as any),
  send: sendOpts.value,
  source: srcOk.value?.run.result ? { columns: srcOk.value.run.result.columns.map((c) => c.name), rows: srcOk.value.run.result.rows as unknown[][] } : null,
  busy: aiBusy.value,
}))
const aiReason = computed(() => (aiGate.value.enabled ? (drawer?.current.value ? t('ai.askDrawerOpen') : undefined) : t(`ai.chart.gate.${aiGate.value.reason}`)))
function openAi() { if (!aiReason.value) drawer?.open({ purpose: 'chart', blockId: props.blockId }) }
const refreshError = ref<string | null>(null)
function refresh() {
  refreshError.value = null
  store.refreshAnalysis(props.blockId).catch((e) => { refreshError.value = e instanceof Error ? e.message : String(e) })
}
watch(() => JSON.stringify([data.value, cfg.value.pivot, chart.value]), () => { refreshError.value = null })
const staleText = computed(() => stale.value.map((r) => t('stale.' + r)).join(t('stale.sep')))
const ctName = (c: string) => t('ct.' + c)

useAutoRefresh({
  key: () => (srcOk.value ? (srcOk.value.executedAt ?? '') : null),
  runnable: () => !!cfg.value.pivot && !!srcOk.value && !legacy.value && missingFields.value.length === 0,
  hasResult: () => !!res.value,
  refresh,
})
</script>

<template>
  <div ref="rootEl" class="ab" data-test="analysis-block" tabindex="-1">
    <div v-if="!legacy" class="ab-head" data-test="ab-head">
      <div class="ab-opts" data-row="options">
      <label class="ab-f">{{ t('ab.source') }}
        <select data-test="ab-source" :value="data" @change="store.setAnalysis(blockId, { data: ($event.target as HTMLSelectElement).value })">
          <option value="">{{ t('ab.pickSource') }}</option>
          <option v-for="b in sources" :key="b.id" :value="resultNameOf(b)">{{ resultNameOf(b) }}</option>
          <option v-if="data && !sources.some((b) => resultNameOf(b) === data)" :value="data">{{ data }}</option>
        </select>
      </label>
      <div class="ab-seg" role="group" :aria-label="t('ab.view')" data-test="ab-view">
        <button v-for="v in VIEWS" :key="v" type="button" :data-view="v" :aria-pressed="view === v" :class="{ on: view === v }" @click="store.setAnalysis(blockId, { view: v })">{{ t('ab.view.' + v) }}</button>
      </div>
      <label class="ab-f">{{ t('ab.chartType') }}
        <select data-test="ab-type" :value="chart.type" @change="store.setAnalysis(blockId, { chartOptions: { type: ($event.target as HTMLSelectElement).value as any } })">
          <option v-for="c in CHART_TYPES" :key="c" :value="c">{{ ctName(c) }}</option>
        </select>
      </label>
      <label v-if="isBar" class="ab-f">{{ t('ab.stacking') }}
        <select data-test="ab-stacking" :value="stackValue" :disabled="!hasSeries" :title="hasSeries ? undefined : t('ab.stack.needsColumns')" @change="store.setAnalysis(blockId, { chartOptions: { stacking: ($event.target as HTMLSelectElement).value as any } })">
          <option v-for="s in stackOptions" :key="s" :value="s">{{ t('ab.stack.' + s) }}</option>
        </select>
        <span v-if="!hasSeries" class="ab-hint" data-test="ab-stacking-hint">{{ t('ab.stack.needsColumns') }}</span>
      </label>
      <label class="ab-f"><input type="checkbox" data-test="ab-labels" :checked="chart.labels === true" @change="store.setAnalysis(blockId, { chartOptions: { labels: ($event.target as HTMLInputElement).checked } })" />{{ t('ab.labels') }}</label>
      <div class="ab-tail" data-test="ab-tail">
        <label v-if="showTimeAxis" class="ab-f">{{ t('ab.timeAxis') }}
          <select data-test="ab-timeaxis" :value="chart.timeAxis ?? 'sparse'" @change="store.setAnalysis(blockId, { chartOptions: { timeAxis: ($event.target as HTMLSelectElement).value as any } })">
            <option v-for="o in ['sparse', 'compact']" :key="o" :value="o">{{ t('ab.timeAxis.' + o) }}</option>
          </select>
        </label>
        <span class="ab-acts" data-test="ab-actions">
          <button v-if="aiShown" type="button" data-test="ask-ai" :aria-label="t('ai.chart.aria')" aria-haspopup="dialog" :disabled="!!aiReason" :title="aiReason" :aria-describedby="aiReason ? `ai-chart-reason-${blockId}` : undefined" @click="openAi">✨ {{ t('ai.chart.ask') }}</button>
          <span v-if="aiShown && aiReason" :id="`ai-chart-reason-${blockId}`" class="sr-only">{{ aiReason }}</span>
          <button type="button" data-test="ab-refresh" :aria-label="t('ab.refresh')" :title="t('ab.refresh')" @click="refresh">↻ {{ t('ab.refresh') }}</button>
        </span>
      </div>
      </div>
      <div class="ab-row" data-row="title">
      <label class="ab-rlabel" :for="'ab-title-' + blockId">{{ t('ab.title') }}</label>
      <input :id="'ab-title-' + blockId" class="ab-title-input" type="text" data-test="ab-title" :value="titleCmp.bound(chart.title ?? '')" @input="titleCmp.start($event)" @compositionend="titleCmp.start($event)" @change="store.setAnalysis(blockId, { chartOptions: { title: ($event.target as HTMLInputElement).value } }); titleCmp.end()" />
      </div>
      <div class="ab-row" data-row="rows"><FieldPicker data-test="ab-rows" :model-value="pivot.rows" :fields="fields" kind="dimension" multiple :max="4" :label="t('ab.rows')" @update:model-value="setRefs('rows', $event)" /></div>
      <div class="ab-row" data-row="cols"><FieldPicker data-test="ab-cols" :model-value="pivot.columns" :fields="fields" kind="dimension" multiple :max="3" :label="t('ab.columns')" @update:model-value="setRefs('columns', $event)" /></div>
      <div class="ab-row" data-row="values"><FieldPicker data-test="ab-values" :model-value="pivot.values" :fields="fields" kind="value" multiple :max="8" :label="t('ab.values')" @update:model-value="setP({ values: $event })" /></div>
    </div>
    <div class="ab-row ab-status" data-test="ab-status" data-row="summary">
      <template v-if="!legacy">
        <span class="ab-rlabel">{{ t('ab.summaryLabel') }}</span>
        <label class="ab-f" :title="t('ab.summaryRow.help')"><input type="checkbox" data-test="ab-summary-row" :aria-describedby="'ab-summary-row-help-' + blockId" :checked="pivot.totals?.row === true" @change="setTotal('row', ($event.target as HTMLInputElement).checked)" />{{ t('ab.summaryRow') }}<span class="ab-sr" :id="'ab-summary-row-help-' + blockId" data-test="ab-summary-row-help">{{ t('ab.summaryRow.short') }}</span></label>
      <label class="ab-f" :title="t('ab.summaryColumn.help')"><input type="checkbox" data-test="ab-summary-column" :aria-describedby="'ab-summary-column-help-' + blockId" :checked="pivot.totals?.column === true" @change="setTotal('column', ($event.target as HTMLInputElement).checked)" />{{ t('ab.summaryColumn') }}<span class="ab-sr" :id="'ab-summary-column-help-' + blockId" data-test="ab-summary-column-help">{{ t('ab.summaryColumn.short') }}</span></label>
      <label class="ab-f" :title="grandOk ? t('ab.summaryGrand.help') : t('ab.summaryGrand.needs')"><input type="checkbox" data-test="ab-summary-grand" :disabled="!grandOk" :aria-describedby="'ab-summary-grand-help-' + blockId" :checked="pivot.totals?.grand === true" @change="setTotal('grand', ($event.target as HTMLInputElement).checked)" />{{ t('ab.summaryGrand') }}<span class="ab-sr" :id="'ab-summary-grand-help-' + blockId" data-test="ab-summary-grand-help">{{ t('ab.summaryGrand.short') }}</span></label>
      <button ref="labelsBtn" type="button" data-test="ab-labels-open" class="ab-labels-btn" aria-haspopup="dialog" @click="openLabels">{{ t('label.open') }}</button>
      </template>
      <span v-if="legacy" class="ab-badge" data-test="ab-legacy">{{ t('ab.legacy') }}</span>
      <span v-if="stale.length" class="ab-badge warn" data-test="ab-stale" :title="staleText">{{ t('ab.stale') }} · {{ staleText }}</span>
      <span v-if="res?.partial" class="ab-badge" data-test="ab-partial">{{ t('ab.partial') }}</span>
      <span v-if="res && res.excludedDateRows > 0" class="ab-badge" data-test="ab-excluded">{{ t('ab.excluded', { n: res.excludedDateRows }) }}</span>
      <span v-if="res?.tooManyPoints" class="ab-badge warn" data-test="ab-toomany">{{ t('ab.tooMany') }}</span>
    </div>
    <p v-if="message" class="ab-msg" data-test="ab-message" role="status">{{ message }}</p>
    <div v-else-if="legacy" class="ab-view" data-test="ab-chart">
      <ChartView :spec="(meta.spec as object)" :rows="rawRows" />
    </div>
    <div v-else class="ab-view" :class="view" data-test="ab-view-area">
      <div v-if="showTable" class="ab-pane" data-test="ab-table">
        <PivotTable v-if="model" :model="model" :editable="editable" :sort="pivot.sort ?? null" @update:sort="setP({ sort: $event })" @update:summary="setSummary($event.valueIndex, $event.summary)" @edit-label="onEditLabel" />
      </div>
      <div v-if="showChart" class="ab-pane" data-test="ab-chart">
        <ChartView v-if="renderSpec && res?.status === 'ok' && (renderSpec.usesRawRows || res.long)" :spec="renderSpec.spec" :rows="chartRows" :title="chart.title" :horizontal="chart.type === 'barHorizontal'" :legend-axis="chart.type === 'pie' || chart.type === 'donut' ? 'x' : 'legend'" :measure-names="resolved.measureNames" :editable="editable" @edit-label="onEditLabel" />
        <p v-else class="ab-msg" data-test="ab-chart-empty">{{ renderSpec ? t('ab.chartEmpty') : t('ab.specErr') }}</p>
      </div>
    </div>
    <LabelsDialog v-if="labelsOpen && rootEl && editable" :cfg="{ pivot, chart }" :categories="labelCats" :ctx="labelCtx" :container="rootEl" :return-focus="labelsBtn" @commit="store.setAnalysis(blockId, $event)" @close="labelsOpen = false">
      <template #preview="{ active, numbers }"><LabelsPreview :cfg="{ pivot, chart }" :ctx="labelCtx" :active="active" :categories="previewCats" :numbers="numbers" /></template>
    </LabelsDialog>
    <LabelPopover v-if="popover && rootEl" :key="popover.seq" ref="popRef" :target="popover.target" :anchor="popover.anchor" :cfg="{ pivot, chart }" :ctx="labelCtx" :container="rootEl" @commit="onPopCommit" @close="onPopClose" />
  </div>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ab { position: relative; outline: none; scroll-margin-top: calc(var(--toolbar-h, 56px) + 8px); border: 1px solid var(--color-border, #ccc); border-radius: 4px; padding: 6px 8px; }
.ab-f { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--color-muted-foreground, #777); }
.ab-hint { font-size: 11px; color: var(--color-muted-foreground, #777); }
.ab-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ab-seg { display: inline-flex; }
.ab-seg button { padding: 1px 8px; cursor: pointer; border: 1px solid var(--color-border, #ccc); background: transparent; color: var(--color-foreground, inherit); }
.ab-seg button.on { background: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #fff); }
.ab-opts { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.ab-tail { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; flex: 1 1 auto; min-width: 0; }
.ab-acts { display: inline-flex; flex-wrap: nowrap; gap: 6px; align-items: center; margin-inline-start: auto; }
.ab-head { display: flex; flex-direction: column; gap: 6px; }
.ab { --ab-gap-row: 12px; --ab-gap-fp: 4px; }
.ab-row { display: flex; flex-wrap: wrap; gap: 6px var(--ab-gap-row); align-items: center; }
/* FieldPicker puts 4px between its label and control; pull the 12px row gap down to match so every row's control starts at the same x */
.ab-rlabel { min-width: 4.5em; margin-inline-end: calc(var(--ab-gap-fp) - var(--ab-gap-row)); font-size: 12px; color: var(--color-muted-foreground, #777); }
.ab-row[data-row=title] { flex-wrap: nowrap; }
.ab-title-input { flex: 0 1 306px; min-width: 120px; max-width: 100%; box-sizing: border-box; }
.ab-row :deep(.fp-label) { min-width: 4.5em; }
.ab-labels-btn { flex: 0 0 auto; padding: 1px 10px; cursor: pointer; border: 1px solid var(--color-border, #ccc); border-radius: 4px; background: transparent; color: var(--color-foreground, inherit); font: inherit; }
.ab-status { margin-top: 6px; font-size: 12px; }
.ab-badge { padding: 0 6px; border-radius: 8px; border: 1px solid var(--color-border, #ccc); color: var(--color-muted-foreground, #777); }
.ab-badge.warn { color: var(--color-warning, #b80); border-color: var(--color-warning, #b80); }
.ab-msg { color: var(--color-muted-foreground, #777); margin: 8px 0; user-select: text; }
.ab-view { margin-top: 6px; display: grid; gap: 8px; grid-template-columns: 1fr; }
.ab-view.both { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
.ab-pane { min-width: 0; scroll-margin-top: calc(var(--toolbar-h, 56px) + 8px); }
</style>
