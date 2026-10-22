import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

const res = (n: number) => ({ columns: [{ name: 'a' }], rows: Array.from({ length: n }, (_, i) => [i]), truncated: false, elapsedMs: 1, dbType: 'x' })

async function setup(ids = ['b1']) {
  const bridge = createFakeBridge({})
  const connections = createConnectionsStore(bridge)
  const store = useNotebookStore()
  for (const id of ids) store.nb.value.blocks.push({ id, type: 'sql', content: 'select 1', metadata: {} })
  const editorFactory = () => ({ setDoc() {}, getDoc: () => '', setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }) as any
  const mk = (id: string) => mount(SqlBlock, { props: { blockId: id, editorFactory }, global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
  return { store, ws: ids.map(mk) }
}
const setRun = (store: any, id: string, n: number, status = 'ok') => store.runs.set(id, { status, result: status === 'ok' ? res(n) : undefined, executedAt: 'x' })
const btn = (w: any) => w.find('[data-test="transpose"]')
const pressed = (w: any) => btn(w).attributes('aria-pressed')

describe('transposed preference lifted into the store', () => {
  beforeEach(() => setLocale('en'))
  it('survives re-run unmount; ineligible keeps preference', async () => {
    const { store, ws: [w] } = await setup()
    setRun(store, 'b1', 3); await flushPromises()
    await btn(w).trigger('click')
    expect(store.transposed.get('b1')).toBe(true)
    store.runs.set('b1', { status: 'running' } as any); await flushPromises()
    expect(btn(w).exists()).toBe(false)
    setRun(store, 'b1', 2); await flushPromises()
    expect(pressed(w)).toBe('true')
    setRun(store, 'b1', 30); await flushPromises()
    expect(btn(w).exists()).toBe(false)
    expect(w.findAll('thead th').map((t) => t.text())).toEqual(['#', 'a'])
    expect(store.transposed.get('b1')).toBe(true)
    setRun(store, 'b1', 2); await flushPromises()
    expect(pressed(w)).toBe('true')
    expect(w.findAll('thead th').map((t) => t.text())).toEqual(['#', '#1', '#2'])
  })
  it('blocks are independent', async () => {
    const { store, ws: [a, b] } = await setup(['b1', 'b2'])
    setRun(store, 'b1', 3); setRun(store, 'b2', 3); await flushPromises()
    await btn(a).trigger('click')
    expect(pressed(a)).toBe('true')
    expect(pressed(b)).toBe('false')
  })
  it('remove cleans up, load clears', async () => {
    const { store } = await setup(['b1'])
    store.setTransposed('b1', true)
    const copy = store.duplicateBlock('b1')
    store.removeBlock('b1')
    expect(store.transposed.has('b1')).toBe(false)
    store.setTransposed(copy, true)
    store.load(serializeNotebook(createEmptyNotebook()), null, null)
    expect(store.transposed.size).toBe(0)
  })
})
