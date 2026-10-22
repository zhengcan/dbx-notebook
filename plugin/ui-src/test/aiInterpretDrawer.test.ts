import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { serializeNotebook } from '@sqlnb/format'
import InterpretDrawer from '../src/ai/InterpretDrawer.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { createChatStore } from '../src/ai/chatStore'
import { AiError, type AiClient, type AiRequest, type AiResult } from '../src/ai/aiClient'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, ConnectionsKey, StoreKey } from '../src/injection'
import { MAX_OUTPUT_CHARS } from '../src/ai/parse'
import { setLocale, t } from '../src/i18n'
import src from '../src/ai/InterpretDrawer.vue?raw'

const mounted: { unmount(): void }[] = []
const send0 = { schema: true, sql: true, data: true }

async function setup(opts: { send?: Partial<typeof send0>; rows?: number; wide?: number; prep?: (settings: { sendOptions: any }) => void; seed?: { messages: any[] }; chatLoadFails?: boolean } = {}) {
  setLocale('en')
  const bridge = createFakeBridge({ caps: { aiCompletion: true } })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.path.value = '/n.sqlnb'
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} } as any, { id: 'b2', type: 'sql', content: 'select 2', metadata: {} } as any)
  const n = opts.rows ?? 3
  store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'region' }, { name: 'amount' }, ...Array.from({ length: opts.wide ?? 0 }, (_, k) => ({ name: `w${k}` }))], rows: Array.from({ length: n }, (_, i) => [i === 0 ? 'PROBE_ROW' : `r${i}`, i, ...Array.from({ length: opts.wide ?? 0 }, (_, k) => `${k}`.padEnd(200, 'x'))]), truncated: false, elapsedMs: 1, dbType: 'postgres' } } as any)
  const calls: AiRequest[] = []
  let pending: { resolve(r: AiResult): void; reject(e: unknown): void } | null = null
  const client: AiClient = {
    available: () => true, streaming: () => true, busy: () => false, listModels: async () => [],
    generate: vi.fn((req: AiRequest) => new Promise<AiResult>((resolve, reject) => {
      calls.push(req)
      pending = { resolve, reject }
      req.signal?.addEventListener('abort', () => reject(new AiError('cancelled')))
    })),
  }
  const settings = { sendOptions: vi.fn(async () => ({ ...send0, ...opts.send })), effectiveModel: () => undefined }
  opts.prep?.(settings)
  const chat = createChatStore(bridge)
  if (opts.chatLoadFails) chat.load = async () => { throw new Error('storage down') }
  if (opts.seed) await chat.save('/n.sqlnb', 'b1:interpret', { v: 1, messages: opts.seed.messages, updated: 1 } as any)
  const closed = vi.fn()
  const mountIt = async () => {
    const w = mount(InterpretDrawer, {
      props: { spec: { purpose: 'interpret', blockId: 'b1' }, onClose: closed } as any,
      attachTo: document.body,
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: client, [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: chat } },
    })
    mounted.push(w)
    await flushPromises()
    return w
  }
  const w = await mountIt()
  // the drawer auto-generates on open: `gen` waits for that request
  const gen = async () => { await flushPromises() }
  const respond = async (text: string, truncated = false) => { pending!.resolve({ text, truncated }); await flushPromises(); await new Promise((r) => setTimeout(r, 10)); await flushPromises() }
  const fail = async (e: unknown) => { pending!.reject(e); await flushPromises() }
  const chatSend = async (text: string, wr = w) => {
    await wr.find('[data-test=chat-input]').setValue(text)
    await wr.find('[data-test=chat-send]').trigger('click')
    await flushPromises()
  }
  return { w, store, calls, client, settings, chat, closed, gen, respond, fail, chatSend, mountIt, bytes: () => serializeNotebook(store.nb.value) }
}

beforeEach(() => { while (mounted.length) { try { mounted.pop()!.unmount() } catch { /* already unmounted */ } } setLocale('en'); document.body.innerHTML = '' })

describe('InterpretDrawer', () => {
  it('opening generates one request by itself and previews through renderMarkdownSafe', async () => {
    const s = await setup()
    await s.gen()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0].task).toBe('rewrite')
    expect(s.calls[0].prompt).toContain('PROBE_ROW')
    await s.respond('# Hi\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![i](https://evil.example/a.png)')
    const pv = s.w.find('[data-test=interpret-preview]').element
    expect(pv.querySelector('h1')).not.toBeNull()
    expect(pv.querySelector('script')).toBeNull()
    expect(pv.querySelector('img')).toBeNull()
    expect(Array.from(pv.querySelectorAll('[href],[src]')).map((e) => (e.getAttribute('href') ?? '') + (e.getAttribute('src') ?? '')).join('|')).not.toMatch(/javascript:|evil\.example/)
    expect(s.calls.length).toBe(1)
  })

  it('follow-up sends history + latest markdown inside the fence, user text outside; preview updates', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## First\n\nLONG_MD_PROBE')
    await s.chatSend('make it shorter')
    expect(s.calls.length).toBe(2)
    const p = s.calls[1].prompt
    expect(p).toContain('LONG_MD_PROBE')
    const open = p.indexOf('\n<<<DATA'), close = p.lastIndexOf('DATA>>>')
    expect(p.indexOf('LONG_MD_PROBE')).toBeGreaterThan(open)
    expect(p.indexOf('LONG_MD_PROBE')).toBeLessThan(close)
    expect(p.indexOf('make it shorter')).toBeLessThan(p.indexOf('\n<<<DATA'))
    await s.respond('UPDATE: ## Short')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('Short')
    expect(s.w.find('[data-test=interpret-preview]').text()).not.toContain('First')
  })

  it('send.data off at turn 2: gate blocks with a reason, no request; stored history retained', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## First')
    s.settings.sendOptions.mockResolvedValue({ schema: true, sql: true, data: false })
    await s.chatSend('shorter')
    expect(s.calls.length).toBe(1)
    expect(s.w.find('[data-test=chat-disabled-reason]').text()).toBe(t('ai.interpret.gate.no-data-setting'))
    const rec = await s.chat.load('/n.sqlnb', 'b1:interpret')
    expect(rec.messages.some((m) => m.markdownAfter === '## First')).toBe(true)
  })

  it('send.data off from the start: no buttons, chat disabled with the reason; typing sends nothing; switching on then sends one', async () => {
    const s = await setup({ send: { data: false } })
    expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
    expect(s.w.find('[data-test=chat-disabled-reason]').text()).toBe(t('ai.interpret.gate.no-data-setting'))
    expect(s.w.find('[data-test=interpret-reason]').text()).toBe(t('ai.interpret.gate.no-data-setting'))
    await s.chatSend('hi')
    expect(s.calls.length).toBe(0)
    expect(s.client.generate).not.toHaveBeenCalled()
    s.settings.sendOptions.mockResolvedValue({ ...send0 })
    s.w.unmount()
    await s.mountIt()
    expect(s.calls.length).toBe(1)
  })

  it('insert: RAW markdown block right after the SQL block, one history entry, undo removes it', async () => {
    const s = await setup()
    const before = s.bytes()
    const depth = s.store.history.undoDepth.value
    await s.gen()
    const raw = '## Findings\n\n- **a** <b>x</b>'
    await s.respond(raw)
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    const blocks = s.store.nb.value.blocks
    expect(blocks[1].type).toBe('markdown')
    expect(blocks[1].content).toBe(raw)
    expect(blocks[0].id).toBe('b1')
    expect(s.store.history.undoDepth.value).toBe(depth + 1)
    expect(s.store.appliedNotice.value?.blockId).toBe(blocks[1].id)
    expect(s.closed).toHaveBeenCalled()
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })

  it('Insert disabled until there is an interpretation', async () => {
    const s = await setup()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
  })

  it('Esc / Discard: no block added, running request cancelled', async () => {
    const s = await setup()
    const before = s.bytes()
    await s.gen()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(s.closed).toHaveBeenCalled()
    s.w.unmount()
    expect((s.calls[0].signal as AbortSignal).aborted).toBe(true)
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
  })

  it('reopen restores chat and the last markdown (separate key from the SQL chat)', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## Remembered')
    s.w.unmount()
    const w2 = await s.mountIt()
    expect(w2.find('[data-test=interpret-preview]').text()).toContain('Remembered')
    expect(w2.findAll('[data-test=chat-msg]').length).toBe(2)
    expect((await s.chat.load('/n.sqlnb', 'b1')).messages).toEqual([])
    expect((await s.chat.load('/n.sqlnb', 'b1:interpret')).messages.length).toBe(2)
  })

  it('block deleted while open: insert disabled with reason', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## Findings')
    s.store.nb.value.blocks.splice(0, 1)
    await flushPromises()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    expect(s.store.nb.value.blocks.map((b) => b.type)).toEqual(['sql'])
  })

  it('empty / over-long model output: alert, show-model-output kept, zero change', async () => {
    for (const out of ['   ', 'x'.repeat(MAX_OUTPUT_CHARS + 1)]) {
      const hasRaw = out.trim() !== ''
      const s = await setup()
      const before = s.bytes()
      await s.gen()
      await s.respond(out)
      expect(s.w.find('[data-test=chat-error]').attributes('role')).toBe('alert')
      expect(s.w.find('[data-test=chat-error]').text()).toContain(out.trim() ? t('ai.err.truncated') : t('ai.err.empty'))
      expect(s.w.find('[data-test=raw-output]').exists()).toBe(hasRaw)
      expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
      expect(s.bytes()).toBe(before)
    }
  })

  it('host errors surface with the 0.5.x wording; busy resets and the retry hint shows', async () => {
    for (const [e, key] of [[new AiError('consent-declined'), 'ai.err.consent-declined'], [new AiError('timeout'), 'ai.err.timeout']] as const) {
      const s = await setup()
      await s.gen()
      await s.fail(e)
      expect(s.w.find('[data-test=chat-error]').text()).toContain(t(key as any))
      expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
      expect(s.w.find('[data-test=interpret-retry]').text()).toBe(t('drawer.interpret.retryHint'))
    }
  })

  it('before any request only the generic sample note; after it, the note states the rows actually sent', async () => {
    const s = await setup({ rows: 51, send: { data: false } })
    expect(s.w.find('[data-test=interpret-trunc]').exists()).toBe(false)
    expect(s.w.find('[data-test=interpret-sample]').text()).toBe(t('drawer.interpret.sample'))
    expect(s.calls.length).toBe(0)
    const s1 = await setup({ rows: 51 })
    expect(s1.w.find('[data-test=interpret-trunc]').text()).toContain('first 50 rows and column stats')
    const s2 = await setup({ rows: 3 })
    expect(s2.w.find('[data-test=interpret-sample]').exists()).toBe(false)
    expect(s2.w.find('[data-test=interpret-trunc]').exists()).toBe(false)
  })

  it('wide result: rows the prompt builder dropped are reflected in the note', async () => {
    const s = await setup({ rows: 50, wide: 40 })
    await s.gen()
    const m = /first (\d+) rows/.exec(s.w.find('[data-test=interpret-trunc]').text())
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThan(50)
    expect(s.calls[0].prompt.length).toBeLessThanOrEqual(100_000)
  })

  it('TOCTOU: data on at the pre-check, off at the turn read -> zero requests, reason shown as alert', async () => {
    const s = await setup({ prep: (st) => { st.sendOptions.mockReset(); st.sendOptions.mockResolvedValueOnce({ ...send0 }).mockResolvedValueOnce({ ...send0 }).mockResolvedValue({ ...send0, data: false }) } })
    await s.gen()
    expect(s.client.generate).not.toHaveBeenCalled()
    const e = s.w.find('[data-test=chat-error]')
    expect(e.attributes('role')).toBe('alert')
    expect(e.text()).toBe(t('ai.interpret.gate.no-data-setting'))
    expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
  })

  it('result re-run after the cached interpretation: hint shown, Insert stays allowed', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## Old')
    expect(s.w.find('[data-test=interpret-stale]').exists()).toBe(false)
    s.store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'region' }], rows: [['new']], truncated: false, elapsedMs: 1, dbType: 'postgres' } } as any)
    await flushPromises()
    expect(s.w.find('[data-test=interpret-stale]').text()).toBe(t('drawer.interpret.stale'))
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeUndefined()
    s.w.unmount()
    const w2 = await s.mountIt()
    expect(w2.find('[data-test=interpret-stale]').exists()).toBe(true)
  })

  it('cancel while preparing: nothing is ever sent', async () => {
    let release!: () => void
    const s = await setup({ prep: (st) => {
      st.sendOptions.mockResolvedValueOnce({ ...send0 }).mockResolvedValueOnce({ ...send0 })
      st.sendOptions.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ...send0 }) }))
    } })
    await s.gen()
    await s.w.find('[data-test=chat-cancel]').trigger('click'); await flushPromises()
    release(); await flushPromises()
    expect(s.client.generate).not.toHaveBeenCalled()
  })

  it('zh-CN prompt asks for Chinese', async () => {
    const s = await setup()
    s.w.unmount()
    s.calls.length = 0
    s.settings.sendOptions.mockResolvedValue({ ...send0 })
    setLocale('zh-CN')
    await s.mountIt()
    await s.gen()
    expect(s.calls[0].prompt).toContain('简体中文')
  })

  it('chat messages are not in the serialized notebook', async () => {
    const s = await setup()
    await s.gen()
    await s.respond('## PROBE_MD_OUT')
    expect(s.bytes()).not.toContain('PROBE_MD_OUT')
    expect(s.bytes()).not.toContain('PROBE_ROW')
    expect(s.bytes()).not.toContain(t('drawer.interpret.firstTurn'))
  })

  it('notebook load mid-flight: request cancelled, late reply dropped', async () => {
    const s = await setup()
    await s.gen()
    const signal = s.calls[0].signal!
    s.store.load(serializeNotebook({ ...s.store.nb.value, blocks: [{ id: 'b1', type: 'sql', content: 'other', metadata: {} }] } as any), null, null)
    await flushPromises()
    expect(signal.aborted).toBe(true)
    await s.respond('## late').catch(() => {})
    expect(s.w.find('[data-test=interpret-preview]').exists()).toBe(false)
  })

  it('opens and immediately generates once when no cached interpretation (consent is the host gate)', async () => {
    const s = await setup()
    await s.gen()
    expect(s.calls.length).toBe(1)
    expect(s.calls[0].prompt).toContain('UPDATE:')
    expect(s.w.find('[data-test=interpret-auto]').exists()).toBe(true)
  })

  it('cached interpretation: shown, zero generation calls on open, earlier-result note kept, no buttons', async () => {
    const s = await setup()
    await s.respond('## Cached')
    s.w.unmount()
    s.calls.length = 0
    s.store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'region' }], rows: [['other']], truncated: false, elapsedMs: 1, dbType: 'postgres' } } as any)
    const w2 = await s.mountIt()
    expect(s.calls.length).toBe(0)
    expect(w2.find('[data-test=interpret-preview]').text()).toContain('Cached')
    expect(w2.find('[data-test=interpret-stale]').text()).toBe(t('drawer.interpret.stale'))
    expect(w2.find('[data-test=interpret-generate]').exists()).toBe(false)
    expect(w2.find('[data-test=interpret-retry]').exists()).toBe(false)
  })

  it('send-result-data off: entry stays disabled, zero calls', async () => {
    const s = await setup({ send: { data: false } })
    expect(s.calls.length).toBe(0)
    expect(s.client.generate).not.toHaveBeenCalled()
    expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
    expect(s.w.find('[data-test=interpret-auto]').exists()).toBe(false)
  })

  it('closing right after open cancels the auto request and saves nothing', async () => {
    const s = await setup()
    s.w.unmount()
    await flushPromises()
    expect((s.calls[0].signal as AbortSignal).aborted).toBe(true)
    expect(s.calls.length).toBe(1)
    expect((await s.chat.load('/n.sqlnb', 'b1:interpret')).messages.some((m) => m.markdownAfter !== undefined)).toBe(false)
  })

  it('auto-generate does not fire twice', async () => {
    const s = await setup()
    await s.gen()
    await new Promise((r) => setTimeout(r, 30)); await flushPromises()
    expect(s.calls.length).toBe(1)
  })

  it('ANSWER reply: bubble shows only the answer, preview unchanged, no markdownAfter saved', async () => {
    const s = await setup()
    await s.respond('## Base\n\nBODY_MD')
    await s.chatSend('what is the total?')
    await s.respond('ANSWER: The total is 42.')
    const msgs = s.w.findAll('[data-test=chat-msg]').map((m) => m.text())
    expect(msgs[msgs.length - 1]).toContain('The total is 42.')
    expect(msgs[msgs.length - 1]).not.toContain('ANSWER')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('BODY_MD')
    const rec = await s.chat.load('/n.sqlnb', 'b1:interpret')
    const last = rec.messages[rec.messages.length - 1]
    expect(last.markdownAfter).toBeUndefined()
    expect(rec.messages.filter((m) => m.markdownAfter !== undefined).length).toBe(1)
  })

  it('UPDATE reply: preview replaced, bubble is the short note, not the interpretation', async () => {
    const s = await setup()
    await s.respond('## Base')
    await s.chatSend('shorter')
    await s.respond('UPDATE: ## Shorter\n\nUNIQUE_NEW_BODY')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('UNIQUE_NEW_BODY')
    const msgs = s.w.findAll('[data-test=chat-msg]').map((m) => m.text())
    expect(msgs[msgs.length - 1]).toContain(t('drawer.interpret.updated'))
    expect(msgs[msgs.length - 1]).not.toContain('UNIQUE_NEW_BODY')
  })

  it('no Generate / Regenerate buttons in any state (by data-test and by label)', async () => {
    const s = await setup()
    const check = () => {
      expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
      const labels = s.w.findAll('button').map((b) => b.text())
      for (const k of ['drawer.interpret.generate', 'drawer.interpret.regenerate']) expect(labels).not.toContain(k)
      expect(labels).not.toContain('Generate'); expect(labels).not.toContain('Regenerate'); expect(labels).not.toContain('生成结果'); expect(labels).not.toContain('重新生成')
    }
    check()
    await s.respond('## Base')
    check()
  })

  it('no interpretation (auto-generate failed): hint shown; typing any text is a forced generate, unmarked reply becomes the interpretation', async () => {
    const s = await setup()
    await s.fail(new AiError('timeout'))
    expect(s.calls.length).toBe(1)
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(true)
    const hint = s.w.find('[data-test=interpret-retry]')
    expect(hint.text()).toBe(t('drawer.interpret.retryHint'))
    expect(hint.attributes('role')).toBe('status')
    await s.chatSend('try again')
    expect(s.calls.length).toBe(2)
    expect(s.calls[1].prompt).toContain('UPDATE:')
    await s.respond('Plain prose interpretation.')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('Plain prose interpretation.')
    expect(s.w.find('[data-test=interpret-retry]').exists()).toBe(false)
  })

  it('no interpretation: an empty UPDATE is an error', async () => {
    const s = await setup()
    await s.fail(new AiError('timeout'))
    await s.chatSend('go')
    await s.respond('UPDATE:')
    expect(s.w.find('[data-test=interpret-preview]').exists()).toBe(false)
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(true)
  })

  it('interpretation present: typed text with an unmarked reply is an answer and does not overwrite', async () => {
    const s = await setup()
    await s.respond('## Base\n\nBASE_BODY')
    await s.chatSend('hi')
    await s.respond('Just prose.')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('BASE_BODY')
    expect(s.w.find('[data-test=interpret-preview]').text()).not.toContain('Just prose.')
  })

  it('first generation forces update even without a marker', async () => {
    const s = await setup()
    await s.respond('Just a sentence about the data.')
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('Just a sentence about the data.')
  })

  it('unmarked short prose on a chat turn is an answer (preview unchanged)', async () => {
    const s = await setup()
    await s.respond('## Base')
    await s.chatSend('why?')
    await s.respond('Because of X.')
    expect(s.w.find('[data-test=interpret-preview]').text()).not.toContain('Because of X.')
    expect(s.w.findAll('[data-test=chat-msg]').pop()!.text()).toContain('Because of X.')
  })

  it('left panel fills height: .id height:100%, .pv-wrap/.pv flex:1 with overflow:auto, no max-height:60vh', () => {
    const css = src.slice(src.indexOf('<style'))
    expect(css).toMatch(/\.id\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.pv-wrap\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/)
    expect(css).toMatch(/\.pv\s*\{(?=[^}]*flex:\s*1)(?=[^}]*overflow:\s*auto)/)
    expect(css).not.toMatch(/max-height:\s*60vh/)
  })

  it('unmarked bullet-list / heading chat replies are answers: preview and markdownAfter unchanged', async () => {
    for (const reply of ['Three reasons:\n- a\n- b\n- c', '## Why\n\nBecause.']) {
      const s = await setup()
      await s.respond('## Base\n\nBASE_BODY')
      await s.chatSend('why?')
      await s.respond(reply)
      expect(s.w.find('[data-test=interpret-preview]').text()).toContain('BASE_BODY')
      const rec = await s.chat.load('/n.sqlnb', 'b1:interpret')
      expect(rec.messages.filter((m) => m.markdownAfter !== undefined).length).toBe(1)
      expect(s.w.findAll('[data-test=chat-msg]').pop()!.text()).toContain(reply.includes('Why') ? 'Because.' : 'Three reasons')
    }
  })

  it('re-run while the auto request is in flight: reply is stamped with the build-time result, earlier-result hint shows', async () => {
    const s = await setup()
    expect(s.calls.length).toBe(1)
    s.store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'region' }], rows: [['changed']], truncated: false, elapsedMs: 1, dbType: 'postgres' } } as any)
    await flushPromises()
    await s.respond('## Late')
    expect(s.w.find('[data-test=interpret-stale]').exists()).toBe(true)
  })

  it('cached chat fails to load: no auto-generate over an unknown cache; retry hint shown, typing generates', async () => {
    const s = await setup({ chatLoadFails: true })
    await flushPromises()
    expect(s.calls.length).toBe(0)
    expect(s.w.find('[data-test=interpret-retry]').text()).toBe(t('drawer.interpret.retryHint'))
    await s.chatSend('hi')
    expect(s.calls.length).toBe(1)
    expect(s.calls[0].prompt).toContain('UPDATE:')
  })

  it('seeded cached interpretation (no unmount trick): no auto-generate, zero calls', async () => {
    const s = await setup({ seed: { messages: [
      { id: 'u', role: 'user', parts: [{ kind: 'text', text: 'q' }], at: 1 },
      { id: 'a', role: 'assistant', parts: [{ kind: 'text', text: 'ok' }], markdownAfter: '## Seeded', at: 2 },
    ] } })
    await flushPromises()
    expect(s.calls.length).toBe(0)
    expect(s.w.find('[data-test=interpret-preview]').text()).toContain('Seeded')
  })

  it('data off with a seeded chat holding ANSWER text: no interpret prompt is built or sent', async () => {
    const s = await setup({ send: { data: false }, seed: { messages: [
      { id: 'u', role: 'user', parts: [{ kind: 'text', text: 'q' }], at: 1 },
      { id: 'a', role: 'assistant', parts: [{ kind: 'text', text: 'PROBE_ANSWER_TEXT' }], at: 2 },
    ] } })
    await s.chatSend('again')
    expect(s.calls.length).toBe(0)
    expect(s.client.generate).not.toHaveBeenCalled()
  })

  it('UPDATE after data was turned off between turns: refused with the reason, zero further requests', async () => {
    const s = await setup()
    await s.respond('## Base')
    expect(s.calls.length).toBe(1)
    s.settings.sendOptions.mockResolvedValue({ ...send0, data: false })
    await s.chatSend('UPDATE: shorter please')
    expect(s.calls.length).toBe(1)
    expect(s.w.find('[data-test=chat-disabled-reason]').text()).toBe(t('ai.interpret.gate.no-data-setting'))
  })
})
