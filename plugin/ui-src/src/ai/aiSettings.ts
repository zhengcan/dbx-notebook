import { ref, type Ref } from 'vue'
import type { HostBridge } from '../host/bridge'
import type { AiClient, AiModel } from './aiClient'

const KEY = 'ai.settings.v1'

export interface AiSendOptions { schema: boolean; sql: boolean; data: boolean }
export const DEFAULT_AI_SEND: AiSendOptions = { schema: true, sql: true, data: true }

export function normalizeAiSettings(raw: unknown): { send: AiSendOptions; model: string | null } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const s = r.send && typeof r.send === 'object' ? (r.send as Record<string, unknown>) : {}
  const b = (v: unknown) => (typeof v === 'boolean' ? v : true)
  return {
    send: { schema: b(s.schema), sql: b(s.sql), data: b(s.data) },
    model: typeof r.model === 'string' && r.model ? r.model : null,
  }
}

export const SEND_OPTIONS_TIMEOUT_MS = 3000
const ALL_OFF: AiSendOptions = { schema: false, sql: false, data: false }

export interface AiSettings {
  /** DISPLAY ONLY (defaults to all on before load). AI consumers must NEVER read `send.value`; use `sendOptions()`, which fails closed. */
  send: Ref<AiSendOptions>
  model: Ref<string | null>
  models: Ref<AiModel[]>
  modelNotice: Ref<'none' | 'fallback' | 'no-models'>
  /** Loads persisted settings. Before it settles, readers see safe defaults (everything on, no model). */
  load(): Promise<void>
  /** Resolves once load() has settled (also on storage failure); starts load() if nobody has. Future AI consumers must await this before reading `send`. */
  ready(): Promise<void>
  isLoaded(): boolean
  /** Fail-closed accessor for AI consumers: saved options once the load succeeded; all OFF if the load failed or has not completed within the timeout. */
  sendOptions(): Promise<AiSendOptions>
  setSend(patch: Partial<AiSendOptions>): Promise<void>
  setModel(id: string | null): Promise<void>
  refreshModels(): Promise<void>
  effectiveModel(): string | undefined
}

export function createAiSettings(bridge: HostBridge, client: AiClient, opts: { sendTimeoutMs?: number } = {}): AiSettings {
  const sendTimeoutMs = opts.sendTimeoutMs ?? SEND_OPTIONS_TIMEOUT_MS
  const send = ref<AiSendOptions>({ ...DEFAULT_AI_SEND })
  const model = ref<string | null>(null)
  const models = ref<AiModel[]>([])
  const modelNotice = ref<'none' | 'fallback' | 'no-models'>('none')
  let loadFailed = false
  const touchedSend = new Set<keyof AiSendOptions>()
  let modelTouched = false
  let loaded = false
  let settingsLoaded = false
  let refreshSeq = 0
  let loadPromise: Promise<void> | null = null

  function recompute() {
    if (!loaded) return
    if (!models.value.length) { modelNotice.value = 'no-models'; return }
    modelNotice.value = model.value && !models.value.some((m) => m.id === model.value) ? 'fallback' : 'none'
  }

  // Writes wait for the load so untouched fields keep their stored values; nothing is written if the load failed (never clobber unseen opt-outs).
  async function persist() {
    await ready()
    if (loadFailed) return
    try { await bridge.storageSet(KEY, { send: send.value, model: model.value }) } catch { /* keep in memory */ }
  }

  async function doLoad() {
    try {
      const v = normalizeAiSettings(await bridge.storageGet<unknown>(KEY))
      const merged = { ...v.send }
      for (const k of touchedSend) merged[k] = send.value[k]
      send.value = merged
      if (!modelTouched) model.value = v.model
      loadFailed = false
      recompute()
    } catch { loadFailed = true }
  }

  function load() {
    loadPromise = doLoad().finally(() => { settingsLoaded = true })
    return loadPromise
  }
  function ready() { return loadPromise ?? load() }

  return {
    send, model, models, modelNotice,
    load,
    ready,
    isLoaded: () => settingsLoaded,
    async sendOptions() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<boolean>((r) => { timer = setTimeout(() => r(true), sendTimeoutMs) })
      try {
        if (await Promise.race([ready().then(() => false), timedOut])) return { ...ALL_OFF }
      } finally { clearTimeout(timer) }
      return loadFailed ? { ...ALL_OFF } : { ...send.value }
    },
    async setSend(patch) {
      const next = { ...send.value }
      for (const k of ['schema', 'sql', 'data'] as const) if (typeof patch[k] === 'boolean') { next[k] = patch[k]!; touchedSend.add(k) }
      send.value = next
      await persist()
    },
    async setModel(id) {
      model.value = id
      modelTouched = true
      recompute()
      await persist()
    },
    async refreshModels() {
      const seq = ++refreshSeq
      let next: AiModel[]
      try { next = await client.listModels() } catch { next = [] }
      if (seq !== refreshSeq) return
      models.value = next
      loaded = true
      recompute()
    },
    effectiveModel() {
      const list = models.value
      if (!list.length) return undefined
      return list.find((m) => m.id === model.value)?.id ?? list[0].id
    },
  }
}
