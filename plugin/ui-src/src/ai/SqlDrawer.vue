<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AiDrawer from './AiDrawer.vue'
import ChatPane from './ChatPane.vue'
import ConfirmDialog from '../shell/ConfirmDialog.vue'
import DiffView from './DiffView.vue'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, ChatStoreKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey } from '../injection'
import { useChatSession, emptyRetrieved, type ParsedTurn, type Retrieved, type TurnContext } from './useChatSession'
import { createSchemaCache, extractTableRefs, summarizeResult, type TableSchema } from './context'
import type { NeedRequest } from './parseNeed'
import { catalogDialectOf, createCatalog, mentionedTables, notebookTables, validCatalogScope, MAX_NEED_TABLES } from './catalog'
import { parseSqlReply } from './parseReply'
import { formatAiSql } from './formatSql'
import { analyzeSql } from './sqlSafety'
import { applySqlSuggestion } from './applySql'
import { trialRun, type TrialResult } from './trialRun'
import { resolveBlockConnection, effectiveCatalog } from '../run/resolveConnection'
import { dialectHasSchemas, listDatabases, listSchemas } from '../run/catalog'
import { isResultsBlock } from '../run/deps'
import { createEngineClient } from '../run/engineClient'
import { createSqlEditor, dialectForDbType, type SqlEditorHandle, type SqlEditorOpts } from '../editor/sqlEditor'
import { currentLocale, t } from '../i18n'
import type { AiLocale } from './prompt'
import type { DrawerSpec } from './drawerState'
import type { ChatPromptInput } from './promptChat'
import type { AiSendOptions } from './aiSettings'

type Factory = (parent: HTMLElement, opts: SqlEditorOpts) => SqlEditorHandle
const props = withDefaults(defineProps<{ spec: DrawerSpec; editorFactory?: Factory }>(), { editorFactory: createSqlEditor })
const emit = defineEmits<{ close: [] }>()

const store = inject(StoreKey)
const bridge = inject(BridgeKey)
const connections = inject(ConnectionsKey)
const client = inject(AiClientKey)
const aiSettings = inject(AiSettingsKey)
const chat = inject(ChatStoreKey)
const engine = inject(EngineKey, null) ?? (bridge ? createEngineClient(bridge) : undefined)
const canRun = inject(CanRunKey, computed(() => true))
const runningAll = inject(RunningAllKey, ref(false))
if (!store || !bridge || !connections || !client || !aiSettings || !chat) throw new Error('SqlDrawer: missing provided dependencies')

const blockId = props.spec.blockId
const session = useChatSession({ client, aiSettings, chat, store }, props.spec)
const schemas = createSchemaCache(bridge)
const catalog = createCatalog(bridge)
const notices = ref<string[]>([])
const chatNotices = computed(() => [
  ...notices.value,
  ...session.notices.value.map((n) => (n.kind === 'list' ? t('ai.catalog.readList') : n.kind === 'empty' ? t('ai.notice.listEmpty', { scope: (n.names ?? []).join(', ') }) : t('ai.catalog.readTables', { names: (n.names ?? []).join(', ') }))),
])
const uid = Math.random().toString(36).slice(2, 8)
const host = ref<HTMLElement | null>(null)
let editor: SqlEditorHandle | null = null

const block = computed(() => store.nb.value.blocks.find((b) => b.id === blockId))
const blockSql = computed(() => block.value?.content ?? '')
const draft = ref(blockSql.value)
const openBase = ref(blockSql.value)
const cmp = ref<'current' | 'baseline'>('current')
const diffBase = computed(() => (cmp.value === 'current' ? blockSql.value : openBase.value))
const dirty = computed(() => draft.value !== blockSql.value)
const applying = ref(false)
const showDiff = ref(false)
const askClose = ref(false)
const applyError = ref('')
const busy = computed(() => session.busy.value || applying.value)

const isLocal = computed(() => !!block.value && isResultsBlock(block.value))
const resolved = computed(() => resolveBlockConnection(connections, store.nb.value, block.value).result)
const conn = computed(() => (resolved.value?.status === 'ok' ? resolved.value.conn : undefined))
const dialect = computed(() => (isLocal.value ? 'SQLite' : conn.value ? dialectForDbType(conn.value.dialect) : ''))

const replaceReason = computed(() =>
  !block.value ? t('drawer.sql.deleted')
  : blockSql.value !== openBase.value ? t('drawer.sql.changed')
  : draft.value.trim() === '' ? t('drawer.sql.empty')
  : draft.value === blockSql.value ? t('drawer.sql.same')
  : '')
const analysis = computed(() => analyzeSql(draft.value))
const trialReason = computed(() => (analysis.value.readOnly && analysis.value.statements === 1 ? '' : t(`drawer.trial.no.${analysis.value.reason ?? 'not-select'}`)))
const trial = ref<TrialResult | null>(null)
const trialBusy = ref(false)
const pending = ref<string | null>(null)
let trialSeq = 0
const dropTrial = () => { trialSeq++; trial.value = null }
watch(() => store.generation.value, () => catalog.clear())
watch(() => `${conn.value?.id ?? ''}|${dialect.value}|${JSON.stringify(store.inputVars())}`, dropTrial)

function setDraft(sql: string) {
  editor?.setDoc(sql)
  draft.value = sql
  pending.value = null
  dropTrial()
}

onMounted(async () => {
  editor = props.editorFactory(host.value!, {
    doc: draft.value,
    dialect: dialect.value || 'PostgreSQL',
    onChange: (d) => { draft.value = d; dropTrial() },
    columnsFor: async () => [],
  })
  const th = bridge.theme()
  editor.setDark(th.appearance === 'dark')
  const rec = await chat.load(store.path.value, blockId)
  const baselineHeld = rec.baseline !== undefined && rec.baseline === blockSql.value
  await session.load()
  openBase.value = session.baseline.value ?? blockSql.value
  const last = [...session.messages.value].reverse().find((m) => m.role === 'assistant' && m.sqlAfter !== undefined)
  if (baselineHeld && last?.sqlAfter !== undefined && last.sqlAfter !== blockSql.value) setDraft(last.sqlAfter)
  editor.focus?.()
})
onBeforeUnmount(() => {
  session.dispose()
  editor?.destroy()
  editor = null
  alive = false
})
let alive = true
let turnSeq = 0

const PARSE_ERR = { truncated: 'ai.err.truncated', empty: 'ai.err.empty', unparseable: 'ai.err.unparseable' } as const

async function onSend(text: string) {
  pending.value = null
  const turn = ++turnSeq
  catalog.newTurn()
  const current = editor?.getDoc() ?? draft.value
  const base = openBase.value
  let first: { found: TableSchema[]; tableList: ChatPromptInput['tableList']; sendNow: AiSendOptions } | null = null
  let lastNames: string[] = []
  const NAME_OK = /^[\p{L}\p{N}_$ .-]{1,128}$/u
  const ECHO_OK = /^[\p{L}\p{N}_$.-]{1,64}$/u
  const echo = (n: string) => (ECHO_OK.test(n) ? n : '(invalid name)')
  const safe = echo
  /** Up to 50 whitelisted schema (or database) names; only after re-reading the schema toggle. Failures degrade to []. */
  async function schemaNamesFor(c: NonNullable<typeof conn.value>, cat: { database?: string }): Promise<string[]> {
    try {
      if (!(await aiSettings!.sendOptions()).schema) return []
      const cc = { id: c.id, dialect: c.dialect, database: cat.database }
      const all = dialectHasSchemas(c.dialect) === false ? await listDatabases(bridge!, cc) : await listSchemas(bridge!, cc, cat.database)
      return all.filter((n) => validCatalogScope(n)).slice(0, 50)
    } catch { return [] }
  }
  async function fetchNeed(need: NeedRequest, send: AiSendOptions): Promise<Retrieved> {
    const out = emptyRetrieved()
    const b = block.value
    const c = conn.value
    if (!send.schema || !b || !c || isLocal.value) { out.notes.push('Catalog information is unavailable for this block.'); return out }
    const cat = effectiveCatalog(b, store!.nb.value, c)
    const target = { connectionId: c.id, dbType: c.dialect, database: cat.database, schema: cat.schema }
    if (need.list) {
      const scope = need.list.scope
      if (!catalogDialectOf(c.dialect)) out.notes.push('The table list is unavailable for this dialect; only the tables seen in the notebook were given.')
      else {
        const r = await catalog.listTables({ connectionId: c.id, dbType: c.dialect, database: cat.database, schema: cat.schema }, scope)
        if (r.ok) {
          out.lists.push(r.list)
          if (!scope) lastNames = r.list.names
          if (r.list.names.length) out.summary.list = true
          else {
            const label = r.list.scope || scope || t('ai.notice.allSchemas')
            out.emptyScopes = [safe(label) === '(invalid name)' ? t('ai.notice.allSchemas') : label]
            out.notes.push(`The table list for ${scope || r.list.scope ? safe(label) : 'all user schemas'} is empty.`)
            const sn = await schemaNamesFor(c, cat)
            if (sn.length) { out.schemaNames = sn; out.summary.list = true }
          }
        }
        else out.notes.push(`Table list unavailable (${r.reason})${scope ? `: ${safe(scope)}` : ''}.`)
      }
    }
    if (need.tables) {
      const found: string[] = []
      const missing: string[] = []
      for (const asked of need.tables.slice(0, MAX_NEED_TABLES)) {
        if (!NAME_OK.test(asked)) { missing.push('(invalid name)'); continue }
        const name = lastNames.find((n) => n.toLowerCase() === asked.toLowerCase()) ?? asked
        const s = await schemas.get(target, name)
        if (s) { out.schemas.push(s); found.push(s.name) } else missing.push(echo(asked))
      }
      if (found.length) out.summary.tables = found
      if (missing.length) out.notes.push(`Table structure unavailable (not found or not readable): ${missing.join(', ')}.`)
    }
    return out
  }
  const ctx: TurnContext = {
    task: 'command-generation',
    async buildInput(send, history, userText, alive = () => true, retrieved) {
      const b = block.value
      const dead = (): ChatPromptInput => ({ locale: 'en', dialect: '', send, purpose: 'sql', schemas: [], history, userText })
      let sendNow = send
      if (!first) {
        const found: TableSchema[] = []
        let tableList: ChatPromptInput['tableList']
        notices.value = []
        if (b && send.schema && conn.value && !isLocal.value) {
          const c = conn.value
          const cat = effectiveCatalog(b, store!.nb.value, c)
          const target = { connectionId: c.id, dbType: c.dialect, database: cat.database, schema: cat.schema }
          let names: string[] = []
          if (!catalogDialectOf(c.dialect)) {
            names = notebookTables(store!.nb.value.blocks)
            tableList = { scope: '', names, truncated: false, fallback: true }
          } else {
            // the toggle may have been switched off since the turn started: re-read it right before any catalog query
            const again = await aiSettings!.sendOptions()
            if (!alive()) return dead()
            if (!again.schema) sendNow = { ...send, schema: false }
            else {
              const r = await catalog.listTables({ connectionId: c.id, dbType: c.dialect, database: cat.database, schema: cat.schema })
              if (!alive()) return dead()
              if (r.ok) {
                names = r.list.names
                tableList = { scope: r.list.scope, names, truncated: r.list.truncated }
                if (names.length) notices.value = [t('ai.notice.list', { n: names.length })]
                else {
                  notices.value = [t('ai.notice.listEmpty', { scope: r.list.scope || t('ai.notice.allSchemas') })]
                  const sn = await schemaNamesFor(c, cat)
                  if (!alive()) return dead()
                  if (sn.length) tableList = { ...tableList, schemas: sn }
                }
              } else if (r.reason === 'invalid-scope') notices.value = [t('ai.notice.scopeUnsupported')]
            }
          }
          if (sendNow.schema) {
            const want: string[] = []
            for (const n of [...extractTableRefs(current), ...mentionedTables(userText, names).slice(0, MAX_NEED_TABLES)]) if (!want.some((w) => w.toLowerCase() === n.toLowerCase())) want.push(n)
            for (const name of want) {
              const s = await schemas.get(target, name)
              if (!alive()) return dead()
              if (s) found.push(s)
            }
            if (found.length) notices.value = [...notices.value, t('ai.notice.structs', { names: found.map((f) => f.name).join(', ') })]
          }
          lastNames = names
        }
        first = { found, tableList, sendNow }
      }
      sendNow = first!.sendNow.schema ? send : { ...send, schema: false }
      let found = first!.found
      let tableList = first!.tableList
      const notes: string[] = []
      if (retrieved && sendNow.schema) {
        found = [...found, ...retrieved.schemas.filter((s) => !found.some((f) => f.name.toLowerCase() === s.name.toLowerCase()))]
        if (retrieved.lists.length) {
          const all = [...(tableList?.names ?? []), ...retrieved.lists.flatMap((l) => l.names)]
          const names = all.filter((n, i) => all.indexOf(n) === i)
          tableList = { scope: '', names, truncated: !!tableList?.truncated || retrieved.lists.some((l) => l.truncated), fallback: tableList?.fallback, schemas: tableList?.schemas }
        }
        if (retrieved.schemaNames?.length) {
          const base = tableList ?? { scope: '', names: [], truncated: false }
          const all = [...(base.schemas ?? []), ...retrieved.schemaNames]
          tableList = { ...base, schemas: all.filter((n, i) => all.indexOf(n) === i).slice(0, 50) }
        }
        notes.push(...retrieved.notes)
      }
      const last = store!.runs.get(blockId)?.result
      return {
        locale: (currentLocale() === 'zh-CN' ? 'zh-CN' : 'en') as AiLocale,
        dialect: dialect.value,
        send: sendNow, purpose: 'sql', baseline: base, draft: current, schemas: found, tableList,
        result: sendNow.data && last ? summarizeResult(last) : undefined,
        catalogNeed: !!b && !!conn.value && !isLocal.value && !retrieved?.answerNow,
        notes,
        history, userText,
      }
    },
    catalog: { fetch: fetchNeed },
    parse(raw, truncated): ParsedTurn {
      const p = parseSqlReply(raw, { truncated })
      if (!p.ok) return { ok: false, message: t(PARSE_ERR[p.reason === 'too-long' ? 'truncated' : p.reason]) }
      const v = p.value
      if (v.kind === 'question') return { ok: true, reply: [{ kind: 'text', text: v.message }], payload: { kind: 'question' } }
      return { ok: true, reply: [{ kind: 'text', text: v.message ?? t('drawer.sql.proposed') }], sqlAfter: v.sql, payload: { kind: 'sql', sql: v.sql } }
    },
  }
  const r = await session.send(text, ctx)
  const payload = r?.payload as { kind: 'sql'; sql: string } | { kind: 'question' } | undefined
  if (payload?.kind === 'sql') {
    // only the AI's SQL is formatted; a failed/unavailable formatter silently keeps the raw SQL
    const f = await formatAiSql(payload.sql, isLocal.value ? 'sqlite' : conn.value?.dialect ?? '').catch(() => null)
    if (!alive || turn !== turnSeq) return
    const sql = f?.ok ? f.sql : payload.sql
    if ((editor?.getDoc() ?? draft.value) === current) setDraft(sql)
    else pending.value = sql
  }
}

function onClear() {
  pending.value = null
  void session.clear()
}

async function onTrial() {
  if (trialReason.value || trialBusy.value) return
  trialBusy.value = true
  const seq = ++trialSeq
  try {
    const r = await trialRun({ bridge: bridge!, connections: connections!, store: store!, engine }, blockId, draft.value)
    if (seq === trialSeq) trial.value = r
  } finally {
    trialBusy.value = false
  }
}

async function apply(mode: 'replace' | 'insert-new'): Promise<boolean> {
  if (applying.value || session.busy.value || !block.value || applyError.value) return false
  if (mode === 'replace' && replaceReason.value) return false
  applying.value = true
  try {
    await applySqlSuggestion(
      { bridge: bridge!, connections: connections!, store: store!, engine, runBlocked: () => runningAll.value || !canRun.value },
      mode, blockId, editor?.getDoc() ?? draft.value,
    )
  } catch (e) {
    if (e instanceof Error && e.message === 'anchor-missing') { applyError.value = t('drawer.sql.deleted'); return false }
    throw e
  } finally {
    applying.value = false
  }
  emit('close')
  return true
}

// Dirty = draft differs from the block. An unconfirmed AI proposal is either already in the draft
// (then it counts) or held in `pending` (not in the draft, so it never makes the drawer dirty by itself).
function onCloseRequest() {
  if (askClose.value) return
  if (dirty.value) askClose.value = true
  else emit('close')
}
// Write buttons of the close dialog follow the same availability as the footer: busy/applying, a missing
// block, a previous write failure, and (update only) the replace reason. If a write is unavailable the dialog
// stays open and says why. After an anchor-missing failure the dialog is closed and the alert is shown in the drawer.
const busyReason = computed(() => (busy.value ? t('drawer.sql.busy') : ''))
const updateReason = computed(() => busyReason.value || applyError.value || replaceReason.value)
const insertReason = computed(() => busyReason.value || applyError.value || (!block.value ? t('drawer.sql.deleted') : ''))
async function onCloseChoose(id: string) {
  if (id === 'update' || id === 'insertNew') {
    if (id === 'update' ? updateReason.value : insertReason.value) return
    askClose.value = false
    await apply(id === 'update' ? 'replace' : 'insert-new')
  } else if (id === 'skip') { askClose.value = false; emit('close') }
  else askClose.value = false
}
watch(dirty, (d) => { if (!d) askClose.value = false })
const closeButtons = computed(() => [
  { id: 'update', label: t('drawer.close.update'), variant: 'primary' as const, disabled: !!updateReason.value, describedby: `sd-close-why-u-${uid}` },
  { id: 'insertNew', label: t('drawer.close.insertNew'), disabled: !!insertReason.value, describedby: `sd-close-why-i-${uid}` },
  { id: 'skip', label: t('drawer.close.skip') },
  { id: 'cancel', label: t('drawer.close.cancel') },
])
</script>

<template>
  <AiDrawer
    :title="t('drawer.sql.title')" :confirm-label="t('drawer.sql.replace')" :dirty="dirty" :busy="busy" close-request @close-request="onCloseRequest"
    :confirm-disabled-reason="applyError || replaceReason || undefined" @close="emit('close')" @discard="emit('close')" @confirm="apply('replace')"
  >
    <template #left>
      <div class="sd" data-test="sql-drawer" :aria-busy="applying ? 'true' : undefined">
        <label :for="`sd-draft-${uid}`" class="lbl">{{ t('drawer.sql.draft') }}</label>
        <div :id="`sd-draft-${uid}`" ref="host" class="editor" data-test="sql-draft" role="group" :aria-label="t('drawer.sql.draft')" />
        <p v-if="applyError" class="err" data-test="sql-apply-error" role="alert">{{ applyError }}</p>
        <div v-if="pending !== null" class="pend" data-test="sql-pending" role="status">
          <span>{{ t('drawer.sql.pending') }}</span>
          <button type="button" class="btn" data-test="sql-pending-apply" @click="setDraft(pending!); pending = null">{{ t('drawer.sql.pendingApply') }}</button>
          <button type="button" class="btn" data-test="sql-pending-dismiss" @click="pending = null">{{ t('drawer.sql.pendingDismiss') }}</button>
        </div>
        <div class="row">
          <button type="button" class="btn" data-test="sql-trial" :disabled="!!trialReason || trialBusy || !block" :aria-describedby="trialReason ? `sd-trial-why-${uid}` : undefined" @click="onTrial">{{ t('drawer.sql.trial') }}</button>
          <span v-if="trialReason" :id="`sd-trial-why-${uid}`" class="why" data-test="sql-trial-reason">{{ trialReason }}</span>
        </div>
        <p v-if="!analysis.readOnly && draft.trim()" class="warn" data-test="ai-not-readonly" role="note">{{ t('drawer.sql.notReadOnly') }}</p>
        <div v-if="trial" class="trial" data-test="sql-trial-result" role="region" :aria-label="t('drawer.sql.trialTitle')">
          <p class="lbl">{{ t('drawer.sql.trialTitle') }}</p>
          <p v-if="!trial.ok" class="err" role="alert">{{ trial.message || t('drawer.trial.failed') }}</p>
          <template v-else>
            <div class="scroll">
              <table>
                <thead><tr><th v-for="(c, i) in trial.columns" :key="i" scope="col">{{ c }}</th></tr></thead>
                <tbody><tr v-for="(r, i) in trial.rows" :key="i"><td v-for="(v, j) in r" :key="j">{{ v === null || v === undefined ? '' : String(v) }}</td></tr></tbody>
              </table>
            </div>
            <p class="lbl">{{ trial.truncated ? t('drawer.sql.trialTrunc', { n: trial.rows.length }) : t('drawer.sql.trialRows', { n: trial.rows.length }) }}</p>
          </template>
        </div>
        <button type="button" class="btn" data-test="sql-diff-toggle" :aria-expanded="showDiff ? 'true' : 'false'" :aria-controls="`sd-diff-${uid}`" @click="showDiff = !showDiff">{{ showDiff ? t('drawer.sql.hideDiff') : t('drawer.sql.showDiff') }}</button>
        <div v-if="showDiff" :id="`sd-diff-${uid}`" class="sd" data-test="diff-view">
        <fieldset class="cmp">
          <legend class="lbl">{{ t('drawer.sql.compare') }}</legend>
          <label><input v-model="cmp" type="radio" :name="`sd-cmp-${uid}`" value="current" data-test="sql-cmp-current"> {{ t('drawer.sql.cmpCurrent') }}</label>
          <label><input v-model="cmp" type="radio" :name="`sd-cmp-${uid}`" value="baseline" data-test="sql-cmp-baseline"> {{ t('drawer.sql.cmpBaseline') }}</label>
        </fieldset>
        <DiffView :before="diffBase" :after="draft" />
        </div>
      </div>
    </template>
    <template #chat>
      <ChatPane
        :messages="session.messages.value" :busy="session.busy.value" :progress="session.progress.value" :error="session.error.value"
        :raw-output="session.rawOutput.value" :notices="chatNotices" :placeholder="t('drawer.sql.placeholder')"
        @send="onSend" @cancel="session.cancel()" @clear="onClear"
      />
    </template>
    <template #footer-extra>
      <button type="button" class="btn" data-test="sql-insert-new" :disabled="busy || !block || !!applyError" @click="apply('insert-new')">{{ t('drawer.sql.insertNew') }}</button>
    </template>
    <ConfirmDialog :open="askClose" :title="t('drawer.close.title')" :message="t('drawer.close.msg')" initial-focus="cancel" :buttons="closeButtons" @choose="onCloseChoose">
      <p v-if="updateReason" :id="`sd-close-why-u-${uid}`" class="why" data-test="close-reason">{{ t('drawer.close.update') }}: {{ updateReason }}</p>
      <p v-if="insertReason" :id="`sd-close-why-i-${uid}`" class="why" data-test="close-reason-insert">{{ t('drawer.close.insertNew') }}: {{ insertReason }}</p>
    </ConfirmDialog>
  </AiDrawer>
</template>

<style scoped>
.sd { display: flex; flex-direction: column; gap: 8px; }
.lbl { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
.editor { border: 1px solid var(--color-border); border-radius: 4px; min-height: 160px; background: var(--color-background); color: var(--color-foreground); }
.row { display: flex; gap: 8px; align-items: center; }
.pend { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 8px; font-size: 12px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-muted); }
.why { font-size: 12px; color: var(--color-muted-foreground); }
.warn { margin: 0; font-size: 12px; color: var(--color-warning); }
.err { margin: 0; font-size: 12px; color: var(--color-destructive); }
.btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.cmp { display: flex; gap: 12px; border: 0; padding: 0; margin: 0; font-size: 12px; }
.trial .scroll { max-height: 220px; overflow: auto; border: 1px solid var(--color-border); border-radius: 4px; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
th, td { padding: 2px 8px; border-bottom: 1px solid var(--color-border); text-align: left; user-select: text; }
th { background: var(--color-muted); position: sticky; top: 0; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
