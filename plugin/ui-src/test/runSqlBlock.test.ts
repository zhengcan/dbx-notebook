import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runSqlBlock } from '../src/run/runSqlBlock'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { HostError } from '../src/host/bridge'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'
import { serializeNotebook, parseNotebook } from '@sqlnb/format'

async function setup(bridgeOpts: any = {}, sql = 'select 1') {
  setLocale('zh-CN')
  const bridge = createFakeBridge(bridgeOpts)
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'prod', dbType: 'postgres', database: 'db1' })
  connections.seedFromContext({ id: 'c2', name: 'dev', dbType: 'postgres' })
  const store = useNotebookStore()
  store.setDefaultConnection('prod')
  const id = store.addBlock('sql', null)
  store.updateContent(id, sql)
  return { bridge, connections, store, id, deps: { bridge, connections, store } }
}
const q = (b: any) => (b.calls as any[]).filter(c => c.method === 'queryData')

describe('runSqlBlock', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('runs ok with default connection', async () => {
    const { deps, id, bridge, store } = await setup()
    const s = await runSqlBlock(deps, id)
    expect(s.status).toBe('ok')
    expect(s.ranSqlHash).toBe(hashSql('select 1'))
    expect(store.runs.get(id)?.status).toBe('ok')
    expect(q(bridge)[0].args).toEqual({ connectionId: 'c1', database: 'db1', schema: undefined, sql: 'select 1', maxRows: 5000 })
  })
  it('block connection overrides default; database override', async () => {
    const { deps, id, bridge, store } = await setup()
    store.updateMeta(id, { connection: 'dev', database: 'x', schema: 's' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[0].args).toMatchObject({ connectionId: 'c2', database: 'x', schema: 's' })
  })
  it('catalog precedence: block > notebook default > connection', async () => {
    const { deps, id, bridge, store } = await setup()
    store.setDefaultCatalog('nbdb', 'nbs')
    await runSqlBlock(deps, id)
    expect(q(bridge)[0].args).toMatchObject({ database: 'nbdb', schema: 'nbs' })
    store.updateMeta(id, { database: 'bdb', schema: 'bs' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[1].args).toMatchObject({ database: 'bdb', schema: 'bs' })
    store.removeMetaKey(id, 'database'); store.removeMetaKey(id, 'schema')
    await runSqlBlock(deps, id)
    expect(q(bridge)[2].args).toMatchObject({ database: 'nbdb', schema: 'nbs' })
    store.setDefaultCatalog(undefined, undefined)
    await runSqlBlock(deps, id)
    expect(q(bridge)[3].args).toMatchObject({ database: 'db1', schema: undefined })
  })
  it('whitespace counts as unset', async () => {
    const { deps, id, bridge, store } = await setup()
    store.updateMeta(id, { database: '  ', schema: ' ' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[0].args).toMatchObject({ database: 'db1', schema: undefined })
  })
  it('drops schema for dialects without schemas; keeps for postgres/unknown', async () => {
    const { deps, id, bridge, store, connections } = await setup()
    connections.seedFromContext({ id: 'c3', name: 'my', dbType: 'mysql' })
    connections.seedFromContext({ id: 'c4', name: 'ora', dbType: 'oracle' })
    store.setDefaultCatalog(undefined, 'public')
    store.updateMeta(id, { connection: 'my' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[0].args.schema).toBeUndefined()
    store.updateMeta(id, { schema: 'blk' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[1].args.schema).toBeUndefined()
    store.updateMeta(id, { connection: 'ora' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[2].args.schema).toBe('blk')
    store.updateMeta(id, { connection: 'prod' })
    await runSqlBlock(deps, id)
    expect(q(bridge)[3].args.schema).toBe('blk')
  })
  it('unknown block throws', async () => {
    const { deps } = await setup()
    await expect(runSqlBlock(deps, 'nope')).rejects.toThrow(/nope/)
  })
  it('no connection -> error', async () => {
    const { deps, id, store, bridge } = await setup()
    store.nb.value.settings.defaultConnection = undefined
    const s = await runSqlBlock(deps, id)
    expect(s.status).toBe('error')
    expect(s.error!.message).toContain('选择')
    expect(q(bridge)).toHaveLength(0)
  })
  it('unmatched connection -> error, no query', async () => {
    const { deps, id, store, bridge } = await setup()
    store.updateMeta(id, { connection: 'ghost' })
    const s = await runSqlBlock(deps, id)
    expect(s.status).toBe('error')
    expect(s.error!.message).toBe('连接 ghost 在 DBX 中不存在：请在 DBX 中创建同名连接，或选择其他连接')
    expect(s.ranSqlHash).toBe(hashSql('select 1'))
    expect(q(bridge)).toHaveLength(0)
  })
  it('ambiguous -> error', async () => {
    const { deps, id, connections, bridge } = await setup()
    connections.seedFromContext({ id: 'c3', name: 'prod' })
    const s = await runSqlBlock(deps, id)
    expect(s.status).toBe('error')
    expect(q(bridge)).toHaveLength(0)
  })
  it.each([
    ['NOT_OPEN', '请先在 DBX 中打开连接 prod'],
    ['NOT_GRANTED', '已拒绝该插件访问此连接，可在插件中心重新授权'],
    ['NOT_READONLY', '笔记本只能执行只读的单条语句'],
  ])('maps %s', async (code, msg) => {
    const { deps, id } = await setup({ queryData: async () => { throw new HostError(code as any, 'raw') } })
    const s = await runSqlBlock(deps, id)
    expect(s.error).toEqual({ code, message: msg })
  })
  it('keeps host message for other errors', async () => {
    const { deps, id } = await setup({ queryData: async () => { throw new HostError('UNKNOWN', 'boom') } })
    expect((await runSqlBlock(deps, id)).error).toEqual({ code: 'UNKNOWN', message: 'boom' })
  })
  it('source results without engine -> clear error, no query', async () => {
    const { deps, id, store, bridge } = await setup()
    store.updateMeta(id, { source: 'results' })
    const s = await runSqlBlock(deps, id)
    expect(s.error!.message).toBe('本地引擎不可用')
    expect(q(bridge)).toHaveLength(0)
  })
  it('source results dispatches to the engine, never queryData', async () => {
    const { deps, id, store, bridge } = await setup()
    store.updateMeta(id, { source: 'results' })
    const query = vi.fn(async () => ({ columns: [], rows: [], truncated: false, elapsedMs: 1 }))
    const engine: any = { sessionId: 's', ensureRegistered: async () => {}, query, invalidate() {}, close: async () => {} }
    const s = await runSqlBlock({ ...deps, engine }, id)
    expect(s.status).toBe('ok')
    expect(query).toHaveBeenCalledTimes(1)
    expect(q(bridge)).toHaveLength(0)
  })
  it('empty sql -> error', async () => {
    const { deps, id, bridge } = await setup({}, '  \n ')
    const s = await runSqlBlock(deps, id)
    expect(s.error!.message).toBe('SQL 为空')
    expect(q(bridge)).toHaveLength(0)
  })
  it('in-flight run returns same promise', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const { deps, id, store } = await setup({
      queryData: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' } },
    })
    const p1 = runSqlBlock(deps, id)
    expect(store.runs.get(id)?.status).toBe('running')
    const p2 = runSqlBlock(deps, id)
    expect(p2).toBe(p1)
    release()
    expect((await p1).status).toBe('ok')
    const p3 = runSqlBlock(deps, id)
    expect(p3).not.toBe(p1)
    await p3
  })
  it('reopening the same file while in flight does not return the old promise (M1)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const { deps, id, store } = await setup({
      queryData: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' } },
    })
    const p1 = runSqlBlock(deps, id)
    const text = store.toText()
    store.load(text, '/same.sqlnb', 1)
    const p2 = runSqlBlock(deps, id)
    expect(p2).not.toBe(p1)
    release()
    await Promise.all([p1, p2])
  })
  it('non-HostError throw resolves error and cleans in-flight', async () => {
    let n = 0
    const { deps, id, store } = await setup({ queryData: async () => { n++; throw new Error('boom') } })
    const p1 = runSqlBlock(deps, id)
    const s = await p1
    expect(s.status).toBe('error')
    expect(s.error!.message).toBe('boom')
    expect(store.runs.get(id)?.status).toBe('error')
    const p2 = runSqlBlock(deps, id)
    expect(p2).not.toBe(p1)
    await p2
    expect(n).toBe(2)
  })
  it('unexpected internal exception becomes error state', async () => {
    const { deps, id, connections } = await setup()
    ;(connections as any).resolve = () => { throw new Error('bug') }
    const s = await runSqlBlock(deps, id)
    expect(s.error).toEqual({ code: 'UNKNOWN', message: 'bug' })
  })
  it('ranSqlHash is of the SQL sent when edited mid-run', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const { deps, id, store } = await setup({
      queryData: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' } },
    })
    const p = runSqlBlock(deps, id)
    store.updateContent(id, 'select 2')
    release()
    const s = await p
    expect(s.ranSqlHash).toBe(hashSql('select 1'))
    expect(store.isStale(id)).toBe(true)
  })

  describe('input parameters', () => {
    const addInput = (store: any, variable: string, inputType: string, value: unknown, extra: any = {}) => {
      const iid = store.addBlock('input', null)
      store.updateMeta(iid, { variable, inputType, value, ...extra })
      return iid
    }
    const noCall = (b: any) => expect(q(b)).toHaveLength(0)

    it('renders per dialect via connection dbType', async () => {
      const { deps, id, bridge, store, connections } = await setup({}, 'select {{ x }}')
      connections.seedFromContext({ id: 'c3', name: 'my', dbType: 'mysql' })
      addInput(store, 'x', 'text', 'a\\b')
      await runSqlBlock(deps, id)
      expect(q(bridge)[0].args.sql).toBe("select E'a\\\\b'")
      store.updateMeta(id, { connection: 'my' })
      await runSqlBlock(deps, id)
      expect(q(bridge)[1].args.sql).toBe("select 'a\\\\b'")
      store.updateContent(id, 'select {{ x }}')
      store.nb.value.blocks.find((b: any) => b.type === 'input')!.metadata!.value = 'ab'
      store.updateMeta(id, { connection: 'prod' })
      await runSqlBlock(deps, id)
      expect(q(bridge)[2].args.sql).toBe("select 'ab'")
    })
    it('negative number and params snapshot with multiple vars and IN list', async () => {
      const { deps, id, bridge, store } = await setup({}, 'select {{ n }} where a in {{ l }} and b = {{ n }}')
      addInput(store, 'n', 'number', -5)
      addInput(store, 'l', 'select', ['a', 'b'], { multiple: true })
      const s = await runSqlBlock(deps, id)
      expect(q(bridge)[0].args.sql).toBe("select (-5) where a in ('a', 'b') and b = (-5)")
      expect(s.params).toEqual({ n: -5, l: ['a', 'b'] })
      expect(s.ranSqlHash).toBe(hashSql('select {{ n }} where a in {{ l }} and b = {{ n }}'))
      expect(store.runs.get(id)?.params).toEqual({ n: -5, l: ['a', 'b'] })
    })
    it('no refs: byte-identical sql and empty params', async () => {
      const { deps, id, bridge } = await setup({}, "select '{x}' -- ok")
      const s = await runSqlBlock(deps, id)
      expect(q(bridge)[0].args.sql).toBe("select '{x}' -- ok")
      expect(s.params).toEqual({})
    })
    it('input blocks added after the sql block resolve', async () => {
      const { deps, id, bridge, store } = await setup({}, 'select {{ x }}')
      addInput(store, 'x', 'number', 7)
      await runSqlBlock(deps, id)
      expect(q(bridge)[0].args.sql).toBe('select 7')
    })
    it('each ParamError code -> error state, no queryData, exact messages', async () => {
      const cases: [string, (s: any) => void, string, string, string][] = [
        ['select {{ x }}', () => {}, '变量 x 未定义（没有对应的输入块）', 'Variable x is not defined (no matching input block)', 'UNRESOLVED'],
        ['select {{ x }}', (s) => addInput(s, 'x', 'text', ''), '变量 x 尚未设置值', 'Variable x has no value yet', 'UNSET'],
        ['select {{ x }}', (s) => addInput(s, 'x', 'number', 'abc'), '变量 x 的值无法安全渲染（类型与输入类型不符或包含不允许的字符）', 'The value of variable x cannot be rendered safely (type mismatch with the input type, or disallowed characters)', 'INVALID'],
        ["select '{{ x }}'", (s) => addInput(s, 'x', 'number', 1), '{{ x }} 出现在字符串、标识符或注释中（位置 8），不支持', '{{ x }} appears inside a string, identifier or comment (position 8), which is not supported', 'FORBIDDEN_POSITION'],
        ['select {{ x }}', (s) => { addInput(s, 'x', 'number', 1); addInput(s, 'x', 'number', 2) }, '变量 x 有多个输入块', 'Variable x has multiple input blocks', 'DUPLICATE'],
      ]
      for (const [sql, prep, zh, en, pc] of cases) {
        for (const [loc, msg] of [['zh-CN', zh], ['en', en]] as const) {
          const { deps, id, bridge, store } = await setup({}, sql)
          prep(store)
          setLocale(loc)
          const s = await runSqlBlock(deps, id)
          expect(s.status).toBe('error')
          expect(s.error).toEqual({ code: 'UNKNOWN', message: msg, kind: 'param', variable: 'x', paramCode: pc })
          expect(s.ranSqlHash).toBe(hashSql(sql))
          expect(store.runs.get(id)?.status).toBe('error')
          noCall(bridge)
        }
      }
    })
    it('post-render error keeps params and has no kind', async () => {
      const { deps, id, store } = await setup({ queryData: async () => { throw new HostError('UNKNOWN', 'boom') } }, 'select {{ x }}')
      addInput(store, 'x', 'number', 3)
      const s = await runSqlBlock(deps, id)
      expect(s.status).toBe('error')
      expect(s.params).toEqual({ x: 3 })
      expect(s.error?.kind).toBeUndefined()
    })
    it('does not echo values', async () => {
      const secret = 's3cr3t-token'
      const a = await setup({}, 'select {{ x }}')
      addInput(a.store, 'x', 'number', secret)
      const s1 = await runSqlBlock(a.deps, a.id)
      const b = await setup({}, "select '{{ x }}'")
      addInput(b.store, 'x', 'text', secret)
      const s2 = await runSqlBlock(b.deps, b.id)
      for (const s of [s1, s2]) {
        expect(s.status).toBe('error')
        expect(JSON.stringify(s)).not.toContain(secret)
      }
    })
  })

  describe('maxRows / executedAt', () => {
    const fixed = () => new Date('2026-01-02T03:04:05.000Z')
    async function mk(bridgeOpts: any = {}) {
      setLocale('zh-CN')
      const bridge = createFakeBridge(bridgeOpts)
      const connections = createConnectionsStore(bridge)
      connections.seedFromContext({ id: 'c1', name: 'prod', dbType: 'postgres', database: 'db1' })
      const cap = { v: 5000 }
      const store = useNotebookStore({ now: fixed, maxRows: () => cap.v })
      store.setDefaultConnection('prod')
      const id = store.addBlock('sql', null)
      store.updateContent(id, 'select 1')
      return { bridge, store, id, cap, deps: { bridge, connections, store } }
    }
    it('uses the plugin-level maxRows, clamped; default 5000', async () => {
      const { deps, id, bridge, cap } = await mk()
      await runSqlBlock(deps, id)
      cap.v = 100
      await runSqlBlock(deps, id)
      cap.v = 99999
      await runSqlBlock(deps, id)
      expect(q(bridge).map((c: any) => c.args.maxRows)).toEqual([5000, 100, 5000])
    })
    it("ignores a file's settings.maxRows and keeps it on round trip", async () => {
      const { deps, id, bridge, store, cap } = await mk()
      const text = serializeNotebook({ ...store.nb.value, settings: { ...store.nb.value.settings, maxRows: 100 } })
      store.load(text, null, null)
      const id2 = store.nb.value.blocks[0].id
      expect(id2).toBe(id)
      cap.v = 250
      await runSqlBlock(deps, id2)
      expect(q(bridge)[0].args.maxRows).toBe(250)
      expect(store.nb.value.settings.maxRows).toBe(100)
      expect(store.dirty.value).toBe(false)
      expect(parseNotebook(store.toText()).settings?.maxRows).toBe(100)
    })
    it('records executedAt for ok and error runs and notes finish once each', async () => {
      const { deps, id, store } = await mk()
      const spy = vi.spyOn(store, 'noteRunFinished')
      const ok = await runSqlBlock(deps, id)
      expect(ok.executedAt).toBe('2026-01-02T03:04:05.000Z')
      expect(store.runs.get(id)?.executedAt).toBe('2026-01-02T03:04:05.000Z')
      expect(store.runs.get(id)?.fromFile).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
      store.updateContent(id, '  ')
      const err = await runSqlBlock(deps, id)
      expect(err.status).toBe('error')
      expect(store.runs.get(id)?.executedAt).toBe('2026-01-02T03:04:05.000Z')
      expect(spy).toHaveBeenCalledTimes(2)
    })
    it('does not touch a different notebook when generation changed', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const { deps, id, store } = await mk({ queryData: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'postgres' } } })
      const spy = vi.spyOn(store, 'noteRunFinished')
      const p = runSqlBlock(deps, id)
      store.runs.clear()
      store.generation.value++
      release()
      await p
      expect(spy).not.toHaveBeenCalled()
      expect(store.runs.get(id)?.executedAt).toBeUndefined()
      expect(store.runs.has(id)).toBe(false)
    })
    it('inline marks dirty; separate marks only resultsDirty', async () => {
      const a = await mk()
      await runSqlBlock(a.deps, a.id)
      expect(a.store.resultsDirty.value).toBe(true)
      const b = await mk()
      b.store.setOutputsMode('inline')
      b.store.dirty.value = false
      b.store.resultsDirty.value = false
      await runSqlBlock(b.deps, b.id)
      expect(b.store.dirty.value).toBe(true)
      const c = await mk()
      c.store.dirty.value = false
      await runSqlBlock(c.deps, c.id)
      expect(c.store.dirty.value).toBe(false)
      expect(c.store.resultsDirty.value).toBe(true)
    })
  })
})
