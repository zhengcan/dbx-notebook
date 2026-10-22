<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { AiClientKey, AiSettingsKey, BridgeKey, DrawerKey, StoreKey } from '../injection'
import { metricsAiGate, listLocalTables } from '../ai/metricsAiGate'
import { useAiRequest } from '../ai/useAiRequest'
import { t } from '../i18n'
import { resultNameOf } from '../run/deps'
import { resolveSource } from './source'
import { useAutoRefresh } from './useAutoRefresh'
import { formatValue } from './pivotModel'
import { compareText } from './compareText'
import BigNumberMetricEditor from './BigNumberMetricEditor.vue'
import { MAX_METRICS, normalizeBigNumber, isKnownAggregate, type Metric } from './bigNumberConfig'

const props = defineProps<{ blockId: string }>()
const store = inject(StoreKey)!

const block = computed(() => store.nb.value.blocks.find((b) => b.id === props.blockId))
const cfg = computed(() => normalizeBigNumber(block.value?.metadata))
const data = computed(() => cfg.value.data)
const metrics = computed(() => cfg.value.metrics)
const single = computed(() => metrics.value.length === 1)
const sources = computed(() => store.nb.value.blocks.filter((b) => b.type === 'sql' && resultNameOf(b)))
const src = computed(() => resolveSource(store, data.value))
const srcOk = computed(() => ('error' in src.value ? null : src.value))
const columns = computed(() => srcOk.value?.columns ?? [])
const res = computed(() => store.bigNumbers.get(props.blockId))
const stale = computed(() => store.staleReasons(props.blockId))
const staleText = computed(() => stale.value.map((r) => t('stale.' + r)).join(t('stale.sep')))
const refreshError = ref<string | null>(null)

// Stable per-metric keys: editor-local state (draft filter rows, errors) must move with its metric, not its slot.
let nextKey = 0
const rowKeys = ref<number[]>([])
watch(() => metrics.value.length, (n) => { if (rowKeys.value.length !== n) rowKeys.value = Array.from({ length: n }, () => nextKey++) }, { immediate: true, flush: 'sync' })
function addMetric() { rowKeys.value.push(nextKey++); store.addBigNumberMetric(props.blockId) }
function removeMetric(i: number) { rowKeys.value.splice(i, 1); store.removeBigNumberMetric(props.blockId, i) }
function moveMetric(i: number, d: -1 | 1) {
  const j = i + d
  if (j >= 0 && j < rowKeys.value.length) { const k = rowKeys.value; [k[i], k[j]] = [k[j], k[i]] }
  store.moveBigNumberMetric(props.blockId, i, d)
}

const colOf = (m: Metric) => columns.value.find((c) => c.name === m.field)
const aggOf = (m: Metric) => m.aggregate ?? (m.field === '' ? 'count' : undefined)
const badAgg = (m: Metric) => { const a = aggOf(m); return a !== undefined && !isKnownAggregate(a) }
const fieldMissing = (m: Metric) => !!srcOk.value && m.field !== '' && !colOf(m)

// Config problems of one metric (shown on its card, or in the message area for a single metric).
function configError(m: Metric): string | null {
  if (badAgg(m)) return t('bn.err.BAD_AGG', { aggregate: aggOf(m)! })
  if (fieldMissing(m)) return t('bn.missing', { field: m.field })
  if (m.field === '' && aggOf(m) !== 'count') return t('bn.pickField')
  return null
}

const message = computed<string | null>(() => {
  if (!data.value) return t('ab.noSource')
  if (single.value && badAgg(metrics.value[0])) return configError(metrics.value[0])
  const s = src.value
  if ('error' in s) return s.error.code === 'SOURCE_NOT_RUN' ? t('ab.notRun') : t('bn.err.NO_SOURCE')
  if (single.value) { const e = configError(metrics.value[0]); if (e) return e }
  if (refreshError.value) return t('ab.refreshFailed', { message: refreshError.value })
  if (res.value?.status === 'error' && (single.value || res.value.items.length === 0)) return res.value.error?.message ?? ''
  return null
})

interface Card { text: string | null; error: string | null; compare?: string; info?: string }
const cards = computed<Card[]>(() => metrics.value.map((m, i) => {
  const ce = configError(m)
  if (ce) return { text: null, error: ce }
  const it = res.value?.items[i]
  if (!it) return { text: null, error: null }
  if (it.error) return { text: null, error: it.error.message }
  const v = it.value
  const cmp = it.compare ? compareText(it.compare, t) : undefined
  const info = it.info ? t('bn.info.' + it.info.code) : undefined
  if (v === null || v === undefined) return { text: '—', error: null, compare: cmp, info }
  if (typeof v === 'number') return { text: formatValue(v, m.format ?? { kind: 'plain' }) || String(v), error: null, compare: cmp, info }
  return { text: String(v), error: null, compare: cmp, info }
}))

const metricName = (m: Metric, i: number) => m.label || m.field || t('bn.rows')

function refresh() {
  refreshError.value = null
  store.refreshBigNumber(props.blockId).catch((e) => { refreshError.value = e instanceof Error ? e.message : String(e) })
}
watch(() => JSON.stringify([data.value, metrics.value.map((m) => [m.field, m.aggregate])]), () => { refreshError.value = null })
const runnable = computed(() => !!srcOk.value && metrics.value.some((m) => !configError(m)))
useAutoRefresh({
  key: () => (srcOk.value ? (srcOk.value.executedAt ?? '') : null),
  runnable: () => runnable.value,
  hasResult: () => !!res.value,
  refresh,
})

const aiClient = inject(AiClientKey, null)
const aiSettings = inject(AiSettingsKey, null)
const bridge = inject(BridgeKey, null)
const drawer = inject(DrawerKey, null)
const aiBusy = aiClient ? useAiRequest(aiClient).busy : ref(false)
const aiShown = computed(() => !!aiSettings && !!bridge)
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
const aiGate = computed(() => metricsAiGate({
  caps: bridge?.capabilities() ?? ({ aiCompletion: false } as any),
  send: sendOpts.value,
  tables: aiShown.value ? listLocalTables(store).length : 0,
  busy: aiBusy.value,
}))
const aiReason = computed(() => (aiGate.value.enabled ? (drawer?.current.value ? t('ai.askDrawerOpen') : undefined) : t(`ai.bn.gate.${aiGate.value.reason}` as any)))
function openAi() { if (!aiReason.value) drawer?.open({ purpose: 'bignumber', blockId: props.blockId }) }

const on = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
</script>


<template>
  <div class="bn" data-test="big-number-block">
    <div class="bn-head" data-test="bn-head">
      <label class="bn-f">{{ t('ab.source') }}
        <select data-test="bn-source" :value="data" @change="store.setBigNumber(blockId, { data: on($event) })">
          <option value="">{{ t('ab.pickSource') }}</option>
          <option v-for="b in sources" :key="b.id" :value="resultNameOf(b)">{{ resultNameOf(b) }}</option>
          <option v-if="data && !sources.some((b) => resultNameOf(b) === data)" :value="data">{{ data }}</option>
        </select>
      </label>
      <button v-if="aiShown" type="button" data-test="bn-ask-ai" :aria-label="t('bn.askAiAria')" aria-haspopup="dialog" :disabled="!!aiReason" :title="aiReason" :aria-describedby="aiReason ? `bn-ai-reason-${blockId}` : undefined" @click="openAi">✨ {{ t('bn.askAi') }}</button>
      <span v-if="aiShown && aiReason" :id="`bn-ai-reason-${blockId}`" class="sr-only">{{ aiReason }}</span>
      <button type="button" data-test="bn-refresh" :aria-label="t('ab.refresh')" :title="t('ab.refresh')" @click="refresh">↻ {{ t('ab.refresh') }}</button>
      <span v-if="stale.length" class="bn-badge warn" data-test="bn-stale" :title="staleText">{{ t('ab.stale') }} · {{ staleText }}</span>
      <span v-if="res?.partial" class="bn-badge" data-test="bn-partial">{{ t('ab.partial') }}</span>
    </div>
    <div class="bn-metrics" role="group" :aria-label="t('bn.cards')" data-test="bn-metrics">
      <BigNumberMetricEditor v-for="(m, i) in metrics" :key="rowKeys[i]" :block-id="blockId" :index="i" :metric="m" :columns="columns" :count="metrics.length" :name="metricName(m, i)" @remove="removeMetric(i)" @move="(d) => moveMetric(i, d)" />
      <button type="button" data-test="bn-add" :disabled="metrics.length >= MAX_METRICS" @click="addMetric">{{ t('bn.addMetric') }}</button>
    </div>
    <p v-if="message" class="bn-msg" data-test="bn-message" role="status">{{ message }}</p>
    <div v-else class="bn-out" :class="{ one: single }" data-test="bn-cards">
      <div v-for="(c, i) in cards" :key="i" class="bn-card" data-test="bn-card">
        <div v-if="c.error" class="bn-card-error" data-test="bn-card-error" role="status">{{ c.error }}</div>
        <div v-else class="bn-value" data-test="bn-value">{{ c.text ?? '…' }}</div>
        <div v-if="c.compare" class="bn-compare" data-test="bn-compare">{{ c.compare }}</div>
        <div v-if="c.info" class="bn-compare" data-test="bn-info" role="status">{{ c.info }}</div>
        <div v-if="metrics[i].label" class="bn-label" data-test="bn-label-text" :title="metrics[i].label">{{ metrics[i].label }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bn { border: 1px solid var(--color-border, #ccc); border-radius: 4px; padding: 6px 8px; }
.bn-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.bn-f { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--color-muted-foreground, #777); }
.bn-badge { padding: 0 6px; border-radius: 8px; border: 1px solid var(--color-border, #ccc); color: var(--color-muted-foreground, #777); font-size: 12px; }
.bn-badge.warn { color: var(--color-warning, #b80); border-color: var(--color-warning, #b80); }
.bn-msg { color: var(--color-muted-foreground, #777); margin: 8px 0; user-select: text; }
.bn-metrics { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; align-items: flex-start; }
.bn-out { display: flex; flex-wrap: wrap; gap: 8px 12px; justify-content: center; padding: 12px 0; }
.bn-card { min-width: 140px; max-width: 280px; box-sizing: border-box; text-align: center; padding: 4px 8px; }
.bn-card-error { font-size: 13px; color: var(--color-destructive, #c00); user-select: text; }
.bn-value { font-size: 40px; font-weight: 600; line-height: 1.1; color: var(--color-foreground, inherit); user-select: text; }
.bn-compare { font-size: 13px; color: var(--color-muted-foreground, #777); margin-top: 2px; user-select: text; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.bn-label { font-size: 13px; color: var(--color-muted-foreground, #777); margin-top: 4px; line-height: 1.3; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
</style>
