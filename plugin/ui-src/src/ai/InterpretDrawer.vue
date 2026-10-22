<script setup lang="ts">
// Interpret chats are hard-gated on the "send result data" switch (buildInput throws when it is off), so cached ANSWER text can never reach a data-off prompt.
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import AiDrawer from './AiDrawer.vue'
import ChatPane from './ChatPane.vue'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, ConnectionsKey, StoreKey } from '../injection'
import { useChatSession, GateClosedError, type ParsedTurn, type TurnContext } from './useChatSession'
import { summarizeResult } from './context'
import { hashPath } from './chatStore'
import { parseInterpretReply } from './parseInterpret'
import { interpretGate } from './interpretGate'
import type { AiSendOptions } from './aiSettings'
import type { AiLocale } from './prompt'
import type { DrawerSpec } from './drawerState'
import { resolveBlockConnection } from '../run/resolveConnection'
import { isResultsBlock } from '../run/deps'
import { renderMarkdownSafe } from '../export/markdown'
import { currentLocale, t } from '../i18n'

const props = defineProps<{ spec: DrawerSpec }>()
const emit = defineEmits<{ close: [] }>()

const store = inject(StoreKey)
const bridge = inject(BridgeKey)
const connections = inject(ConnectionsKey)
const client = inject(AiClientKey)
const aiSettings = inject(AiSettingsKey)
const chat = inject(ChatStoreKey)
if (!store || !bridge || !connections || !client || !aiSettings || !chat) throw new Error('InterpretDrawer: missing provided dependencies')

const blockId = props.spec.blockId
const session = useChatSession({ client, aiSettings, chat, store }, props.spec)
const startGeneration = store.generation.value

const block = computed(() => store.nb.value.blocks.find((b) => b.id === blockId))
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
const gateOf = (send: AiSendOptions) => interpretGate({ caps: bridge!.capabilities(), send, run: store!.runs.get(blockId), busy: false })
const gateReason = computed(() => {
  const g = gateOf(sendOpts.value)
  return g.enabled ? '' : t(`ai.interpret.gate.${g.reason}`)
})

const latest = computed(() => [...session.messages.value].reverse().find((m) => m.role === 'assistant' && m.markdownAfter !== undefined)?.markdownAfter ?? '')
const html = computed(() => (latest.value ? renderMarkdownSafe(latest.value) : ''))
const summary = computed(() => {
  const r = store.runs.get(blockId)?.result
  return r ? summarizeResult(r) : null
})
const sigOf = (r: { columns: { name: string }[]; rows: unknown[][] }) => hashPath(JSON.stringify([r.columns.map((c) => c.name), r.rows.length, r.rows.slice(0, 20)]))
const resultSig = computed(() => { const r = store.runs.get(blockId)?.result; return r ? sigOf(r) : '' })
const sampled = computed(() => !!summary.value && (summary.value.totalRows > Math.min(summary.value.rows.length, summary.value.shownRows ?? summary.value.rows.length) || summary.value.truncatedAtRun))
// what the last request actually carried (rows the prompt builder dropped to fit its budget are excluded)
const sent = ref<{ rows: number; truncated: boolean } | null>(null)
const lastAi = computed(() => [...session.messages.value].reverse().find((m) => m.role === 'assistant' && m.markdownAfter !== undefined))
const stale = computed(() => !!lastAi.value?.resultSig && !!resultSig.value && lastAi.value.resultSig !== resultSig.value)

const insertError = ref('')
const insertReason = computed(() =>
  !block.value || insertError.value ? t('drawer.interpret.deleted')
  : !latest.value ? t('drawer.interpret.none')
  : '')

let autoStarted = false
onMounted(async () => {
  // rule: never auto-generate over an unknown cache — if the cached chat could not be loaded, the user starts it by typing
  const loaded = await session.load().then(() => true, () => false)
  const sendNow = await refreshSend()
  if (!loaded || !session.ready.value) return
  if (autoStarted || disposedFlag || latest.value || !gateOf(sendNow).enabled) return
  autoStarted = true
  await onSend(t('drawer.interpret.firstTurn'), { force: true })
})
let disposedFlag = false
onBeforeUnmount(() => { disposedFlag = true; session.dispose() })

async function onSend(text: string, opts?: { force?: boolean }) {
    // the result the prompt was built from: the reply is stamped with this, not with whatever the block shows when it arrives
  let turnSig = ''
  let turnSummary: ReturnType<typeof summarizeResult> | null = null
  // the three switches are re-read for every turn; with result data off nothing is sent
  const send = await refreshSend()
  if (!gateOf(send).enabled) return
  // with no interpretation yet any typed message is a forced generate; read after the awaits above
  const force = !!opts?.force || !latest.value
  const ctx: TurnContext = {
    task: 'rewrite',
    async buildInput(sendNow, history, userText) {
      const b = block.value
      const result = store!.runs.get(blockId)?.result
      if (!sendNow.data) throw new GateClosedError(t('ai.interpret.gate.no-data-setting'))
      if (!b || !result || result.rows.length === 0) throw new GateClosedError(t(`ai.interpret.gate.${result ? 'empty-result' : 'no-result'}`))
      turnSig = sigOf(result)
      turnSummary = summarizeResult(result)
      const local = isResultsBlock(b)
      const res = local ? undefined : resolveBlockConnection(connections!, store!.nb.value, b).result
      const conn = res?.status === 'ok' ? res.conn : undefined
      return {
        locale: (currentLocale() === 'zh-CN' ? 'zh-CN' : 'en') as AiLocale,
        dialect: local ? 'SQLite' : conn?.dialect ?? result.dbType ?? '',
        send: sendNow, purpose: 'interpret', draft: b.content, schemas: [], result: summarizeResult(result),
        history, userText, forceUpdate: force,
      }
    },
    onBuilt(built) {
      const s = turnSummary ?? summarizeResult(store!.runs.get(blockId)!.result!)
      const rows = Math.max(0, Math.min(s.rows.length, s.shownRows ?? s.rows.length) - built.droppedRows)
      sent.value = { rows, truncated: s.totalRows > rows || s.truncatedAtRun }
    },
    parse(raw, truncatedOut): ParsedTurn {
      const p = parseInterpretReply(raw, { truncated: truncatedOut, force })
      if (!p.ok) return { ok: false, message: t(p.reason === 'truncated' || p.reason === 'too-long' ? 'ai.err.truncated' : p.reason === 'empty' ? 'ai.err.empty' : 'ai.err.unparseable') }
      if (p.value.kind === 'answer') return { ok: true, reply: [{ kind: 'text', text: p.value.text }] }
      return { ok: true, reply: [{ kind: 'text', text: t('drawer.interpret.updated') }], markdownAfter: p.value.markdown, resultSig: turnSig }
    },
  }
  await session.send(text, ctx)
  void refreshSend()
}

function insert() {
  const md = latest.value
  if (insertReason.value || !md || session.busy.value) return
  if (store!.generation.value !== startGeneration) return
  try {
    store!.applyAiEdit({ label: 'AI: insert interpretation', run: (tx) => { tx.insertAfter('markdown', blockId, md) } })
  } catch (e) {
    if (e instanceof Error && e.message === 'anchor-missing') { insertError.value = t('drawer.interpret.deleted'); return }
    throw e
  }
  emit('close')
}
</script>

<template>
  <AiDrawer
    :title="t('drawer.interpret.title')" :confirm-label="t('ai.interpret.insert')" :dirty="false" :busy="session.busy.value"
    :confirm-disabled-reason="insertReason || undefined" @close="emit('close')" @discard="emit('close')" @confirm="insert"
  >
    <template #left>
      <div class="id" data-test="interpret-drawer">
        <div v-if="sent?.truncated" class="note" data-test="interpret-trunc">{{ t('ai.interpret.trunc', { n: sent.rows }) }}</div>
        <div v-else-if="!sent && sampled" class="note" data-test="interpret-sample">{{ t('drawer.interpret.sample') }}</div>
        <p v-if="gateReason" class="why" data-test="interpret-reason">{{ gateReason }}</p>
        <p v-if="insertError" class="why" role="alert" data-test="interpret-insert-error">{{ insertError }}</p>
        <p v-if="!latest && session.busy.value" class="why" role="status" data-test="interpret-auto">{{ t('drawer.interpret.autoStart') }}</p>
        <p v-if="!latest && !session.busy.value && !gateReason" class="why" role="status" data-test="interpret-retry">{{ t('drawer.interpret.retryHint') }}</p>
        <div v-if="latest" class="pv-wrap">
          <div class="lbl">{{ t('ai.interpret.preview') }}</div>
          <div v-if="stale" class="note" data-test="interpret-stale" role="note">{{ t('drawer.interpret.stale') }}</div>
          <div class="pv" data-test="interpret-preview" role="region" :aria-label="t('ai.interpret.preview')" v-html="html" />
        </div>
      </div>
    </template>
    <template #chat>
      <ChatPane
        :messages="session.messages.value" :busy="session.busy.value" :progress="session.progress.value" :error="session.error.value"
        :raw-output="session.rawOutput.value" :disabled-reason="gateReason || undefined" :placeholder="t('drawer.interpret.placeholder')"
        @send="onSend" @cancel="session.cancel()" @clear="session.clear()"
      />
    </template>
  </AiDrawer>
</template>

<style scoped>
.id { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.pv-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.lbl, .why, .note { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
.pv { padding: 6px 8px; background: var(--color-background); color: var(--color-foreground); border: 1px solid var(--color-border); border-radius: 4px; user-select: text; overflow: auto; flex: 1; min-height: 0; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
