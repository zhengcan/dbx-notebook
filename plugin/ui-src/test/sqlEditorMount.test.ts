import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, computed } from 'vue'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import SqlDrawer from '../src/ai/SqlDrawer.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { createChatStore } from '../src/ai/chatStore'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, ChatStoreKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey } from '../src/injection'

const mounted: VueWrapper<any>[] = []
afterEach(() => { mounted.splice(0).forEach((w) => { try { w.unmount() } catch { /* already unmounted */ } }) })

async function env() {
  const bridge = createFakeBridge({ queryData: vi.fn(async () => ({ columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' })), caps: { aiCompletion: true, dataApi: true } })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: "select 1, 'x' from t where a = {{ p }}", metadata: {} })
  return { bridge, connections, store }
}

const colourised = (root: Element) => ({
  keyword: root.querySelector('.cm-line .sql-keyword')?.textContent,
  number: !!root.querySelector('.cm-line .sql-number'),
  string: !!root.querySelector('.cm-line .sql-string'),
  placeholder: root.querySelector('.cm-line .sql-placeholder')?.textContent,
})

describe('real editor mounts carry highlighting', () => {
  it('SqlBlock default editor', async () => {
    const { bridge, connections, store } = await env()
    const w = mount(SqlBlock, { props: { blockId: 'b1' }, attachTo: document.body, global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
    mounted.push(w)
    await flushPromises()
    expect(colourised(w.element)).toEqual({ keyword: 'select', number: true, string: true, placeholder: '{{ p }}' })
    expect(document.getElementById('sqlnb-sql-palette')).not.toBeNull()
    expect(w.element.querySelector('.cm-content')).not.toBeNull()
  })
  it('SqlDrawer default editor', async () => {
    const { bridge, connections, store } = await env()
    const settings = { sendOptions: vi.fn(async () => ({ schema: true, sql: true, data: true })), effectiveModel: () => undefined }
    const engine = { sessionId: 's', ensureRegistered: async () => {}, query: vi.fn(), invalidate() {}, async close() {} }
    const w = mount(SqlDrawer, {
      props: { spec: { purpose: 'sql', blockId: 'b1' } } as any,
      attachTo: document.body,
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: createAiClient(bridge), [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: createChatStore(bridge), [EngineKey as symbol]: engine, [RunningAllKey as symbol]: ref(false), [CanRunKey as symbol]: computed(() => true) } },
    })
    mounted.push(w)
    await flushPromises()
    expect(colourised(w.element).keyword).toBe('select')
  })
})
