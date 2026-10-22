import { readonly, ref, type Ref } from 'vue'
import { AiError, type AiClient, type AiErrorCode, type AiRequest, type AiResult } from './aiClient'
import { t } from '../i18n'

export type AiRequestState =
  | { phase: 'idle' }
  | { phase: 'running'; chars: number }
  | { phase: 'done'; result: AiResult }
  | { phase: 'error'; code: AiErrorCode; message: string }

// One reactive busy flag per client: the host allows a single generation at a time, so every block shares it.
const busyFlags = new WeakMap<AiClient, Ref<boolean>>()
const busyOf = (c: AiClient) => {
  let r = busyFlags.get(c)
  if (!r) busyFlags.set(c, (r = ref(false)))
  return r
}

const ERR: Record<AiErrorCode, (detail: string) => string> = {
  'consent-declined': () => t('ai.err.consent-declined'), timeout: () => t('ai.err.timeout'), cancelled: () => t('ai.err.cancelled'),
  unsupported: () => t('ai.err.unsupported'), busy: () => t('ai.err.busy'), 'too-long-request': () => t('ai.err.too-long-request'),
  'model-unavailable': () => t('ai.err.model-unavailable'), failed: (detail) => t('ai.err.failed', { detail }),
}
export function errorMessage(code: AiErrorCode, detail?: string): string {
  return ERR[code](detail ?? '')
}

export function useAiRequest(client: AiClient) {
  const state = ref<AiRequestState>({ phase: 'idle' })
  const busy = busyOf(client)
  let ctl: AbortController | null = null
  let token = 0

  /** `stillWanted` is the pre-start cancel token: if it returns false nothing is sent. */
  async function start(req: Omit<AiRequest, 'signal' | 'onProgress'>, stillWanted?: () => boolean): Promise<void> {
    if (busy.value) return
    if (stillWanted && !stillWanted()) return
    busy.value = true
    const mine = ++token
    const c = (ctl = new AbortController())
    state.value = { phase: 'running', chars: 0 }
    try {
      const result = await client.generate({
        ...req,
        signal: c.signal,
        onProgress: (chars) => { if (mine === token && state.value.phase === 'running') state.value = { phase: 'running', chars } },
      })
      if (mine === token && !c.signal.aborted) state.value = { phase: 'done', result }
    } catch (e) {
      if (mine === token) {
        const code: AiErrorCode = e instanceof AiError ? e.code : 'failed'
        const detail = e instanceof AiError ? e.detail : e instanceof Error ? e.message : String(e)
        state.value = { phase: 'error', code, message: errorMessage(code, detail) }
      }
    } finally {
      if (ctl === c) ctl = null
      busy.value = false
    }
  }

  function cancel(): void {
    if (!ctl) return
    ctl.abort()
    token++
    state.value = { phase: 'error', code: 'cancelled', message: errorMessage('cancelled') }
  }

  function reset(): void {
    if (ctl) cancel()
    state.value = { phase: 'idle' }
  }

  return { state: readonly(state) as Readonly<Ref<AiRequestState>>, busy: readonly(busy) as Readonly<Ref<boolean>>, start, cancel, reset }
}
