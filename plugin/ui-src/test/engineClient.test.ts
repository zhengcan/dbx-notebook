import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEngineClient, EngineError, withReregister } from '../src/run/engineClient'
import { HostError } from '../src/host/bridge'

type Call = { method: string; params: any }
function mk(handler?: (c: Call) => unknown) {
  const calls: Call[] = []
  const bridge: any = {
    invoke: vi.fn(async (method: string, params: any) => {
      calls.push({ method, params })
      if (handler) return handler({ method, params })
      return {}
    }),
  }
  return { bridge, calls }
}
const blk: any = { id: 'b1' }
const run = (over: any = {}): any => ({
  status: 'ok', executedAt: 't1',
  result: { columns: [{ name: 'a', dataType: 'int' }, { name: 'b' }], rows: [[1, 2]], truncated: false, elapsedMs: 1, dbType: 'x' },
  ...over,
})
const mkc = (b: any) => createEngineClient(b, { sessionId: 'ses_test1234' })
const count = (calls: Call[], m: string) => calls.filter((c) => c.method === m).length
const fail = (code: number, msg: string) => new HostError('UNKNOWN', msg, code)

afterEach(() => vi.useRealTimers())

describe('engineClient', () => {
  it('session id format and uniqueness', () => {
    const { bridge } = mk()
    const a = createEngineClient(bridge), b = createEngineClient(bridge)
    expect(a.sessionId).toMatch(/^ses_[A-Za-z0-9]{20}$/)
    expect(a.sessionId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(createEngineClient(bridge, { randomId: () => 'custom_id_1' }).sessionId).toBe('custom_id_1')
  })
  it('registers once, no-op on same run, re-registers on change', async () => {
    const { bridge, calls } = mk()
    const c = mkc(bridge)
    await c.ensureRegistered('t', blk, run())
    await c.ensureRegistered('t', blk, run())
    expect(count(calls, 'engine/register')).toBe(1)
    await c.ensureRegistered('t', blk, run({ executedAt: 't2' }))
    expect(count(calls, 'engine/register')).toBe(2)
    const r = run(); r.result.rows.push([3, 4])
    await c.ensureRegistered('t', blk, r)
    expect(count(calls, 'engine/register')).toBe(3)
  })
  it('concurrent same name registers once; different names independent', async () => {
    const { bridge, calls } = mk()
    const c = mkc(bridge)
    await Promise.all([c.ensureRegistered('t', blk, run()), c.ensureRegistered('t', blk, run())])
    expect(count(calls, 'engine/register')).toBe(1)
    await Promise.all([c.ensureRegistered('x', blk, run()), c.ensureRegistered('y', blk, run())])
    expect(count(calls, 'engine/register')).toBe(3)
  })
  it('rejects non-ok run without RPC', async () => {
    const { bridge, calls } = mk()
    await expect(mkc(bridge).ensureRegistered('t', blk, { status: 'error' } as any)).rejects.toThrow('block result not available')
    expect(calls.length).toBe(0)
  })
  it('maps column types and passes rows by reference', async () => {
    const { bridge, calls } = mk()
    const r = run()
    await mkc(bridge).ensureRegistered('t', blk, r)
    const p = calls[0].params
    expect(p.sessionId).toBe('ses_test1234')
    expect(p.name).toBe('t')
    expect(p.columns).toEqual([{ name: 'a', type: 'int' }, { name: 'b' }])
    expect('type' in p.columns[1]).toBe(false)
    expect(p.rows).toBe(r.result.rows)
  })
  it('sends decimal (numeric affinity) for columns whose number kind is inferred from numeric strings', async () => {
    const { bridge, calls } = mk()
    const r = { status: 'ok', executedAt: 'T', result: { columns: [{ name: 'a' }, { name: 'b', dataType: 'weird' }, { name: 'c', dataType: 'varchar' }], rows: [['12.50', '3', '7']], truncated: false, elapsedMs: 1, dbType: 'x' } } as any
    await mkc(bridge).ensureRegistered('t', blk, r)
    expect(calls[0].params.columns).toEqual([{ name: 'a', type: 'decimal' }, { name: 'b', type: 'decimal' }, { name: 'c', type: 'varchar' }])
  })
  it('query happy path', async () => {
    const out = { columns: [{ name: 'n', type: 'BIGINT' }], rows: [[1]], truncated: false, elapsedMs: 3 }
    const { bridge, calls } = mk(() => out)
    expect(await mkc(bridge).query('select 1', 10)).toEqual(out)
    expect(calls[0]).toEqual({ method: 'engine/query', params: { sessionId: 'ses_test1234', sql: 'select 1', maxRows: 10 } })
  })
  it('clamps maxRows', async () => {
    const { bridge, calls } = mk(() => ({ columns: [], rows: [], truncated: false, elapsedMs: 0 }))
    const c = mkc(bridge)
    for (const n of [0, -3, 1e9, 2.5]) await c.query('s', n)
    expect(calls.map((x) => x.params.maxRows)).toEqual([1, 1, 5000, 2])
  })
  it('parses error with hint', async () => {
    const { bridge } = mk(() => { throw fail(-32602, 'near "::": syntax error\nhint:cast_operator') })
    const e: any = await mkc(bridge).query('s', 5).catch((x) => x)
    expect(e).toBeInstanceOf(EngineError)
    expect(e.code).toBe(-32602)
    expect(e.hint).toBe('cast_operator')
    expect(e.message).toBe('near "::": syntax error')
    expect(e.sqlMessage).toBe('near "::": syntax error')
  })
  it('parses prefixed raw errors and passes through -32021', async () => {
    const { bridge } = mk(() => { throw new Error('[-32021] session full') })
    const e: any = await mkc(bridge).query('s', 5).catch((x) => x)
    expect(e.code).toBe(-32021)
    expect(e.message).toBe('session full')
  })
  it('no such table: needsReregister depends on cache', async () => {
    const { bridge } = mk((c) => { if (c.method === 'engine/query') throw fail(-32602, 'no such table: t'); return {} })
    const c = mkc(bridge)
    const miss: any = await c.query('select * from t', 5).catch((x) => x)
    expect(miss.needsReregister).toBeFalsy()
    await c.ensureRegistered('t', blk, run())
    const hit: any = await c.query('select * from t', 5).catch((x) => x)
    expect(hit.needsReregister).toBe(true)
  })
  it('invalidate clears one or all', async () => {
    const { bridge, calls } = mk()
    const c = mkc(bridge)
    await c.ensureRegistered('a', blk, run())
    await c.ensureRegistered('b', blk, run())
    c.invalidate('a')
    await c.ensureRegistered('a', blk, run()); await c.ensureRegistered('b', blk, run())
    expect(count(calls, 'engine/register')).toBe(3)
    c.invalidate()
    await c.ensureRegistered('b', blk, run())
    expect(count(calls, 'engine/register')).toBe(4)
  })
  it('close is best effort and clears cache', async () => {
    const { bridge, calls } = mk((c) => { if (c.method === 'engine/close') throw new Error('boom'); return {} })
    const c = mkc(bridge)
    await c.ensureRegistered('a', blk, run())
    await expect(c.close()).resolves.toBeUndefined()
    await c.ensureRegistered('a', blk, run())
    expect(count(calls, 'engine/register')).toBe(2)
  })
  it('60s timeout rejects with -32020 and leaves no timers', async () => {
    vi.useFakeTimers()
    const bridge: any = { invoke: () => new Promise(() => {}) }
    const p = mkc(bridge).query('s', 5).catch((x) => x)
    await vi.advanceTimersByTimeAsync(60_000)
    const e: any = await p
    expect(e).toBeInstanceOf(EngineError)
    expect(e.code).toBe(-32020)
    expect(e.message).toBe('engine request timed out')
    expect(vi.getTimerCount()).toBe(0)
    const ok: any = { invoke: async () => ({}) }
    await mkc(ok).close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('errors never contain row data', async () => {
    const { bridge } = mk((c) => { if (c.method === 'engine/register') throw fail(-32602, 'bad'); return {} })
    const r = run(); r.result.rows = [['SECRET_VALUE']]
    const e: any = await mkc(bridge).ensureRegistered('t', blk, r).catch((x) => x)
    expect(e.message).not.toContain('SECRET_VALUE')
  })
})

describe('withReregister', () => {
  const need = () => Object.assign(new EngineError(-32602, 'no such table: t'), { needsReregister: true })
  it('success first try', async () => {
    const fn = vi.fn(async () => 1), re = vi.fn(async () => {})
    expect(await withReregister(fn, re)).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1); expect(re).not.toHaveBeenCalled()
  })
  it('retries once after reregister', async () => {
    const fn = vi.fn().mockRejectedValueOnce(need()).mockResolvedValueOnce(2)
    const re = vi.fn(async () => {})
    expect(await withReregister(fn, re)).toBe(2)
    expect(re).toHaveBeenCalledTimes(1); expect(fn).toHaveBeenCalledTimes(2)
  })
  it('second failure surfaces', async () => {
    const e2 = need()
    const fn = vi.fn().mockRejectedValueOnce(need()).mockRejectedValueOnce(e2)
    await expect(withReregister(fn, async () => {})).rejects.toBe(e2)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('other errors not retried', async () => {
    const fn = vi.fn().mockRejectedValue(new EngineError(-32602, 'x'))
    const re = vi.fn(async () => {})
    await expect(withReregister(fn, re)).rejects.toThrow('x')
    expect(fn).toHaveBeenCalledTimes(1); expect(re).not.toHaveBeenCalled()
  })
})
