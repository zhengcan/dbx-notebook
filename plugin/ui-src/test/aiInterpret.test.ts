import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { ref, computed } from 'vue'
import { useAiRequest } from '../src/ai/useAiRequest'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, DrawerKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey } from '../src/injection'
import { createDrawerManager } from '../src/ai/drawerState'
import { AiError, type AiClient, type AiRequest, type AiResult } from '../src/ai/aiClient'
import { interpretGate } from '../src/ai/interpretGate'
import { setLocale, t } from '../src/i18n'

const okRun = { status: 'ok', result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1 } } as any
const caps = { aiCompletion: true } as any
const send = { schema: true, sql: true, data: true }

describe('interpretGate', () => {
  const base = { caps, send, run: okRun, busy: false }
  it('enabled when everything is available', () => expect(interpretGate(base)).toEqual({ enabled: true }))
  it('reasons', () => {
    expect(interpretGate({ ...base, send: { ...send, data: false } })).toEqual({ enabled: false, reason: 'no-data-setting' })
    expect(interpretGate({ ...base, run: undefined })).toEqual({ enabled: false, reason: 'no-result' })
    expect(interpretGate({ ...base, run: { status: 'error' } as any })).toEqual({ enabled: false, reason: 'no-result' })
    expect(interpretGate({ ...base, run: { status: 'ok', result: { columns: [{ name: 'a' }], rows: [] } } as any })).toEqual({ enabled: false, reason: 'empty-result' })
    expect(interpretGate({ ...base, busy: true })).toEqual({ enabled: false, reason: 'ai-busy' })
    expect(interpretGate({ ...base, caps: { aiCompletion: false } as any })).toEqual({ enabled: false, reason: 'unsupported' })
  })
})

async function setup(opts: { send?: Partial<typeof send>; rows?: number; aiCompletion?: boolean } = {}) {
  setLocale('en')
  const bridge = createFakeBridge({ caps: { aiCompletion: opts.aiCompletion ?? true } })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} } as any, { id: 'b2', type: 'sql', content: 'select 2', metadata: {} } as any)
  const n = opts.rows ?? 3
  store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'region' }, { name: 'amount' }], rows: Array.from({ length: n }, (_, i) => [`r${i}`, i]), truncated: false, elapsedMs: 1, dbType: 'postgres' } } as any)
  let hold = false
  const client: AiClient = {
    available: () => true, streaming: () => true, busy: () => false, listModels: async () => [],
    generate: vi.fn((req: AiRequest) => new Promise<AiResult>((_, reject) => { hold = true; req.signal?.addEventListener('abort', () => reject(new AiError('cancelled'))) })),
  }
  void hold
  const settings = { sendOptions: vi.fn(async () => ({ ...send, ...opts.send })), effectiveModel: () => undefined }
  const drawer = createDrawerManager(store)
  const mountBlock = (id: string) => mount(SqlBlock, {
    props: { blockId: id, editorFactory: () => ({ setDoc() {}, getDoc: () => '', setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }) as any },
    attachTo: document.body,
    global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: client, [AiSettingsKey as symbol]: settings, [EngineKey as symbol]: { sessionId: 's', ensureRegistered: async () => {}, query: vi.fn(), invalidate() {}, async close() {} }, [RunningAllKey as symbol]: ref(false), [CanRunKey as symbol]: computed(() => true), [DrawerKey as symbol]: drawer } },
  })
  const w = mountBlock('b1')
  await flushPromises()
  return { w, store, client, settings, drawer, mountBlock }
}

beforeEach(() => setLocale('en'))

// The inline card flow moved into InterpretDrawer (see aiInterpretDrawer.test.ts); only the entry point is tested here.
describe('interpret entry (SqlBlock)', () => {
  it('absent without capability or without result', async () => {
    expect((await setup({ aiCompletion: false })).w.find('[data-test=ai-interpret]').exists()).toBe(false)
    const s = await setup()
    s.store.runs.delete('b1')
    await flushPromises()
    expect(s.w.find('[data-test=ai-interpret]').exists()).toBe(false)
  })
  it('click opens the interpretation drawer for this block and sends nothing', async () => {
    const s = await setup()
    await s.w.find('[data-test=ai-interpret]').trigger('click'); await flushPromises()
    expect(s.drawer.current.value).toEqual({ purpose: 'interpret', blockId: 'b1' })
    expect(s.client.generate).not.toHaveBeenCalled()
  })
  it('disabled with a reason when result-data option is off; describedby; click opens nothing', async () => {
    const s = await setup({ send: { data: false } })
    const b = s.w.find('[data-test=ai-interpret]')
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.attributes('title')).toBe(t('ai.interpret.gate.no-data-setting'))
    const d = b.attributes('aria-describedby')!
    expect(s.w.find(`#${d}`).text()).toBe(t('ai.interpret.gate.no-data-setting'))
    await b.trigger('click'); await flushPromises()
    expect(s.drawer.current.value).toBeNull()
    expect(s.client.generate).not.toHaveBeenCalled()
  })
  it('disabled with a reason while a drawer is already open', async () => {
    const s = await setup()
    s.drawer.open({ purpose: 'sql', blockId: 'b2' })
    await flushPromises()
    const b = s.w.find('[data-test=ai-interpret]')
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.attributes('title')).toBe(t('ai.askDrawerOpen'))
  })
  it('other blocks AI buttons disabled with ai-busy reason while a request runs', async () => {
    const s = await setup()
    s.store.runs.set('b2', s.store.runs.get('b1')!)
    const w2 = s.mountBlock('b2'); await flushPromises()
    void useAiRequest(s.client).start({ task: 'rewrite', prompt: 'x' })
    await flushPromises()
    const b2 = w2.find('[data-test=ai-interpret]')
    expect(b2.attributes('disabled')).toBeDefined()
    expect(b2.attributes('title')).toBe(t('ai.interpret.gate.ai-busy'))
    expect(w2.find('[data-test=ask-ai]').attributes('disabled')).toBeDefined()
  })
})

describe('interpret error wordings', () => {
  it('error wordings are distinct', () => {
    const keys = ['consent-declined', 'timeout', 'cancelled', 'truncated', 'unsupported', 'unparseable', 'empty']
    expect(new Set(keys.map((k) => t(`ai.err.${k}` as any))).size).toBe(keys.length)
    setLocale('zh-CN')
    expect(new Set(keys.map((k) => t(`ai.err.${k}` as any))).size).toBe(keys.length)
  })
})
