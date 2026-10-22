import { describe, it, expect, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'
import { runSqlBlock } from '../src/run/runSqlBlock'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import ConnectionPicker from '../src/shell/ConnectionPicker.vue'
import Toolbar from '../src/shell/Toolbar.vue'
import { createPluginSettings } from '../src/state/pluginSettings'
import { BridgeKey, ConnectionsKey, RunningAllKey, SelectedKey, StoreKey, CanRunKey, PluginSettingsKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'

const NB = serializeNotebook(createEmptyNotebook())

describe('store generation', () => {
  it('load increments generation', () => {
    const s = useNotebookStore()
    const g = s.generation.value
    s.load(NB, null, null)
    expect(s.generation.value).toBe(g + 1)
  })
})

describe('runSqlBlock late result', () => {
  it('drops the result when the notebook was loaded meanwhile', async () => {
    setLocale('en')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const bridge = createFakeBridge({
      queryData: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'pg' } },
    })
    const connections = createConnectionsStore(bridge)
    connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'pg' })
    const store = useNotebookStore()
    store.setDefaultConnection('main')
    const id = store.addBlock('sql', null)
    store.updateContent(id, 'select 1')
    const p = runSqlBlock({ bridge, connections, store }, id)
    store.load(NB, null, null)
    release()
    await p
    expect(store.runs.size).toBe(0)
  })
})

function env() {
  setLocale('en')
  const bridge = createFakeBridge()
  const connections = createConnectionsStore(bridge)
  const store = useNotebookStore()
  return { bridge, connections, store }
}

describe('SqlBlock runningAll', () => {
  it('disables per-block run while run-all is active', () => {
    const { bridge, connections, store } = env()
    store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} })
    const w = mount(SqlBlock, {
      props: { blockId: 'b1', editorFactory: fakeEditorFactory() },
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [RunningAllKey as symbol]: ref(true) } },
    })
    expect(w.find('[data-test=run]').attributes('disabled')).toBeDefined()
  })
})

describe('ConnectionPicker duplicate names', () => {
  it('picking by id sets a mapping', async () => {
    const { bridge, connections, store } = env()
    connections.seedFromContext({ id: 'c1', name: 'dup', dbType: 'pg' })
    connections.seedFromContext({ id: 'c2', name: 'dup', dbType: 'pg' })
    const w = mount(ConnectionPicker, { global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
    await w.find('[data-test=picker]').setValue('c2')
    await vi.waitFor(() => expect(connections.resolve('dup')).toMatchObject({ status: 'ok', conn: { id: 'c2' } }))
  })
})

describe('Toolbar', () => {
  const mk = (props: any) => {
    const { bridge, connections, store } = env()
    return mount(Toolbar, { props, global: { provide: { [PluginSettingsKey as symbol]: createPluginSettings(bridge), [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [SelectedKey as symbol]: ref(null), [CanRunKey as symbol]: computed(() => true) } } })
  }
  it('shows stopping state and no ⌘N/⌘O tooltips', () => {
    const w = mk({ running: true, stopping: true })
    expect(w.find('[data-test=stop]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test=stop]').text()).toContain('Stopping')
    expect(w.find('[data-test=new]').attributes('title')).not.toMatch(/N\)/)
    expect(w.find('[data-test=open]').attributes('title')).not.toMatch(/O\)/)
    w.unmount()
  })
  it('Mod-S ignored while a modal is open', () => {
    const w = mk({ running: false })
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true')
    document.body.appendChild(d)
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    d.remove(); w.unmount()
  })
})
