import { describe, it, expect, vi, beforeEach } from 'vitest'
import { trialRun } from '../src/ai/trialRun'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'

async function setup(opts: { conn?: boolean; blocks?: any[]; queryData?: any } = {}) {
  const queryData = opts.queryData ?? vi.fn(async () => ({ columns: [{ name: 'a' }], rows: [[1], [2]], truncated: false, elapsedMs: 1, dbType: 'postgres' }))
  const bridge = createFakeBridge({ queryData, caps: { aiCompletion: true } })
  const connections = createConnectionsStore(bridge)
  if (opts.conn !== false) connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push(...(opts.blocks ?? [{ id: 'b1', type: 'sql', content: 'select 1', metadata: {} }]))
  const engineQuery = vi.fn(async () => ({ columns: [{ name: 'c', type: 'INTEGER' }], rows: [[1]], truncated: false, elapsedMs: 3 }))
  const engine = { sessionId: 's', ensureRegistered: vi.fn(async () => {}), query: engineQuery, invalidate() {}, async close() {} }
  return { bridge, connections, store, queryData, engine, engineQuery, deps: { bridge, connections, store, engine } as any }
}
beforeEach(() => setLocale('en'))

describe('trialRun', () => {
  it.each(['insert into t values (1)', 'update t set a=1', 'select 1; select 2', 'delete from t'])('%s is refused without any query', async (sql) => {
    const s = await setup()
    const r = await trialRun(s.deps, 'b1', sql)
    expect(r).toMatchObject({ ok: false, reason: 'not-read-only' })
    expect(s.queryData).not.toHaveBeenCalled()
  })

  it('runs a SELECT with params rendered', async () => {
    const s = await setup()
    s.store.nb.value.blocks.push({ id: 'i1', type: 'input', content: '', metadata: { variable: 'n', inputType: 'number', value: '5' } } as any)
    const r = await trialRun(s.deps, 'b1', 'select * from t where a = {{n}}')
    expect(r).toMatchObject({ ok: true, columns: ['a'], rows: [[1], [2]], truncated: false })
    const req = s.queryData.mock.calls[0][0]
    expect(req.connectionId).toBe('c1')
    expect(req.sql).not.toContain('{{')
    expect(req.maxRows).toBe(50)
  })

  it('unresolved param -> params', async () => {
    const s = await setup()
    const r = await trialRun(s.deps, 'b1', 'select {{nope}}')
    expect(r).toMatchObject({ ok: false, reason: 'params' })
    expect(s.queryData).not.toHaveBeenCalled()
  })

  it('no connection -> no-connection', async () => {
    const s = await setup({ conn: false })
    expect(await trialRun(s.deps, 'b1', 'select 1')).toMatchObject({ ok: false, reason: 'no-connection' })
  })

  it('host error -> error with message; maxRows caps rows and flags truncated', async () => {
    const s = await setup({ queryData: vi.fn(async () => { throw new Error('boom') }) })
    expect(await trialRun(s.deps, 'b1', 'select 1')).toMatchObject({ ok: false, reason: 'error' })
    const many = await setup({ queryData: vi.fn(async () => ({ columns: [{ name: 'a' }], rows: Array.from({ length: 80 }, (_, i) => [i]), truncated: false, elapsedMs: 1, dbType: 'postgres' })) })
    const r = await trialRun(many.deps, 'b1', 'select a from t')
    expect(r.ok && r.rows.length).toBe(50)
    expect(r.ok && r.truncated).toBe(true)
  })

  it('second concurrent trial -> busy', async () => {
    let go: (v: any) => void = () => {}
    const s = await setup({ queryData: vi.fn(() => new Promise((r) => { go = r })) })
    const p = trialRun(s.deps, 'b1', 'select 1')
    expect(await trialRun(s.deps, 'b1', 'select 2')).toMatchObject({ ok: false, reason: 'busy' })
    go({ columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' })
    expect((await p).ok).toBe(true)
  })

  it('never mutates store.runs / revision / dirty / history and sends no host.ai request', async () => {
    const s = await setup()
    const rev = s.store.revision.value, dirty = s.store.dirty.value
    await trialRun(s.deps, 'b1', 'select 1')
    expect(s.store.runs.size).toBe(0)
    expect(s.store.revision.value).toBe(rev)
    expect(s.store.dirty.value).toBe(dirty)
    expect(s.store.history.undoDepth.value).toBe(0)
    expect((s.bridge.calls as any[]).some((c) => c.method === 'request' && String(c.args?.method).startsWith('host.ai'))).toBe(false)
  })

  it('local results block runs through the engine, not queryData', async () => {
    const s = await setup({ blocks: [
      { id: 'u', type: 'sql', content: 'select 1', metadata: { resultName: 'up' } },
      { id: 'b1', type: 'sql', content: 'select * from up', metadata: { source: 'results' } },
    ] })
    s.store.runs.set('u', { status: 'ok', result: { columns: [{ name: 'x' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' }, executedAt: 'z', ranSqlHash: hashSql('select 1') } as any)
    const before = s.store.runs.size
    const r = await trialRun(s.deps, 'b1', 'select * from up')
    expect(r).toMatchObject({ ok: true, columns: ['c'], rows: [[1]] })
    expect(s.engineQuery).toHaveBeenCalledTimes(1)
    expect(s.queryData).not.toHaveBeenCalled()
    expect(s.store.runs.size).toBe(before)
  })

  it('results block with a stale upstream is refused with a message, engine untouched', async () => {
    const s = await setup({ blocks: [
      { id: 'u', type: 'sql', content: 'select 1', metadata: { resultName: 'up' } },
      { id: 'b1', type: 'sql', content: 'select * from up', metadata: { source: 'results' } },
    ] })
    s.store.runs.set('u', { status: 'ok', result: { columns: [{ name: 'x' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' }, executedAt: 'z', ranSqlHash: 'different' } as any)
    expect(s.store.isStale('u')).toBe(true)
    const r = await trialRun(s.deps, 'b1', 'select * from up')
    expect(r).toMatchObject({ ok: false, reason: 'error' })
    expect(!r.ok && r.message).toMatch(/stale|out of date|re-run/i)
    expect(s.engineQuery).not.toHaveBeenCalled()
  })

  it('every failure carries a message', async () => {
    const s = await setup({ queryData: vi.fn(async () => { throw new Error('') }) })
    const r = await trialRun(s.deps, 'b1', 'select 1')
    expect(!r.ok && r.message).toBeTruthy()
  })
})
