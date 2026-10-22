import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runResultsBlock } from '../src/run/runResultsBlock'
import { runSqlBlock } from '../src/run/runSqlBlock'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { EngineError, type EngineClient } from '../src/run/engineClient'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'

const sql = (id: string, content: string, metadata: any = {}) => ({ id, type: 'sql', content, metadata })
const res = (id: string, content: string, name?: string) => sql(id, content, { source: 'results', ...(name ? { resultName: name } : {}) })
const okRun = (executedAt: string, o: any = {}) => ({
  status: 'ok' as const,
  result: { columns: [{ name: 'x', dataType: 'int' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'pg', ...(o.result ?? {}) },
  ranSqlHash: 'h', executedAt, ...(o.run ?? {}),
})

function fakeEngine(over: Partial<EngineClient> & { queryImpl?: (sql: string, n: number) => any } = {}) {
  const calls = { register: [] as string[], query: [] as [string, number][], invalidate: 0 }
  const engine: EngineClient = {
    sessionId: 's',
    async ensureRegistered(name) { calls.register.push(name) },
    async query(s, n) {
      calls.query.push([s, n])
      if (over.queryImpl) return over.queryImpl(s, n)
      return { columns: [{ name: 'c', type: 'INTEGER' }], rows: [[1], [2]], truncated: false, elapsedMs: 7 }
    },
    invalidate() { calls.invalidate++ },
    async close() {},
  }
  return { engine, calls }
}

function setup(blocks: any[], engineOver: any = {}, maxRows?: () => number) {
  setLocale('en')
  const bridge = createFakeBridge()
  const store = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z'), ...(maxRows ? { maxRows } : {}) })
  store.nb.value.blocks.push(...blocks)
  const { engine, calls } = fakeEngine(engineOver)
  return { bridge, store, engine, calls, deps: { bridge, store, engine } }
}

describe('runResultsBlock', () => {
  beforeEach(() => setLocale('en'))

  it('success: maps result, snapshot upstream, clock, maxRows', async () => {
    const { deps, store, calls } = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')], {}, () => 123)
    store.nb.value.settings.maxRows = 7
    store.runs.set('a', okRun('T0'))
    const s = await runResultsBlock(deps, 'b')
    expect(s).toMatchObject({
      status: 'ok', ranSqlHash: hashSql('select * from a'), executedAt: '2026-01-02T03:04:05.000Z',
      upstream: { a: 'T0' }, partial: false,
      result: { columns: [{ name: 'c', dataType: 'INTEGER' }], rows: [[1], [2]], truncated: false, elapsedMs: 7, dbType: 'sqlite' },
    })
    expect(calls.register).toEqual(['a'])
    expect(calls.query).toEqual([['select * from a', 123]])
    expect(store.runs.get('b')).toEqual(s)
  })
  it('partial inherits from truncated and partial upstream and own truncation', async () => {
    const mk = () => setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')])
    let x = mk(); x.store.runs.set('a', okRun('T', { result: { truncated: true } }))
    expect((await runResultsBlock(x.deps, 'b')).partial).toBe(true)
    x = mk(); x.store.runs.set('a', okRun('T', { run: { partial: true } }))
    expect((await runResultsBlock(x.deps, 'b')).partial).toBe(true)
    x = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')], { queryImpl: () => ({ columns: [], rows: [], truncated: true, elapsedMs: 1 }) })
    x.store.runs.set('a', okRun('T'))
    expect((await runResultsBlock(x.deps, 'b')).partial).toBe(true)
  })
  it('no references still runs', async () => {
    const { deps, calls } = setup([res('b', 'select 1')])
    const s = await runResultsBlock(deps, 'b')
    expect(s.status).toBe('ok')
    expect(s.upstream).toEqual({})
    expect(calls.register).toEqual([])
    expect(calls.query).toHaveLength(1)
  })
  describe('params', () => {
    const inp = (variable: string, inputType: string, value: unknown, extra: any = {}) =>
      ({ id: 'i_' + variable, type: 'input', metadata: { variable, inputType, value, ...extra } })
    const SECRET = 'S3cr3t-Zq9'
    it('renders with SQLite rules, passes rendered SQL, params snapshot, raw hash', async () => {
      const raw = 'select * from a where r = {{ r }} and n = {{ n }} and d = {{ d }} and b = {{ b }} and s in {{ s }}'
      const { deps, calls } = setup([
        inp('r', 'text', "O'Br\\ien"), inp('n', 'number', -5), inp('d', 'date', '2026-01-31'), inp('b', 'boolean', true),
        inp('s', 'select', ['a', "b'c"], { multiple: true, options: ['a', "b'c"] }),
        sql('a', 'select 1', { resultName: 'a' }), res('b', raw),
      ])
      ;(deps.store.runs as any).set('a', okRun('T0'))
      const s = await runResultsBlock(deps, 'b')
      expect(s.status).toBe('ok')
      expect(calls.query[0][0]).toBe("select * from a where r = 'O''Br\\ien' and n = (-5) and d = '2026-01-31' and b = 1 and s in ('a', 'b''c')")
      expect(s.ranSqlHash).toBe(hashSql(raw))
      expect(s.params).toEqual({ r: "O'Br\\ien", n: -5, d: '2026-01-31', b: true, s: ['a', "b'c"] })
      expect(s.upstream).toEqual({ a: 'T0' })
    })
    it('boolean false renders 0', async () => {
      const { deps, calls } = setup([inp('b', 'boolean', false), res('b', 'select {{ b }}')])
      await runResultsBlock(deps, 'b')
      expect(calls.query[0][0]).toBe('select 0')
    })
    it('SQL without placeholders is passed byte-identical and has no params', async () => {
      const q = "select  '{x}' , 1  -- c\n"
      const { deps, calls } = setup([res('b', q)])
      const s = await runResultsBlock(deps, 'b')
      expect(calls.query[0][0]).toBe(q)
      expect(s.params).toEqual({})
    })
    it.each([
      ['select {{ x }}', [] as any[], '变量 x 未定义（没有对应的输入块）', 'Variable x is not defined (no matching input block)', 'UNRESOLVED'],
      ['select {{ x }}', [inp('x', 'text', '')], '变量 x 尚未设置值', 'Variable x has no value yet', 'UNSET'],
      ['select {{ x }}', [inp('x', 'number', SECRET)], '变量 x 的值无法安全渲染（类型与输入类型不符或包含不允许的字符）', 'The value of variable x cannot be rendered safely (type mismatch with the input type, or disallowed characters)', 'INVALID'],
      ["select '{{ x }}'", [inp('x', 'text', SECRET)], '{{ x }} 出现在字符串、标识符或注释中（位置 8），不支持', '{{ x }} appears inside a string, identifier or comment (position 8), which is not supported', 'FORBIDDEN_POSITION'],
      ['select {{ x }}', [inp('x', 'text', SECRET), inp('x', 'text', 'b')], '变量 x 有多个输入块', 'Variable x has multiple input blocks', 'DUPLICATE'],
    ])('%s -> %s', async (q, inputs, zh, en, code) => {
      const { deps, calls } = setup([...inputs, res('b', q)])
      const s = await runResultsBlock(deps, 'b')
      expect(s.status).toBe('error')
      expect(s.error).toMatchObject({ kind: 'param', variable: 'x', paramCode: code, message: en })
      expect(s.ranSqlHash).toBe(hashSql(q))
      expect(s.ranSource).toBe('results')
      expect(JSON.stringify(s)).not.toContain(SECRET)
      expect(calls.query).toHaveLength(0)
      expect(calls.register).toHaveLength(0)
      setLocale('zh-CN')
      expect((await runResultsBlock(deps, 'b')).error!.message).toBe(zh)
    })
    it('placeholder is not a table reference; FORWARD/SELF unaffected', async () => {
      const { deps, calls } = setup([inp('orders', 'text', 'x'), sql('o', 'select 1', { resultName: 'orders' }), res('b', 'select {{ orders }}')])
      const s = await runResultsBlock(deps, 'b')
      expect(s.status).toBe('ok')
      expect(calls.register).toEqual([])
      let x = setup([inp('x', 'number', 1), res('b', 'select * from a where k = {{ x }}', 'a')])
      expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('A block cannot reference its own result "a"')
      x = setup([inp('x', 'number', 1), res('b', 'select * from a where k = {{ x }}'), sql('a', 'select 1', { resultName: 'a' })])
      expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('The block for "a" comes after this block; reorder them')
    })
    it('via runSqlBlock dispatch', async () => {
      const { deps, calls, store, bridge } = setup([inp('n', 'number', 3), res('b', 'select {{ n }}')])
      const s = await runSqlBlock({ bridge, connections: createConnectionsStore(bridge as any), store, engine: deps.engine }, 'b')
      expect(s.status).toBe('ok')
      expect(calls.query[0][0]).toBe('select 3')
    })
  })
  it('DepError messages', async () => {
    let x = setup([res('b', 'select * from a', 'a')])
    expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('A block cannot reference its own result "a"')
    x = setup([res('b', 'select * from a'), sql('a', 'select 1', { resultName: 'a' })])
    expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('The block for "a" comes after this block; reorder them')
    x = setup([sql('a', 'select 1', { resultName: 'a' }), sql('a2', 'select 2', { resultName: 'a' }), res('b', 'select * from a')])
    expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('Result name "a" is used by more than one block')
    expect(x.calls.query).toHaveLength(0)
    setLocale('zh-CN')
    expect((await runResultsBlock(x.deps, 'b')).error!.message).toBe('结果名「a」被多个块使用')
  })
  it('upstream missing / never run / error run: names block, no query', async () => {
    const { deps, store, calls } = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')])
    let s = await runResultsBlock(deps, 'b')
    expect(s.error!.message).toBe('Block "a" has no result yet — run it first')
    store.runs.set('a', { status: 'error', error: { code: 'UNKNOWN', message: 'x' } })
    s = await runResultsBlock(deps, 'b')
    expect(s.error!.message).toContain('"a"')
    expect(s.executedAt).toBeTruthy()
    expect(calls.query).toHaveLength(0)
    setLocale('zh-CN')
    expect((await runResultsBlock(deps, 'b')).error!.message).toBe('块「a」还没有结果，请先运行它')
  })
  it('session loss: invalidate, re-register all, retry once', async () => {
    let n = 0
    const { deps, store, calls } = setup([sql('a', 'select 1', { resultName: 'a' }), sql('c', 'select 1', { resultName: 'c' }), res('b', 'select * from a, c')], {
      queryImpl: () => { if (n++ === 0) { const e = new EngineError(-32602, 'no such table: a'); e.needsReregister = true; throw e } return { columns: [], rows: [], truncated: false, elapsedMs: 1 } },
    })
    store.runs.set('a', okRun('T')); store.runs.set('c', okRun('T'))
    const s = await runResultsBlock(deps, 'b')
    expect(s.status).toBe('ok')
    expect(calls.invalidate).toBe(1)
    expect(calls.register).toEqual(['a', 'c', 'a', 'c'])
    expect(calls.query).toHaveLength(2)
  })
  it('second failure surfaces', async () => {
    const { deps, store, calls } = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')], {
      queryImpl: () => { const e = new EngineError(-32602, 'no such table: a'); e.needsReregister = true; throw e },
    })
    store.runs.set('a', okRun('T'))
    const s = await runResultsBlock(deps, 'b')
    expect(s.status).toBe('error')
    expect(calls.query).toHaveLength(2)
  })
  it('engine error carries hint', async () => {
    const { deps, store } = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from a')], {
      queryImpl: () => { throw new EngineError(-32602, 'near "::": syntax error', 'cast_operator') },
    })
    store.runs.set('a', okRun('T'))
    const s = await runResultsBlock(deps, 'b')
    expect(s.error).toEqual({ code: 'UNKNOWN', message: 'near "::": syntax error', kind: 'engine', hint: 'SQLite has no :: operator; use CAST(x AS type)' })
  })
  it('unexpected exception clears running into an error state', async () => {
    const { deps, store } = setup([res('b', 'select 1')], { queryImpl: () => { throw new TypeError('kaboom') } })
    const s = await runResultsBlock(deps, 'b')
    expect(s.status).toBe('error')
    expect(s.error).toMatchObject({ code: 'UNKNOWN', message: 'kaboom' })
    expect(store.runs.get('b')!.status).toBe('error')
  })
  it('no such table for unknown name appends a bilingual hint', async () => {
    const { deps } = setup([sql('a', 'select 1', { resultName: 'a' }), res('b', 'select * from zz')], { queryImpl: () => { throw new EngineError(-32602, 'no such table: zz') } })
    const s = await runResultsBlock(deps, 'b')
    expect(s.error).toEqual({ code: 'UNKNOWN', message: 'no such table: zz', kind: 'engine', hint: 'No result named zz found: check the spelling, or give the database block a result name first' })
    setLocale('zh-CN')
    expect((await runResultsBlock(deps, 'b')).error!.hint).toBe('找不到名为 zz 的结果：请检查拼写，或先给对应的数据库块设置结果名')
  })
  it('no such table for a known resultName has no such hint', async () => {
    const { deps, store } = setup([sql('a', 'select 1', { resultName: 'zz' }), res('b', 'select * from zz')], { queryImpl: () => { throw new EngineError(-32602, 'no such table: zz') } })
    store.runs.set('a', okRun('T'))
    expect((await runResultsBlock(deps, 'b')).error!.hint).toBeUndefined()
  })
  it('renamed upstream: next run reports the missing table', async () => {
    const { deps, store } = setup([sql('a', 'select 1', { resultName: 'renamed' }), res('b', 'select * from a')], { queryImpl: () => { throw new EngineError(-32602, 'no such table: a') } })
    store.runs.set('a', okRun('T'))
    const s = await runResultsBlock(deps, 'b')
    expect(s.error!.message).toBe('no such table: a')
    expect(s.error!.hint).toContain('a')
  })
  it('timeout and full', async () => {
    let code = -32020
    const { deps } = setup([res('b', 'select 1')], { queryImpl: () => { throw new EngineError(code, 'raw') } })
    expect((await runResultsBlock(deps, 'b')).error!.message).toBe(
      (await import('../src/i18n')).t('run.engineTimeout'))
    code = -32021
    setLocale('zh-CN')
    expect((await runResultsBlock(deps, 'b')).error!.message).toBe('本地引擎内存已满，请重新打开笔记本或减少结果行数')
  })
  it('generation change mid-run does not write', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { deps, store } = setup([res('b', 'select 1')], { queryImpl: async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1 } } })
    const p = runResultsBlock(deps, 'b')
    await Promise.resolve()
    store.generation.value++
    store.runs.clear()
    release()
    await p
    expect(store.runs.has('b')).toBe(false)
  })
  it('runSqlBlock dispatches, coalesces, never calls queryData', async () => {
    const { deps, store, bridge, calls } = setup([res('b', 'select 1')])
    const connections = createConnectionsStore(bridge)
    const d = { ...deps, connections }
    const p1 = runSqlBlock(d, 'b')
    const p2 = runSqlBlock(d, 'b')
    expect(p1).toBe(p2)
    const s = await p1
    expect(s.status).toBe('ok')
    expect(calls.query).toHaveLength(1)
    expect((bridge as any).calls.filter((c: any) => c.method === 'queryData')).toHaveLength(0)
    expect(store.runs.get('b')!.status).toBe('ok')
  })
  it('runSqlBlock without engine: clear error', async () => {
    const { store, bridge } = setup([res('b', 'select 1')])
    const s = await runSqlBlock({ bridge, connections: createConnectionsStore(bridge), store }, 'b')
    expect(s.error!.message).toBe(
      (await import('../src/i18n')).t('run.noEngine'))
    expect(s.error!.message).toMatch(/engine/i)
  })
})
void vi
