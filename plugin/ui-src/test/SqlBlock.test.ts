import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, CanRunKey, ConnectionsKey, StoreKey } from '../src/injection'
import { computed } from 'vue'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'

async function setup(opts: { conn?: string; metadata?: Record<string, unknown>; upstream?: (b: any) => any } = {}) {
  const bridge = createFakeBridge({
    queryData: vi.fn(async () => ({ columns: [{ name: 'a' }], rows: [[1], [2]], truncated: false, elapsedMs: 5, dbType: 'postgres' })),
  })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore({ upstream: opts.upstream })
  store.nb.value.settings.defaultConnection = opts.conn ?? 'main'
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: opts.metadata ?? {} })
  const editors: any[] = []
  const editorFactory = vi.fn((_p: HTMLElement, o: any) => {
    let doc: string = o.doc
    const e = {
      opts: o,
      setDoc: vi.fn((x: string) => { doc = x }),
      getDoc: () => doc,
      type(x: string) { doc = x; o.onChange(x) },
      setDialect: vi.fn(), setFont: vi.fn(), setDark: vi.fn(), clearCache: vi.fn(), destroy: vi.fn() }
    editors.push(e)
    return e
  })
  const w = mount(SqlBlock, {
    props: { blockId: 'b1', editorFactory },
    global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } },
  })
  return { w, store, bridge, editors, editorFactory }
}

describe('SqlBlock', () => {
  beforeEach(() => setLocale('en'))

  it('run button calls queryData once with right args and shows result', async () => {
    const { w, bridge } = await setup()
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    expect(bridge.queryData).toHaveBeenCalledTimes(1)
    expect(bridge.queryData).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', database: 'db1', sql: 'select 1', maxRows: 5000 }))
    expect(w.find('[data-test=status]').text()).toContain('2 rows')
  })

  it('Mod-Enter (onRun) runs; editor onChange updates store', async () => {
    const { editors, store, bridge } = await setup()
    editors[0].opts.onChange('select 2')
    expect(store.nb.value.blocks[0].content).toBe('select 2')
    editors[0].opts.onRun()
    await flushPromises()
    expect(bridge.queryData).toHaveBeenCalledTimes(1)
  })

  it('invalid resultName is not written; clearing removes', async () => {
    const { w, store } = await setup({ metadata: { resultName: 'ok_1' } })
    const input = w.find('[data-test=result-name]')
    await input.setValue('1bad name')
    expect(store.nb.value.blocks[0].metadata?.resultName).toBe('ok_1')
    expect(input.classes()).toContain('invalid')
    await input.setValue('good_2')
    expect(store.nb.value.blocks[0].metadata?.resultName).toBe('good_2')
    await input.setValue('')
    expect(store.nb.value.blocks[0].metadata).not.toHaveProperty('resultName')
  })

  it('shows stale chip after editing post-run', async () => {
    const { w, store } = await setup()
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    store.updateContent('b1', 'select 3')
    await flushPromises()
    expect(w.find('[data-test=status]').text()).toContain('Stale')
  })

  it.each([
    ['en', 'sql', 'SQL was modified'],
    ['zh-CN', 'sql', 'SQL 已修改'],
    ['en', 'params', 'Parameters changed'],
    ['zh-CN', 'params', '参数已变化'],
    ['en', 'upstream', 'Upstream results changed'],
    ['zh-CN', 'upstream', '上游结果已变化'],
    ['en', 'both', 'SQL was modified, Parameters changed'],
    ['zh-CN', 'both', 'SQL 已修改、参数已变化'],
  ])('stale marker title (%s, %s)', async (loc, reason, text) => {
    const { w, store } = await setup({ upstream: reason === 'upstream' ? () => 'upstream' : undefined })
    setLocale(loc as 'en')
    store.nb.value.blocks.push({ id: 'i1', type: 'input', metadata: { variable: 'a', inputType: 'text', value: 'p' } } as any)
    store.runs.set('b1', { status: 'ok', ranSqlHash: hashSql(reason === 'sql' || reason === 'both' ? 'other' : 'select 1'), params: { a: reason === 'params' || reason === 'both' ? 'old' : 'p' } })
    await flushPromises()
    const chip = w.find('[data-test=status]')
    expect(chip.attributes('title')).toBe(text)
    expect(chip.attributes('aria-label')).toBe(text)
  })

  it('unmatched connection shows badge', async () => {
    const { w } = await setup({ conn: 'ghost' })
    expect(w.find('[data-test=unmatched]').exists()).toBe(true)
  })

  it('connection select sets and clears override', async () => {
    const { w, store } = await setup()
    await w.find('[data-test=conn]').setValue('main')
    expect(store.nb.value.blocks[0].metadata?.connection).toBe('main')
    await w.find('[data-test=conn]').setValue('')
    expect(store.nb.value.blocks[0].metadata).not.toHaveProperty('connection')
  })

  it('columnsFor uses getTableMetadata', async () => {
    const { editors, bridge } = await setup()
    ;(bridge as any).getTableMetadata = vi.fn(async () => ({ columns: [{ name: 'id', dataType: 'int', nullable: false }] }))
    expect(await editors[0].opts.columnsFor('public.users')).toEqual(['id'])
    expect(bridge.getTableMetadata).toHaveBeenCalledWith({ connectionId: 'c1', database: 'db1', schema: 'public', table: 'users' })
  })

  it('store -> editor sync; own onChange does not echo setDoc', async () => {
    const { editors, store } = await setup()
    store.updateContent('b1', 'select 2')
    await flushPromises()
    expect(editors[0].setDoc).toHaveBeenCalledTimes(1)
    expect(editors[0].setDoc).toHaveBeenCalledWith('select 2')
    editors[0].type('select 3')
    await flushPromises()
    expect(editors[0].setDoc).toHaveBeenCalledTimes(1)
  })

  it('a -> b -> a keeps editor in sync (no stale guard)', async () => {
    const { editors, store } = await setup()
    editors[0].type('a')
    store.updateContent('b1', 'b')
    await flushPromises()
    expect(editors[0].getDoc()).toBe('b')
    store.updateContent('b1', 'a')
    await flushPromises()
    expect(editors[0].getDoc()).toBe('a')
  })

  it('refreshes cache/dialect when default connection changes; nameDraft resyncs', async () => {
    const { editors, store, w } = await setup({ metadata: { resultName: 'a' } })
    editors[0].clearCache.mockClear()
    store.nb.value.settings.defaultConnection = 'other'
    await flushPromises()
    expect(editors[0].clearCache).toHaveBeenCalled()
    store.updateMeta('b1', { resultName: 'zz' })
    await flushPromises()
    expect((w.find('[data-test=result-name]').element as HTMLInputElement).value).toBe('zz')
  })

  it('missing provide throws helpful error', () => {
    expect(() => mount(SqlBlock, { props: { blockId: 'b1' } })).toThrow('SqlBlock: missing provided StoreKey')
  })

  it('unmount destroys editor and unsubscribes env', async () => {
    const { w, editors, bridge } = await setup()
    ;(bridge as any).emitEnv()
    expect(editors[0].setFont).toHaveBeenCalled()
    editors[0].setFont.mockClear()
    w.unmount()
    expect(editors[0].destroy).toHaveBeenCalled()
    ;(bridge as any).emitEnv()
    expect(editors[0].setFont).not.toHaveBeenCalled()
  })
})

describe('SqlBlock canRun', () => {
  it('disables run and does not query when canRun is false', async () => {
    setLocale('en')
    const bridge = createFakeBridge({ queryData: vi.fn() as any })
    const connections = createConnectionsStore(bridge)
    const store = useNotebookStore()
    store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} })
    const editorFactory = vi.fn((_p: HTMLElement, o: any) => ({ opts: o, setDoc() {}, getDoc: () => o.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }))
    const w = mount(SqlBlock, {
      props: { blockId: 'b1', editorFactory: editorFactory as any },
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [CanRunKey as symbol]: computed(() => false) } },
    })
    expect(w.find('[data-test=run]').attributes('disabled')).toBeDefined()
    ;(editorFactory.mock.calls[0] as any)[1].onRun()
    await flushPromises()
    expect(bridge.queryData).not.toHaveBeenCalled()
  })
})

describe('SqlBlock error hints', () => {
  beforeEach(() => setLocale('en'))
  const B = 'SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.'
  const fail = (store: any, message: string) => store.runs.set('b1', { status: 'error', error: { code: 'query_failed', message } })

  it('shows hint with block metadata and details with boilerplate', async () => {
    const { w, store } = await setup({ metadata: { database: 'mydb', schema: 'sch' } })
    fail(store, `ERROR: relation "xxx" does not exist ${B}`)
    await flushPromises()
    expect(w.find('[data-test=error]').text()).toContain('ERROR: relation "xxx" does not exist')
    expect(w.find('[data-test=error-hint]').text()).toBe('Check the selected database and schema (current: mydb/sch)')
    const d = w.find('[data-test=error-redacted]')
    expect(d.element.tagName).toBe('DETAILS')
    expect(d.text()).toContain(B)
    expect(d.text()).toContain('DBX hid the SQL text')
  })
  it('falls back to notebook default and connection', async () => {
    const { w, store } = await setup()
    store.nb.value.settings.defaultSchema = 'nbs'
    fail(store, 'relation "x" does not exist')
    await flushPromises()
    expect(w.find('[data-test=error-hint]').text()).toContain('(current: db1/nbs)')
    expect(w.find('[data-test=error-redacted]').exists()).toBe(false)
  })
  it('unset values render placeholder', async () => {
    const { w, store } = await setup()
    fail(store, 'relation "x" does not exist')
    await flushPromises()
    expect(w.find('[data-test=error-hint]').text()).toContain('db1/not set (connection default)')
  })
  it('non-matching error has no hint', async () => {
    const { w, store } = await setup()
    fail(store, 'syntax error at or near "x"')
    await flushPromises()
    expect(w.find('[data-test=error-hint]').exists()).toBe(false)
  })
  it('mysql omits schema', async () => {
    const bridge = createFakeBridge({})
    const connections = createConnectionsStore(bridge)
    connections.seedFromContext({ id: 'c2', name: 'my', dbType: 'mysql', database: 'd2' })
    const store = useNotebookStore()
    store.nb.value.settings.defaultConnection = 'my'
    store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'x', metadata: {} })
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: () => ({ setDoc() {}, getDoc: () => '', setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }) as any },
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
    fail(store, "Table 'a.b' doesn't exist")
    await flushPromises()
    expect(w.find('[data-test=error-hint]').text()).toBe('Check the selected database and schema (current: d2)')
  })

  it('cell-detail event opens the popover; close removes it', async () => {
    const { w } = await setup()
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    expect(w.find('[role=dialog]').exists()).toBe(false)
    await w.findComponent({ name: 'ResultTable' }).vm.$emit('cell-detail', { row: 0, col: 0, value: 'big text', column: 'a' })
    expect(w.find('[role=dialog]').attributes('aria-label')).toBe('a')
    expect(w.find('pre').text()).toBe('big text')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(w.find('[role=dialog]').exists()).toBe(false)
  })

  it('re-running (result replaced) closes the detail', async () => {
    const { w, store } = await setup()
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    await w.findComponent({ name: 'ResultTable' }).vm.$emit('cell-detail', { row: 0, col: 0, value: 'old', column: 'a' })
    expect(w.find('[role=dialog]').exists()).toBe(true)
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    expect(w.find('[role=dialog]').exists()).toBe(false)
    expect(store.runs.get('b1')?.status).toBe('ok')
  })
})

describe('SqlBlock param errors', () => {
  beforeEach(() => setLocale('en'))
  const B = 'SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.'
  const pfail = (store: any, message: string, variable?: string, paramCode: string = 'INVALID') =>
    store.runs.set('b1', { status: 'error', error: { code: 'UNKNOWN', message, kind: 'param', variable, paramCode } })

  it('shows message plainly: no hint, no boilerplate folding', async () => {
    const { w, store } = await setup()
    pfail(store, `Variable x does not exist ${B}`, 'x')
    await flushPromises()
    expect(w.find('[data-test=error]').text()).toContain(`does not exist ${B}`)
    expect(w.find('[data-test=error-hint]').exists()).toBe(false)
    expect(w.find('[data-test=error-redacted]').exists()).toBe(false)
  })
  it('goto button only when matching input block exists; click scrolls and focuses', async () => {
    const { w, store } = await setup()
    store.nb.value.blocks.push({ id: 'i1', type: 'input', content: '', metadata: { variable: 'x', inputType: 'number', value: 'abc' } })
    const host = document.createElement('div')
    host.setAttribute('data-block-id', 'i1')
    const inp = document.createElement('input')
    host.appendChild(inp)
    document.body.appendChild(host)
    host.scrollIntoView = vi.fn()
    const focus = vi.spyOn(inp, 'focus')
    pfail(store, 'bad value', 'x')
    await flushPromises()
    await w.find('[data-test=goto-input]').trigger('click')
    expect(host.scrollIntoView).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    pfail(store, 'unresolved', 'nope')
    await flushPromises()
    expect(w.find('[data-test=goto-input]').exists()).toBe(false)
    pfail(store, 'no variable')
    await flushPromises()
    expect(w.find('[data-test=goto-input]').exists()).toBe(false)
    for (const c of ['UNSET', 'DUPLICATE']) {
      pfail(store, 'm', 'x', c)
      await flushPromises()
      expect(w.find('[data-test=goto-input]').exists()).toBe(true)
    }
    for (const c of ['FORBIDDEN_POSITION', 'UNRESOLVED']) {
      pfail(store, 'm', 'x', c)
      await flushPromises()
      expect(w.find('[data-test=goto-input]').exists()).toBe(false)
    }
    host.remove()
  })

  it('saved-result label for fromFile runs, gone after re-run', async () => {
    const { w, store } = await setup()
    store.runs.set('b1', { status: 'ok', fromFile: true, executedAt: '2026-01-02T03:04:05.000Z', ranSqlHash: hashSql('select 1'), result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' } as any })
    await flushPromises()
    expect(w.find('[data-test=saved-label]').text()).toContain('Saved result')
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=saved-label]').exists()).toBe(false)
    expect(w.find('[data-test=status]').text()).toContain('2 rows')
  })
  it('no label for fresh runs', async () => {
    const { w } = await setup()
    await w.find('[data-test=run]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=saved-label]').exists()).toBe(false)
  })

  it('does not crash with unresolved connection and empty dbType run', async () => {
    const { w, store } = await setup({ conn: 'missing' })
    store.runs.set('b1', { status: 'ok', result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 0, dbType: '' }, fromFile: true } as any)
    await flushPromises()
    expect(w.find('[data-test=status]').exists() || w.exists()).toBe(true)
  })

  describe('local blocks (2c-4b)', () => {
    const okRun = (cols: string[], extra: any = {}) => ({ status: 'ok', executedAt: '2026-01-01T00:00:00.000Z', result: { columns: cols.map((name) => ({ name })), rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' }, ...extra }) as any
    async function local(truncated = false) {
      const ctx = await setup()
      const { store } = ctx
      const bl = store.nb.value.blocks
      bl.splice(0, 0,
        { id: 'a', type: 'sql', content: 'select 1', metadata: { resultName: 'Orders' } },
        { id: 'e', type: 'sql', content: 'x', metadata: { resultName: 'bad' } },
        { id: 'n', type: 'sql', content: 'x', metadata: {} })
      bl.push({ id: 'z', type: 'sql', content: 'x', metadata: { resultName: 'later' } })
      store.runs.set('a', okRun(['id', 'total'], { result: { ...okRun([]).result, columns: [{ name: 'id' }, { name: 'total' }], truncated } }))
      store.runs.set('e', { status: 'error', error: { kind: 'sql', message: 'x' } } as any)
      store.runs.set('z', okRun(['q']))
      return ctx
    }

    it('SQLite dialect, earlier named results and their columns', async () => {
      const { editors, store } = await local()
      store.updateMeta('b1', { source: 'results', resultName: 'mine' })
      await flushPromises()
      store.runs.set('b1', okRun(['m']))
      // editor created before switch: switching calls setDialect
      expect(editors[0].setDialect).toHaveBeenLastCalledWith('SQLite')
      expect(editors[0].clearCache).toHaveBeenCalled()
      const o = editors[0].opts
      expect(await o.completionTables()).toEqual(['Orders', 'bad'])
      expect(await o.columnsFor('orders')).toEqual(['id', 'total'])
      expect(await o.columnsFor('bad')).toEqual([])
      expect(await o.columnsFor('later')).toEqual([])
      expect(await o.columnsFor('mine')).toEqual([])
      expect(await o.columnsFor('nope')).toEqual([])
    })

    it('created as local: SQLite dialect; no schema calls; switch back restores', async () => {
      const bridge = createFakeBridge({ getTableMetadata: vi.fn(async () => ({ columns: [{ name: 'c' }] })) as any, queryData: vi.fn() as any })
      const connections = createConnectionsStore(bridge)
      connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
      const store = useNotebookStore()
      store.nb.value.settings.defaultConnection = 'main'
      store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 's', metadata: { source: 'results' } })
      const editors: any[] = []
      const editorFactory = (_p: any, o: any) => { const e = { opts: o, setDialect: vi.fn(), clearCache: vi.fn(), setDoc: vi.fn(), getDoc: () => o.doc, setFont: vi.fn(), setDark: vi.fn(), destroy: vi.fn() }; editors.push(e); return e }
      mount(SqlBlock, { props: { blockId: 'b1', editorFactory: editorFactory as any }, global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
      expect(editors[0].opts.dialect).toBe('SQLite')
      await editors[0].opts.columnsFor('main')
      await editors[0].opts.completionTables()
      expect(bridge.getTableMetadata).not.toHaveBeenCalled()
      expect(bridge.queryData).not.toHaveBeenCalled()
      store.removeMetaKey('b1', 'source')
      await flushPromises()
      expect(editors[0].setDialect).toHaveBeenLastCalledWith('PostgreSQL')
      expect(editors[0].clearCache).toHaveBeenCalled()
      expect(await editors[0].opts.completionTables()).toEqual([])
    })

    it('refreshes completion when upstream reruns', async () => {
      const { editors, store } = await local()
      store.updateMeta('b1', { source: 'results' })
      await flushPromises()
      const n = editors[0].clearCache.mock.calls.length
      store.runs.set('a', okRun(['id'], { executedAt: '2026-02-02T00:00:00.000Z' }))
      await flushPromises()
      expect(editors[0].clearCache.mock.calls.length).toBeGreaterThan(n)
    })

    it('partial banner follows upstream truncation; DB blocks never', async () => {
      for (const [trunc, want] of [[true, true], [false, false]] as const) {
        const { w, store } = await local(trunc)
        store.updateMeta('b1', { source: 'results' })
        store.runs.set('b1', okRun(['m'], { upstream: { Orders: '2026-01-01T00:00:00.000Z' } }))
        await flushPromises()
        expect(w.find('[data-test=partial-banner]').exists()).toBe(want)
      }
      const { w, store } = await setup()
      store.runs.set('b1', okRun(['m'], { result: { columns: [{ name: 'm' }], rows: [[1]], truncated: true, elapsedMs: 1, dbType: 'postgres' } }))
      await flushPromises()
      expect(w.find('[data-test=partial-banner]').exists()).toBe(false)
    })

    it('no connection warnings on local blocks', async () => {
      const { w, store } = await setup({ conn: 'ghost' })
      expect(w.find('[data-test=unmatched]').exists()).toBe(true)
      store.updateMeta('b1', { source: 'results', connection: 'ghost' })
      await flushPromises()
      expect(w.find('[data-test=unmatched]').exists()).toBe(false)
      expect(w.text()).not.toContain('ghost')
    })
  })

  describe('date comparison hint', () => {
    async function withDate(content: string, local: boolean) {
      const r = await setup({ metadata: local ? { source: 'results' } : {} })
      r.store.nb.value.blocks.unshift({ id: 'i1', type: 'input', content: '', metadata: { variable: 'date', inputType: 'date', value: '2026-10-01' } })
      r.store.nb.value.blocks.find((b) => b.id === 'b1')!.content = content
      await flushPromises()
      return r
    }
    it('shown for local block with <= date placeholder', async () => {
      const { w } = await withDate('select * from t where c <= {{date}}', true)
      expect(w.find('[data-test=date-hint]').text()).toContain('compare as ISO text')
    })
    it('hidden for < , and for non-local blocks', async () => {
      expect((await withDate('select * from t where c < {{date}}', true)).w.find('[data-test=date-hint]').exists()).toBe(false)
      expect((await withDate('select * from t where c <= {{date}}', false)).w.find('[data-test=date-hint]').exists()).toBe(false)
    })
  })

  it('visualize inserts a chart block, names the source and shows a notice', async () => {
    const { w, store } = await setup()
    store.runs.set('b1', { status: 'ok', executedAt: 'T', result: { columns: [{ name: 'a', dataType: 'text' }, { name: 'n', dataType: 'integer' }], rows: [['x', 1]], truncated: false, elapsedMs: 1, dbType: 'x' } } as any)
    await flushPromises()
    await w.find('[data-test="visualize"]').trigger('click')
    await flushPromises()
    const bl = store.nb.value.blocks
    expect(bl[1].type).toBe('chart'); expect(bl[0].metadata!.resultName).toBe('result_1')
    expect(w.find('[data-test="visualize-notice"]').text()).toContain('result_1')
  })
})
