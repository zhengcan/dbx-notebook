<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { normalizeBigNumber } from '../analysis/bigNumberConfig'
import AiDrawer from './AiDrawer.vue'
import ChatPane from './ChatPane.vue'
import MetricCardBoard, { type MetricCardItem } from './MetricCardBoard.vue'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, EngineKey, StoreKey } from '../injection'
import { useChatSession, GateClosedError, type ParsedTurn, type TurnContext } from './useChatSession'
import { summarizeResult } from './context'
import { MAX_SAMPLE_ROWS, type MetricsPromptTable } from './promptChat'
import { checkCandidate, detectMetricTarget, parseMetricsReply, type LocalTable, type MetricCandidate } from './parseMetrics'
import { canonicalizeCandidate, planMetricApply, type PlanError } from './groupMetrics'
import { listLocalTables, metricsAiGate, previewCandidate, tableSignature, type Preview } from './metricsAiGate'
import { createEngineClient } from '../run/engineClient'
import type { AiSendOptions } from './aiSettings'
import type { AiLocale } from './prompt'
import type { DrawerSpec } from './drawerState'
import { currentLocale, t, type MessageKey } from '../i18n'

const props = defineProps<{ spec: DrawerSpec }>()
const emit = defineEmits<{ close: [] }>()

const store = inject(StoreKey)
const bridge = inject(BridgeKey, null)
const client = inject(AiClientKey)
const aiSettings = inject(AiSettingsKey)
const chat = inject(ChatStoreKey)
if (!store || !client || !aiSettings || !chat) throw new Error('MetricsDrawer: missing provided dependencies')
const engine = inject(EngineKey, null) ?? (bridge ? createEngineClient(bridge) : undefined)

const blockId = props.spec.blockId
const session = useChatSession({ client, aiSettings, chat, store }, props.spec)
const uid = Math.random().toString(36).slice(2, 8)
const startGeneration = store.generation.value
let alive = true

const block = computed(() => store.nb.value.blocks.find((b) => b.id === blockId))
const tables = computed(() => listLocalTables(store))

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
const gateOf = (send: AiSendOptions, n = tables.value.length) => metricsAiGate({ caps: bridge?.capabilities() ?? ({ aiCompletion: true } as any), send, tables: n, busy: false })
const gateReason = computed(() => {
  const g = gateOf(sendOpts.value)
  return g.enabled ? '' : t(`ai.bn.gate.${g.reason}` as MessageKey)
})

interface Stored { metrics: MetricCandidate[]; sig?: string }
function readStored(raw: string | undefined): Stored | null {
  if (raw === undefined) return null
  try {
    const v = JSON.parse(raw)
    if (!v || !Array.isArray(v.metrics)) return null
    const metrics = (v.metrics as unknown[]).filter((c): c is MetricCandidate => !!c && typeof c === 'object' && typeof (c as any).data === 'string' && typeof (c as any).aggregate === 'string')
    return metrics.length ? { metrics, sig: typeof v.sig === 'string' ? v.sig : undefined } : null
  } catch { return null }
}
const latest = computed<Stored | null>(() => {
  for (let i = session.messages.value.length - 1; i >= 0; i--) {
    const m = session.messages.value[i]
    if (m.role === 'assistant' && m.metricsAfter !== undefined) return readStored(m.metricsAfter)
  }
  return null
})
const older = computed(() => !!latest.value && latest.value.sig !== undefined && latest.value.sig !== tableSignature(tables.value))

const rawList = computed(() => latest.value?.metrics ?? [])
// every card is validated by planMetricApply (the only path from candidates to definitions) against the live tables
const checked = computed(() => rawList.value.map((c) => {
  const canon = canonicalizeCandidate(c, tables.value)
  const plan = planMetricApply([c], tables.value, 'insert')
  if (!('error' in plan)) return { canon, code: '' }
  const p = checkCandidate(canon, tables.value).problem
  return { canon, code: p?.code ?? 'AMBIGUOUS' }
}))

const unchecked = ref<Set<number>>(new Set())
watch(latest, () => { unchecked.value = new Set() })
const isOn = (i: number) => !checked.value[i]?.code && !unchecked.value.has(i)
const selected = ref(0)
const sel = computed(() => Math.min(selected.value, Math.max(0, rawList.value.length - 1)))

const previews = ref<(Preview | 'loading' | undefined)[]>([])
let pSeq = 0
const previewKey = computed(() => JSON.stringify([checked.value.map((x) => (x.code ? null : x.canon)), tables.value.map((x) => [x.name, x.executedAt])]))
watch(previewKey, async () => {
  const my = ++pSeq
  const gen = store.generation.value
  const list = checked.value
  previews.value = list.map((x) => (x.code ? undefined : 'loading'))
  const ok = () => alive && my === pSeq && store.generation.value === gen
  if (!engine) { previews.value = list.map((x) => (x.code ? undefined : { text: null, error: t('bn.err.ENGINE', { message: '' }) })); return }
  await Promise.all(list.map(async (x, i) => {
    if (x.code) return
    const p = await previewCandidate({ store, engine }, x.canon, ok)
    if (!ok()) return
    const next = previews.value.slice()
    next[i] = p
    previews.value = next
  }))
}, { immediate: true })

const checkedCands = computed(() => rawList.value.filter((_, i) => isOn(i)))
const insertPlan = computed(() => planMetricApply(checkedCands.value, tables.value, 'insert'))
const updatePlan = computed(() => planMetricApply(checkedCands.value, tables.value, 'update'))
const groupOf = computed(() => {
  const p = insertPlan.value
  const out = new Map<number, number>()
  if ('error' in p) return out
  const left = p.defs.map((d) => d.metrics.length)
  rawList.value.forEach((_, i) => {
    if (!isOn(i)) return
    const src = checked.value[i].canon.data.toLowerCase()
    const k = p.defs.findIndex((d, j) => d.data.toLowerCase() === src && left[j] > 0)
    if (k >= 0) { left[k]--; out.set(i, k + 1) }
  })
  return out
})

const items = computed<MetricCardItem[]>(() => rawList.value.map((c, i) => {
  const code = checked.value[i].code
  const pv = previews.value[i]
  return {
    cand: code ? c : checked.value[i].canon,
    ...(code ? { problem: { code, text: t(`ai.bn.problem.${code}` as MessageKey) } } : {}),
    preview: pv ?? 'loading',
    checked: isOn(i),
    ...(groupOf.value.has(i) ? { group: groupOf.value.get(i) } : {}),
  }
}))

function rejectText(e: PlanError, cands: MetricCandidate[], live: LocalTable[]): string {
  switch (e.code) {
    case 'ambiguous': return t('ai.bn.reject.ambiguous')
    case 'mixed-sources': return t('ai.bn.reject.mixedSources')
    case 'too-many': return t('ai.bn.reject.tooMany')
    case 'empty': return t('ai.bn.reject.empty')
    case 'invalid': {
      const code = checkCandidate(canonicalizeCandidate(cands[e.index], live), live).problem?.code
      return t(code === 'NO_TABLE' ? 'ai.bn.reject.sourceGone' : code === 'NO_COLUMN' ? 'ai.bn.reject.columnGone' : 'ai.bn.reject.invalid')
    }
  }
}
const planReason = (p: ReturnType<typeof planMetricApply>) => ('error' in p ? rejectText(p.error, checkedCands.value, tables.value) : '')
const blockReason = computed(() => (!block.value ? t('ai.bn.reject.blockGone') : block.value.type !== 'big-number' ? t('ai.bn.reject.notBigNumber') : ''))
const updateReason = computed(() => blockReason.value || planReason(updatePlan.value))
const insertReason = computed(() => blockReason.value || planReason(insertPlan.value))
const insertLabel = computed(() => ('defs' in insertPlan.value ? t('ai.bn.insertN', { n: insertPlan.value.defs.length, m: checkedCands.value.length }) : t('drawer.bn.insert')))

const warnings = ref<string[]>([])
const rejection = ref('')
watch([unchecked, latest], () => { rejection.value = '' })

// what the user sees checked (valid at the last render): the click re-plans exactly these against the live tables
let shownOn: boolean[] = []
const snap = () => { shownOn = items.value.map((x) => x.checked) }
watch(items, snap, { flush: 'post' })
onMounted(async () => {
  snap()
  await Promise.all([session.load(), refreshSend()])
})
onBeforeUnmount(() => { alive = false; pSeq++; session.dispose() })

const errMsg = (reason: string) => t(reason === 'truncated' || reason === 'too-long' ? 'ai.err.truncated' : reason === 'empty' ? 'ai.err.empty' : reason === 'incomplete' ? 'ai.err.incomplete' : 'ai.err.unparseable')

async function onSend(text: string, whole = false) {
  const send = await refreshSend()
  if (!gateOf(send).enabled) return
  const have = whole ? [] : rawList.value
  const typed = have.length ? detectMetricTarget(text, have.length) : 'all'
  const numbered = typeof typed === 'number'
  const turnSel = have.length ? (numbered ? (typed as number) - 1 : sel.value) : null
  let sig = ''
  const ctx: TurnContext = {
    task: 'rewrite',
    async buildInput(sendNow, history, userText) {
      if (!sendNow.schema) throw new GateClosedError(t('ai.catalog.off'))
      const live = listLocalTables(store)
      if (!live.length) throw new GateClosedError(t('ai.bn.gate.no-tables'))
      sig = tableSignature(live)
      const metricTables: MetricsPromptTable[] = live.map((x) => {
        const r = x.run.result!
        return { name: x.name, columns: r.columns.map((c) => ({ name: c.name, dataType: c.dataType })), ...(sendNow.data ? { sample: summarizeResult(r, { maxRows: MAX_SAMPLE_ROWS }) } : {}) }
      })
      const cfg = block.value && block.value.type === 'big-number' ? normalizeBigNumber(block.value.metadata) : null
      return {
        locale: (currentLocale() === 'zh-CN' ? 'zh-CN' : 'en') as AiLocale,
        dialect: live[0].run.result?.dbType ?? '', send: sendNow, purpose: 'bignumber', schemas: [], metricTables,
        metricCurrent: { candidate: turnSel !== null ? have[turnSel] ?? null : null, block: cfg && cfg.data !== '' ? { data: cfg.data, metrics: cfg.metrics } : null },
        metricSelected: turnSel !== null ? turnSel + 1 : undefined, history, userText,
      }
    },
    parse(raw, truncatedOut): ParsedTurn {
      const p = parseMetricsReply(raw, { truncated: truncatedOut, selected: turnSel, numbered })
      if (!p.ok) return { ok: false, message: errMsg(p.reason) }
      const v = p.value
      if (v.metrics.length === 0) return { ok: true, reply: [{ kind: 'text', text: v.question ?? '' }] }
      const one = v.replaced === 'one' && v.index !== undefined && v.index < have.length
      const next = one ? have.map((c, i) => (i === v.index ? v.metrics[0] : c)) : v.metrics
      const note = one ? t('drawer.bn.updatedOne', { n: (v.index ?? 0) + 1 }) : t('drawer.bn.updated', { n: next.length })
      const stored: Stored = { metrics: next, sig }
      return {
        ok: true, reply: [{ kind: 'text', text: v.question ? `${note}\n${v.question}` : note }],
        metricsAfter: JSON.stringify(stored), metricsSampled: send.data, payload: { warnings: p.warnings, select: one ? v.index ?? 0 : 0 },
      }
    },
  }
  const r = await session.send(text, ctx)
  const pl = r?.payload as { warnings: string[]; select: number } | undefined
  if (pl && alive) { warnings.value = pl.warnings; selected.value = pl.select }
  void refreshSend()
}

function onClear() { warnings.value = []; rejection.value = ''; void session.clear() }
const generate = () => onSend(t('drawer.bn.firstTurn'), true)
const onChat = (text: string) => onSend(text)

function toggle(i: number) {
  const s = new Set(unchecked.value)
  if (s.has(i)) s.delete(i); else s.add(i)
  unchecked.value = s
}
function toggleAll(v: boolean) {
  unchecked.value = v ? new Set() : new Set(rawList.value.map((_, i) => i))
}

const thrown = (e: unknown): string => {
  const m = e instanceof Error ? e.message : ''
  return t(m === 'block-gone' ? 'ai.bn.reject.blockGone' : m === 'not-big-number' ? 'ai.bn.reject.notBigNumber' : m === 'anchor-missing' ? 'ai.bn.reject.anchorMissing' : 'ai.bn.reject.invalid')
}
function apply(mode: 'update' | 'insert') {
  if (session.busy.value) return
  if (store!.generation.value !== startGeneration) { emit('close'); return }
  rejection.value = ''
  const cands = rawList.value.filter((_, i) => shownOn[i])
  const live = listLocalTables(store!)
  const plan = planMetricApply(cands, live, mode)
  if ('error' in plan) { rejection.value = rejectText(plan.error, cands, live); return }
  try {
    store!.applyAiEdit({
      label: mode === 'update' ? 'AI: update big-number metrics' : 'AI: insert big-number metrics',
      run: (tx) => {
        if (mode === 'update') { tx.setBigNumberDef(blockId, plan.defs[0]); return }
        let after = blockId
        for (const d of plan.defs) after = tx.insertBigNumberAfter(after, d)
      },
    })
  } catch (e) { rejection.value = thrown(e); return }
  emit('close')
}
</script>

<template>
  <AiDrawer
    :title="t('drawer.bn.title')" :dirty="false" :busy="session.busy.value" hide-confirm
    @close="emit('close')" @discard="emit('close')"
  >
    <template #left>
      <div class="bd" data-test="bn-drawer">
        <div class="row">
          <button
            type="button" class="btn primary" data-test="bn-generate" :disabled="session.busy.value || !!gateReason"
            :aria-describedby="gateReason ? `bd-why-${uid}` : undefined" @click="generate"
          >{{ rawList.length ? t('drawer.bn.regenerate') : t('drawer.bn.generate') }}</button>
          <span v-if="gateReason" :id="`bd-why-${uid}`" class="why" data-test="bn-reason">{{ gateReason }}</span>
        </div>
        <p v-if="!rawList.length && !gateReason" class="why" data-test="bn-hint">{{ t('drawer.bn.hint') }}</p>
        <p v-if="older" class="why" data-test="bn-older" role="status">{{ t('drawer.bn.older') }}</p>
        <p v-if="warnings.length" class="why" data-test="bn-warnings">{{ t('drawer.bn.warnings') }}: {{ warnings.join('; ') }}</p>
        <MetricCardBoard v-if="rawList.length" :items="items" :selected="sel" @select="(i: number) => (selected = i)" @toggle="toggle" @toggle-all="toggleAll" />
        <section v-if="rawList.length" class="apply" :aria-label="t('drawer.bn.applyUpdate')">
          <div class="row">
            <button type="button" class="btn primary" data-test="bn-apply-update" :disabled="session.busy.value || !!updateReason" :aria-describedby="updateReason ? `bd-ur-${uid}` : undefined" @click="apply('update')">{{ t('drawer.bn.applyUpdate') }}</button>
            <button type="button" class="btn" data-test="bn-apply-insert" :disabled="session.busy.value || !!insertReason" :aria-describedby="insertReason ? `bd-ir-${uid}` : undefined" @click="apply('insert')">{{ insertLabel }}</button>
          </div>
          <p v-if="updateReason" :id="`bd-ur-${uid}`" class="why" data-test="bn-apply-reason">{{ updateReason }}</p>
          <p v-if="insertReason && insertReason !== updateReason" :id="`bd-ir-${uid}`" class="why" data-test="bn-apply-insert-reason">{{ insertReason }}</p>
          <p v-if="rejection" class="err" data-test="bn-reject" role="alert">⚠ {{ rejection }}</p>
        </section>
      </div>
    </template>
    <template #chat>
      <ChatPane
        :messages="session.messages.value" :busy="session.busy.value" :progress="session.progress.value" :error="session.error.value"
        :raw-output="session.rawOutput.value" :disabled-reason="gateReason || undefined" :placeholder="t('drawer.bn.placeholder')"
        @send="onChat" @cancel="session.cancel()" @clear="onClear"
      />
    </template>
  </AiDrawer>
</template>

<style scoped>
.bd { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.apply { display: flex; flex-direction: column; gap: 6px; }
.why { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
.err { margin: 0; font-size: 12px; font-weight: 600; color: var(--color-destructive); }
.btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.btn.primary { background: var(--color-primary); color: var(--color-primary-foreground); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
