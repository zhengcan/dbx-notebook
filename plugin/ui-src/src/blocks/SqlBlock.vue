<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ResultTable from './ResultTable.vue'
import CellDetail from './CellDetail.vue'
import CatalogPicker from './CatalogPicker.vue'
import { useCatalogOptions } from './useCatalogOptions'
import { createCatalogCache, dialectHasSchemas } from '../run/catalog'
import { createEngineClient } from '../run/engineClient'
import { interpretGate } from '../ai/interpretGate'
import { useAiRequest } from '../ai/useAiRequest'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, CatalogKey, DrawerKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey, HistoryActionsKey } from '../injection'
import { runSqlBlock } from '../run/runSqlBlock'
import { groupNames } from '../connections/groups'
import { missingConnections } from '../connections/missing'
import { resolveBlockConnection, effectiveCatalog } from '../run/resolveConnection'
import { createSqlEditor, dialectForDbType, type SqlEditorHandle, type SqlEditorOpts } from '../editor/sqlEditor'
import type { ConnectionsStore } from '../connections/hostConnections'
import type { HostBridge } from '../host/bridge'
import type { useNotebookStore } from '../state/notebookStore'
import { t } from '../i18n'
import { DepError, isResultsBlock, resultNameOf, upstreamOf } from '../run/deps'
import { isSqliteKeyword } from '../run/sqliteKeywords'
import { dateComparisonHint } from '../run/hints'
import { splitDbxBoilerplate, isMissingObjectError } from '../run/errorHints'
import { useComposingDraft } from '../ui/composing'

type Factory = (parent: HTMLElement, opts: SqlEditorOpts) => SqlEditorHandle
const props = withDefaults(defineProps<{ blockId: string; editorFactory?: Factory }>(), { editorFactory: createSqlEditor })

function need<T>(key: symbol, name: string): T {
  const v = inject<T | undefined>(key, undefined)
  if (v === undefined) throw new Error(`SqlBlock: missing provided ${name}`)
  return v
}
const store = need<NonNullable<ReturnType<typeof inject<ReturnType<typeof useNotebookStore>>>>>(StoreKey as symbol, 'StoreKey')
const connections = need<ConnectionsStore>(ConnectionsKey as symbol, 'ConnectionsKey')
const bridge = need<HostBridge>(BridgeKey as symbol, 'BridgeKey')

const aiClient = inject(AiClientKey, null)
const aiSettings = inject(AiSettingsKey, null)
const aiShown = computed(() => !!aiClient && !!aiSettings && bridge.capabilities().aiCompletion === true)
const aiBusy = aiClient ? useAiRequest(aiClient).busy : ref(false)
const drawer = inject(DrawerKey, null)
const aiDisabledReason = computed(() => (aiBusy.value ? t('ai.askBusy') : drawer?.current.value ? t('ai.askDrawerOpen') : undefined))
function openAskAi() { if (!aiDisabledReason.value) drawer?.open({ purpose: 'sql', blockId: props.blockId }) }
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
const interpretGateNow = computed(() => interpretGate({ caps: bridge.capabilities(), send: sendOpts.value, run: store.runs.get(props.blockId), busy: aiBusy.value }))
const interpretReason = computed(() => (interpretGateNow.value.enabled ? (drawer?.current.value ? t('ai.askDrawerOpen') : undefined) : t(`ai.interpret.gate.${interpretGateNow.value.reason}`)))
function openInterpret() { if (!interpretReason.value) drawer?.open({ purpose: 'interpret', blockId: props.blockId }) }
onMounted(() => { void refreshSend() })

const actions = inject(HistoryActionsKey, null)
const catalog = inject(CatalogKey, null) ?? createCatalogCache(bridge)
const engine = inject(EngineKey, null) ?? createEngineClient(bridge)
const canRun = inject(CanRunKey, computed(() => true))
const runningAll = inject(RunningAllKey, ref(false))
const RESULT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const block = computed(() => store.nb.value.blocks.find((b) => b.id === props.blockId))
const meta = computed(() => (block.value?.metadata ?? {}) as Record<string, unknown>)
const run = computed(() => store.runs.get(props.blockId))
watch(() => run.value?.result, () => { void refreshSend() })
const stale = computed(() => store.isStale(props.blockId))
const staleTitle = computed(() => store.staleReasons(props.blockId).map((r) => t(`stale.${r}` as 'stale.sql')).join(t('stale.sep')))
const resolved = computed(() => resolveBlockConnection(connections, store.nb.value, block.value))
const unmatched = computed(() => !!resolved.value.name && resolved.value.result?.status !== 'ok')
const connValue = computed(() => (typeof meta.value.connection === 'string' ? meta.value.connection : ''))
const nameGroups = computed(() => groupNames(connections.list()))
const connGrouped = computed(() => connections.state.value === 'ready' || (connections.state.value === 'loading' && connections.loaded.value))
const connNames = computed(() => [...new Set(connections.list().map((c) => c.name))])
const missingName = computed(() => (isLocal.value ? undefined : missingConnections(connections, store.nb.value).blocks[props.blockId]))
const connWarn = computed(() => (connValue.value && !connNames.value.includes(connValue.value) ? connValue.value : ''))
const runReason = computed(() => (missingName.value ? t('run.unmatched', { name: missingName.value }) : ''))
watch(() => block.value?.content, (c) => {
  if (!editor || (c ?? '') === editor.getDoc()) return
  editor.setDoc(c ?? '')
})
watch(() => meta.value.resultName, (v) => {
  const n = typeof v === 'string' ? v : ''
  if (n !== nameDraft.value && !invalidName.value) nameDraft.value = n
  else if (n !== '' && n !== nameDraft.value) { nameDraft.value = n; invalidName.value = false }
})
const okConn = computed(() => (resolved.value.result?.status === 'ok' ? resolved.value.result.conn : undefined))
const eff = computed(() => effectiveCatalog(block.value, store.nb.value, okConn.value))
const inherited = computed(() => effectiveCatalog(block.value ? { ...block.value, metadata: {} } : undefined, store.nb.value, okConn.value))
const hasSchemas = computed(() => (okConn.value ? dialectHasSchemas(okConn.value.dialect) !== false : true))
const metaStr = (k: string) => (typeof meta.value[k] === 'string' && meta.value[k] !== '' ? (meta.value[k] as string) : undefined)
const opts = useCatalogOptions(catalog, () => okConn.value, () => eff.value.database)
const loaded = { db: false, sc: false }
function openDb() { loaded.db = true; void opts.loadDatabases() }
function openSc() { loaded.sc = true; void opts.loadSchemas() }
function inheritPh(v: string | undefined) { return v ? t('cat.inherit', { v }) : t('cat.inheritNone') }
function setCat(key: 'database' | 'schema', v: string | undefined) {
  if (v === undefined) store.removeMetaKey(props.blockId, key)
  else store.updateMeta(props.blockId, { [key]: v })
}
function onRefresh() { void opts.refresh({ db: true, sc: hasSchemas.value }) }
watch(() => okConn.value?.id, (id, old) => {
  if (old !== undefined) catalog.clear(old)
  opts.reset()
  loaded.db = loaded.sc = false
})
watch(() => eff.value.database, () => { opts.sc.options = []; if (loaded.sc) void opts.loadSchemas() })
watch(
  () => { const r = resolved.value.result; return r?.status === 'ok' ? `${r.conn.id}|${r.conn.dialect}` : `x:${resolved.value.name ?? ''}` },
  () => { editor?.clearCache(); editor?.setDialect(currentDialect()) },
)
const detail = ref<{ column: string; value: unknown } | null>(null)
watch(() => [run.value, run.value?.status, run.value?.result], () => { detail.value = null })
const running = computed(() => run.value?.status === 'running')

const isLocal = computed(() => !!block.value && isResultsBlock(block.value))
const dateHint = computed(() => isLocal.value && dateComparisonHint(block.value?.content ?? '', store.inputVars().map((v) => ({ name: v.name, inputType: v.inputType }))))
function onType(e: Event) {
  if ((e.target as HTMLSelectElement).value === 'results') store.updateMeta(props.blockId, { source: 'results' })
  else store.removeMetaKey(props.blockId, 'source')
}
const upstream = computed(() => {
  const b = block.value
  if (!b || !isResultsBlock(b)) return { chips: [] as { id: string; name: string; warn: boolean; title: string }[], err: '' }
  try {
    const chips = upstreamOf(b, store.nb.value.blocks).map((u) => {
      const r = store.runs.get(u.id)
      const missing = !r || r.status !== 'ok'
      const st = !missing && store.isStale(u.id)
      const title = missing ? t('blk.refMissing') : st ? store.staleReasons(u.id).map((x) => t(`stale.${x}` as 'stale.sql')).join(t('stale.sep')) : ''
      return { id: u.id, name: resultNameOf(u)!, warn: missing || st, title }
    })
    return { chips, err: '' }
  } catch (e) {
    if (!(e instanceof DepError)) throw e
    const key = e.code === 'SELF' ? 'run.depSelf' : e.code === 'FORWARD' ? 'run.depForward' : 'run.depDuplicate'
    return { chips: [], err: t(key, { name: e.name }) }
  }
})
function gotoBlock(id: string) {
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-block-id]')).find((e) => e.getAttribute('data-block-id') === id)
  if (!el) return
  el.scrollIntoView?.({ block: 'center' })
  const target = el.querySelector<HTMLElement>('[data-editor] .cm-content') ?? el.querySelector<HTMLElement>('[data-editor]') ?? el.querySelector<HTMLElement>('input, select, textarea, button')
  target?.focus()
}
const dupOf = ref('')
const storedName = computed(() => (typeof meta.value.resultName === 'string' ? meta.value.resultName : ''))
const quoteNote = computed(() => (storedName.value && isSqliteKeyword(storedName.value) ? t('blk.nameQuote', { q: `"${storedName.value}"` }) : ''))
function otherNameClash(v: string): string {
  const k = v.toLowerCase()
  for (const b of store.nb.value.blocks) {
    if (b.id === props.blockId) continue
    const n = resultNameOf(b)
    if (n !== undefined && n.toLowerCase() === k) return n
  }
  return ''
}
const invalidName = ref(false)
const sqlitePrefix = ref(false)
const nameDraft = ref(typeof meta.value.resultName === 'string' ? meta.value.resultName : '')
const cmp = useComposingDraft()
function onName(e: Event) {
  if (cmp.composing.value || (e as InputEvent).isComposing) { cmp.track(e); return }
  const v = (e.target as HTMLInputElement).value
  nameDraft.value = v
  dupOf.value = ''
  sqlitePrefix.value = /^sqlite_/i.test(v)
  if (sqlitePrefix.value) { invalidName.value = true; return }
  if (v === '') {
    invalidName.value = false
    store.removeMetaKey(props.blockId, 'resultName', { coalesce: 'resultName' })
  } else if (RESULT_NAME_RE.test(v)) {
    invalidName.value = false
    const clash = otherNameClash(v)
    if (clash) { dupOf.value = clash; return }
    store.updateMeta(props.blockId, { resultName: v }, { coalesce: 'resultName' })
  } else {
    invalidName.value = true
  }
}

function onConn(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v && connGrouped.value && nameGroups.value.disconnected.includes(v)) return
  if (v) store.updateMeta(props.blockId, { connection: v })
  else store.removeMetaKey(props.blockId, 'connection')
}

function currentDialect(): string {
  if (isLocal.value) return 'SQLite'
  const r = resolved.value.result
  if (r?.status === 'ok') return dialectForDbType(r.conn.dialect)
  const last = run.value?.result?.dbType
  return dialectForDbType(last ?? '')
}

async function doRun() {
  if (running.value || !canRun.value || runningAll.value) return
  await runSqlBlock({ bridge, connections, store, engine }, props.blockId)
  editor?.setDialect(currentDialect())
}

const earlierNamed = computed(() => {
  const out: { name: string; id: string }[] = []
  for (const b of store.nb.value.blocks) {
    if (b.id === props.blockId) break
    if (b.type !== 'sql') continue
    const n = resultNameOf(b)
    if (n !== undefined) out.push({ name: n, id: b.id })
  }
  return out
})
function localTables(): Promise<string[]> { return Promise.resolve(earlierNamed.value.map((e) => e.name)) }
function localColumns(table: string): Promise<string[]> {
  const k = table.toLowerCase()
  const hit = earlierNamed.value.find((e) => e.name.toLowerCase() === k)
  const r = hit ? store.runs.get(hit.id) : undefined
  return Promise.resolve(r?.status === 'ok' && r.result ? r.result.columns.map((c) => c.name) : [])
}
watch(
  () => `${isLocal.value}|${isLocal.value ? earlierNamed.value.map((e) => `${e.name}:${store.runs.get(e.id)?.executedAt ?? ''}:${store.runs.get(e.id)?.status ?? ''}`).join(',') : ''}`,
  (_n, old) => { if (old === undefined) return; editor?.clearCache(); editor?.setDialect(currentDialect()) },
)

async function columnsFor(table: string): Promise<string[]> {
  if (isLocal.value) return localColumns(table)
  if (!bridge.capabilities().schemaMetadataApi) return []
  const r = resolved.value.result
  if (r?.status !== 'ok') return []
  const parts = table.split('.')
  const name = parts.pop()!
  const schema = parts.length ? parts[parts.length - 1] : undefined
  const md = await bridge.getTableMetadata({
    connectionId: r.conn.id,
    database: eff.value.database,
    schema: schema ?? eff.value.schema,
    table: name,
  })
  return md.columns.map((c) => c.name)
}

const host = ref<HTMLElement | null>(null)
let editor: SqlEditorHandle | null = null
let offEnv: (() => void) | null = null

function applyTheme() {
  const th = bridge.theme()
  editor?.setFont(th.editor?.fontFamily, th.editor?.fontSize)
  editor?.setDark(th.appearance === 'dark')
}

onMounted(() => {
  const th = bridge.theme()
  editor = props.editorFactory(host.value!, {
    doc: block.value?.content ?? '',
    dialect: currentDialect(),
    fontFamily: th.editor?.fontFamily,
    fontSize: th.editor?.fontSize,
    onChange: (d) => store.updateContent(props.blockId, d, { coalesce: true }),
    onRun: () => { void doRun() },
    onUndo: () => { if (actions) actions.undo(); else store.undo(); return true },
    onRedo: () => { if (actions) actions.redo(); else store.redo(); return true },
    columnsFor,
    completionTables: () => (isLocal.value ? localTables() : Promise.resolve([])),
  })
  editor.setDark(th.appearance === 'dark')
  offEnv = bridge.onEnv(applyTheme)
})

onBeforeUnmount(() => {
  offEnv?.()
  offEnv = null
  editor?.destroy()
  editor = null
})

const isParamErr = computed(() => run.value?.error?.kind === 'param')
const errParts = computed(() => isParamErr.value ? { main: run.value?.error?.message ?? '' } as { main: string; redacted?: string } : splitDbxBoilerplate(run.value?.error?.message ?? ''))
const gotoTarget = computed(() => {
  const v = run.value?.error?.variable
  const c = run.value?.error?.paramCode
  if (!isParamErr.value || !v || !c || !['UNSET', 'INVALID', 'DUPLICATE'].includes(c)) return undefined
  return store.nb.value.blocks.find((b) => b.type === 'input' && b.metadata?.variable === v)?.id
})
async function onVisualize() {
  const id = store.visualizeResult(props.blockId)
  if (!id) return
  await nextTick()
  gotoBlock(id)
}
function gotoInput() {
  const id = gotoTarget.value
  if (!id) return
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-block-id]')).find((e) => e.getAttribute('data-block-id') === id)
  if (!el) return
  el.scrollIntoView?.({ block: 'center' })
  el.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
}
const errHint = computed(() => {
  if (isParamErr.value || !isMissingObjectError(run.value?.error?.message ?? '')) return ''
  const unset = t('err.unset')
  const parts = [eff.value.database ?? unset]
  if (hasSchemas.value) parts.push(eff.value.schema ?? unset)
  return t('err.hint', { where: parts.join('/') })
})
const statusKind = computed(() => {
  const s = run.value?.status ?? 'idle'
  if (s === 'ok' || s === 'error') return stale.value ? 'stale' : s
  return s
})
const statusText = computed(() => {
  const k = statusKind.value
  if (k === 'ok') return t('sql.ok', { n: run.value?.result?.rows.length ?? 0, ms: run.value?.result?.elapsedMs ?? 0 })
  return t(`sql.${k}` as 'sql.idle')
})
</script>

<template>
  <div class="sql-block">
    <div class="header">
      <select data-test="block-type" :value="isLocal ? 'results' : 'database'" :aria-label="t('blk.type')" @change="onType">
        <option value="database">{{ t('blk.typeDb') }}</option>
        <option value="results">{{ t('blk.typeResults') }}</option>
      </select>
      <select v-if="!isLocal" data-test="conn" :value="connValue" @change="onConn">
        <option value="">{{ t('sql.defaultConn') }}{{ store.nb.value.settings.defaultConnection ? ` ${store.nb.value.settings.defaultConnection}` : '' }}</option>
        <template v-if="connGrouped">
          <optgroup v-if="nameGroups.connected.length" :label="t('conn.groupConnected')">
            <option v-for="n in nameGroups.connected" :key="n" :value="n">{{ n }}</option>
          </optgroup>
          <optgroup v-if="nameGroups.disconnected.length" :label="t('conn.groupDisconnected')">
            <option
              v-for="n in nameGroups.disconnected" :key="n" :value="n" disabled class="grey"
              :title="`${n} · ${t('conn.notConnected')}`" :aria-label="`${n} · ${t('conn.notConnected')}`"
            >{{ n }} · {{ t('conn.notConnected') }}</option>
          </optgroup>
        </template>
        <template v-else>
          <option v-for="n in connNames" :key="n" :value="n">{{ n }}</option>
        </template>
        <optgroup v-if="connWarn && missingName" :label="t('conn.groupMissing')">
          <option
            :value="connWarn" disabled class="grey" data-test="conn-missing-option"
            :title="t('conn.missing', { name: connWarn })"
          >{{ t('conn.warnOption', { name: connWarn }) }}</option>
        </optgroup>
        <option v-else-if="connWarn" :value="connWarn">{{ connWarn }}</option>
      </select>
      <span v-if="missingName" class="badge" data-test="block-conn-missing" role="status">⚠ {{ t('conn.missing', { name: missingName }) }}</span>
      <span v-else-if="unmatched && !isLocal" class="badge" data-test="unmatched">⚠ {{ t('sql.unmatchedBadge') }}</span>
      <CatalogPicker
        v-if="!isLocal"
        kind="database" :model-value="metaStr('database')" :options="opts.db.options" :loading="opts.db.loading"
        :error="opts.db.error" :placeholder="inheritPh(inherited.database)"
        @update:model-value="setCat('database', $event)" @open="openDb"
      />
      <CatalogPicker
        v-if="hasSchemas && !isLocal"
        kind="schema" :model-value="metaStr('schema')" :options="opts.sc.options" :loading="opts.sc.loading"
        :error="opts.sc.error" :placeholder="inheritPh(inherited.schema)"
        @update:model-value="setCat('schema', $event)" @open="openSc"
      />
      <button v-if="!isLocal" type="button" data-test="cat-refresh" :title="t('cat.refresh')" :disabled="!okConn" @click="onRefresh">↻</button>
      <input
        data-test="result-name"
        :class="{ invalid: invalidName }"
        :value="cmp.bound(nameDraft)"
        :placeholder="t('sql.resultName')"
        :title="invalidName ? t('sql.resultNameInvalid') : ''"
        @input="onName" @compositionstart="cmp.start($event)" @compositionend="cmp.end(); onName($event)"
      />
      <button data-test="run" :disabled="running || !canRun || runningAll || !!runReason" :title="runReason || undefined" @click="doRun">▶ {{ t('sql.run') }}</button>
      <button
        v-if="aiShown && drawer" type="button" data-test="ask-ai" :aria-label="t('ai.askAria')"
        :disabled="!!aiDisabledReason" :title="aiDisabledReason" @click="openAskAi"
      >✨ {{ t('ai.ask') }}</button>
      <button
        v-if="aiShown && run?.status === 'ok' && run.result" type="button" data-test="ai-interpret" :aria-label="t('ai.interpret.aria')" aria-haspopup="dialog"
        :disabled="!!interpretReason" :title="interpretReason" :aria-describedby="interpretReason ? `ai-interpret-reason-${blockId}` : undefined" @click="openInterpret"
      >📊 {{ t('ai.interpret') }}</button>
      <span v-if="aiShown && interpretReason && run?.status === 'ok' && run.result" :id="`ai-interpret-reason-${blockId}`" class="sr-only">{{ interpretReason }}</span>
      <span class="chip" :class="statusKind" data-test="status" :title="statusKind === 'stale' ? staleTitle : undefined" :aria-label="statusKind === 'stale' ? staleTitle : undefined">{{ statusText }}</span>
    </div>
    <div v-if="sqlitePrefix" class="note warn" data-test="name-sqlite">{{ t('blk.nameSqlite') }}</div>
    <div v-if="dupOf" class="note warn" data-test="name-dup">{{ t('blk.nameDup', { name: dupOf }) }}</div>
    <div v-if="quoteNote" class="note" data-test="name-quote">{{ quoteNote }}</div>
    <div v-if="store.visualizeNotice.value?.blockId === blockId" class="note" data-test="visualize-notice">{{ t('blk.vizNamed', { name: store.visualizeNotice.value.name }) }}</div>
    <div v-if="isLocal" class="refs" data-test="ref-results">
      <span class="refs-label">{{ t('blk.refs') }}</span>
      <button
        v-for="c in upstream.chips" :key="c.id" type="button" class="ref-chip" :data-warn="c.warn ? 'true' : undefined"
        :title="c.title || undefined" data-test="ref-chip" @click="gotoBlock(c.id)"
      ><span v-if="c.warn" aria-hidden="true">⚠ </span>{{ c.name }}</button>
      <span v-if="upstream.err" class="dep-error" data-test="dep-error" role="alert">{{ upstream.err }}</span>
    </div>
    <div ref="host" class="editor" data-editor />
    <div v-if="dateHint" class="note" data-test="date-hint">{{ t('hint.dateCmp') }}</div>
    <div v-if="run?.status === 'error' && run.error" class="error" data-test="error">
      <div class="err-main">{{ errParts.main }}</div>
      <button v-if="gotoTarget" type="button" class="err-goto" data-test="goto-input" @click="gotoInput">{{ t('err.gotoInput') }}</button>
      <div v-if="errHint" class="err-hint" data-test="error-hint">{{ errHint }}</div>
      <details v-if="errParts.redacted" class="err-redacted" data-test="error-redacted">
        <summary>{{ t('err.redacted') }}</summary>
        {{ errParts.redacted }}
      </details>
    </div>
    <ResultTable v-else-if="run?.status === 'ok' && run.result" :result="run.result" :transposed="store.transposed.get(blockId) === true" @update:transposed="store.setTransposed(blockId, $event)" :partial="isLocal && store.isPartial(blockId)" :saved-at="run.fromFile ? run.executedAt : undefined" @visualize="onVisualize" @cell-detail="detail = { column: $event.column, value: $event.value }" />
    <CellDetail :open="detail !== null" :column="detail?.column ?? ''" :value="detail?.value" @close="detail = null" />
  </div>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 4px 0; }
.invalid { border-color: var(--color-destructive, #d33); outline: 1px solid var(--color-destructive, #d33); }
.grey { color: var(--color-muted-foreground, #888); }
.badge { color: var(--color-warning, #b80); font-size: 12px; }
.chip { font-size: 12px; color: var(--color-muted-foreground, #888); margin-left: auto; }
.chip.ok { color: var(--color-success, #2a7); }
.chip.error { color: var(--color-destructive, #d33); }
.chip.stale { color: var(--color-warning, #b80); }
.note { font-size: 12px; color: var(--color-muted-foreground, #888); padding: 0 0 4px; }
.note.warn { color: var(--color-warning, #b80); }
.refs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 0 4px; font-size: 12px; }
.refs-label { color: var(--color-muted-foreground, #888); }
.ref-chip { font-size: 12px; padding: 1px 8px; border-radius: 10px; cursor: pointer; background: var(--color-muted, #eee); color: var(--color-foreground, #222); border: 1px solid var(--color-border, #ddd); }
.ref-chip:hover, .ref-chip:focus-visible { background: var(--color-accent, #e6e6e6); color: var(--color-accent-foreground, #222); }
.ref-chip[data-warn='true'] { color: var(--color-warning, #b80); border-color: var(--color-warning, #b80); }
.dep-error { color: var(--color-destructive, #d33); }
.editor { border: 1px solid var(--color-border, #ddd); min-height: 40px; }
.error { color: var(--color-destructive, #d33); padding: 6px; white-space: pre-wrap; }
.err-main { user-select: text; }
.err-goto { margin-top: 4px; color: var(--color-primary, #36c); background: none; border: 1px solid var(--color-border, #ddd); cursor: pointer; }
.err-hint { margin-top: 4px; color: var(--color-warning, #b80); user-select: text; }
.err-redacted { margin-top: 4px; font-size: 12px; color: var(--color-muted-foreground, #888); user-select: text; }
</style>
