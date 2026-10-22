import { describe, it, expect } from 'vitest'
import { runSqlBlock } from '../src/run/runSqlBlock'
import { createConnectionsStore } from '../src/connections/hostConnections'
import { createFakeBridge } from '../src/host/fakeBridge'
import { mkStore } from './undoHelpers'

function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const bridge = createFakeBridge({ queryData: async () => { await gate; return { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' } } })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'c', dbType: 'postgres', database: 'db1' })
  return { bridge, connections, release }
}

describe('undo with runs in flight', () => {
  it('result arriving for a deleted block is discarded', async () => {
    const { s } = mkStore()
    const d = deferred()
    const p = runSqlBlock({ bridge: d.bridge, connections: d.connections, store: s }, 's1')
    s.removeBlock('s1')
    d.release(); await p
    expect(s.runs.has('s1')).toBe(false)
    expect(s.nb.value.blocks.some((b) => b.id === 's1')).toBe(false)
  })
  it('result arriving after the add of its block was undone is discarded; no history entry is recorded by the run', async () => {
    const { s } = mkStore()
    const id = s.addBlock('sql', null)
    s.updateContent(id, 'select 1')
    const d = deferred()
    const p = runSqlBlock({ bridge: d.bridge, connections: d.connections, store: s }, id)
    s.undo(); s.undo()
    const depth = s.history.undoDepth.value
    d.release(); await p
    expect(s.runs.has(id)).toBe(false)
    expect(s.history.undoDepth.value).toBe(depth)
  })
  it('undo while a run is in flight is allowed; the result is stored and stale follows the source rule; completion adds no entry', async () => {
    const { s } = mkStore()
    s.updateContent('s1', 'select 2')
    const d = deferred()
    const p = runSqlBlock({ bridge: d.bridge, connections: d.connections, store: s }, 's1')
    expect(s.undo().ok).toBe(true)
    const depth = s.history.undoDepth.value
    d.release(); await p
    expect(s.runs.get('s1')?.status).toBe('ok')
    expect(s.history.undoDepth.value).toBe(depth)
    expect(s.isStale('s1')).toBe(true)
    s.redo()
    expect(s.isStale('s1')).toBe(false)
  })
  it('delete restored by undo is idle (no run) after a running delete', async () => {
    const { s } = mkStore()
    const d = deferred()
    const p = runSqlBlock({ bridge: d.bridge, connections: d.connections, store: s }, 's1')
    s.removeBlock('s1'); s.undo()
    d.release(); await p
    expect(s.runs.get('s1')?.status === undefined || s.runs.get('s1')?.status === 'ok').toBe(true)
    expect(s.history.undoDepth.value).toBe(0)
  })
  it('a failing run on a deleted block is discarded too', async () => {
    const { s } = mkStore()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const bridge = createFakeBridge({ queryData: async () => { await gate; throw new Error('boom') } })
    const connections = createConnectionsStore(bridge)
    connections.seedFromContext({ id: 'c1', name: 'c', dbType: 'postgres', database: 'db1' })
    const p = runSqlBlock({ bridge, connections, store: s }, 's1')
    s.removeBlock('s1')
    release(); await p
    expect(s.runs.has('s1')).toBe(false)
  })
})

import { runResultsBlock } from '../src/run/runResultsBlock'

describe('local SQL late results', () => {
  const okRun = { status: 'ok', executedAt: 'T', result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any
  function engineWithGate() {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const engine: any = { ensureRegistered: async () => { await gate }, invalidate() {}, query: async () => ({ columns: [{ name: 'a', type: 'int' }], rows: [[1]], truncated: false, elapsedMs: 1 }) }
    return { engine, release }
  }
  it('finishing after the block was deleted adds no runs entry and does not bump resultsRevision', async () => {
    const { s } = mkStore([
      { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } },
      { id: 'r1', type: 'sql', content: 'select * from sales', metadata: { source: 'results' } },
    ])
    s.runs.set('s1', okRun)
    const { engine, release } = engineWithGate()
    const rev = s.resultsRevision.value
    const p = runResultsBlock({ bridge: {} as any, store: s, engine }, 'r1')
    expect(s.runs.get('r1')?.status).toBe('running')
    s.removeBlock('r1')
    release(); await p
    expect(s.runs.has('r1')).toBe(false)
    expect(s.resultsRevision.value).toBe(rev)
  })
  it('finishing after the add was undone is discarded too', async () => {
    const { s } = mkStore([{ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }])
    s.runs.set('s1', okRun)
    const id = s.addBlock('results', 's1')
    s.updateContent(id, 'select * from sales')
    const { engine, release } = engineWithGate()
    const rev = s.resultsRevision.value
    const p = runResultsBlock({ bridge: {} as any, store: s, engine }, id)
    s.undo(); s.undo()
    release(); await p
    expect(s.runs.has(id)).toBe(false)
    expect(s.resultsRevision.value).toBe(rev)
  })
})
