import { describe, it, expect, vi } from 'vitest'
import { runAll } from '../src/run/runMany'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { HostError } from '../src/host/bridge'
import { setLocale } from '../src/i18n'

async function setup(blocks: any[], failOn: string[] = []) {
  setLocale('en')
  const order: string[] = []
  const bridge = createFakeBridge({
    queryData: vi.fn(async (req: any) => {
      order.push(req.sql)
      if (failOn.includes(req.sql)) throw new HostError('NOT_OPEN', 'Connection is not open')
      return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'pg' }
    }),
  })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'pg' })
  const store = useNotebookStore()
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push(...blocks)
  return { deps: { bridge, connections, store }, order, store }
}
const sql = (id: string, content: string, metadata: any = {}) => ({ id, type: 'sql', content, metadata })

describe('runAll', () => {
  it('runs sql blocks in order and skips non-sql', async () => {
    const { deps, order } = await setup([sql('a', 'q1'), { id: 'm', type: 'markdown', content: 'x' }, sql('b', 'q2')])
    const r = await runAll(deps, { kind: 'all' })
    expect(order).toEqual(['q1', 'q2'])
    expect(r).toEqual({ ran: ['a', 'b'] })
  })
  it('stops at first error', async () => {
    const { deps, order } = await setup([sql('a', 'q1'), sql('b', 'bad'), sql('c', 'q3')], ['bad'])
    const r = await runAll(deps, { kind: 'all' })
    expect(order).toEqual(['q1', 'bad'])
    expect(r.ran).toEqual(['a', 'b'])
    expect(r.stoppedAt).toEqual({ blockId: 'b', code: 'NOT_OPEN' })
  })
  it("'from' starts at the given block", async () => {
    const { deps, order } = await setup([sql('a', 'q1'), sql('b', 'q2'), sql('c', 'q3')])
    const r = await runAll(deps, { kind: 'from', blockId: 'b' })
    expect(order).toEqual(['q2', 'q3'])
    expect(r.ran).toEqual(['b', 'c'])
  })
  it('cancel mid-run stops between blocks', async () => {
    const { deps, order } = await setup([sql('a', 'q1'), sql('b', 'q2'), sql('c', 'q3')])
    const ac = new AbortController()
    const orig = deps.bridge.queryData
    deps.bridge.queryData = async (req: any) => { const r = await orig(req); ac.abort(); return r }
    const r = await runAll({ ...deps, signal: ac.signal }, { kind: 'all' })
    expect(order).toEqual(['q1'])
    expect(r).toEqual({ ran: ['a'] })
  })
  it('runs results blocks in document order via the engine; stops at first error', async () => {
    const order2: string[] = []
    const { deps, order } = await setup([sql('a', 'q1', { resultName: 'a' }), sql('b', 'select * from a', { source: 'results', resultName: 'b' }), sql('c', 'select * from b', { source: 'results' }), sql('d', 'q4')])
    const engine: any = {
      sessionId: 's', invalidate() {}, close: async () => {},
      ensureRegistered: async (n: string) => { order2.push('reg:' + n) },
      query: async (s: string) => { order2.push(s); if (s === 'select * from b') throw new Error('engine boom'); return { columns: [], rows: [], truncated: false, elapsedMs: 1 } },
    }
    const r = await runAll({ ...deps, engine }, { kind: 'all' })
    expect(order).toEqual(['q1'])
    expect(order2).toEqual(['reg:a', 'select * from a', 'reg:b', 'select * from b'])
    expect(r.ran).toEqual(['a', 'b', 'c'])
    expect(r.stoppedAt).toEqual({ blockId: 'c', code: 'UNKNOWN' })
  })
  it('skips input blocks; stops on param error', async () => {
    const inp = { id: 'i', type: 'input', content: '', metadata: { variable: 'x', inputType: 'number', value: '' } }
    const { deps, order } = await setup([inp, sql('a', 'q1'), sql('b', 'select {{ x }}'), sql('c', 'q3')])
    const r = await runAll(deps, { kind: 'all' })
    expect(order).toEqual(['q1'])
    expect(r.ran).toEqual(['a', 'b'])
    expect(r.stoppedAt).toEqual({ blockId: 'b', code: 'UNKNOWN' })
  })
})

describe('runAll refreshes analysis blocks', () => {
  const chart = (id: string, data: string) => ({ id, type: 'chart', content: '', metadata: { data } })
  const big = (id: string, data: string) => ({ id, type: 'big-number', content: '', metadata: { data } })
  function wire(store: any, failFor: string[] = []) {
    const calls: string[] = []
    const run = async (id: string) => {
      calls.push(id)
      if (failFor.includes(id)) throw new Error('boom')
      const b = store.nb.value.blocks.find((x: any) => x.id === id)
      const src = store.nb.value.blocks.find((x: any) => x.metadata?.resultName === b.metadata.data)
      const r: any = { status: 'ok', sourceExecutedAt: store.runs.get(src.id)?.executedAt }
      ;(b.type === 'chart' ? store.analysis : store.bigNumbers).set(id, r)
      return r
    }
    store.setAnalysisRunner(run); store.setBigNumberRunner(run)
    return calls
  }
  it('run all refreshes chart + big-number and clears stale', async () => {
    const { deps, store } = await setup([sql('a', 'q1', { resultName: 'a' }), chart('c', 'a'), big('n', 'a')])
    const calls = wire(store)
    await runAll(deps, { kind: 'all' })
    await runAll(deps, { kind: 'all' })
    expect(calls).toEqual(['c', 'n', 'c', 'n'])
    expect(store.staleReasons('c')).toEqual([])
    expect(store.staleReasons('n')).toEqual([])
  })
  it('run from refreshes only dependents of re-run sources (even earlier-positioned)', async () => {
    const { deps, store } = await setup([sql('a', 'q1', { resultName: 'a' }), chart('ca', 'a'), sql('b', 'q2', { resultName: 'b' }), chart('cb', 'b')])
    const calls = wire(store)
    await runAll(deps, { kind: 'from', blockId: 'b' })
    expect(calls).toEqual(['cb'])
  })
  it('source error keeps analysis stale and unrefreshed', async () => {
    const { deps, store } = await setup([sql('a', 'q1', { resultName: 'a' }), chart('c1', 'a'), sql('b', 'bad', { resultName: 'b' }), chart('c2', 'b')], ['bad'])
    const calls = wire(store)
    await runAll(deps, { kind: 'all' })
    expect(calls).toEqual(['c1'])
  })
  it('refresh failure does not abort others; cancel skips refresh', async () => {
    const { deps, store } = await setup([sql('a', 'q1', { resultName: 'a' }), chart('c1', 'a'), chart('c2', 'a')])
    const calls = wire(store, ['c1'])
    await runAll(deps, { kind: 'all' })
    expect(calls).toEqual(['c1', 'c2'])
    calls.length = 0
    const ac = new AbortController()
    const orig = deps.bridge.queryData
    deps.bridge.queryData = async (req: any) => { const r = await orig(req); ac.abort(); return r }
    await runAll({ ...deps, signal: ac.signal }, { kind: 'all' })
    expect(calls).toEqual([])
  })
  it('single block run only marks stale', async () => {
    const { deps, store } = await setup([sql('a', 'q1', { resultName: 'a' }), chart('c', 'a')])
    const calls = wire(store)
    await runAll(deps, { kind: 'all' })
    calls.length = 0
    const { runSqlBlock } = await import('../src/run/runSqlBlock')
    await new Promise((r) => setTimeout(r, 5))
    await runSqlBlock(deps, 'a')
    expect(calls).toEqual([])
    expect(store.staleReasons('c')).toEqual(['upstream'])
  })
})
