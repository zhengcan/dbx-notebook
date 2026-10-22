import { describe, it, expect, vi } from 'vitest'
import { serializeNotebook, createEmptyNotebook } from '@sqlnb/format'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient, AI_METHODS } from '../src/ai/aiClient'
import { hostAiCalls } from './aiRequests'
import { createAiSettings, normalizeAiSettings, DEFAULT_AI_SEND } from '../src/ai/aiSettings'

const KEY = 'ai.settings.v1'
const MODELS = [{ configId: 'c1', name: 'Cfg', model: 'm-a', isDefault: false }, { configId: 'c1', name: 'Cfg', model: 'm-b', isDefault: true }]
function setup(opts: { models?: unknown[]; ai?: boolean; storage?: Map<string, unknown>; failSet?: boolean } = {}) {
  const m = opts.storage ?? new Map<string, unknown>()
  const bridge = createFakeBridge({
    caps: { aiCompletion: opts.ai ?? true },
    requestHandlers: { [AI_METHODS.listModels]: () => opts.models ?? MODELS },
    async storageGet(k: string) { return (m.get(k) ?? null) as any },
    async storageSet(k: string, v: unknown) { if (opts.failSet) throw new Error('nope'); m.set(k, v) },
  })
  const client = createAiClient(bridge)
  return { m, bridge, client, settings: createAiSettings(bridge, client) }
}

describe('normalizeAiSettings', () => {
  it.each([undefined, null, 'x', 5, [], { send: 'a' }, { send: { schema: 'no' } }])('%j -> defaults, no throw', (v) => {
    expect(normalizeAiSettings(v)).toEqual({ send: DEFAULT_AI_SEND, model: null })
  })
  it('keeps valid booleans and model', () => {
    expect(normalizeAiSettings({ send: { schema: false, sql: 1, data: true }, model: 'c|m' })).toEqual({ send: { schema: false, sql: true, data: true }, model: 'c|m' })
  })
})

describe('createAiSettings', () => {
  it('load defaults when storage empty', async () => {
    const { settings } = setup()
    await settings.load()
    expect(settings.send.value).toEqual({ schema: true, sql: true, data: true })
    expect(settings.model.value).toBeNull()
  })
  it('setSend persists and survives reload', async () => {
    const { m, bridge, client, settings } = setup()
    await settings.setSend({ data: false })
    expect((m.get(KEY) as any).send).toEqual({ schema: true, sql: true, data: false })
    const b = createAiSettings(bridge, client)
    await b.load()
    expect(b.send.value.data).toBe(false)
  })
  it('storageSet failure keeps memory and does not throw', async () => {
    const { settings } = setup({ failSet: true })
    await expect(settings.setSend({ schema: false })).resolves.toBeUndefined()
    expect(settings.send.value.schema).toBe(false)
  })
  it('missing saved model falls back to first with notice', async () => {
    const { settings } = setup({ storage: new Map([[KEY, { send: DEFAULT_AI_SEND, model: 'm-gone' }]]) })
    await settings.load(); await settings.refreshModels()
    expect(settings.effectiveModel()).toBe('c1|m-a')
    expect(settings.modelNotice.value).toBe('fallback')
  })
  it('saved model present is used with no notice', async () => {
    const { settings } = setup()
    await settings.setModel('c1|m-b'); await settings.refreshModels()
    expect(settings.effectiveModel()).toBe('c1|m-b')
    expect(settings.modelNotice.value).toBe('none')
  })
  it('no saved model -> first, no notice', async () => {
    const { settings } = setup()
    await settings.refreshModels()
    expect(settings.effectiveModel()).toBe('c1|m-a')
    expect(settings.modelNotice.value).toBe('none')
  })
  it('empty list -> no-models', async () => {
    const { settings } = setup({ models: [] })
    await settings.refreshModels()
    expect(settings.modelNotice.value).toBe('no-models')
    expect(settings.effectiveModel()).toBeUndefined()
  })
  it('capability off: refreshModels does not invoke', async () => {
    const { bridge, settings } = setup({ ai: false })
    await settings.refreshModels()
    expect(hostAiCalls(bridge)).toHaveLength(0)
  })
  it('capability on: refreshModels does issue the listModels call (positive control)', async () => {
    const { bridge, settings } = setup({ ai: true })
    await settings.refreshModels()
    expect(hostAiCalls(bridge, /listModels/).length).toBeGreaterThan(0)
  })
  it('listModels failure does not throw', async () => {
    const { client, bridge } = setup()
    vi.spyOn(client, 'listModels').mockRejectedValue(new Error('x'))
    const s = createAiSettings(bridge, client)
    await expect(s.refreshModels()).resolves.toBeUndefined()
  })
  it('settings never change serialized notebook', async () => {
    const { settings } = setup()
    const nb = createEmptyNotebook()
    const before = serializeNotebook(nb)
    await settings.setSend({ sql: false }); await settings.setModel('c1|m-b')
    expect(serializeNotebook(nb)).toBe(before)
  })
})

import { messages } from '../src/i18n'
describe('ai.set i18n', () => {
  it('zh/en parity', () => {
    const f = (o: object) => Object.keys(o).filter((k) => k.startsWith('ai.set.')).sort()
    expect(f(messages['zh-CN']).length).toBeGreaterThan(5)
    expect(f(messages['zh-CN'])).toEqual(f(messages.en))
  })

  it('refreshModels: older overlapping call resolving last does not win', async () => {
    const resolvers: Array<(v: unknown) => void> = []
    const bridge = createFakeBridge({ caps: { aiCompletion: true }, requestHandlers: { [AI_METHODS.listModels]: () => new Promise((r) => { resolvers.push(r) }) } })
    const settings = createAiSettings(bridge, createAiClient(bridge))
    const a = settings.refreshModels()
    const b = settings.refreshModels()
    await Promise.resolve(); await Promise.resolve()
    resolvers[1]([{ configId: 'n', name: 'New', model: 'new', isDefault: true }])
    await b
    resolvers[0]([{ configId: 'o', name: 'Old', model: 'old', isDefault: true }])
    await a
    expect(settings.models.value.map((m) => m.id)).toEqual(['n|new'])
  })
  it('load vs write race: user change made before storageGet resolves wins', async () => {
    let release: (v: unknown) => void = () => {}
    const m = new Map<string, unknown>()
    const bridge = createFakeBridge({
      caps: { aiCompletion: true },
      storageGet: () => new Promise((r) => { release = r }) as any,
      async storageSet(k: string, v: unknown) { m.set(k, v) },
    })
    const settings = createAiSettings(bridge, createAiClient(bridge))
    const l = settings.load()
    const w = settings.setSend({ data: false })
    release({ send: { schema: true, sql: true, data: true }, model: null })
    await l; await w
    expect(settings.send.value.data).toBe(false)
  })
  it('ready(): safe defaults before load, resolves once load settled', async () => {
    const { settings, m } = setup()
    m.set(KEY, { send: { schema: true, sql: true, data: false }, model: null })
    expect(settings.send.value.data).toBe(true)
    expect(settings.isLoaded()).toBe(false)
    const r = settings.ready()
    await settings.load()
    await r
    expect(settings.isLoaded()).toBe(true)
    expect(settings.send.value.data).toBe(false)
  })
  it('ready() resolves even when storage fails', async () => {
    const bridge = createFakeBridge({ caps: { aiCompletion: true }, async storageGet() { throw new Error('x') } })
    const settings = createAiSettings(bridge, createAiClient(bridge))
    await settings.load()
    await settings.ready()
    expect(settings.isLoaded()).toBe(true)
  })

  it('sendOptions: load success returns saved options', async () => {
    const { settings, m } = setup()
    m.set(KEY, { send: { schema: true, sql: false, data: false }, model: null })
    expect(await settings.sendOptions()).toEqual({ schema: true, sql: false, data: false })
  })
  it('sendOptions: storageGet throws -> all off', async () => {
    const bridge = createFakeBridge({ caps: { aiCompletion: true }, async storageGet() { throw new Error('x') } })
    const settings = createAiSettings(bridge, createAiClient(bridge))
    expect(await settings.sendOptions()).toEqual({ schema: false, sql: false, data: false })
  })
  it('sendOptions: load pending past timeout -> all off', async () => {
    const bridge = createFakeBridge({ caps: { aiCompletion: true }, storageGet: () => new Promise(() => {}) as any })
    const settings = createAiSettings(bridge, createAiClient(bridge), { sendTimeoutMs: 20 })
    expect(await settings.sendOptions()).toEqual({ schema: false, sql: false, data: false })
  })
  it('user write before load resolves keeps other stored fields (storage and memory)', async () => {
    let release: (v: unknown) => void = () => {}
    const m = new Map<string, unknown>()
    const bridge = createFakeBridge({
      caps: { aiCompletion: true },
      storageGet: () => new Promise((r) => { release = r }) as any,
      async storageSet(k: string, v: unknown) { m.set(k, v) },
    })
    const settings = createAiSettings(bridge, createAiClient(bridge))
    const l = settings.load()
    const w = settings.setSend({ schema: false })
    release({ send: { schema: true, sql: false, data: false }, model: 'c|m' })
    await l; await w
    expect((m.get(KEY) as any).send).toEqual({ schema: false, sql: false, data: false })
    expect((m.get(KEY) as any).model).toBe('c|m')
    expect(settings.send.value).toEqual({ schema: false, sql: false, data: false })
  })
})
