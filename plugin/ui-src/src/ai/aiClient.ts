import { mapHostError, type HostBridge } from '../host/bridge'

// host.* methods go through bridge.request (window.dbxPlugin.request), NEVER invoke (= backend.invoke to our sidecar).
// Host contract confirmed against t8y2/dbx main (pluginHostBridge.ts, pluginAiCompletion.ts);
// (the contract was checked against the DBX sources; see the host plugin docs).
export type AiTask = 'command-generation' | 'rewrite'
export interface AiModel { id: string; label: string }
export interface AiRequest { task: AiTask; prompt: string; model?: string; signal?: AbortSignal; onProgress?: (chars: number) => void }
export interface AiResult { text: string; truncated: boolean }
export type AiErrorCode = 'unsupported' | 'busy' | 'cancelled' | 'consent-declined' | 'timeout' | 'too-long-request' | 'model-unavailable' | 'failed'
const CONSENT_DECLINED_MESSAGE = 'Generation was cancelled or the confirmation was declined in DBX'
export class AiError extends Error {
  code: AiErrorCode
  detail?: string
  constructor(code: AiErrorCode, detail?: string) {
    super(code === 'consent-declined' ? CONSENT_DECLINED_MESSAGE : detail ? `${code}: ${detail}` : code)
    this.name = 'AiError'
    this.code = code
    this.detail = detail
  }
}

export const MAX_REQUEST_CHARS = 100_000
export const MAX_OUTPUT_TOKENS = 2048
// The host returns plain text with no finish reason; outputs this long are treated as hitting the token cap.
export const TRUNCATION_HEURISTIC_CHARS = 8000
export const AI_METHODS = {
  listModels: 'host.ai.listModels',
  generate: 'host.ai.generateText',
  stream: 'host.ai.generateTextStream',
  cancel: 'host.ai.cancelGeneration',
} as const
export const AI_CHUNK_EVENT = 'host.ai.generationChunk'

export interface AiClient {
  available(): boolean
  streaming(): boolean
  busy(): boolean
  listModels(): Promise<AiModel[]>
  generate(req: AiRequest): Promise<AiResult>
}

interface RawModel { configId: string; model: string; name: string; isDefault: boolean }
const SEP = '|'
const encodeId = (m: RawModel) => `${m.configId}${SEP}${m.model}`

function parseModels(v: unknown): RawModel[] {
  if (!Array.isArray(v)) return []
  const out: RawModel[] = []
  for (const m of v) {
    if (!m || typeof m !== 'object') continue
    const { configId, model, name, isDefault } = m as Record<string, unknown>
    if (typeof configId !== 'string' || !configId || typeof model !== 'string' || !model) continue
    out.push({ configId, model, name: typeof name === 'string' ? name : '', isDefault: isDefault === true })
  }
  return out
}

function rawMessage(e: unknown): string {
  const h = mapHostError(e)
  return h.message
}

function mapError(e: unknown): AiError {
  if (e instanceof AiError) return e
  const h = mapHostError(e)
  const detail = h.rawMessage ?? h.message
  if (h.code === 'AI_CONSENT_DECLINED') return new AiError('consent-declined', detail)
  if (h.code === 'AI_BUSY') return new AiError('busy', detail)
  if (/no longer available|Invalid AI (configId|model)/i.test(h.message)) return new AiError('model-unavailable', detail)
  return new AiError('failed', detail)
}

export function createAiClient(bridge: HostBridge, opts: { timeoutMs?: number } = {}): AiClient {
  const timeoutMs = opts.timeoutMs ?? 120_000
  let inFlight = false
  let seq = 0

  const available = () => bridge.capabilities().aiCompletion === true
  const streaming = () => available() && bridge.capabilities().aiCompletionStream === true

  async function listRaw(): Promise<RawModel[]> {
    if (!available()) return []
    try {
      return parseModels(await bridge.request<unknown>(AI_METHODS.listModels, {}))
    } catch (e) {
      throw new AiError('failed', rawMessage(e))
    }
  }

  async function resolveModel(id?: string): Promise<RawModel> {
    if (!available()) throw new AiError('unsupported')
    const all = await listRaw()
    const pick = id ? all.find((m) => encodeId(m) === id) : (all.find((m) => m.isDefault) ?? all[0])
    if (!pick) throw new AiError('model-unavailable', id)
    return pick
  }

  return {
    available,
    streaming,
    busy: () => inFlight,
    async listModels() {
      return (await listRaw()).map((m) => ({ id: encodeId(m), label: m.name ? `${m.name} · ${m.model}` : m.model }))
    },
    async generate(req) {
      if (!available()) throw new AiError('unsupported')
      if (inFlight) throw new AiError('busy')
      if (req.prompt.length > MAX_REQUEST_CHARS) throw new AiError('too-long-request', String(req.prompt.length))
      if (req.signal?.aborted) throw new AiError('cancelled')
      inFlight = true
      const stream = streaming()
      const requestId = `sqlnb-${Date.now().toString(36)}-${++seq}`
      let settled = false
      let acc = ''
      let off: () => void = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const cancelHost = () => {
        if (!stream) return
        void bridge.request(AI_METHODS.cancel, { requestId }).catch(() => undefined)
      }
      try {
        return await new Promise<AiResult>((resolve, reject) => {
          const fail = (err: AiError, cancel: boolean) => {
            if (settled) return
            settled = true
            if (cancel) cancelHost()
            reject(err)
          }
          onAbort = () => fail(new AiError('cancelled'), true)
          req.signal?.addEventListener('abort', onAbort)
          timer = setTimeout(() => fail(new AiError('timeout'), true), timeoutMs)
          if (stream) {
            off = bridge.onEvent(AI_CHUNK_EVENT, (p) => {
              if (settled || !p || typeof p !== 'object') return
              const { requestId: rid, delta } = p as { requestId?: unknown; delta?: unknown }
              if (rid !== requestId || typeof delta !== 'string' || !delta) return
              acc += delta
              try { req.onProgress?.(acc.length) } catch { /* UI callback must not break the bridge listener */ }
            })
          }
          void (async () => {
            try {
              const model = await resolveModel(req.model)
              if (settled) return
              const params: Record<string, unknown> = { configId: model.configId, model: model.model, prompt: req.prompt, task: req.task }
              if (stream) params.requestId = requestId
              const out = await bridge.request<unknown>(stream ? AI_METHODS.stream : AI_METHODS.generate, params, { timeoutMs })
              if (settled) return
              const text = typeof out === 'string' ? out : acc
              settled = true
              resolve({ text, truncated: text.length >= TRUNCATION_HEURISTIC_CHARS })
            } catch (e) {
              fail(mapError(e), false)
            }
          })()
        })
      } finally {
        settled = true
        off()
        if (timer) clearTimeout(timer)
        if (onAbort) req.signal?.removeEventListener('abort', onAbort)
        inFlight = false
      }
    },
  }
}
