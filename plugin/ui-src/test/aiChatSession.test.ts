import { describe, it, expect, beforeEach } from 'vitest'
import { genPrompts, genRequests } from './aiRequests'
import { nextTick } from 'vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { useAiRequest } from '../src/ai/useAiRequest'
import { createChatStore } from '../src/ai/chatStore'
import { useChatSession, watchDeletedBlocks, type TurnContext } from '../src/ai/useChatSession'
import { buildChatPrompt, filterHistory, OMITTED_REPLY } from '../src/ai/promptChat'
import { MAX_AUTO_ROUNDS, type Retrieved } from '../src/ai/useChatSession'
import { useNotebookStore } from '../src/state/notebookStore'
import { setLocale, t } from '../src/i18n'
import { serializeNotebook } from '@sqlnb/format'

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)) }
type Send = { schema: boolean; sql: boolean; data: boolean }
const PROBE = 'PROBE_ROW_DATA'

function setup(opts: { send?: () => Promise<Send>; replies?: string[]; path?: string | null; storageFail?: boolean; hold?: boolean } = {}) {
  const replies = [...(opts.replies ?? [])]
  let release: ((v: string) => void) | null = null
  const bridge = createFakeBridge({
    caps: { aiCompletion: true },
    requestHandlers: {
      'host.ai.listModels': async () => [{ configId: 'c', model: 'm', name: 'M', isDefault: true }],
      'host.ai.generateText': async () => {
        if (opts.hold) return new Promise<string>((r) => { release = r })
        const r = replies.shift() ?? 'select 1'
        if (r === '__DECLINE__') throw new Error('AI generation cancelled.')
        return r
      },
    },
  })
  if (opts.storageFail) (bridge as any).storageSet = async () => { throw new Error('quota') }
  const client = createAiClient(bridge)
  const sendOpts = opts.send ?? (async () => ({ schema: true, sql: true, data: true }))
  const aiSettings = { sendOptions: sendOpts, effectiveModel: () => undefined } as any
  const chat = createChatStore(bridge)
  const store = useNotebookStore()
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 0', metadata: {} } as any, { id: 'b2', type: 'sql', content: 'select 2', metadata: {} } as any)
  if (opts.path !== undefined) store.path.value = opts.path
  else store.path.value = '/n.sqlnb'
  const mk = (blockId = 'b1') => useChatSession({ client, aiSettings, chat, store }, { purpose: 'sql', blockId })
  const prompts = () => genPrompts(bridge)
  const ctx = (): TurnContext => ({
    task: 'command-generation',
    buildInput: (send, history, userText) => ({
      locale: 'en', dialect: 'PostgreSQL', send, purpose: 'sql', draft: 'select 0', schemas: [],
      result: send.data ? { columns: ['a'], rows: [[PROBE]], totalRows: 1, truncated: false } as any : undefined,
      history, userText,
    }),
    parse: (text) => (text.includes('BAD') ? { ok: false, message: 'unparseable' } : { ok: true, reply: [{ kind: 'text', text }], sqlAfter: text, payload: { sql: text } }),
  })
  return { bridge, client, chat, store, mk, prompts, ctx, aiSettings, release: (v: string) => release?.(v) }
}

beforeEach(() => setLocale('en'))

describe('useChatSession', () => {
  describe('send while the cached chat is still loading', () => {
    async function slow(waitMs?: number) {
      const s = setup()
      const first = s.mk(); await first.load()
      await first.send('one', s.ctx())
      const stored = async () => JSON.stringify((await s.chat.load('/n.sqlnb', 'b1')).messages)
      const before = await stored()
      const orig = (s.bridge as any).storageGet.bind(s.bridge)
      let open!: () => void
      const gate = new Promise<void>((r) => { open = r })
      ;(s.bridge as any).storageGet = async (k: string) => { await gate; return orig(k) }
      const c = useChatSession({ client: s.client, aiSettings: s.aiSettings, chat: s.chat, store: s.store, ...(waitMs !== undefined ? { loadWaitMs: waitMs } : {}) } as any, { purpose: 'sql', blockId: 'b1' })
      const n0 = s.prompts().length
      const release = async () => { open(); await flush() }
      const restore = () => { (s.bridge as any).storageGet = orig }
      return { s, c, before, stored, n0, release, restore }
    }

    it('cancel while waiting: nothing sent, cached messages restored, stored chat untouched', async () => {
      const { s, c, before, stored, n0, release } = await slow()
      const loading = c.load()
      const sending = c.send('two', s.ctx())
      await flush()
      expect(c.busy.value).toBe(true)
      c.cancel()
      expect(c.busy.value).toBe(false)
      await release()
      await loading
      expect(await sending).toBeNull()
      expect(s.prompts().length).toBe(n0)
      expect(c.ready.value).toBe(true)
      expect(c.messages.value).toHaveLength(2)
      expect(await stored()).toBe(before)
    })

    it('dispose while waiting: nothing sent, nothing saved', async () => {
      const { s, c, before, stored, n0, release } = await slow()
      const loading = c.load()
      const sending = c.send('two', s.ctx())
      await flush()
      c.dispose()
      await release()
      await loading
      expect(await sending).toBeNull()
      expect(s.prompts().length).toBe(n0)
      expect(await stored()).toBe(before)
    })

    it('a second send while waiting returns null', async () => {
      const { s, c, n0, release } = await slow()
      const loading = c.load()
      const a = c.send('two', s.ctx())
      await flush()
      expect(await c.send('three', s.ctx())).toBeNull()
      await release()
      await loading; await a
      expect(s.prompts().length).toBe(n0 + 1)
      expect(c.messages.value).toHaveLength(4)
    })

    it('hanging load: after the timeout the turn is sent once, memory-only, stored chat not overwritten, no error', async () => {
      const { s, c, before, stored, n0, release } = await slow(30)
      const loading = c.load()
      const r = await c.send('two', s.ctx())
      expect(r).not.toBeNull()
      expect(s.prompts().length).toBe(n0 + 1)
      expect(c.error.value).toBe('')
      await release(); await loading
      expect(c.messages.value).toHaveLength(2)
      expect((c.messages.value[0].parts[0] as any).text).toBe('two')
      expect(c.ready.value).toBe(false)
      expect(await stored()).toBe(before)
    })
  })

  it('a send issued before the cached chat has loaded waits for it and keeps the earlier turns', async () => {
    const s = setup()
    const first = s.mk(); await first.load()
    await first.send('one', s.ctx())
    const orig = (s.bridge as any).storageGet.bind(s.bridge)
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    ;(s.bridge as any).storageGet = async (k: string) => { await gate; return orig(k) }
    const c = s.mk()
    const loading = c.load()
    const sending = c.send('two', s.ctx())
    await flush()
    open()
    await loading; await sending
    expect(c.messages.value).toHaveLength(4)
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(4)
    expect(c.ready.value).toBe(true)
  })

  it('rebuilds send options each turn: data off between turns removes PROBE from turn 2', async () => {
    let data = true
    const s = setup({ send: async () => ({ schema: true, sql: true, data }) })
    const c = s.mk(); await c.load()
    await c.send('one', s.ctx())
    data = false
    await c.send('two', s.ctx())
    const [p1, p2] = s.prompts()
    expect(p1).toContain(PROBE)
    expect(p2).not.toContain(PROBE)
  })

  it('sendOptions rejecting -> error state, nothing sent, not stuck busy', async () => {
    const s = setup({ send: async () => { throw new Error('boom') } })
    const c = s.mk(); await c.load()
    expect(await c.send('hi', s.ctx())).toBeNull()
    expect(c.error.value).not.toBe('')
    expect(s.prompts()).toHaveLength(0)
    expect(c.busy.value).toBe(false)
  })

  it('all options off -> prompt carries no data / SQL', async () => {
    const s = setup({ send: async () => ({ schema: false, sql: false, data: false }) })
    const c = s.mk(); await c.load()
    await c.send('hi', s.ctx())
    expect(s.prompts()[0]).not.toContain(PROBE)
    expect(s.prompts()[0]).not.toContain('select 0')
  })

  it('persists history: 2 turns = 4 messages; a new session restores them', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    await c.send('one', s.ctx()); await c.send('two', s.ctx())
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(4)
    const c2 = s.mk(); await c2.load()
    expect(c2.messages.value).toHaveLength(4)
    expect(c2.ready.value).toBe(true)
  })

  it('parse failure: error + rawOutput set, user message kept, no assistant message', async () => {
    const s = setup({ replies: ['BAD output'] })
    const c = s.mk(); await c.load()
    const r = await c.send('x', s.ctx())
    expect(r).toBeNull()
    expect(c.error.value).toBe('unparseable')
    expect(c.rawOutput.value).toBe('BAD output')
    expect(c.messages.value.map((m) => m.role)).toEqual(['user'])
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(1)
  })

  it('cancel before start sends nothing', async () => {
    let gate!: (v: Send) => void
    const s = setup({ send: () => new Promise<Send>((r) => { gate = r }) })
    const c = s.mk(); await c.load()
    const p = c.send('x', s.ctx())
    await flush()
    c.cancel()
    gate({ schema: true, sql: true, data: true })
    await p
    await flush()
    expect(s.prompts()).toHaveLength(0)
    expect(c.busy.value).toBe(false)
  })

  it('cancel during buildInput (schema fetch) sends nothing', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    let gate!: () => void
    const ctx = s.ctx()
    const inner = ctx.buildInput
    ctx.buildInput = async (a, b, d) => { await new Promise<void>((r) => { gate = r }); return inner(a, b, d) }
    const p = c.send('x', ctx)
    await flush()
    c.cancel(); gate()
    await p
    expect(s.prompts()).toHaveLength(0)
  })

  it('dispose before start sends nothing; dispose mid-request drops late reply and saves nothing more', async () => {
    const s = setup()
    const c0 = s.mk(); await c0.load()
    const p0 = c0.send('x', s.ctx()); c0.dispose(); await p0
    expect(s.prompts()).toHaveLength(0)

    const h = setup({ hold: true })
    const c = h.mk(); await c.load()
    const p = c.send('x', h.ctx())
    await flush()
    expect(h.prompts()).toHaveLength(1)
    c.dispose()
    h.release('select 9')
    expect(await p).toBeNull()
    await flush()
    expect(c.messages.value.map((m) => m.role)).toEqual(['user'])
    expect((await h.chat.load('/n.sqlnb', 'b1')).messages.map((m) => m.role)).toEqual(['user'])
  })

  it('store.load() mid-request: reply dropped, nothing saved to the new notebook key', async () => {
    const h = setup({ hold: true })
    const c = h.mk(); await c.load()
    const p = c.send('x', h.ctx())
    await flush()
    h.store.load(serializeNotebook({ ...h.store.nb.value, blocks: [{ id: 'b1', type: 'sql', content: 'other', metadata: {} }] } as any), '/other.sqlnb', 0)
    await flush()
    h.release('select 9')
    expect(await p).toBeNull()
    await flush()
    expect(c.messages.value.map((m) => m.role)).toEqual(['user'])
    expect((await h.chat.load('/other.sqlnb', 'b1')).messages).toHaveLength(0)
    expect((await h.chat.load('/n.sqlnb', 'b1')).messages.map((m) => m.role)).toEqual(['user'])
  })

  it('busy: second send is ignored; busy flag is shared with another useAiRequest(client)', async () => {
    const h = setup({ hold: true })
    const c = h.mk(); await c.load()
    const p = c.send('one', h.ctx())
    await flush()
    expect(c.busy.value).toBe(true)
    expect(useAiRequest(h.client).busy.value).toBe(true)
    expect(await c.send('two', h.ctx())).toBeNull()
    expect(h.prompts()).toHaveLength(1)
    expect(c.messages.value).toHaveLength(1)
    h.release('select 1')
    await p
    expect(c.busy.value).toBe(false)
  })

  it('overLimit prompt: not sent, too-long error shown', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    const ctx = s.ctx()
    ctx.buildInput = (send, history, userText) => ({ locale: 'en', dialect: '', send, purpose: 'sql', draft: 'x'.repeat(150_000), schemas: [], history, userText })
    await c.send('x', ctx)
    expect(s.prompts()).toHaveLength(0)
    expect(c.error.value).toMatch(/too long/i)
    expect(buildChatPrompt(await ctx.buildInput({ schema: true, sql: true, data: true }, [], 'x')).overLimit).toBe(true)
  })

  it('storage setItem rejecting: send still completes with the reply (memory-only)', async () => {
    const s = setup({ storageFail: true })
    const c = s.mk(); await c.load()
    const r = await c.send('x', s.ctx())
    expect(r).toEqual({ payload: { sql: 'select 1' } })
    expect(c.messages.value).toHaveLength(2)
    expect(c.error.value).toBe('')
  })

  it('clear(): messages empty, key nulled', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    await c.send('x', s.ctx())
    await c.clear()
    expect(c.messages.value).toHaveLength(0)
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(0)
    const nulls = (s.bridge.calls as any[]).filter((x) => x.method === 'storageSet' && x.args.value === null)
    expect(nulls.length).toBeGreaterThan(0)
  })

  it('path null: chat works in memory, no storageSet', async () => {
    const s = setup({ path: null })
    const c = s.mk(); await c.load()
    await c.send('x', s.ctx())
    expect(c.messages.value).toHaveLength(2)
    expect((s.bridge.calls as any[]).filter((x) => x.method === 'storageSet')).toHaveLength(0)
  })

  it('baseline: persisted and resumed when block unchanged; reset when block changed', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    expect(c.baseline.value).toBe('select 0')
    await c.send('x', s.ctx())
    expect((await s.chat.load('/n.sqlnb', 'b1')).baseline).toBe('select 0')
    const c2 = s.mk(); await c2.load()
    expect(c2.baseline.value).toBe('select 0')
    s.store.nb.value.blocks[0].content = 'select 7'
    const c3 = s.mk(); await c3.load()
    expect(c3.baseline.value).toBe('select 7')
  })

  it('never uses invoke for host methods', async () => {
    const s = setup()
    const c = s.mk(); await c.load(); await c.send('x', s.ctx())
    expect(s.prompts().length).toBe(1)
    expect((s.bridge.calls as any[]).filter((x) => x.method === 'invoke')).toHaveLength(0)
    await nextTick()
  })

  it('block deleted (GC watcher): its key is removed; another block untouched; notebook load is not a deletion', async () => {
    const s = setup()
    watchDeletedBlocks(s.store, s.chat)
    const rec = { v: 1 as const, messages: [{ id: 'a', role: 'user' as const, parts: [{ kind: 'text' as const, text: 'q' }], at: 1 }], updated: 1 }
    await s.chat.save('/n.sqlnb', 'b1', rec)
    await s.chat.save('/n.sqlnb', 'b2', rec)
    s.store.nb.value.blocks.splice(0, 1)
    await flush()
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(0)
    expect((await s.chat.load('/n.sqlnb', 'b2')).messages).toHaveLength(1)
    s.store.load(serializeNotebook({ ...s.store.nb.value, blocks: [] } as any), '/n.sqlnb', 0)
    await flush()
    expect((await s.chat.load('/n.sqlnb', 'b2')).messages).toHaveLength(1)
  })

  it('GC watcher clears base, :interpret and :chart keys of a deleted block (not on load)', async () => {
    const s = setup()
    watchDeletedBlocks(s.store, s.chat)
    const rec = { v: 1 as const, messages: [{ id: 'a', role: 'user' as const, parts: [{ kind: 'text' as const, text: 'q' }], at: 1 }], updated: 1 }
    for (const k of ['b1', 'b1:interpret', 'b1:chart', 'b2:interpret']) await s.chat.save('/n.sqlnb', k, rec)
    s.store.load(serializeNotebook({ ...s.store.nb.value, blocks: [] } as any), '/n.sqlnb', 0)
    await flush()
    for (const k of ['b1', 'b1:interpret', 'b1:chart']) expect((await s.chat.load('/n.sqlnb', k)).messages).toHaveLength(1)
    s.store.nb.value.blocks.splice(0, s.store.nb.value.blocks.length, { id: 'b1', type: 'sql', content: 'x', metadata: {} } as any, { id: 'b2', type: 'sql', content: 'y', metadata: {} } as any)
    await flush()
    s.store.nb.value.blocks.splice(0, 1)
    await flush()
    for (const k of ['b1', 'b1:interpret', 'b1:chart']) expect((await s.chat.load('/n.sqlnb', k)).messages).toHaveLength(0)
    expect((await s.chat.load('/n.sqlnb', 'b2:interpret')).messages).toHaveLength(1)
  })

  it('notebook load during the preparing phase: busy resets, no host.ai call, next send works', async () => {
    const s = setup()
    const c = s.mk(); await c.load()
    let gate!: () => void
    const ctx = s.ctx()
    const inner = ctx.buildInput
    ctx.buildInput = async (a, b, d) => { await new Promise<void>((r) => { gate = r }); return inner(a, b, d) }
    const p = c.send('x', ctx)
    await flush()
    expect(c.busy.value).toBe(true)
    s.store.load(serializeNotebook({ ...s.store.nb.value, blocks: [{ id: 'b1', type: 'sql', content: 'other', metadata: {} }] } as any), '/other.sqlnb', 0)
    gate()
    expect(await p).toBeNull()
    await flush()
    expect(c.busy.value).toBe(false)
    expect(s.prompts()).toHaveLength(0)
    expect(await c.send('again', s.ctx())).not.toBeNull()
    expect(s.prompts()).toHaveLength(1)
  })

  it('another session grabbing the global busy flag during preparing surfaces the busy error', async () => {
    let gate!: (v: Send) => void
    let calls = 0
    const s = setup({ send: () => (++calls === 1 ? new Promise<Send>((r) => { gate = r }) : Promise.resolve({ schema: true, sql: true, data: true })), hold: true })
    const c = s.mk(); await c.load()
    const p = c.send('x', s.ctx())
    await flush()
    const other = useAiRequest(s.client)
    const o = other.start({ task: 'command-generation', prompt: 'hi' })
    gate({ schema: true, sql: true, data: true })
    expect(await p).toBeNull()
    expect(c.error.value).toMatch(/another AI request/i)
    expect(c.busy.value).toBe(true)
    other.cancel(); s.release('x'); await o
  })

  describe('streaming', () => {
  it('positive control: the prompts helper counts streaming requests too', () => {
    const fake = { calls: [{ method: 'request', args: { method: 'host.ai.generateTextStream', params: { prompt: 'STREAMED' } } }] }
    expect(genPrompts(fake)).toEqual(['STREAMED'])
  })
    function streamSetup() {
      let rid = ''
      const releases: Array<(v: string) => void> = []
      const bridge = createFakeBridge({
        caps: { aiCompletion: true, aiCompletionStream: true },
        requestHandlers: {
          'host.ai.listModels': async () => [{ configId: 'c', model: 'm', name: 'M', isDefault: true }],
          'host.ai.generateTextStream': async (_m: any, params: any) => { rid = params?.requestId ?? rid; return new Promise<string>((r) => { releases.push(r) }) },
          'host.ai.cancelGeneration': async () => ({}),
        },
      } as any)
      return { bridge, rid: () => rid, release: (v: string) => releases[releases.length - 1](v), releaseAt: (i: number, v: string) => releases[i](v) }
    }
    const mkS = (st: ReturnType<typeof streamSetup>) => {
      const base = setup()
      const client = createAiClient(st.bridge)
      const chat = createChatStore(st.bridge)
      const c = useChatSession({ client, aiSettings: base.aiSettings, chat, store: base.store }, { purpose: 'sql', blockId: 'b1' })
      return { c, base, client, chat }
    }
    const calls = (st: ReturnType<typeof streamSetup>, m: string) => (st.bridge.calls as any[]).filter((x) => x.method === 'request' && x.args.method === m)

    it('positive control: a real streaming send is counted by genPrompts', async () => {
      const st = streamSetup()
      const { c, base } = mkS(st)
      await c.load()
      const p = c.send('x', base.ctx())
      await flush()
      expect(genPrompts(st.bridge)).toHaveLength(1)
      st.release('select 1'); await p
    })

    it('cancel while streaming calls cancelGeneration and the late final result is ignored', async () => {
      const st = streamSetup()
      const { c, base } = mkS(st)
      await c.load()
      const p = c.send('x', base.ctx())
      await flush()
      st.bridge.emit('host.ai.generationChunk', { requestId: st.rid(), delta: 'sel' })
      c.cancel()
      await flush()
      expect(calls(st, 'host.ai.cancelGeneration')).toHaveLength(1)
      st.release('select 9')
      expect(await p).toBeNull()
      await flush()
      expect(c.messages.value.map((m) => m.role)).toEqual(['user'])
      expect(c.busy.value).toBe(false)
    })

    it('new turn after cancel works; the old turn cannot resurrect', async () => {
      const st = streamSetup()
      const { c, base } = mkS(st)
      await c.load()
      const p1 = c.send('one', base.ctx())
      await flush()
      const oldRid = st.rid()
      const oldRelease = (v: string) => st.releaseAt(0, v)
      c.cancel()
      await flush()
      const p2 = c.send('two', base.ctx())
      await flush()
      st.bridge.emit('host.ai.generationChunk', { requestId: oldRid, delta: 'STALE' })
      oldRelease('select old')
      expect(await p1).toBeNull()
      expect(c.messages.value.filter((m) => m.role === 'assistant')).toHaveLength(0)
      st.release('select new')
      expect(await p2).toEqual({ payload: { sql: 'select new' } })
      expect(c.messages.value.map((m) => m.parts[0].text)).toEqual(['one', 'two', 'select new'])
    })
  })
})

describe('NEED_ chain', () => {
  const empty = (): Retrieved => ({ lists: [], schemas: [], notes: [], summary: {} })
  function chain(opts: Parameters<typeof setup>[0] = {}, fetchImpl?: (need: any) => Promise<Retrieved>) {
    const s = setup(opts)
    const fetches: any[] = []
    const retrievedSeen: (Retrieved | undefined)[] = []
    const base = s.ctx()
    const ctx: TurnContext = {
      ...base,
      buildInput: (send, h, u, _alive, retrieved) => { retrievedSeen.push(retrieved); return { ...(base.buildInput(send, h, u) as any), notes: retrieved?.notes } },
      catalog: {
        fetch: async (need) => {
          fetches.push(need)
          return fetchImpl ? fetchImpl(need) : { ...empty(), summary: { ...(need.list ? { list: true } : {}), ...(need.tables ? { tables: need.tables } : {}) } }
        },
      },
    }
    return { s, fetches, retrievedSeen, ctx }
  }
  const stored = async (s: ReturnType<typeof setup>) => (await s.chat.load('/n.sqlnb', 'b1')).messages

  it('NEED_TABLES then SQL: 2 generation requests, one user msg + one assistant msg saved, notice "read table structure: A, B"', async () => {
    let cs: ReturnType<typeof useChatSession> | undefined
    const seen: unknown[] = []
    const { s, ctx, fetches } = chain({ replies: ['NEED_TABLES: A, B', 'select 1'] }, async (n) => { seen.push(...cs!.notices.value); return { ...empty(), summary: { tables: n.tables } } })
    const c = s.mk(); cs = c; await c.load()
    const p = c.send('go', ctx)
    expect(await p).toEqual({ payload: { sql: 'select 1' } })
    expect(seen).toEqual([{ kind: 'tables', names: ['A', 'B'] }])
    expect(s.prompts()).toHaveLength(2)
    expect(fetches).toEqual([{ tables: ['A', 'B'] }])
    const m = await stored(s)
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(m[1].catalog).toEqual({ tables: ['A', 'B'] })
  })

  it('three NEED rounds then a SQL → 4 requests, success; a fourth NEED → stop with the limit message, 4 requests total, nothing saved but the user message', async () => {
    expect(MAX_AUTO_ROUNDS).toBe(3)
    const ok = chain({ replies: ['NEED_LIST:', 'NEED_TABLES: a', 'NEED_TABLES: b', 'select 1'] })
    const c1 = ok.s.mk(); await c1.load()
    expect(await c1.send('go', ok.ctx)).toEqual({ payload: { sql: 'select 1' } })
    expect(ok.s.prompts()).toHaveLength(4)
    const bad = chain({ replies: ['NEED_LIST:', 'NEED_TABLES: a', 'NEED_TABLES: b', 'NEED_TABLES: c'] })
    const c2 = bad.s.mk(); await c2.load()
    expect(await c2.send('go', bad.ctx)).toBeNull()
    expect(bad.s.prompts()).toHaveLength(4)
    expect(c2.error.value).toBe(t('ai.catalog.limit'))
    expect((await stored(bad.s)).map((x) => x.role)).toEqual(['user'])
    expect(c2.busy.value).toBe(false)
  })

  it('every round awaits aiSettings.sendOptions and a toggle flipped off mid-chain stops before the next request with zero further catalog queries', async () => {
    let n = 0
    const { s, ctx, fetches } = chain({ replies: ['NEED_TABLES: a', 'NEED_TABLES: b', 'select 1'], send: async () => ({ schema: ++n < 4, sql: true, data: true }) })
    const c = s.mk(); await c.load()
    expect(await c.send('go', ctx)).toBeNull()
    expect(n).toBe(4)
    expect(fetches).toHaveLength(1)
    expect(s.prompts()).toHaveLength(1)
    expect(c.error.value).toBe(t('ai.catalog.off'))
    expect((await stored(s)).map((x) => x.role)).toEqual(['user'])
  })

  describe('options are re-read after every await before the prompt is built', () => {
    const secretCtx = (opts: Parameters<typeof setup>[0], flip: () => void) => {
      const k = chain(opts, async (need) => { flip(); return { ...empty(), schemas: [{ name: 'SECRET_T', columns: [{ name: 'SECRET_COL', dataType: 'int', nullable: true }] }], notes: ['NOTE_SECRET'], summary: { tables: need.tables } } })
      const base = k.ctx
      const ctx: TurnContext = { ...base, buildInput: (send, h, u, a, r) => { const i = base.buildInput(send, h, u, a, r) as any; return { ...i, schemas: r?.schemas ?? [], notes: r?.notes } } }
      return { ...k, ctx }
    }
    it('schema flipped off INSIDE the fetch: no further request, no structures in any prompt, no catalog summary, nothing saved', async () => {
      let schema = true
      const { s, ctx } = secretCtx({ replies: ['NEED_TABLES: a', 'select 1'], send: async () => ({ schema, sql: true, data: true }) }, () => { schema = false })
      const c = s.mk(); await c.load()
      expect(await c.send('go', ctx)).toBeNull()
      expect(s.prompts()).toHaveLength(1)
      expect(s.prompts().join('')).not.toContain('SECRET_')
      expect(c.error.value).toBe(t('ai.catalog.off'))
      const m = await stored(s)
      expect(m.map((x) => x.role)).toEqual(['user'])
      expect(JSON.stringify(m)).not.toContain('catalog')
      expect(c.notices.value).toEqual([])
    })
    it('schema flipped off during turn 0 buildInput (the first list fetch): the request is not sent', async () => {
      let schema = true
      const { s, ctx } = chain({ replies: ['select 1'], send: async () => ({ schema, sql: true, data: true }) })
      const base = ctx.buildInput
      const c = s.mk(); await c.load()
      const flipping: TurnContext = { ...ctx, buildInput: async (a, b, d, e, f) => { const r = await base(a, b, d, e, f); schema = false; return { ...r, tableList: { scope: '', names: ['SECRET_T'], truncated: false } } as any } }
      expect(await c.send('go', flipping)).toBeNull()
      expect(s.prompts()).toHaveLength(0)
      expect(c.error.value).toBe(t('ai.catalog.off'))
    })
    it('data and sql flipped off mid-chain: later rounds carry no result, draft or baseline; flags never re-enable', async () => {
      let o = { schema: true, sql: true, data: true }
      const { s, ctx } = chain({ replies: ['NEED_TABLES: a', 'select 1'], send: async () => ({ ...o }) }, async (n) => { o = { schema: true, sql: false, data: false }; return { ...empty(), summary: { tables: n.tables } } })
      const base = ctx.buildInput
      const c = s.mk(); await c.load()
      await c.send('go', { ...ctx, buildInput: (a, b, d, e, f) => ({ ...(base(a, b, d, e, f) as any), baseline: 'BASELINE_PROBE' }) })
      const ps = s.prompts()
      expect(ps).toHaveLength(2)
      expect(ps[0]).toContain(PROBE); expect(ps[0]).toContain('BASELINE_PROBE'); expect(ps[0]).toContain('[CURRENT SQL]')
      expect(ps[1]).not.toContain(PROBE); expect(ps[1]).not.toContain('BASELINE_PROBE'); expect(ps[1]).not.toContain('[CURRENT SQL]')
    })
    it('a flag that was off at the start of the turn is not enabled mid-chain', async () => {
      let o = { schema: true, sql: true, data: false }
      const { s, ctx } = chain({ replies: ['NEED_TABLES: a', 'select 1'], send: async () => ({ ...o }) }, async (n) => { o = { schema: true, sql: true, data: true }; return { ...empty(), summary: { tables: n.tables } } })
      const c = s.mk(); await c.load()
      await c.send('go', ctx)
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts().join('')).not.toContain(PROBE)
    })
  })

  it('asking again for names already requested (any case) → ONE answer-now round, no second fetch, no limit error', async () => {
    const { s, ctx, fetches } = chain({ replies: ['NEED_TABLES: a, B', 'NEED_TABLES: A, b', 'select 1'] })
    const c = s.mk(); await c.load()
    expect(await c.send('go', ctx)).toEqual({ payload: { sql: 'select 1' } })
    expect(fetches).toHaveLength(1)
    expect(s.prompts()).toHaveLength(3)
    expect(s.prompts()[2]).toContain('already')
    expect(c.error.value).toBe('')
  })

  it('raw output on a parse failure never shows NEED lines; the limit error shows no raw output', async () => {
    const a = chain({ replies: ['NEED_TABLES: a\nBAD'], send: async () => ({ schema: false, sql: true, data: true }) })
    const c1 = a.s.mk(); await c1.load()
    await c1.send('go', a.ctx)
    expect(c1.error.value).not.toBe('')
    expect(c1.rawOutput.value).not.toContain('NEED_')
    const b = chain({ replies: ['NEED_LIST:', 'NEED_TABLES: a', 'NEED_TABLES: b', 'NEED_TABLES: c'] })
    const c2 = b.s.mk(); await c2.load()
    await c2.send('go', b.ctx)
    expect(c2.error.value).toBe(t('ai.catalog.limit'))
    expect(c2.rawOutput.value).toBe('')
  })

  it('another request starting during the fetch: the next round fails safe with the busy error and saves nothing', async () => {
    const s = setup({ hold: true })
    const base = s.ctx()
    const ctx: TurnContext = { ...base, catalog: { fetch: async () => { void s.client.generate({ task: 'command-generation', prompt: 'other' }).catch(() => {}); return empty() } } }
    const c = s.mk(); await c.load()
    const p = c.send('go', ctx)
    await flush()
    s.release('NEED_TABLES: a')
    await flush()
    expect(await p).toBeNull()
    expect(c.error.value).not.toBe('')
    expect((await stored(s)).map((x) => x.role)).toEqual(['user'])
    s.release('x')
  })

  it('cancel while the catalog fetch is pending: no further generate, late fetch result ignored, notices cleared', async () => {
    let done!: (r: Retrieved) => void
    const { s, ctx } = chain({ replies: ['NEED_TABLES: a', 'select 1'] }, () => new Promise<Retrieved>((r) => { done = r }))
    const c = s.mk(); await c.load()
    const p = c.send('go', ctx)
    await flush()
    expect(c.notices.value).toHaveLength(1)
    c.cancel()
    done({ ...empty(), summary: { tables: ['a'] } })
    expect(await p).toBeNull()
    await flush()
    expect(s.prompts()).toHaveLength(1)
    expect(c.notices.value).toEqual([])
    expect((await stored(s)).map((x) => x.role)).toEqual(['user'])
  })

  it('cancel during a later round aborts via the signal; close (dispose) too', async () => {
    for (const how of ['cancel', 'dispose'] as const) {
      const s = setup({ hold: true })
      const fetches: any[] = []
      const base = s.ctx()
      const ctx: TurnContext = { ...base, catalog: { fetch: async (n) => { fetches.push(n); return empty() } } }
      const c = s.mk(); await c.load()
      const p = c.send('go', ctx)
      await flush()
      s.release('NEED_TABLES: a')
      await flush()
      expect(s.prompts()).toHaveLength(2)
      c[how]()
      s.release('select 9')
      expect(await p).toBeNull()
      await flush()
      expect(s.prompts()).toHaveLength(2)
      expect(c.messages.value.map((m) => m.role)).toEqual(['user'])
    }
  })

  it('DBX consent declined in round 2 → error shown, chain ends, nothing saved', async () => {
    const { s, ctx } = chain({ replies: ['NEED_TABLES: a', '__DECLINE__', 'select 1'] })
    const c = s.mk(); await c.load()
    expect(await c.send('go', ctx)).toBeNull()
    expect(c.error.value).toBe(t('ai.err.consent-declined'))
    expect(s.prompts()).toHaveLength(2)
    expect((await stored(s)).map((x) => x.role)).toEqual(['user'])
  })

  it('intermediate NEED reply never appears in messages or in chat.save payloads', async () => {
    const { s, ctx } = chain({ replies: ['NEED_TABLES: SECRET_T', 'select 1'] })
    const saves: string[] = []
    const orig = s.chat.save.bind(s.chat)
    ;(s.chat as any).save = (...a: any[]) => { saves.push(JSON.stringify(a[2])); return (orig as any)(...a) }
    const c = s.mk(); await c.load()
    await c.send('go', ctx)
    expect(JSON.stringify(c.messages.value.map((m) => m.parts))).not.toContain('NEED_TABLES')
    expect(saves.join('')).not.toContain('NEED_TABLES')
    expect(saves.length).toBeGreaterThan(0)
  })

  it('NEED plus SQL in the same reply: SQL discarded, no sqlAfter on any saved message', async () => {
    const { s, ctx } = chain({ replies: ['NEED_TABLES: a\nselect 5', 'select 6'] })
    const c = s.mk(); await c.load()
    expect(await c.send('go', ctx)).toEqual({ payload: { sql: 'select 6' } })
    const m = await stored(s)
    expect(m.filter((x) => x.sqlAfter !== undefined).map((x) => x.sqlAfter)).toEqual(['select 6'])
    expect(JSON.stringify(m)).not.toContain('select 5')
  })

  it('schema off: NEED lines in a reply are not acted on, text shown without them', async () => {
    const { s, ctx, fetches } = chain({ replies: ['NEED_TABLES: a\nselect 3'], send: async () => ({ schema: false, sql: true, data: true }) })
    const c = s.mk(); await c.load()
    await c.send('go', ctx)
    expect(fetches).toHaveLength(0)
    expect(s.prompts()).toHaveLength(1)
    expect(c.messages.value[1].parts[0].text).toBe('select 3')
  })

  it('a second send during the chain is rejected (busy)', async () => {
    const s = setup({ hold: true })
    const base = s.ctx()
    const ctx: TurnContext = { ...base, catalog: { fetch: async () => empty() } }
    const c = s.mk(); await c.load()
    const p = c.send('go', ctx)
    await flush()
    s.release('NEED_TABLES: a')
    await flush()
    expect(await c.send('again', ctx)).toBeNull()
    expect(s.prompts()).toHaveLength(2)
    s.release('select 1')
    await p
  })

  it('notebook load during the chain stops it', async () => {
    const s = setup({ hold: true })
    const base = s.ctx()
    const ctx: TurnContext = { ...base, catalog: { fetch: async () => empty() } }
    const c = s.mk(); await c.load()
    const p = c.send('go', ctx)
    await flush()
    s.release('NEED_TABLES: a')
    await flush()
    s.store.generation.value++
    s.release('select 1')
    expect(await p).toBeNull()
    expect(c.busy.value).toBe(false)
  })

  it('history with catalog summary and schema off: prompt has no table names and the reply text is [earlier reply omitted]; with schema on the CATALOG READ line is present', () => {
    const history: any[] = [
      { id: '1', role: 'user', parts: [{ kind: 'text', text: 'q' }], at: 1 },
      { id: '2', role: 'assistant', parts: [{ kind: 'text', text: 'about SECRET_T' }], at: 2, catalog: { list: true, tables: ['SECRET_T'] } },
    ]
    const mk = (schema: boolean) => buildChatPrompt({ locale: 'en', dialect: 'PostgreSQL', send: { schema, sql: true, data: true }, purpose: 'sql', schemas: [], history, userText: 'x' }).text
    const off = mk(false)
    expect(off).not.toContain('SECRET_T')
    expect(off).toContain(OMITTED_REPLY)
    expect(mk(true)).toContain('[CATALOG READ: table list; tables: SECRET_T]')
  })

  describe('catalog marker when the first prompt already carried catalog data', () => {
    it('round-0 table list and structures mark the saved reply (names only); no marker when nothing was sent', async () => {
      const s = setup({ replies: ['answer one', 'answer two'] })
      const base = s.ctx()
      const withCat: TurnContext = { ...base, buildInput: (send, h, u) => ({ ...(base.buildInput(send, h, u) as any), tableList: { scope: '', names: ['ZED_T'], truncated: false }, schemas: [{ name: 'ZED_S', columns: [] }] }) }
      const c = s.mk(); await c.load()
      await c.send('go', withCat)
      expect(c.messages.value[1].catalog).toEqual({ list: true, tables: ['ZED_S'] })
      const s2 = setup({ replies: ['plain'] })
      const c2 = s2.mk(); await c2.load()
      await c2.send('go', s2.ctx())
      expect(c2.messages.value[1].catalog).toBeUndefined()
    })
    it('schema off at send time: no marker', async () => {
      const s = setup({ replies: ['x'], send: async () => ({ schema: false, sql: true, data: true }) })
      const base = s.ctx()
      const c = s.mk(); await c.load()
      await c.send('go', { ...base, buildInput: (a, b, d) => ({ ...(base.buildInput(a, b, d) as any), tableList: { scope: '', names: ['ZED_T'], truncated: false } }) })
      expect(c.messages.value[1].catalog).toBeUndefined()
    })
  })
})

describe('bignumber purpose', () => {
  const reply = '[{"data":"t","field":"a","aggregate":"sum"}]'
  const tables = [{ name: 'SECRET_T', columns: [{ name: 'SECRET_COL', dataType: 'INTEGER' }] }]
  const bnCtx = (): TurnContext => ({
    task: 'command-generation',
    buildInput: (send, history, userText) => ({ locale: 'en', dialect: 'sqlite', send, purpose: 'bignumber', schemas: [], metricTables: tables, history, userText }),
    parse: (text) => (text.startsWith('QUESTION') ? { ok: true, reply: [{ kind: 'text', text }] } : { ok: true, reply: [{ kind: 'text', text }], metricsAfter: text }),
  })

  it('uses chat id <block>:bignumber and copies metricsAfter / metricsSampled onto the reply', async () => {
    const s = setup({ replies: [reply] })
    const c = useChatSession({ client: s.client, aiSettings: s.aiSettings, chat: s.chat, store: s.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c.load()
    await c.send('go', bnCtx())
    expect(c.messages.value[1].metricsAfter).toBe(reply)
    expect(c.messages.value[1].metricsSampled).toBe(false)
    await flush()
    expect((await s.chat.load('/n.sqlnb', 'b1:bignumber')).messages[1].metricsAfter).toBe(reply)
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toHaveLength(0)
  })

  it('schema flipped off between buildInput and send: no request, ai.catalog.off (positive control sends)', async () => {
    let n = 0
    const off = setup({ replies: [reply], send: async () => ({ schema: ++n < 2, sql: true, data: true }) })
    const c = useChatSession({ client: off.client, aiSettings: off.aiSettings, chat: off.chat, store: off.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c.load()
    expect(await c.send('go', bnCtx())).toBeNull()
    expect(genPrompts(off.bridge)).toHaveLength(0)
    expect((off.bridge.calls as any[]).filter((x) => /generateText/.test(String(x.args?.method)))).toHaveLength(0)
    expect(c.error.value).toBe(t('ai.catalog.off'))
    const on = setup({ replies: [reply] })
    const c2 = useChatSession({ client: on.client, aiSettings: on.aiSettings, chat: on.chat, store: on.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c2.load()
    await c2.send('go', bnCtx())
    expect(genPrompts(on.bridge)).toHaveLength(1)
    expect(genPrompts(on.bridge)[0]).toContain('SECRET_T')
  })
  it('the sampled flag is derived from what was sent, not from the parse callback', async () => {
    const withData = setup({ replies: [reply] })
    const c = useChatSession({ client: withData.client, aiSettings: withData.aiSettings, chat: withData.chat, store: withData.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c.load()
    const ctx = bnCtx()
    const input = ctx.buildInput
    ctx.buildInput = (send, h, u) => ({ ...(input(send, h, u) as any), metricTables: [{ ...tables[0], sample: { totalRows: 1, shownRows: 1, truncatedAtRun: false, columns: [{ name: 'SECRET_COL', nulls: 0, distinct: 1 }], rows: [['SAMPLE_CELL']] } }] })
    await c.send('go', ctx)
    expect(genPrompts(withData.bridge)[0]).toContain('SAMPLE_CELL')
    expect(c.messages.value[1].metricsSampled).toBe(true)
    const noData = setup({ replies: [reply], send: async () => ({ schema: true, sql: true, data: false }) })
    const c2 = useChatSession({ client: noData.client, aiSettings: noData.aiSettings, chat: noData.chat, store: noData.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c2.load()
    const ctx2 = bnCtx(); const input2 = ctx2.buildInput
    ctx2.buildInput = (send, h, u) => ({ ...(input2(send, h, u) as any), metricTables: [{ ...tables[0], sample: { totalRows: 1, shownRows: 1, truncatedAtRun: false, columns: [{ name: 'SECRET_COL', nulls: 0, distinct: 1 }], rows: [['SAMPLE_CELL']] } }] })
    await c2.send('go', ctx2)
    expect(genPrompts(noData.bridge)[0]).not.toContain('SAMPLE_CELL')
    expect(c2.messages.value[1].metricsSampled).toBe(false)
  })

  it('every bignumber reply of a schema-on turn is schema-marked (QUESTION too) and masked later; saved to the local cache', async () => {
    const s = setup({ replies: ['QUESTION: did you mean SECRET_T.SECRET_COL?'] })
    const c = useChatSession({ client: s.client, aiSettings: s.aiSettings, chat: s.chat, store: s.store }, { purpose: 'bignumber', blockId: 'b1' })
    await c.load()
    await c.send('go', bnCtx())
    const r = c.messages.value[1]
    expect(r.metricsAfter).toBeUndefined()
    expect(r.metricsSchema).toBe(true)
    await flush()
    const saved = (await s.chat.load('/n.sqlnb', 'b1:bignumber')).messages
    expect(saved[1].metricsSchema).toBe(true)
    const t = buildChatPrompt({ locale: 'en', dialect: 'sqlite', send: { schema: false, sql: true, data: true }, purpose: 'bignumber', schemas: [], history: saved, userText: 'again' }).text
    expect(t).not.toContain('SECRET_T')
  })

  describe('schema off at turn start refuses the turn with zero requests', () => {
    const streamBridge = () => createFakeBridge({
      caps: { aiCompletion: true, aiCompletionStream: true },
      requestHandlers: {
        'host.ai.listModels': async () => [{ configId: 'c', model: 'm', name: 'M', isDefault: true }],
        'host.ai.generateTextStream': async () => reply,
        'host.ai.generateText': async () => reply,
      },
    } as any)
    const mkSession = (bridge: any, schema: boolean) => {
      const base = setup()
      const aiSettings = { sendOptions: async () => ({ schema, sql: true, data: true }), effectiveModel: () => undefined } as any
      return useChatSession({ client: createAiClient(bridge), aiSettings, chat: createChatStore(bridge), store: base.store }, { purpose: 'bignumber', blockId: 'b1' })
    }
    it('non-streaming: schema off -> no request, schema on -> generateText observed', async () => {
      const off = setup({ replies: [reply], send: async () => ({ schema: false, sql: true, data: true }) })
      const c = useChatSession({ client: off.client, aiSettings: off.aiSettings, chat: off.chat, store: off.store }, { purpose: 'bignumber', blockId: 'b1' })
      await c.load()
      expect(await c.send('go', bnCtx())).toBeNull()
      expect(genRequests(off.bridge)).toHaveLength(0)
      expect(c.error.value).toBe(t('ai.catalog.off'))
      const on = setup({ replies: [reply] })
      const c2 = useChatSession({ client: on.client, aiSettings: on.aiSettings, chat: on.chat, store: on.store }, { purpose: 'bignumber', blockId: 'b1' })
      await c2.load(); await c2.send('go', bnCtx())
      expect(genRequests(on.bridge).map((x: any) => x.args.method)).toContain('host.ai.generateText')
    })
    it('streaming: schema off -> no request, schema on -> generateTextStream observed', async () => {
      const bOff = streamBridge()
      const c = mkSession(bOff, false); await c.load()
      expect(await c.send('go', bnCtx())).toBeNull()
      expect(genRequests(bOff)).toHaveLength(0)
      const bOn = streamBridge()
      const c2 = mkSession(bOn, true); await c2.load(); await c2.send('go', bnCtx())
      expect(genRequests(bOn).map((x: any) => x.args.method)).toContain('host.ai.generateTextStream')
    })
  })
})
