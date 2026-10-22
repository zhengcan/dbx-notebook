<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { normalizeAnalysis } from '@sqlnb/format'
import AiDrawer from './AiDrawer.vue'
import ChatPane from './ChatPane.vue'
import ChartSchemeBoard from './ChartSchemeBoard.vue'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, StoreKey } from '../injection'
import { useChatSession, GateClosedError, type ParsedTurn, type TurnContext } from './useChatSession'
import { summarizeResult } from './context'
import { chartConfigColumnsValid, detectSchemeTarget, parseChartReply, type ChartCandidate } from './parse'
import { chartAiGate, chartApplyPatch, chartConfigEqual, describeChart } from './chartAiGate'
import { hashPath } from './chatStore'
import type { AiSendOptions } from './aiSettings'
import type { AiLocale } from './prompt'
import type { DrawerSpec } from './drawerState'
import { resolveSource } from '../analysis/source'
import { currentLocale, t } from '../i18n'

const props = defineProps<{ spec: DrawerSpec }>()
const emit = defineEmits<{ close: [] }>()

const store = inject(StoreKey)
const bridge = inject(BridgeKey, null)
const client = inject(AiClientKey)
const aiSettings = inject(AiSettingsKey)
const chat = inject(ChatStoreKey)
if (!store || !client || !aiSettings || !chat) throw new Error('ChartDrawer: missing provided dependencies')

const blockId = props.spec.blockId
const session = useChatSession({ client, aiSettings, chat, store }, props.spec)
const uid = Math.random().toString(36).slice(2, 8)
const startGeneration = store.generation.value

const block = computed(() => store.nb.value.blocks.find((b) => b.id === blockId))
const meta = computed(() => (block.value?.metadata ?? {}) as Record<string, unknown>)
const metaJson = computed(() => (block.value ? JSON.stringify(block.value.metadata ?? null) : ''))
const src = computed(() => resolveSource(store, typeof meta.value.data === 'string' ? meta.value.data : ''))
const srcOk = computed(() => ('error' in src.value ? null : src.value))
const sourceData = computed(() => {
  const r = srcOk.value?.run.result
  return r ? { columns: r.columns.map((c) => ({ name: c.name, dataType: c.dataType })), rows: r.rows as unknown[][] } : null
})
const current = computed(() => normalizeAnalysis(meta.value))

// fail-closed until aiSettings.sendOptions() resolves; never read aiSettings.send directly
const sendOpts = ref<AiSendOptions>({ schema: false, sql: false, data: false })
let sendSeq = 0
async function refreshSend(): Promise<AiSendOptions> {
  const seq = ++sendSeq
  let o: AiSendOptions = { schema: false, sql: false, data: false }
  try { o = await aiSettings!.sendOptions() } catch { /* stay closed */ }
  if (seq === sendSeq) sendOpts.value = o
  return o
}
const gateOf = (send: AiSendOptions) => chartAiGate({
  caps: bridge?.capabilities() ?? ({ aiCompletion: true } as any),
  send,
  source: sourceData.value ? { columns: sourceData.value.columns.map((c) => c.name), rows: sourceData.value.rows } : null,
  busy: false,
})
const gateReason = computed(() => {
  const g = gateOf(sendOpts.value)
  return g.enabled ? '' : t(`ai.chart.gate.${g.reason}`)
})

interface StoredSchemes { schemes: ChartCandidate[]; cols?: string }
const colSig = (names: string[]) => hashPath(JSON.stringify(names))
function readStored(raw: string | undefined): StoredSchemes | null {
  if (raw === undefined) return null
  try {
    const v = JSON.parse(raw)
    if (!v || !Array.isArray(v.schemes)) return null
    const schemes = (v.schemes as any[]).filter((c) => c && typeof c === 'object' && c.config && typeof c.config.pivot === 'object' && c.config.pivot && c.config.chartOptions && typeof c.config.chartOptions === 'object')
    const out: StoredSchemes = {
      schemes: schemes.map((c) => {
        const o: ChartCandidate = { title: typeof c.title === 'string' ? c.title : '', config: c.config }
        if (typeof c.summary === 'string' && c.summary.trim()) o.summary = c.summary.slice(0, 200)
        return o
      }),
    }
    if (typeof v.cols === 'string') out.cols = v.cols
    return schemes.length ? out : null
  } catch { return null }
}
const latest = computed<StoredSchemes | null>(() => {
  for (let i = session.messages.value.length - 1; i >= 0; i--) {
    const m = session.messages.value[i]
    if (m.role === 'assistant' && m.chartAfter !== undefined) return readStored(m.chartAfter)
  }
  return null
})
const curColumns = computed(() => srcOk.value?.run.result?.columns.map((c) => c.name) ?? [])
// restored/stored schemes are re-checked against the CURRENT result columns; invalid ones are dropped
const schemes = computed(() => {
  const l = latest.value
  return l ? l.schemes.filter((c) => chartConfigColumnsValid(c.config, curColumns.value)) : []
})
const droppedCount = computed(() => (latest.value?.schemes.length ?? 0) - schemes.value.length)
const colsChanged = computed(() => !!latest.value && (droppedCount.value > 0 && schemes.value.length === 0 || (latest.value.cols !== undefined && latest.value.cols !== colSig(curColumns.value))))
const selected = ref(0)
const sel = computed(() => Math.min(selected.value, Math.max(0, schemes.value.length - 1)))
const warnings = ref<string[]>([])
// metadata of the block when the schemes were produced (or, for restored schemes, when the drawer opened)
const producedMeta = ref<string | null>(null)

const applyReason = computed(() =>
  !block.value ? t('drawer.chart.deleted')
  : colsChanged.value ? t('drawer.chart.colsChanged')
  : !schemes.value.length ? t('drawer.chart.none')
  : producedMeta.value !== null && producedMeta.value !== metaJson.value ? t('ai.chart.modifiedSince')
  : '')

const selectedScheme = computed(() => schemes.value[sel.value])
const rowLabels = ['type', 'rows', 'columns', 'values', 'stacking', 'timeAxis', 'title', 'totals'] as const
const diff = computed(() => {
  const c = selectedScheme.value
  if (!c) return []
  const a = describeChart({ pivot: current.value.pivot, chartOptions: current.value.chart })
  const b = describeChart({ pivot: c.config.pivot, chartOptions: c.config.chartOptions })
  return rowLabels.map((k) => {
    const o = a.find((x) => x.key === k)!.text, n = b.find((x) => x.key === k)!.text
    return { key: k, old: o, next: n, changed: o !== n }
  }).filter((r) => r.old !== '' || r.next !== '')
})

onMounted(async () => {
  await Promise.all([session.load(), refreshSend()])
  if (schemes.value.length) producedMeta.value = metaJson.value
  const cur = { pivot: current.value.pivot, chartOptions: current.value.chart }
  const m = schemes.value.findIndex((c) => chartConfigEqual(c.config, cur))
  selected.value = m >= 0 ? m : 0
})
onBeforeUnmount(() => session.dispose())

const flat = (c: ChartCandidate) => ({ title: c.title, ...c.config })

async function onSend(text: string, whole = false) {
  const send = await refreshSend()
  if (!gateOf(send).enabled) return
  const have = whole ? [] : schemes.value
  const typed = have.length ? detectSchemeTarget(text) : 'all'
  const numbered = typeof typed === 'number' && typed <= have.length
  const turnSel = have.length ? (numbered ? (typed as number) - 1 : sel.value) : null
  let columns: string[] = []
  let baseline = ''
  const ctx: TurnContext = {
    task: 'rewrite',
    async buildInput(sendNow, history, userText) {
      if (!sendNow.data) throw new GateClosedError(t('ai.chart.gate.no-data-setting'))
      const r = srcOk.value?.run.result
      if (!block.value || !r || r.rows.length === 0) throw new GateClosedError(t(`ai.chart.gate.${r ? 'empty-source' : 'no-source'}`))
      columns = r.columns.map((c) => c.name)
      baseline = metaJson.value
      const cur = turnSel !== null
        ? { current: flat(have[turnSel]) }
        : { current: { pivot: current.value.pivot, chartOptions: current.value.chart }, label: 'CURRENT CHART CONFIG' }
      return {
        locale: (currentLocale() === 'zh-CN' ? 'zh-CN' : 'en') as AiLocale,
        dialect: r.dbType ?? '', send: sendNow, purpose: 'chart', schemas: [], result: summarizeResult(r),
        chart: { ...cur, columns: r.columns.map((c) => ({ name: c.name, dataType: c.dataType })) },
        chartSelected: turnSel !== null ? turnSel + 1 : undefined, history, userText,
      }
    },
    parse(raw, truncatedOut): ParsedTurn {
      const p = parseChartReply(raw, { columns, truncated: truncatedOut, current: have, selected: turnSel, numbered })
      if (p.ok && whole && p.value.schemes.length === 1) p.warnings = [...p.warnings, t('drawer.chart.singleScheme')]
      if (!p.ok) return { ok: false, message: t(p.reason === 'truncated' || p.reason === 'too-long' ? 'ai.err.truncated' : p.reason === 'empty' ? 'ai.err.empty' : p.reason === 'incomplete' ? 'ai.err.incomplete' : 'ai.err.unparseable') }
      const v = p.value
      if (v.schemes.length === 0) return { ok: true, reply: [{ kind: 'text', text: v.question ?? '' }] }
      const note = v.replaced === 'one' ? t('drawer.chart.updatedOne', { n: (v.index ?? 0) + 1 }) : t('drawer.chart.updated', { n: v.schemes.length })
      const stored: StoredSchemes = { schemes: v.schemes, cols: colSig(columns) }
      return { ok: true, reply: [{ kind: 'text', text: v.question ? `${note}\n${v.question}` : note }], chartAfter: JSON.stringify(stored), payload: { warnings: p.warnings, baseline, select: v.replaced === 'one' ? (numbered ? v.index ?? 0 : null) : 0 } }
    },
  }
  const r = await session.send(text, ctx)
  const pl = r?.payload as { warnings: string[]; baseline: string; select: number | null } | undefined
  if (pl) { warnings.value = pl.warnings; producedMeta.value = pl.baseline; if (pl.select !== null) selected.value = pl.select }
  void refreshSend()
}

function onClear() { warnings.value = []; producedMeta.value = null; void session.clear() }
const generate = () => onSend(t('drawer.chart.firstTurn.candidates'), true)
const onChat = (text: string) => onSend(text)

function apply(i = sel.value) {
  const c = schemes.value[i]
  if (!c || applyReason.value || session.busy.value) return
  if (!chartConfigColumnsValid(c.config, curColumns.value)) return
  if (store!.generation.value !== startGeneration) return
  store!.applyAiEdit({ label: 'AI: configure chart', run: (tx) => tx.setAnalysis(blockId, chartApplyPatch(c.config)) })
  emit('close')
}
</script>

<template>
  <AiDrawer
    :title="t('drawer.chart.title')" :confirm-label="t('ai.apply')" :dirty="false" :busy="session.busy.value"
    :confirm-disabled-reason="applyReason || undefined" @close="emit('close')" @discard="emit('close')" @confirm="apply()"
  >
    <template #left>
      <div class="cd" data-test="chart-drawer">
        <div class="row">
          <button
            type="button" class="btn primary" data-test="chart-generate" :disabled="session.busy.value || !!gateReason"
            :aria-describedby="gateReason ? `cd-why-${uid}` : undefined" @click="generate"
          >{{ schemes.length ? t('drawer.chart.regenerate') : t('drawer.chart.generate') }}</button>
          <span v-if="gateReason" :id="`cd-why-${uid}`" class="why" data-test="chart-reason">{{ gateReason }}</span>
        </div>
        <p v-if="!schemes.length && !gateReason" class="why" data-test="chart-hint">{{ t('drawer.chart.hint') }}</p>
        <p v-if="droppedCount > 0" class="why" data-test="chart-dropped">{{ t('drawer.chart.dropped', { n: droppedCount }) }}</p>
        <p v-if="warnings.length" class="why" data-test="chart-warnings">{{ t('ai.chart.warnings') }}: {{ warnings.join('; ') }}</p>
        <ChartSchemeBoard
          v-if="schemes.length && sourceData" :source="sourceData" :candidates="schemes"
          :selected="sel" @select="(i: number) => (selected = i)" @apply="apply($event)"
        />
        <section v-if="schemes.length" class="cmp" data-test="chart-diff" :aria-label="t('drawer.chart.compare')">
          <h3 class="lbl">{{ t('drawer.chart.compare') }}</h3>
          <table>
            <thead><tr><th /><th>{{ t('ai.chart.old') }}</th><th>{{ t('ai.chart.new') }}</th></tr></thead>
            <tbody>
              <tr v-for="r in diff" :key="r.key" :class="{ changed: r.changed }">
                <th scope="row">{{ t('ai.chart.f.' + r.key) }}</th><td>{{ r.old || '—' }}</td><td>{{ r.next || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
    <template #chat>
      <ChatPane
        :messages="session.messages.value" :busy="session.busy.value" :progress="session.progress.value" :error="session.error.value"
        :raw-output="session.rawOutput.value" :disabled-reason="gateReason || undefined" :placeholder="t('drawer.chart.placeholder')"
        @send="onChat" @cancel="session.cancel()" @clear="onClear"
      />
    </template>
  </AiDrawer>
</template>

<style scoped>
.cd { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lbl { margin: 0; font-size: 12px; font-weight: 600; color: var(--color-muted-foreground); }
.why { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
table { border-collapse: collapse; font-size: 12px; background: var(--color-background); }
th, td { border: 1px solid var(--color-border); padding: 2px 8px; text-align: left; }
tr.changed td:last-child { font-weight: 600; color: var(--color-primary); }
.btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.btn.primary { background: var(--color-primary); color: var(--color-primary-foreground); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
