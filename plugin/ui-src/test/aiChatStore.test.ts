import { describe, it, expect } from 'vitest'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createChatStore, chatKey, hashPath, CHAT_LIMITS } from '../src/ai/chatStore'
import type { ChatMessage, ChatRecord } from '../src/ai/chatTypes'

const msg = (id: string, text: string, kind: 'text' | 'data' = 'text', role: 'user' | 'assistant' = 'user'): ChatMessage =>
  ({ id, role, parts: [{ kind, text }], at: 1 })
const rec = (messages: ChatMessage[], extra: Partial<ChatRecord> = {}): ChatRecord => ({ v: 1, messages, updated: 1, ...extra })

describe('chatStore', () => {
  it('save then load round-trips messages incl. data-tagged parts', async () => {
    const s = createChatStore(createFakeBridge())
    const r = rec([msg('1', 'hi'), { ...msg('2', 'rows: 3', 'data', 'assistant'), sqlAfter: 'select 1' }], { baseline: 'select 0' })
    await s.save('/a.sqlnb', 'b1', r)
    const got = await s.load('/a.sqlnb', 'b1')
    expect(got.messages).toEqual(r.messages)
    expect(got.baseline).toBe('select 0')
    expect(got.v).toBe(1)
  })

  it('markdownAfter round-trips', async () => {
    const s = createChatStore(createFakeBridge())
    const r = rec([{ ...msg('2', 'ok', 'text', 'assistant'), markdownAfter: '## md' }])
    await s.save('/a.sqlnb', 'b1:interpret', r)
    expect((await s.load('/a.sqlnb', 'b1:interpret')).messages).toEqual(r.messages)
    expect((await s.load('/a.sqlnb', 'b1')).messages).toEqual([])
  })

  it('key uses path hash + block id and never contains the path or any message text', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    const path = '/Users/secret/notebook.sqlnb'
    await s.save(path, 'blk', rec([msg('1', 'SECRETTEXT')]))
    expect(chatKey(path, 'blk')).toBe('ai.chat.v1.' + hashPath(path) + '.blk')
    for (const c of b.calls as any[]) {
      if (c.method !== 'storageSet') continue
      expect(c.args.key).not.toContain('secret')
      expect(c.args.key).not.toContain('notebook')
      expect(JSON.stringify(c.args.value)).not.toContain('/Users/secret')
    }
    const chatSet = (b.calls as any[]).find((c) => c.method === 'storageSet' && c.args.key === chatKey(path, 'blk'))
    expect(chatSet).toBeTruthy()
  })

  it('two blocks and two paths are isolated', async () => {
    const s = createChatStore(createFakeBridge())
    await s.save('/a', 'b1', rec([msg('1', 'a-b1')]))
    await s.save('/a', 'b2', rec([msg('2', 'a-b2')]))
    await s.save('/b', 'b1', rec([msg('3', 'b-b1')]))
    expect((await s.load('/a', 'b1')).messages[0].id).toBe('1')
    expect((await s.load('/a', 'b2')).messages[0].id).toBe('2')
    expect((await s.load('/b', 'b1')).messages[0].id).toBe('3')
  })

  it('null path: load returns empty, save writes nothing (no storageSet call)', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    await s.save(null, 'b1', rec([msg('1', 'x')]))
    expect((await s.load(null, 'b1')).messages).toEqual([])
    expect((b.calls as any[]).filter((c) => c.method === 'storageSet')).toEqual([])
  })

  it('per-block caps: >maxMessages drops oldest messages; >maxCharsPerBlock drops oldest until it fits', async () => {
    const s = createChatStore(createFakeBridge(), { maxMessages: 3, maxCharsPerBlock: 10 })
    await s.save('/a', 'b', rec(['1', '2', '3', '4', '5'].map((i) => msg(i, 'x'))))
    expect((await s.load('/a', 'b')).messages.map((m) => m.id)).toEqual(['3', '4', '5'])
    await s.save('/a', 'c', rec([msg('1', 'aaaaaa'), msg('2', 'bbbbbb'), msg('3', 'cccccc')]))
    expect((await s.load('/a', 'c')).messages.map((m) => m.id)).toEqual(['3'])
  })

  it('eviction: saving block 31 evicts the least-recently-updated block (its key set to null, index updated)', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    for (let i = 0; i < CHAT_LIMITS.maxBlocks + 1; i++) await s.save('/a', 'b' + i, rec([msg('1', 'x')]))
    expect((b.calls as any[]).some((c) => c.method === 'storageSet' && c.args.key === chatKey('/a', 'b0') && c.args.value === null)).toBe(true)
    expect((await s.load('/a', 'b0')).messages).toEqual([])
    expect((await s.load('/a', 'b1')).messages.length).toBe(1)
    expect((await s.load('/a', 'b30')).messages.length).toBe(1)
    const idx = await b.storageGet<Record<string, unknown>>('ai.chat.index.v1')
    expect(Object.keys(idx!).length).toBe(CHAT_LIMITS.maxBlocks)
    expect(idx![chatKey('/a', 'b0')]).toBeUndefined()
  })

  it('eviction by total chars', async () => {
    const s = createChatStore(createFakeBridge(), { maxCharsTotal: 25 })
    await s.save('/a', 'b0', rec([msg('1', 'x'.repeat(10))]))
    await s.save('/a', 'b1', rec([msg('1', 'y'.repeat(10))]))
    await s.save('/a', 'b2', rec([msg('1', 'z'.repeat(10))]))
    expect((await s.load('/a', 'b0')).messages).toEqual([])
    expect((await s.load('/a', 'b2')).messages.length).toBe(1)
  })

  it('storage rejects on set: save resolves, subsequent load in same session returns the in-memory record', async () => {
    const b = createFakeBridge({ storageSet: async () => { throw new Error('quota') } })
    const s = createChatStore(b)
    await expect(s.save('/a', 'b', rec([msg('1', 'kept')]))).resolves.toBeUndefined()
    expect((await s.load('/a', 'b')).messages[0].parts[0]).toEqual({ kind: 'text', text: 'kept' })
  })

  it('storage rejects on get: load returns empty record, no throw', async () => {
    const b = createFakeBridge({ storageGet: async () => { throw new Error('boom') } })
    const r = await createChatStore(b).load('/a', 'b')
    expect(r.messages).toEqual([])
    expect(r.v).toBe(1)
  })

  it('clear and remove null the key and index entry', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    await s.save('/a', 'b1', rec([msg('1', 'x')]))
    await s.save('/a', 'b2', rec([msg('1', 'x')]))
    await s.clear('/a', 'b1')
    await s.remove('/a', 'b2')
    expect(await b.storageGet(chatKey('/a', 'b1'))).toBeNull()
    expect(await b.storageGet(chatKey('/a', 'b2'))).toBeNull()
    expect(await b.storageGet('ai.chat.index.v1')).toEqual({})
    expect((await s.load('/a', 'b1')).messages).toEqual([])
  })

  it('corrupt stored value (wrong shape / v≠1) loads as empty', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    await b.storageSet(chatKey('/a', 'x'), { v: 2, messages: [msg('1', 'x')], updated: 1 })
    await b.storageSet(chatKey('/a', 'y'), 'junk')
    await b.storageSet(chatKey('/a', 'z'), { v: 1, messages: 'no', updated: 1 })
    for (const k of ['x', 'y', 'z']) expect((await s.load('/a', k)).messages).toEqual([])
  })

  it('normalizes loaded records: drops unknown part kinds and non-string text', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    await b.storageSet(chatKey('/a', 'x'), { v: 1, updated: 1, messages: [
      { id: '1', role: 'user', at: 1, parts: [{ kind: 'text', text: 'ok' }, { kind: 'evil', text: 'no' }, { kind: 'text', text: 5 }] },
      { id: '2', role: 'system', at: 1, parts: [] }, 'junk'] })
    const got = await s.load('/a', 'x')
    expect(got.messages.length).toBe(1)
    expect(got.messages[0].parts).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('byte guard: CJK-heavy block stays <= 200 KiB UTF-8 JSON and newest message survives', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b, { maxCharsPerBlock: 1_000_000 })
    const cjk = (c: string) => c.repeat(3000)
    const msgs = Array.from({ length: 40 }, (_, i) => msg(String(i), cjk('汉')))
    await s.save('/a', 'b', rec(msgs))
    const stored = await b.storageGet<ChatRecord>(chatKey('/a', 'b'))
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThanOrEqual(200 * 1024)
    expect(stored!.messages.at(-1)!.id).toBe('39')
    expect(stored!.messages.length).toBeGreaterThan(0)
    expect((await s.load('/a', 'b')).messages.at(-1)!.id).toBe('39')
  })

  it('index read failure does not wipe existing index entries', async () => {
    const b = createFakeBridge()
    const s0 = createChatStore(b)
    await s0.save('/a', 'b1', rec([msg('1', 'x')]))
    await s0.save('/a', 'b2', rec([msg('1', 'x')]))
    let failed = false
    const flaky = { ...b, storageGet: async (k: string) => { if (!failed) { failed = true; throw new Error('once') } return b.storageGet(k) } } as typeof b
    const s = createChatStore(flaky)
    await s.save('/a', 'b3', rec([msg('1', 'x')]))
    const idx = await b.storageGet<Record<string, unknown>>('ai.chat.index.v1')
    expect(idx![chatKey('/a', 'b1')]).toBeDefined()
    expect(idx![chatKey('/a', 'b2')]).toBeDefined()
    await s.save('/a', 'b4', rec([msg('1', 'x')]))
    const idx2 = await b.storageGet<Record<string, unknown>>('ai.chat.index.v1')
    expect(Object.keys(idx2!).length).toBe(4)
  })

  it('corrupt (non-object) index is not overwritten from an empty fallback', async () => {
    const b = createFakeBridge()
    await b.storageSet('ai.chat.index.v1', 'junk')
    const s = createChatStore(b)
    await s.save('/a', 'b1', rec([msg('1', 'x')]))
    expect(await b.storageGet('ai.chat.index.v1')).toBe('junk')
    expect((await s.load('/a', 'b1')).messages.length).toBe(1)
  })

  it('remove/clear on a null path are no-ops', async () => {
    const b = createFakeBridge()
    const s = createChatStore(b)
    await s.remove(null, 'b'); await s.clear(null, 'b')
    expect((b.calls as any[]).length).toBe(0)
  })

  it('concurrent save/load are serialised', async () => {
    const s = createChatStore(createFakeBridge())
    const p1 = s.save('/a', 'b', rec([msg('1', 'one')]))
    const p2 = s.save('/a', 'b', rec([msg('2', 'two')]))
    const p3 = s.load('/a', 'b')
    await Promise.all([p1, p2])
    expect((await p3).messages[0].id).toBe('2')
  })
  it('metricsAfter / metricsSampled round-trip, are normalized, and count in the size cap', async () => {
    const s = createChatStore(createFakeBridge())
    const r = rec([{ ...msg('2', 'ok', 'text', 'assistant'), metricsAfter: '[{"data":"t"}]', metricsSampled: true }])
    await s.save('/a.sqlnb', 'b1:bignumber', r)
    expect((await s.load('/a.sqlnb', 'b1:bignumber')).messages).toEqual(r.messages)
    const b = createFakeBridge()
    await b.storageSet(chatKey('/a.sqlnb', 'x'), { v: 1, messages: [{ id: '1', role: 'assistant', parts: [], at: 1, metricsAfter: 5, metricsSampled: 'yes' }], updated: 1 })
    const got = (await createChatStore(b).load('/a.sqlnb', 'x')).messages[0]
    expect(got.metricsAfter).toBeUndefined()
    expect(got.metricsSampled).toBeUndefined()
    const small = createChatStore(createFakeBridge(), { maxCharsPerBlock: 100 })
    await small.save('/a.sqlnb', 'b', rec([{ ...msg('1', 'a', 'text', 'assistant'), metricsAfter: 'x'.repeat(200) }, msg('2', 'b')]))
    expect((await small.load('/a.sqlnb', 'b')).messages.map((m) => m.id)).toEqual(['2'])
  })
})
