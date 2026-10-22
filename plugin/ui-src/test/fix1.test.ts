import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'
import { isSqliteKeyword } from '../src/run/sqliteKeywords'
import { runSqlBlock } from '../src/run/runSqlBlock'

function fresh() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  s.load(serializeNotebook(createEmptyNotebook()), null, null)
  return s
}
const res = { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: '' }
const sqlOf = 'select 1'

describe('source staleness', () => {
  function withRun(ranSource?: 'database' | 'results', extra: Record<string, unknown> = {}) {
    const s = fresh()
    s.nb.value.blocks.push({ id: 'a', type: 'sql', content: sqlOf, metadata: { resultName: 'a', ...extra } } as any)
    s.runs.set('a', { status: 'ok', result: res as any, ranSqlHash: hashSql(sqlOf), ...(ranSource ? { ranSource } : {}), executedAt: 't1' })
    return s
  }
  it('db run switched to local is stale [source]; back is fresh', () => {
    const s = withRun('database')
    expect(s.staleReasons('a')).toEqual([])
    s.updateMeta('a', { source: 'results' })
    expect(s.staleReasons('a')).toEqual(['source'])
    s.removeMetaKey('a', 'source')
    expect(s.staleReasons('a')).toEqual([])
  })
  it('local run switched to database', () => {
    const s = withRun('results', { source: 'results' })
    expect(s.staleReasons('a')).toEqual([])
    s.removeMetaKey('a', 'source')
    expect(s.staleReasons('a')).toEqual(['source'])
  })
  it('restored run (no ranSource) never flagged', () => {
    const s = withRun(undefined)
    s.updateMeta('a', { source: 'results' })
    expect(s.staleReasons('a')).toEqual([])
  })
  it('combines with sql', () => {
    const s = withRun('database')
    s.updateMeta('a', { source: 'results' })
    s.updateContent('a', 'select 2')
    expect(s.staleReasons('a')).toEqual(['sql', 'source'])
  })
  it('dependents become upstream-stale', () => {
    const s = withRun('database')
    s.nb.value.blocks.push({ id: 'b', type: 'sql', content: 'select * from a', metadata: { source: 'results' } } as any)
    s.runs.set('b', { status: 'ok', result: res as any, ranSource: 'results', ranSqlHash: hashSql('select * from a'), upstream: { a: 't1' }, executedAt: 't2' })
    expect(s.staleReasons('b')).toEqual([])
    s.updateMeta('a', { source: 'results' })
    expect(s.staleReasons('b')).toEqual(['upstream'])
  })
  it('runSqlBlock records ranSource=database on ok and error', async () => {
    const bridge = createFakeBridge({ queryData: vi.fn(async () => ({ ...res, dbType: 'postgres' })) as any })
    const connections = createConnectionsStore(bridge)
    connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
    const s = fresh()
    s.nb.value.settings.defaultConnection = 'main'
    s.nb.value.blocks.push({ id: 'a', type: 'sql', content: sqlOf, metadata: {} } as any)
    await runSqlBlock({ bridge, connections, store: s, engine: {} as any }, 'a')
    expect(s.runs.get('a')!.ranSource).toBe('database')
    s.nb.value.settings.defaultConnection = 'nope'
    await runSqlBlock({ bridge, connections, store: s, engine: {} as any }, 'a')
    expect(s.runs.get('a')!.status).toBe('error')
    expect(s.runs.get('a')!.ranSource).toBe('database')
  })
  it('runResultsBlock records ranSource=results (error)', async () => {
    const { runResultsBlock } = await import('../src/run/runResultsBlock')
    const s = fresh()
    s.nb.value.blocks.push({ id: 'a', type: 'sql', content: '', metadata: { source: 'results' } } as any)
    await runResultsBlock({ bridge: {} as any, store: s, engine: {} as any }, 'a')
    expect(s.runs.get('a')!.ranSource).toBe('results')
  })
  it('chip title lists source reason zh/en and flips reactively', async () => {
    for (const [loc, txt] of [['en', 'Block type changed (database query ⇄ local result SQL)'], ['zh-CN', '块类型已更改（数据库查询 ⇄ 本地结果 SQL）']] as const) {
      setLocale(loc)
      const s = withRun('database')
      const bridge = createFakeBridge()
      const connections = createConnectionsStore(bridge)
      const w = mount(SqlBlock, {
        props: { blockId: 'a', editorFactory: ((_p: any, o: any) => ({ getDoc: () => o.doc, setDoc() {}, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus() {} })) as any },
        global: { provide: { [StoreKey as symbol]: s, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } },
      })
      expect(w.find('[data-test=status]').attributes('title')).toBeUndefined()
      await w.find('[data-test=block-type]').setValue('results')
      expect(w.find('[data-test=status]').attributes('title')).toBe(txt)
    }
    setLocale('en')
  })
})

describe('duplicateBlock names', () => {
  it('case-insensitive collision', () => {
    const s = fresh()
    s.nb.value.blocks.push({ id: 'a', type: 'sql', content: '', metadata: { resultName: 'Orders' } } as any, { id: 'b', type: 'sql', content: '', metadata: { resultName: 'orders_copy' } } as any)
    const id = s.duplicateBlock('a')
    expect(s.nb.value.blocks.find((b) => b.id === id)!.metadata!.resultName).toBe('Orders_copy2')
  })
  it('63-char name stays valid', () => {
    const s = fresh()
    const long = 'a'.repeat(63)
    s.nb.value.blocks.push({ id: 'a', type: 'sql', content: '', metadata: { resultName: long } } as any)
    const id = s.duplicateBlock('a')
    const n = s.nb.value.blocks.find((b) => b.id === id)!.metadata!.resultName as string
    expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
    expect(n.endsWith('_copy')).toBe(true)
    const id2 = s.duplicateBlock('a')
    const n2 = s.nb.value.blocks.find((b) => b.id === id2)!.metadata!.resultName as string
    expect(n2).not.toBe(n)
    expect(n2.length).toBeLessThanOrEqual(63)
  })
})

describe('keywords, sqlite_ prefix, chip focus', () => {
  beforeEach(() => setLocale('en'))
  it('TRUE/FALSE are keywords', () => {
    expect(isSqliteKeyword('true')).toBe(true)
    expect(isSqliteKeyword('False')).toBe(true)
  })
  async function mk(blocks: any[], target: string) {
    const bridge = createFakeBridge()
    const connections = createConnectionsStore(bridge)
    const store = fresh()
    store.nb.value.blocks.push(...blocks)
    const handles: Record<string, any> = {}
    const w = mount(SqlBlock, {
      props: { blockId: target, editorFactory: ((_p: any, o: any) => ({ getDoc: () => o.doc, setDoc() {}, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus: (handles.f = vi.fn()) })) as any },
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } },
    })
    return { w, store, handles }
  }
  it('sqlite_ prefix invalid, not written, bilingual note', async () => {
    const { w, store } = await mk([{ id: 'b1', type: 'sql', content: '', metadata: {} }], 'b1')
    await w.find('[data-test=result-name]').setValue('SQLite_x')
    expect(store.nb.value.blocks[0].metadata).toEqual({})
    expect(w.find('[data-test=name-sqlite]').text()).toBe("Result names can't start with sqlite_")
    setLocale('zh-CN')
    await w.vm.$nextTick()
    expect(w.find('[data-test=name-sqlite]').text()).toBe('结果名不能以 sqlite_ 开头')
    setLocale('en')
    await w.find('[data-test=result-name]').setValue('ok')
    expect(w.find('[data-test=name-sqlite]').exists()).toBe(false)
  })
  it('chip click focuses the source block editor', async () => {
    const a = await mk([{ id: 'a', type: 'sql', content: '', metadata: { resultName: 'orders' } }], 'a')
    const focusA = a.handles.f
    expect(focusA).toBeDefined()
    // source block's editor host is a DOM element tagged data-editor with a focusable target
    const host = document.createElement('div')
    host.setAttribute('data-block-id', 'a')
    const ed = document.createElement('div')
    ed.setAttribute('data-editor', '')
    ed.tabIndex = 0
    const btn = document.createElement('button')
    host.append(btn, ed)
    document.body.appendChild(host)
    const spyEd = vi.spyOn(ed, 'focus')
    const spyBtn = vi.spyOn(btn, 'focus')
    const l = await mk([
      { id: 'a', type: 'sql', content: '', metadata: { resultName: 'orders' } },
      { id: 'c', type: 'sql', content: 'select * from orders', metadata: { source: 'results' } },
    ], 'c')
    await l.w.find('[data-test=ref-chip]').trigger('click')
    expect(spyEd).toHaveBeenCalled()
    expect(spyBtn).not.toHaveBeenCalled()
    host.remove()
  })
})
