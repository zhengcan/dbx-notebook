import { describe, it, expect, vi, beforeEach } from 'vitest'
import { genPrompts } from './aiRequests'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, computed } from 'vue'
import { serializeNotebook } from '@sqlnb/format'
import SqlDrawer from '../src/ai/SqlDrawer.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { createChatStore } from '../src/ai/chatStore'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, ChatStoreKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

const fence = (sql: string) => '```sql\n' + sql + '\n```'
type Send = { schema: boolean; sql: boolean; data: boolean }

async function setup(replies: string[]) {
  const bridge = createFakeBridge({
    queryData: vi.fn(async () => ({ columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' })),
    caps: { aiCompletion: true },
    requestHandlers: {
      'host.ai.listModels': async () => [{ configId: 'c', model: 'm', name: 'M', isDefault: true }],
      'host.ai.generateText': async () => replies.shift() ?? 'QUESTION: which?',
    },
  })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.path.value = '/n.sqlnb'
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} })
  const send = { schema: true, sql: true, data: true }
  const settings = { sendOptions: vi.fn(async () => ({ ...send })), effectiveModel: () => undefined }
  const engine = { sessionId: 's', ensureRegistered: async () => {}, query: vi.fn(async () => ({ columns: [{ name: 'c' }], rows: [[1]], truncated: false, elapsedMs: 3 })), invalidate() {}, async close() {} }
  const chat = createChatStore(bridge)
  await chat.save('/n.sqlnb', 'b1', { v: 1, updated: 1, messages: [
    { id: 'u0', role: 'user', parts: [{ kind: 'text', text: 'earlier' }, { kind: 'data', text: 'DATAPART_PROBE' }], at: 1 },
    { id: 'a0', role: 'assistant', parts: [{ kind: 'text', text: 'note CHART_PROBE' }], markdownAfter: 'MARKDOWN_PROBE', chartAfter: '{"c":"CHART_PROBE"}', at: 2 },
  ] })
  const factory = (_p: HTMLElement, o: any) => {
    const e = { doc: o.doc as string }
    return { setDoc(s: string) { e.doc = s }, getDoc: () => e.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus() {} } as any
  }
  const w = mount(SqlDrawer, {
    props: { spec: { purpose: 'sql', blockId: 'b1' }, editorFactory: factory } as any,
    attachTo: document.body,
    global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: createAiClient(bridge), [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: chat, [EngineKey as symbol]: engine, [RunningAllKey as symbol]: ref(false), [CanRunKey as symbol]: computed(() => true) } },
  })
  await flushPromises()
  const turn = async (text: string) => {
    await w.find('[data-test=chat-input]').setValue(text)
    await w.find('[data-test=chat-send]').trigger('click')
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    const p = genPrompts(bridge)
    return p[p.length - 1]
  }
  return { send, turn }
}

beforeEach(() => { setLocale('en'); document.body.innerHTML = '' })

describe('SqlDrawer history privacy across toggle flips', () => {
  it('earlier SQL / data / markdown / chart leave the prompt when their toggle is turned off between turns', async () => {
    const s = await setup([fence('SELECT SECRETCOL FROM secret_tbl') + '\nWhy: reads SECRETCOL', fence('select 2'), fence('select 3'), fence('select 4')])
    await s.turn('first')
    const on = await s.turn('second')
    for (const p of ['SELECT SECRETCOL FROM secret_tbl', 'DATAPART_PROBE', 'MARKDOWN_PROBE', 'CHART_PROBE']) expect(on).toContain(p)
    s.send.sql = false
    const noSql = await s.turn('third')
    expect(noSql).not.toContain('SECRETCOL')
    expect(noSql).not.toContain('secret_tbl')
    expect(noSql).toContain('DATAPART_PROBE')
    expect(noSql).toContain('MARKDOWN_PROBE')
    s.send.schema = false
    s.send.data = false
    const off = await s.turn('fourth')
    for (const p of ['SECRETCOL', 'DATAPART_PROBE', 'MARKDOWN_PROBE', 'CHART_PROBE']) expect(off).not.toContain(p)
  })
})
