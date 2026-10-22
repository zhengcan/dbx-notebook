import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import type { AiClient } from './aiClient'
import type { AiSendOptions, AiSettings } from './aiSettings'
import type { ChatStore } from './chatStore'
import type { ChatMessage, ChatPart, ChatRecord } from './chatTypes'
import type { DrawerSpec } from './drawerState'
import { buildChatPrompt, MAX_USER_CHARS, type BuiltChatPrompt, type ChatPromptInput } from './promptChat'
import { parseNeed, type NeedRequest } from './parseNeed'
import type { CatalogList } from './catalog'
import type { TableSchema } from './context'
import { errorMessage, useAiRequest } from './useAiRequest'
import type { AiTask } from './aiClient'
import type { useNotebookStore } from '../state/notebookStore'

type Store = ReturnType<typeof useNotebookStore>
type AiSettingsLike = Pick<AiSettings, 'sendOptions' | 'effectiveModel'>

export interface TurnContext {
  buildInput(send: AiSendOptions, history: ChatMessage[], userText: string, alive?: () => boolean, retrieved?: Retrieved): ChatPromptInput | Promise<ChatPromptInput>
  /** Fulfils NEED_ requests of a reply (table list / table structures); absent for drawers without catalog access. */
  catalog?: { fetch(need: NeedRequest, send: AiSendOptions): Promise<Retrieved> }
  task: AiTask
  parse(text: string, truncated: boolean): ParsedTurn
  /** Called with the built prompt of the turn right before it is sent (e.g. to learn how many rows were dropped). */
  onBuilt?(built: BuiltChatPrompt): void
}
export const MAX_AUTO_ROUNDS = 3
export interface Retrieved { lists: CatalogList[]; schemas: TableSchema[]; notes: string[]; summary: { list?: boolean; tables?: string[] }; answerNow?: boolean; schemaNames?: string[]; emptyScopes?: string[] }
export const narrow = (a: AiSendOptions, b: AiSendOptions): AiSendOptions => ({ ...a, schema: a.schema && b.schema, sql: a.sql && b.sql, data: a.data && b.data })
export const emptyRetrieved = (): Retrieved => ({ lists: [], schemas: [], notes: [], summary: {} })
export type CatalogNotice = { kind: 'list' | 'tables' | 'empty'; names?: string[] }
const uniq = (a: string[]) => a.filter((x, i) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)
function mergeRetrieved(a: Retrieved, b: Retrieved): Retrieved {
  const lists = [...a.lists, ...b.lists.filter((l) => !a.lists.some((x) => x.scope === l.scope))]
  const schemas = [...a.schemas, ...b.schemas.filter((s) => !a.schemas.some((x) => x.name.toLowerCase() === s.name.toLowerCase()))]
  const tables = uniq([...(a.summary.tables ?? []), ...(b.summary.tables ?? [])])
  const summary: Retrieved['summary'] = {}
  if (a.summary.list || b.summary.list) summary.list = true
  if (tables.length) summary.tables = tables
  const schemaNames = uniq([...(a.schemaNames ?? []), ...(b.schemaNames ?? [])])
  const emptyScopes = uniq([...(a.emptyScopes ?? []), ...(b.emptyScopes ?? [])])
  return { lists, schemas, notes: uniq([...a.notes, ...b.notes]), summary, ...(schemaNames.length ? { schemaNames } : {}), ...(emptyScopes.length ? { emptyScopes } : {}), ...(a.answerNow || b.answerNow ? { answerNow: true } : {}) }
}

/** Thrown by buildInput when a gate closed between the pre-check and the turn: its message is shown to the user verbatim. */
export class GateClosedError extends Error {}
export type ParsedTurn = { ok: true; reply: ChatPart[]; sqlAfter?: string; markdownAfter?: string; chartAfter?: string; metricsAfter?: string; metricsSampled?: boolean; resultSig?: string; payload?: unknown } | { ok: false; message: string }

let seq = 0
const newId = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`

export function useChatSession(deps: { client: AiClient; aiSettings: AiSettingsLike; chat: ChatStore; store: Store; loadWaitMs?: number }, spec: DrawerSpec) {
  const { client, aiSettings, chat, store } = deps
  const loadWaitMs = deps.loadWaitMs ?? 3000
  // the interpret/chart chats of a block are separate conversations from its SQL chat
  const chatId = spec.purpose === 'sql' ? spec.blockId : `${spec.blockId}:${spec.purpose}`
  const req = useAiRequest(client)
  const messages = ref<ChatMessage[]>([])
  const ready = ref(false)
  const preparing = ref(false)
  const error = ref('')
  const notices = ref<CatalogNotice[]>([])
  const rawOutput = ref('')
  const baseline = ref<string | undefined>(undefined)
  const busy = computed(() => preparing.value || req.busy.value)
  const progress = computed(() => {
    if (preparing.value) return t('ai.waiting')
    const s = req.state.value
    return s.phase === 'running' ? (s.chars > 0 ? t('ai.progress', { n: s.chars }) : t('ai.waiting')) : ''
  })
  let gen = 0
  // a notebook load replaces the document under this block: cancel whatever is in flight or being prepared
  watch(() => store.generation.value, () => stop(), { flush: 'sync' })
  let disposed = false
  let owned = false

  const blockContent = () => store.nb.value.blocks.find((b) => b.id === spec.blockId)?.content
  const record = (): ChatRecord => {
    const r: ChatRecord = { v: 1, messages: messages.value.slice(), updated: Date.now() }
    if (baseline.value !== undefined) r.baseline = baseline.value
    return r
  }

  // the load has its own token: cancel/stop/send must not abort it (its result restores the cached chat)
  let loadTok = 0
  let loadAbandoned = false
  let loading: Promise<void> | null = null
  function load(): Promise<void> {
    const p = doLoad()
    loading = p
    return p
  }

  async function doLoad(): Promise<void> {
    const mine = ++loadTok
    const g = store.generation.value
    const rec = await chat.load(store.path.value, chatId)
    if (mine !== loadTok || loadAbandoned || disposed || g !== store.generation.value) return
    messages.value = rec.messages
    const content = blockContent()
    baseline.value = rec.baseline !== undefined && rec.baseline === content ? rec.baseline : content
    ready.value = true
  }

  // never write a chat whose cached history has not been loaded: it would overwrite the stored one
  function persist(path: string | null): void {
    if (ready.value) void chat.save(path, chatId, record())
  }

  async function send(text: string, ctx: TurnContext): Promise<{ payload?: unknown } | null> {
    const userText = text.trim().slice(0, MAX_USER_CHARS)
    if (!userText || busy.value || disposed) return null
    // wait (bounded) for the cached chat so this turn is not built on, and does not overwrite, an unloaded history
    if (!ready.value && loading) {
      const g0 = gen
      preparing.value = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        loading.then(() => false, () => false),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), loadWaitMs) }),
      ])
      clearTimeout(timer)
      if (gen !== g0 || disposed) return null
      preparing.value = false
      if (timedOut) loadAbandoned = true
    }
    const mine = ++gen
    const g = store.generation.value
    const path = store.path.value
    const alive = () => mine === gen && !disposed && g === store.generation.value
    error.value = ''
    rawOutput.value = ''
    req.reset()
    const history = messages.value.slice()
    messages.value = [...history, { id: newId(), role: 'user', parts: [{ kind: 'text', text: userText }], at: Date.now() }]
    if (baseline.value === undefined) baseline.value = blockContent()
    persist(path)
    preparing.value = true
    owned = true
    notices.value = []
    let retrieved: Retrieved = emptyRetrieved()
    let round = 0
    const used = { list: false, tables: [] as string[] }
    let sendOpts: AiSendOptions
    let startOpts: AiSendOptions
    let metricsData = false
    const asked = { tables: new Set<string>(), lists: new Set<string>() }
    try {
      sendOpts = await aiSettings.sendOptions()
      startOpts = sendOpts
      if (!alive()) return null
      // the big-number assistant is meaningless (and must not talk to the model) without the schema switch
      if (spec.purpose === 'bignumber' && !sendOpts.schema) {
        preparing.value = false
        error.value = t('ai.catalog.off')
        return null
      }
    } catch {
      if (!alive()) return null
      preparing.value = false
      error.value = errorMessage('failed', '')
      return null
    }
    for (;;) {
      let prompt: string
      let model: string | undefined
      try {
        const input = await ctx.buildInput(sendOpts, history, userText, alive, round > 0 ? retrieved : undefined)
        if (!alive()) return null
        // the options may have changed during any await above (catalog fetch, list query): re-read right before the prompt is built
        const fresh = narrow(startOpts, await aiSettings.sendOptions())
        if (!alive()) return null
        const inputOpts = input.send
        if (inputOpts.schema && !fresh.schema) {
          preparing.value = false
          notices.value = []
          error.value = t('ai.catalog.off')
          return null
        }
        sendOpts = fresh
        const built = buildChatPrompt({ ...input, send: narrow(inputOpts, fresh) })
        if (built.overLimit) {
          preparing.value = false
          error.value = errorMessage('too-long-request')
          return null
        }
        prompt = built.text
        if (built.usedCatalog.list) used.list = true
        used.tables = uniq([...used.tables, ...built.usedCatalog.tables])
        if (built.metricsData) metricsData = true
        ctx.onBuilt?.(built)
        model = aiSettings.effectiveModel()
      } catch (e) {
        if (!alive()) return null
        preparing.value = false
        error.value = e instanceof GateClosedError ? e.message : errorMessage('failed', '')
        return null
      }
      if (!alive()) return null
      const started = req.start({ task: ctx.task, prompt, model }, alive)
      preparing.value = false
      await started
      if (!alive()) return null
      const s = req.state.value
      if (s.phase !== 'done') notices.value = []
      if (s.phase === 'idle') { error.value = errorMessage('busy'); return null }
      if (s.phase === 'error') { error.value = s.message; return null }
      if (s.phase !== 'done') return null
      const stripped = parseNeed(s.result.text)
      // NEED_ lines are acted on only with the schema toggle on and a catalog-capable drawer; otherwise they are just hidden
      if (stripped.need && !s.result.truncated && sendOpts.schema && ctx.catalog && !retrieved.answerNow) {
        if (round >= MAX_AUTO_ROUNDS) {
          error.value = t('ai.catalog.limit')
          notices.value = []
          return null
        }
        round++
        const need: NeedRequest = {}
        if (stripped.need.list && !asked.lists.has(stripped.need.list.scope.toLowerCase())) need.list = stripped.need.list
        const fresh = (stripped.need.tables ?? []).filter((n) => !asked.tables.has(n.toLowerCase()))
        if (fresh.length) need.tables = fresh
        if (need.list) asked.lists.add(need.list.scope.toLowerCase())
        for (const n of fresh) asked.tables.add(n.toLowerCase())
        const fetcher = ctx.catalog
        preparing.value = true
        if (!need.list && !need.tables) {
          // everything asked for was already served or failed: one last round that asks the model to answer
          retrieved = { ...retrieved, notes: [...retrieved.notes, 'The requested catalog information was already provided or is unavailable; answer now without NEED_ lines.'], answerNow: true }
          continue
        }
        if (need.list) notices.value = [...notices.value, { kind: 'list' }]
        if (need.tables) notices.value = [...notices.value, { kind: 'tables', names: need.tables }]
        try {
          sendOpts = narrow(startOpts, await aiSettings.sendOptions())
          if (!alive()) return null
          if (!sendOpts.schema) {
            preparing.value = false
            notices.value = []
            error.value = t('ai.catalog.off')
            return null
          }
          const got = await fetcher.fetch(need, sendOpts)
          if (!alive()) return null
          retrieved = mergeRetrieved(retrieved, got)
          if (got.emptyScopes?.length) notices.value = [...notices.value.filter((n) => n.kind !== 'list'), { kind: 'empty', names: got.emptyScopes }]
        } catch {
          if (!alive()) return null
          preparing.value = false
          notices.value = []
          error.value = errorMessage('failed', '')
          return null
        }
        continue
      }
      const parsed = ctx.parse(stripped.rest, s.result.truncated)
      if (!parsed.ok) {
        error.value = parsed.message
        rawOutput.value = stripped.rest
        return null
      }
      const reply: ChatMessage = { id: newId(), role: 'assistant', parts: parsed.reply, at: Date.now() }
      if (parsed.sqlAfter !== undefined) reply.sqlAfter = parsed.sqlAfter
      if (parsed.markdownAfter !== undefined) reply.markdownAfter = parsed.markdownAfter
      if (parsed.chartAfter !== undefined) reply.chartAfter = parsed.chartAfter
      if (parsed.metricsAfter !== undefined) reply.metricsAfter = parsed.metricsAfter
      if (parsed.resultSig !== undefined) reply.resultSig = parsed.resultSig
      // Replies written from a prompt that carried catalog names are marked so filterHistory masks them when schema is off.
      // Limit: replies saved before this marker existed cannot be recognised and may still carry names.
      if (sendOpts.schema) {
        const tables = uniq([...used.tables, ...(retrieved.summary.tables ?? [])]).slice(0, 8)
        const c: NonNullable<ChatMessage['catalog']> = {}
        if (used.list || retrieved.summary.list) c.list = true
        if (tables.length) c.tables = tables
        if (c.list || c.tables) reply.catalog = c
      }
      if (spec.purpose === 'bignumber') {
        // derived from what this turn really sent: the parse callback can only add to it
        reply.metricsSampled = parsed.metricsSampled === true || metricsData
        if (sendOpts.schema) reply.metricsSchema = true
      }
      messages.value = [...messages.value, reply]
      notices.value = []
      persist(path)
      return parsed.payload === undefined ? {} : { payload: parsed.payload }
    }
  }

  function stop() {
    gen++
    preparing.value = false
    notices.value = []
    if (owned) req.cancel()
  }

  function cancel(): void {
    const was = busy.value
    stop()
    if (was) error.value = errorMessage('cancelled')
  }

  async function clear(): Promise<void> {
    stop()
    error.value = ''
    rawOutput.value = ''
    messages.value = []
    loadTok++
    ready.value = true
    baseline.value = blockContent()
    await chat.clear(store.path.value, chatId)
  }

  function dispose(): void {
    disposed = true
    stop()
  }

  return {
    messages, ready, busy, progress, error, rawOutput, baseline, notices,
    load, send, cancel, clear, dispose,
  }
}

/** Drops the cached chat of blocks deleted within one notebook generation (a notebook load is not a deletion). */
export function watchDeletedBlocks(store: Store, chat: ChatStore): void {
  let gen = store.generation.value
  let ids = new Set(store.nb.value.blocks.map((b) => b.id))
  watch(
    () => [store.generation.value, store.nb.value.blocks.map((b) => b.id).join('\u0000')] as const,
    () => {
      const next = new Set(store.nb.value.blocks.map((b) => b.id))
      if (store.generation.value === gen) for (const id of ids) if (!next.has(id)) { void chat.remove(store.path.value, id); void chat.remove(store.path.value, `${id}:interpret`); void chat.remove(store.path.value, `${id}:chart`) }
      gen = store.generation.value
      ids = next
    },
  )
}
