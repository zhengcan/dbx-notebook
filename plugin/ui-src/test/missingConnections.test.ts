import { describe, it, expect } from 'vitest'
import { useNotebookStore } from '../src/state/notebookStore'
import { missingConnections } from '../src/connections/missing'
import { makeConnections } from './connectionsEnv'

function nbWith(default_?: string) {
  const store = useNotebookStore()
  if (default_) store.setDefaultConnection(default_)
  return store
}

describe('missingConnections', () => {
  it('reports names absent from host list', async () => {
    const { connections } = await makeConnections([{ name: 'prod' }])
    const store = nbWith('gone')
    const a = store.addBlock('sql', null)
    const b = store.addBlock('sql', a)
    store.updateMeta(b, { connection: 'prod' })
    const m = missingConnections(connections, store.nb.value)
    expect(m.names).toEqual(['gone'])
    expect(m.blocks).toEqual({ [a]: 'gone' })
  })
  it('ignores local/results blocks', async () => {
    const { connections } = await makeConnections([{ name: 'prod' }])
    const store = nbWith('gone')
    const r = store.addBlock('results', null)
    expect(missingConnections(connections, store.nb.value).blocks[r]).toBeUndefined()
    const m = store.addBlock('markdown', r)
    expect(missingConnections(connections, store.nb.value).blocks[m]).toBeUndefined()
  })
  it('returns none when list unavailable (no false alarms)', async () => {
    const { connections } = await makeConnections([], { caps: { connectionsApi: false } })
    expect(connections.state.value).toBe('unavailable')
    const store = nbWith('gone')
    store.addBlock('sql', null)
    expect(missingConnections(connections, store.nb.value)).toEqual({ names: [], blocks: {} })
  })
  it('returns none before the first refresh (idle)', async () => {
    const { createConnectionsStore } = await import('../src/connections/hostConnections')
    const { createFakeBridge } = await import('../src/host/fakeBridge')
    const connections = createConnectionsStore(createFakeBridge())
    const store = nbWith('gone')
    store.addBlock('sql', null)
    expect(missingConnections(connections, store.nb.value).names).toEqual([])
  })
  it('notebook default + block override both counted once per name', async () => {
    const { connections } = await makeConnections([{ name: 'prod' }])
    const store = nbWith('gone')
    const a = store.addBlock('sql', null)
    const b = store.addBlock('sql', a)
    const c = store.addBlock('sql', b)
    store.updateMeta(b, { connection: 'gone' })
    store.updateMeta(c, { connection: 'other' })
    const m = missingConnections(connections, store.nb.value)
    expect(m.names.sort()).toEqual(['gone', 'other'])
    expect(m.blocks).toEqual({ [a]: 'gone', [b]: 'gone', [c]: 'other' })
  })
  it('after refresh adds the connection → hint disappears', async () => {
    const items: any[] = []
    const { createConnectionsStore } = await import('../src/connections/hostConnections')
    const { createFakeBridge } = await import('../src/host/fakeBridge')
    const bridge = createFakeBridge({ connections: items })
    const connections = createConnectionsStore(bridge)
    await connections.refresh()
    const store = nbWith('later')
    store.addBlock('sql', null)
    expect(missingConnections(connections, store.nb.value).names).toEqual(['later'])
    items.push({ id: 'n', name: 'later', dialect: 'x', connected: false, readOnly: false })
    await connections.refresh({ force: true })
    expect(missingConnections(connections, store.nb.value).names).toEqual([])
  })
  it('keeps the last-ready verdict while a refresh is loading (no blink)', async () => {
    const { createConnectionsStore } = await import('../src/connections/hostConnections')
    const { createFakeBridge } = await import('../src/host/fakeBridge')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let hold = false
    const bridge = createFakeBridge({ connections: [{ id: 'p', name: 'prod', dialect: 'x', connected: true, readOnly: false }] })
    const orig = bridge.getConnections.bind(bridge)
    bridge.getConnections = async () => { if (hold) await gate; return orig() }
    const connections = createConnectionsStore(bridge)
    await connections.refresh()
    const store = nbWith('gone')
    store.addBlock('sql', null)
    expect(missingConnections(connections, store.nb.value).names).toEqual(['gone'])
    hold = true
    const p = connections.refresh({ force: true })
    expect(connections.state.value).toBe('loading')
    expect(missingConnections(connections, store.nb.value).names).toEqual(['gone'])
    release(); await p
    expect(missingConnections(connections, store.nb.value).names).toEqual(['gone'])
  })
  it('first load (never ready) reports nothing while loading', async () => {
    const { createConnectionsStore } = await import('../src/connections/hostConnections')
    const { createFakeBridge } = await import('../src/host/fakeBridge')
    const bridge = createFakeBridge({ connections: [] })
    bridge.getConnections = () => new Promise(() => {})
    const connections = createConnectionsStore(bridge, { timeoutMs: 10_000 })
    void connections.refresh()
    const store = nbWith('gone')
    store.addBlock('sql', null)
    expect(missingConnections(connections, store.nb.value).names).toEqual([])
  })
})
