import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useAiRequest } from '../src/ai/useAiRequest'
import { AiError, type AiClient, type AiRequest, type AiResult } from '../src/ai/aiClient'
import { setLocale } from '../src/i18n'

function fakeClient() {
  const pending: { req: AiRequest; resolve(r: AiResult): void; reject(e: unknown): void }[] = []
  const generate = vi.fn((req: AiRequest) => new Promise<AiResult>((resolve, reject) => {
    pending.push({ req, resolve, reject })
    req.signal?.addEventListener('abort', () => reject(new AiError('cancelled')))
  }))
  const client: AiClient = { available: () => true, streaming: () => true, busy: () => false, listModels: async () => [], generate }
  return { client, generate, pending }
}
const REQ = { task: 'command-generation', prompt: 'p' } as const
beforeEach(() => setLocale('en'))

describe('useAiRequest stillWanted (pre-start cancel token)', () => {
  it('stillWanted false: no host request, phase stays idle, not busy', async () => {
    const { client, generate } = fakeClient()
    const r = useAiRequest(client)
    await r.start(REQ, () => false)
    expect(generate).not.toHaveBeenCalled()
    expect(r.state.value).toEqual({ phase: 'idle' })
    expect(r.busy.value).toBe(false)
  })
  it('stillWanted true: the request is sent', async () => {
    const { client, generate } = fakeClient()
    const r = useAiRequest(client)
    void r.start(REQ, () => true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(r.state.value).toEqual({ phase: 'running', chars: 0 })
  })
  it('stillWanted flipping to false during an awaited gap before start sends nothing', async () => {
    const { client, generate } = fakeClient()
    const r = useAiRequest(client)
    let wanted = true
    const caller = (async () => { await new Promise((res) => setTimeout(res, 5)); await r.start(REQ, () => wanted) })()
    wanted = false
    await caller
    expect(generate).not.toHaveBeenCalled()
    expect(r.state.value).toEqual({ phase: 'idle' })
  })
})

describe('useAiRequest', () => {
  it('idle -> running(chars) -> done', async () => {
    const { client, pending } = fakeClient()
    const r = useAiRequest(client)
    expect(r.state.value).toEqual({ phase: 'idle' })
    const p = r.start(REQ)
    expect(r.state.value).toEqual({ phase: 'running', chars: 0 })
    expect(r.busy.value).toBe(true)
    pending[0].req.onProgress!(42)
    expect(r.state.value).toEqual({ phase: 'running', chars: 42 })
    pending[0].resolve({ text: 'x', truncated: false })
    await p
    expect(r.state.value).toEqual({ phase: 'done', result: { text: 'x', truncated: false } })
    expect(r.busy.value).toBe(false)
  })
  it('cancel aborts, never reaches done, frees busy', async () => {
    const { client, pending } = fakeClient()
    const r = useAiRequest(client)
    const p = r.start(REQ)
    r.cancel()
    expect(pending[0].req.signal!.aborted).toBe(true)
    pending[0].resolve({ text: 'late', truncated: false })
    await p
    expect(r.state.value.phase).toBe('error')
    expect(r.state.value).toMatchObject({ code: 'cancelled' })
    expect(r.busy.value).toBe(false)
  })
  it('single flight is global across composable instances; second start sends nothing', async () => {
    const { client, generate, pending } = fakeClient()
    const a = useAiRequest(client)
    const b = useAiRequest(client)
    const p = a.start(REQ)
    expect(b.busy.value).toBe(true)
    await b.start(REQ)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(b.state.value.phase).toBe('idle')
    pending[0].resolve({ text: 'x', truncated: false })
    await p
    await nextTick()
    expect(b.busy.value).toBe(false)
  })
  it('errors map to distinct messages and free busy', async () => {
    const msgs = new Set<string>()
    for (const code of ['consent-declined', 'timeout', 'unsupported', 'cancelled'] as const) {
      const { client, pending } = fakeClient()
      const r = useAiRequest(client)
      const p = r.start(REQ)
      pending[0].reject(new AiError(code))
      await p
      const s = r.state.value
      expect(s).toMatchObject({ phase: 'error', code })
      if (s.phase === 'error') msgs.add(s.message)
      expect(r.busy.value).toBe(false)
    }
    expect(msgs.size).toBe(4)
  })
  it('unexpected throw becomes failed and reset returns to idle', async () => {
    const { client, pending } = fakeClient()
    const r = useAiRequest(client)
    const p = r.start(REQ)
    pending[0].reject(new Error('boom'))
    await p
    expect(r.state.value).toMatchObject({ phase: 'error', code: 'failed' })
    r.reset()
    expect(r.state.value).toEqual({ phase: 'idle' })
  })
})
