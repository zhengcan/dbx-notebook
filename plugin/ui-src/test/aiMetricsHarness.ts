import { vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MetricsDrawer from '../src/ai/MetricsDrawer.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createChatStore } from '../src/ai/chatStore'
import { AiClientKey, AiSettingsKey, BridgeKey, ChatStoreKey, EngineKey, StoreKey } from '../src/injection'
import { AiError, type AiClient, type AiRequest, type AiResult } from '../src/ai/aiClient'
import { setLocale } from '../src/i18n'
import type { EngineClient } from '../src/run/engineClient'

export const send0 = { schema: true, sql: true, data: true }
export const fence = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```'
export const SALES_COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }]
export const mounted: { unmount(): void }[] = []
export const cleanup = () => { while (mounted.length) { try { mounted.pop()!.unmount() } catch { /* gone */ } } setLocale('en'); document.body.innerHTML = '' }
export const m = (data: string, field: string, aggregate = 'sum', extra: Record<string, unknown> = {}) => ({ data, field, aggregate, ...extra })

export async function setup(opts: { send?: Partial<typeof send0>; costs?: boolean; noTables?: boolean; blockId?: string; aiCompletion?: boolean } = {}) {
  setLocale('en')
  const bridge = createFakeBridge({ caps: { aiCompletion: opts.aiCompletion ?? true } })
  const store = useNotebookStore()
  store.path.value = '/n.sqlnb'
  const run = (cols: typeof SALES_COLS, rows: unknown[][]) => ({ status: 'ok', executedAt: 'T1', result: { columns: cols, rows, truncated: false, elapsedMs: 1, dbType: 'sqlite' } }) as any
  if (!opts.noTables) {
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } } as any)
    store.runs.set('s1', run(SALES_COLS, [['PROBE_CELL', 1, '2026-01-01'], ['a', 2, '2026-02-01']]))
    if (opts.costs !== false) {
      store.nb.value.blocks.push({ id: 's2', type: 'sql', content: 'select 2', metadata: { resultName: 'costs' } } as any)
      store.runs.set('s2', run([{ name: 'cost', dataType: 'integer' }, { name: 'kind', dataType: 'text' }], [[5, 'x']]))
    }
  }
  store.nb.value.blocks.push({ id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' } } } as any)
  const queries: string[] = []
  const engine: EngineClient = {
    sessionId: 's', async ensureRegistered() {}, invalidate() {}, async close() {},
    async query(sql) {
      queries.push(sql)
      const rows = (v: unknown) => ({ columns: [], rows: [[v]], truncated: false, elapsedMs: 1 })
      if (sql.startsWith('SELECT max(CASE')) return rows('2026-03')
      const mm = /= '(\d{4}-\d{2})'$/.exec(sql)
      if (mm) return rows(mm[1] === '2026-03' ? 150 : 100)
      return rows(42)
    },
  }
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
  const chat = createChatStore(bridge)
  const provide = { [StoreKey as symbol]: store, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: client, [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: chat, [EngineKey as symbol]: engine }
  const mountIt = async () => {
    const w = mount(MetricsDrawer, { props: { spec: { purpose: 'bignumber', blockId: opts.blockId ?? 'n1' } } as any, attachTo: document.body, global: { provide } })
    mounted.push(w)
    await flushPromises()
    return w
  }
  const w = await mountIt()
  const meta = (id = 'n1') => store.nb.value.blocks.find((b) => b.id === id)?.metadata as any
  const respond = async (text: string, truncated = false) => { pending!.resolve({ text, truncated }); await flushPromises(); await new Promise((r) => setTimeout(r, 10)); await flushPromises() }
  const gen = async (wr = w) => { await wr.find('[data-test=bn-generate]').trigger('click'); await flushPromises() }
  const chatSend = async (text: string, wr = w) => {
    await wr.find('[data-test=chat-input]').setValue(text)
    await wr.find('[data-test=chat-send]').trigger('click')
    await flushPromises()
  }
  const cards = (wr = w) => wr.findAll('[data-test=bn-card]')
  const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 10)); await flushPromises() }
  return { w, store, bridge, calls, client, settings, chat, engine, queries, provide, mountIt, meta, respond, gen, chatSend, cards, settle }
}
export const flush = flushPromises
