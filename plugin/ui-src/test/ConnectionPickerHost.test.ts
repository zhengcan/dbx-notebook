import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed } from 'vue'
import ConnectionPicker from '../src/shell/ConnectionPicker.vue'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import NotebookView from '../src/shell/NotebookView.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from '../src/connections/hostConnections'
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, CanRunKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { serializeNotebook } from '@sqlnb/format'
import { makeConnections } from './connectionsEnv'
import { fakeEditorFactory } from './helpers'

const HOST = [
  { id: 'c1', name: 'prod', dialect: 'postgres', connected: true, readOnly: true },
  { id: 'c2', name: 'dev', dialect: 'mysql', connected: false, readOnly: false },
]

async function pickerEnv(conns: any[] = HOST, bridgeOpts: any = {}, def?: string) {
  setLocale('en')
  const { bridge, connections } = await makeConnections(conns, bridgeOpts)
  const store = useNotebookStore()
  if (def) store.nb.value.settings.defaultConnection = def
  const provide = { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge }
  return { bridge, connections, store, provide, mount: () => mount(ConnectionPicker, { global: { provide } }) }
}

describe('ConnectionPicker (host connections)', () => {
  beforeEach(() => setLocale('en'))

  it('options come from host connections with dialect, connected state and read-only text', async () => {
    const e = await pickerEnv()
    const w = e.mount()
    const opts = w.findAll('[data-test=picker] option').filter((o) => o.attributes('value') !== '')
    expect(opts.map((o) => o.text())).toEqual([
      'prod (postgres) · connected · read-only',
      'dev (mysql) · not connected',
    ])
    for (const o of opts) {
      expect(o.attributes('title')).toBe(o.text())
      expect(o.attributes('aria-label')).toBe(o.text())
    }
  })

  it('selecting writes only the connection name (no id in the notebook JSON)', async () => {
    const e = await pickerEnv()
    const w = e.mount()
    await w.find('[data-test=picker]').setValue('c1')
    expect(e.store.nb.value.settings.defaultConnection).toBe('prod')
    const json = serializeNotebook(e.store.nb.value)
    expect(json).not.toContain('"c1"')
    expect(json).not.toContain('connected')
    expect(json).not.toContain('readOnly')
  })

  it('current name missing from host → grey disabled warning option, notebook untouched, not dirty', async () => {
    const e = await pickerEnv(HOST, {}, 'ghost')
    e.store.dirty.value = false
    const before = serializeNotebook(e.store.nb.value)
    const w = e.mount()
    await flushPromises()
    await e.connections.refresh({ force: true })
    await flushPromises()
    const warn = w.find('[data-test=picker-missing-option]')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toBe('⚠ ghost')
    expect(warn.attributes('disabled')).toBeDefined()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).selectedOptions[0].textContent).toBe('⚠ ghost')
    expect(e.store.nb.value.settings.defaultConnection).toBe('ghost')
    expect(serializeNotebook(e.store.nb.value)).toBe(before)
    expect(e.store.dirty.value).toBe(false)
  })

  it('unavailable state: current name still shown and selectable, with a hint, no false missing warning', async () => {
    const e = await pickerEnv([], { caps: { connectionsApi: false } }, 'prod')
    const w = e.mount()
    expect(e.connections.state.value).toBe('unavailable')
    expect(w.find('[data-test=picker-unavailable]').text()).toContain('unavailable')
    const cur = w.find('[data-test=picker-current-option]')
    expect(cur.text()).toBe('prod')
    expect(cur.attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test=picker-missing-option]').exists()).toBe(false)
  })

  it('empty host list (ready) → hint to create a connection in DBX', async () => {
    const e = await pickerEnv([])
    const w = e.mount()
    expect(e.connections.state.value).toBe('ready')
    expect(w.find('[data-test=picker-empty]').text()).toContain('DBX')
  })

  it('duplicate names → second dropdown (mapping) calls setMapping', async () => {
    const e = await pickerEnv([
      { id: 'a1', name: 'same', dialect: 'postgres' },
      { id: 'a2', name: 'same', dialect: 'postgres' },
    ], {}, 'same')
    const spy = vi.spyOn(e.connections, 'setMapping')
    const w = e.mount()
    expect(w.find('[data-test=picker-warn]').exists()).toBe(true)
    await w.find('[data-test=picker-map]').setValue('a2')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('same', 'a2')
    expect(e.connections.resolve('same')).toMatchObject({ status: 'ok' })
    expect(w.find('[data-test=picker-warn]').exists()).toBe(false)
  })

  it('keyboard operable: native select, refresh is a real button with aria-label, no add/remove UI', async () => {
    const e = await pickerEnv()
    const w = e.mount()
    expect(w.find('[data-test=picker]').element.tagName).toBe('SELECT')
    const btn = w.find('[data-test=picker-refresh]')
    expect(btn.element.tagName).toBe('BUTTON')
    expect(btn.attributes('aria-label')).toBeTruthy()
    expect(w.find('[data-test=picker-map]').exists()).toBe(false)
    expect(w.find('[data-test=picker-add]').exists()).toBe(false)
  })

  it('refresh triggers: mount (stale-guarded), window focus (stale-guarded), manual button (force)', async () => {
    setLocale('en')
    let n = 0
    let t = 0
    const bridge = createFakeBridge({ getConnections: async () => { n++; return [] } } as any)
    const connections = createConnectionsStore(bridge, { now: () => t })
    const store = useNotebookStore()
    const w = mount(ConnectionPicker, { global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
    await flushPromises()
    expect(n).toBe(1)
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(n).toBe(1)
    t = 5000
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(n).toBe(2)
    await w.find('[data-test=picker-refresh]').trigger('click')
    await flushPromises()
    expect(n).toBe(3)
    w.unmount()
    t = 20000
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(n).toBe(3)
  })

  it('missing name resolved by a later refresh drops the warning option', async () => {
    const items: any[] = []
    const bridge = createFakeBridge({ connections: items })
    const connections = createConnectionsStore(bridge)
    await connections.refresh()
    const store = useNotebookStore()
    store.setDefaultConnection('later')
    const w = mount(ConnectionPicker, { global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
    expect(w.find('[data-test=picker-missing-option]').exists()).toBe(true)
    items.push({ id: 'n', name: 'later', dialect: 'x', connected: true, readOnly: false })
    await connections.refresh({ force: true })
    await flushPromises()
    expect(w.find('[data-test=picker-missing-option]').exists()).toBe(false)
  })
})

async function blockEnv(opts: { def?: string; conn?: string; conns?: any[]; bridgeOpts?: any } = {}) {
  setLocale('en')
  const { bridge, connections } = await makeConnections(opts.conns ?? HOST, opts.bridgeOpts)
  const store = useNotebookStore()
  if (opts.def) store.nb.value.settings.defaultConnection = opts.def
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: opts.conn ? { connection: opts.conn } : {} })
  store.dirty.value = false
  const provide = { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [CanRunKey as symbol]: computed(() => true) }
  return { bridge, connections, store, provide }
}

describe('SqlBlock connection selector (host connections)', () => {
  it('lists host connections; a missing name stays as a grey warning option and is not rewritten', async () => {
    const e = await blockEnv({ def: 'prod', conn: 'ghost' })
    const before = serializeNotebook(e.store.nb.value)
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    await e.connections.refresh({ force: true })
    await flushPromises()
    const sel = w.find('[data-test=conn]')
    expect(sel.findAll('option').map((o) => o.text())).toContain('prod')
    const warn = w.find('[data-test=conn-missing-option]')
    expect(warn.text()).toBe('⚠ ghost')
    expect(warn.attributes('disabled')).toBeDefined()
    expect((sel.element as HTMLSelectElement).value).toBe('ghost')
    expect(serializeNotebook(e.store.nb.value)).toBe(before)
    expect(e.store.dirty.value).toBe(false)
  })

  it('shows the missing-connection hint and disables run with the reason; positive control enabled', async () => {
    const bad = await blockEnv({ def: 'ghost' })
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide: bad.provide } })
    await flushPromises()
    expect(w.find('[data-test=block-conn-missing]').text()).toContain('Connection ghost does not exist in DBX')
    const run = w.find('[data-test=run]')
    expect(run.attributes('disabled')).toBeDefined()
    expect(run.attributes('title')).toContain('ghost')
    const good = await blockEnv({ def: 'prod' })
    const w2 = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide: good.provide } })
    await flushPromises()
    expect(w2.find('[data-test=block-conn-missing]').exists()).toBe(false)
    expect(w2.find('[data-test=run]').attributes('disabled')).toBeUndefined()
  })

  it('no hint when the API is unavailable (no false missing warning)', async () => {
    const e = await blockEnv({ def: 'ghost', conns: [], bridgeOpts: { caps: { connectionsApi: false } } })
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    await flushPromises()
    expect(w.find('[data-test=block-conn-missing]').exists()).toBe(false)
    expect(w.find('[data-test=run]').attributes('disabled')).toBeUndefined()
  })

  it('hint clears once a refresh adds the connection', async () => {
    const items: any[] = []
    const bridge = createFakeBridge({ connections: items })
    const connections = createConnectionsStore(bridge)
    await connections.refresh()
    const store = useNotebookStore()
    store.nb.value.settings.defaultConnection = 'later'
    store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} })
    const provide = { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge }
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide } })
    expect(w.find('[data-test=block-conn-missing]').exists()).toBe(true)
    items.push({ id: 'n', name: 'later', dialect: 'x', connected: true, readOnly: false })
    await connections.refresh({ force: true })
    await flushPromises()
    expect(w.find('[data-test=block-conn-missing]').exists()).toBe(false)
  })
})

describe('NotebookView missing-connection banner', () => {
  it('lists missing names once, does not mark the notebook dirty', async () => {
    const e = await blockEnv({ def: 'ghost', conn: 'other' })
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    await flushPromises()
    const b = w.find('[data-test=notebook-conn-missing]')
    expect(b.text()).toContain('ghost')
    expect(b.text()).toContain('other')
    expect(e.store.dirty.value).toBe(false)
  })
  it('no banner when nothing is missing, or when unavailable', async () => {
    const ok = await blockEnv({ def: 'prod' })
    expect(mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: ok.provide } }).find('[data-test=notebook-conn-missing]').exists()).toBe(false)
    const off = await blockEnv({ def: 'ghost', conns: [], bridgeOpts: { caps: { connectionsApi: false } } })
    expect(mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: off.provide } }).find('[data-test=notebook-conn-missing]').exists()).toBe(false)
  })
})
