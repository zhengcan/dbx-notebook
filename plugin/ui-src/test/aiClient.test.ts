import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient, AiError, AI_METHODS, AI_CHUNK_EVENT, MAX_REQUEST_CHARS } from '../src/ai/aiClient'

const MODELS = [{ configId: 'c1', name: 'Cfg', model: 'm-a', isDefault: false }, { configId: 'c1', name: 'Cfg', model: 'm-b', isDefault: true }]

function setup(handlers: Record<string, (p: any) => unknown> = {}, caps: any = {}) {
  const bridge = createFakeBridge({
    caps: { aiCompletion: true, aiCompletionStream: false, aiModelDiscovery: true, ...caps },
    requestHandlers: { [AI_METHODS.listModels]: () => MODELS, [AI_METHODS.cancel]: () => ({ cancelled: true }), ...handlers },
  })
  return { bridge, client: createAiClient(bridge, { timeoutMs: 1000 }) }
}
const invokes = (b: any, m: string) => b.calls.filter((c: any) => c.method === 'request' && c.args.method === m)
const catchErr = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as AiError } throw new Error('no throw') }

afterEach(() => { vi.useRealTimers() })

describe('aiClient', () => {
  it('unsupported without capability, no invoke', async () => {
    const { bridge, client } = setup({}, { aiCompletion: false })
    expect(client.available()).toBe(false)
    const e = await catchErr(client.generate({ task: 'rewrite', prompt: 'x' }))
    expect(e).toBeInstanceOf(AiError); expect(e.code).toBe('unsupported')
    expect(bridge.calls.length).toBe(0)
  })

  it('non-stream: calls generateText with task, configId, model (default model)', async () => {
    const { bridge, client } = setup({ [AI_METHODS.generate]: () => 'hello' })
    const r = await client.generate({ task: 'command-generation', prompt: 'p' })
    expect(r).toEqual({ text: 'hello', truncated: false })
    const c = invokes(bridge, AI_METHODS.generate)
    expect(c.length).toBe(1)
    expect(c[0].args.params).toMatchObject({ task: 'command-generation', prompt: 'p', configId: 'c1', model: 'm-b' })
  })

  it('uses explicit model id from listModels', async () => {
    const { bridge, client } = setup({ [AI_METHODS.generate]: () => 'x' })
    const ms = await client.listModels()
    await client.generate({ task: 'rewrite', prompt: 'p', model: ms[0].id })
    expect(invokes(bridge, AI_METHODS.generate)[0].args.params).toMatchObject({ configId: 'c1', model: 'm-a' })
  })

  it('no models -> model-unavailable', async () => {
    const { client } = setup({ [AI_METHODS.listModels]: () => [] })
    expect((await catchErr(client.generate({ task: 'rewrite', prompt: 'p' }))).code).toBe('model-unavailable')
    expect(client.busy()).toBe(false)
  })

  it('stream: concatenates chunks, progress monotonic, ignores other requestId', async () => {
    let bridgeRef: any
    const { bridge, client } = setup({
      [AI_METHODS.stream]: async (p) => {
        const e = (delta: string, done = false, requestId = p.requestId) => bridgeRef.emit(AI_CHUNK_EVENT, { requestId, delta, done })
        e('ab'); e('zzzz', false, 'other'); e('cde'); e('f'); e('', true)
        return 'abcdef'
      },
    }, { aiCompletionStream: true })
    bridgeRef = bridge
    const seen: number[] = []
    const r = await client.generate({ task: 'rewrite', prompt: 'p', onProgress: (n) => seen.push(n) })
    expect(r.text).toBe('abcdef')
    expect(seen).toEqual([2, 5, 6])
    expect(invokes(bridge, AI_METHODS.stream)[0].args.params.requestId).toEqual(expect.any(String))
  })

  it('stream: falls back to accumulated chunks if host returns no string', async () => {
    let b: any
    const { bridge, client } = setup({ [AI_METHODS.stream]: (p) => { b.emit(AI_CHUNK_EVENT, { requestId: p.requestId, delta: 'xy', done: false }) } }, { aiCompletionStream: true })
    b = bridge
    expect((await client.generate({ task: 'rewrite', prompt: 'p' })).text).toBe('xy')
  })

  it('single-flight: second generate rejects busy, lock released after success/failure', async () => {
    let release!: (v: string) => void
    const { bridge, client } = setup({ [AI_METHODS.generate]: () => new Promise<string>((r) => { release = r }) })
    const p1 = client.generate({ task: 'rewrite', prompt: 'a' })
    await new Promise((r) => setTimeout(r, 0))
    expect(client.busy()).toBe(true)
    expect((await catchErr(client.generate({ task: 'rewrite', prompt: 'b' }))).code).toBe('busy')
    expect(invokes(bridge, AI_METHODS.generate).length).toBe(1)
    release('ok'); await p1
    expect(client.busy()).toBe(false)

    const f = setup({ [AI_METHODS.generate]: () => { throw new Error('AI generation failed. Check') } })
    const e = await catchErr(f.client.generate({ task: 'rewrite', prompt: 'a' }))
    expect(e.code).toBe('failed'); expect(f.client.busy()).toBe(false)
  })

  it('cancel: abort calls cancelGeneration and rejects cancelled; late chunk dropped', async () => {
    let b: any, rid = ''
    const { bridge, client } = setup({ [AI_METHODS.stream]: (p) => { rid = p.requestId; return new Promise(() => {}) } }, { aiCompletionStream: true })
    b = bridge
    const ac = new AbortController(); const seen: number[] = []
    const p = catchErr(client.generate({ task: 'rewrite', prompt: 'p', signal: ac.signal, onProgress: (n) => seen.push(n) }))
    await new Promise((r) => setTimeout(r, 0))
    ac.abort()
    expect((await p).code).toBe('cancelled')
    expect(invokes(bridge, AI_METHODS.cancel)[0].args.params).toEqual({ requestId: rid })
    b.emit(AI_CHUNK_EVENT, { requestId: rid, delta: 'late', done: false })
    expect(seen).toEqual([])
    expect(client.busy()).toBe(false)
  })

  it('cancel: cancelGeneration throwing still rejects cancelled and frees lock', async () => {
    const { client } = setup({ [AI_METHODS.stream]: () => new Promise(() => {}), [AI_METHODS.cancel]: () => { throw new Error('boom') } }, { aiCompletionStream: true })
    const ac = new AbortController()
    const p = catchErr(client.generate({ task: 'rewrite', prompt: 'p', signal: ac.signal }))
    await new Promise((r) => setTimeout(r, 0))
    ac.abort()
    expect((await p).code).toBe('cancelled')
    expect(client.busy()).toBe(false)
  })

  it('already-aborted signal rejects cancelled without invoke', async () => {
    const { bridge, client } = setup()
    const ac = new AbortController(); ac.abort()
    expect((await catchErr(client.generate({ task: 'rewrite', prompt: 'p', signal: ac.signal }))).code).toBe('cancelled')
    expect(invokes(bridge, AI_METHODS.generate).length).toBe(0)
  })

  it('timeout: cancels and rejects timeout', async () => {
    vi.useFakeTimers()
    const { bridge, client } = setup({ [AI_METHODS.stream]: () => new Promise(() => {}) }, { aiCompletionStream: true })
    const p = catchErr(client.generate({ task: 'rewrite', prompt: 'p' }))
    await vi.advanceTimersByTimeAsync(1001)
    expect((await p).code).toBe('timeout')
    expect(invokes(bridge, AI_METHODS.cancel).length).toBe(1)
    expect(client.busy()).toBe(false)
  })

  it('request length boundary counts string length', async () => {
    const { bridge, client } = setup({ [AI_METHODS.generate]: () => 'ok' })
    expect((await catchErr(client.generate({ task: 'rewrite', prompt: 'a'.repeat(MAX_REQUEST_CHARS + 1) }))).code).toBe('too-long-request')
    expect(invokes(bridge, AI_METHODS.generate).length).toBe(0)
    await client.generate({ task: 'rewrite', prompt: 'a'.repeat(MAX_REQUEST_CHARS) })
    expect((await catchErr(client.generate({ task: 'rewrite', prompt: '😀'.repeat(50_001) }))).code).toBe('too-long-request')
    await client.generate({ task: 'rewrite', prompt: '中'.repeat(MAX_REQUEST_CHARS) })
  })

  it('error mapping', async () => {
    const cases: [string, string][] = [
      ['AI generation cancelled.', 'consent-declined'],
      ['AI configuration or model is no longer available. Refresh the model list.', 'model-unavailable'],
      ['AI is already generating. Please wait.', 'busy'],
      ['AI generation failed. Check the selected model in DBX AI settings.', 'failed'],
      ['AI response exceeded 16000 characters.', 'failed'],
    ]
    for (const [msg, code] of cases) {
      const { client } = setup({ [AI_METHODS.generate]: () => { throw new Error(msg) } })
      const e = await catchErr(client.generate({ task: 'rewrite', prompt: 'p' }))
      expect(e.code).toBe(code); expect(e.detail).toContain(msg.slice(0, 15))
      expect(client.busy()).toBe(false)
    }
  })

  it('listModels: tolerates malformed, ignores aiModelDiscovery, fails as AiError', async () => {
    const { client } = setup({ [AI_METHODS.listModels]: () => [{ configId: 'a', model: 'm', name: 'N' }, { name: 'x' }, null, { configId: 'a', model: '' }] })
    const ms = await client.listModels()
    expect(ms).toHaveLength(1); expect(ms[0].label).toContain('m')
    const nodisc = setup({}, { aiModelDiscovery: false })
    expect(await nodisc.client.listModels()).toHaveLength(2)
    const bad = setup({ [AI_METHODS.listModels]: () => { throw new Error('x') } })
    expect((await catchErr(bad.client.listModels())).code).toBe('failed')
  })

  it('listModels: [] without invoke when aiCompletion is off', async () => {
    const { bridge, client } = setup({}, { aiCompletion: false })
    expect(await client.listModels()).toEqual([])
    expect(bridge.calls.length).toBe(0)
  })

  it('non-stream abort does not call cancelGeneration', async () => {
    const { bridge, client } = setup({ [AI_METHODS.generate]: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = catchErr(client.generate({ task: 'rewrite', prompt: 'p', signal: ac.signal }))
    await new Promise((r) => setTimeout(r, 0))
    ac.abort()
    expect((await p).code).toBe('cancelled')
    expect(invokes(bridge, AI_METHODS.cancel).length).toBe(0)
  })

  it('throwing onProgress does not break the listener or the result', async () => {
    let b: any
    const { bridge, client } = setup({ [AI_METHODS.stream]: (p) => { b.emit(AI_CHUNK_EVENT, { requestId: p.requestId, delta: 'ab', done: false }); b.emit(AI_CHUNK_EVENT, { requestId: p.requestId, delta: 'c', done: false }); return 'abc' } }, { aiCompletionStream: true })
    b = bridge
    const cb = vi.fn(() => { throw new Error('ui') })
    expect((await client.generate({ task: 'rewrite', prompt: 'p', onProgress: cb })).text).toBe('abc')
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('consent-declined message is neutral', async () => {
    const { client } = setup({ [AI_METHODS.generate]: () => { throw new Error('AI generation cancelled.') } })
    const e = await catchErr(client.generate({ task: 'rewrite', prompt: 'p' }))
    expect(e.message).toBe('Generation was cancelled or the confirmation was declined in DBX')
    expect(e.detail).toBe('AI generation cancelled.')
  })

  it('truncated heuristic on very long output', async () => {
    const { client } = setup({ [AI_METHODS.generate]: () => 'a'.repeat(9000) })
    expect((await client.generate({ task: 'rewrite', prompt: 'p' })).truncated).toBe(true)
  })
})
