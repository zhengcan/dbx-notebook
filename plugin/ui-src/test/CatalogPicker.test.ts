import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CatalogPicker from '../src/blocks/CatalogPicker.vue'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import ConnectionPicker from '../src/shell/ConnectionPicker.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, ConnectionsKey, StoreKey } from '../src/injection'
import { useCatalogOptions } from '../src/blocks/useCatalogOptions'
import { setLocale } from '../src/i18n'

const base = { kind: 'database' as const, options: ['a', 'b'], loading: false }

describe('CatalogPicker', () => {
  beforeEach(() => setLocale('en'))
  it('emits open on focus only while options are empty and not loading', async () => {
    const w = mount(CatalogPicker, { props: { ...base, options: [] } })
    const i = w.find('input')
    await i.trigger('focus'); await i.trigger('focus')
    expect(w.emitted('open')).toHaveLength(2)
    await w.setProps({ loading: true })
    await i.trigger('focus')
    expect(w.emitted('open')).toHaveLength(2)
    await w.setProps({ loading: false, options: ['a'] })
    await i.trigger('focus')
    expect(w.emitted('open')).toHaveLength(2)
  })
  it('has aria-label', () => {
    expect(mount(CatalogPicker, { props: base }).find('input').attributes('aria-label')).toBe('Database')
    expect(mount(CatalogPicker, { props: { ...base, kind: 'schema' } }).find('input').attributes('aria-label')).toBe('Schema')
  })
  it('emits value and undefined on clear', async () => {
    const w = mount(CatalogPicker, { props: base })
    const i = w.find('input')
    await i.setValue('zzz'); await i.trigger('change')
    expect(w.emitted('update:modelValue')![0]).toEqual(['zzz'])
    await i.setValue(''); await i.trigger('change')
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([undefined])
    expect(w.findAll('datalist option')).toHaveLength(2)
  })
  it('a datalist pick is committed on the first attempt and survives an options reload', async () => {
    const w = mount(CatalogPicker, { props: { ...base, options: [], modelValue: 'old' } })
    const el = w.find('input').element as HTMLInputElement
    await w.find('input').trigger('focus')
    await w.setProps({ loading: true })
    el.value = 'b'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await w.setProps({ loading: false, options: ['a', 'b'] })
    expect(el.value).toBe('b')
    expect(w.emitted('update:modelValue')![0]).toEqual(['b'])
  })
  it('uncommitted typing is not clobbered by a re-render and commits on change only', async () => {
    const w = mount(CatalogPicker, { props: { ...base, options: [], modelValue: 'old' } })
    const el = w.find('input').element as HTMLInputElement
    el.value = 'pro'
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'o' }))
    await w.setProps({ options: ['prod', 'proxy'] })
    expect(el.value).toBe('pro')
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await w.find('input').trigger('change')
    expect(w.emitted('update:modelValue')![0]).toEqual(['pro'])
  })
  it('blur resyncs the input to the model (trimmed commit / rejected commit)', async () => {
    const w = mount(CatalogPicker, { props: { ...base, modelValue: 'foo' } })
    const el = w.find('input').element as HTMLInputElement
    el.value = 'foo '
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }))
    await w.find('input').trigger('change')
    expect(w.emitted('update:modelValue')![0]).toEqual(['foo'])
    await w.find('input').trigger('blur')
    expect(el.value).toBe('foo')
  })
  it('shows error without disabling input', () => {
    const w = mount(CatalogPicker, { props: { ...base, error: 'boom' } })
    expect(w.find('[data-test=cat-error]').exists()).toBe(true)
    expect(w.find('input').attributes('disabled')).toBeUndefined()
  })
})

async function setup(dbType: string, meta: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const queryData = vi.fn(async () => ({ columns: [{ name: 'n' }], rows: [['x'], ['y']], truncated: false, elapsedMs: 1, dbType }))
  const bridge = createFakeBridge({ queryData })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType, database: 'db1' })
  const store = useNotebookStore()
  Object.assign(store.nb.value.settings, { defaultConnection: 'main', ...settings })
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: meta })
  const editorFactory = (_p: HTMLElement, o: any) => ({ setDoc() {}, getDoc: () => o.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {} }) as any
  const global = { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } }
  return { store, queryData, editorFactory, global }
}

describe('SqlBlock catalog pickers', () => {
  beforeEach(() => setLocale('en'))
  it('present for postgres, schema hidden for mysql', async () => {
    const a = await setup('postgres')
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    expect(w.find('[data-test=cat-database]').exists()).toBe(true)
    expect(w.find('[data-test=cat-schema]').exists()).toBe(true)
    const b = await setup('mysql')
    const w2 = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: b.editorFactory }, global: b.global })
    expect(w2.find('[data-test=cat-database]').exists()).toBe(true)
    expect(w2.find('[data-test=cat-schema]').exists()).toBe(false)
  })
  it('writes and removes metadata; inherited placeholder', async () => {
    const a = await setup('postgres', {}, { defaultSchema: 'app' })
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    expect(w.find('[data-test=cat-schema]').attributes('placeholder')).toBe('inherit: app')
    expect(w.find('[data-test=cat-database]').attributes('placeholder')).toBe('inherit: db1')
    const i = w.find('[data-test=cat-database]')
    await i.setValue('prod'); await i.trigger('change')
    expect(a.store.nb.value.blocks[0].metadata!.database).toBe('prod')
    await i.setValue(''); await i.trigger('change')
    expect(a.store.nb.value.blocks[0].metadata!.database).toBeUndefined()
  })
  it('loads lazily once on open; refresh clears and reloads; failure shows error', async () => {
    const a = await setup('postgres')
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    expect(a.queryData).not.toHaveBeenCalled()
    const i = w.find('[data-test=cat-database]')
    await i.trigger('focus'); await flushPromises()
    await i.trigger('focus'); await flushPromises()
    expect(a.queryData).toHaveBeenCalledTimes(1)
    expect(w.findAll('datalist')[0].findAll('option')).toHaveLength(2)
    await w.find('[data-test=cat-refresh]').trigger('click'); await flushPromises()
    expect(a.queryData).toHaveBeenCalledTimes(3)
    a.queryData.mockRejectedValueOnce(new Error('nope'))
    await w.find('[data-test=cat-refresh]').trigger('click'); await flushPromises()
    expect(w.find('[data-test=cat-error]').exists()).toBe(true)
  })
})

describe('ConnectionPicker defaults', () => {
  it('sets and clears default database/schema', async () => {
    const a = await setup('postgres')
    const w = mount(ConnectionPicker, { global: a.global })
    const d = w.find('[data-test=cat-database]'); const s = w.find('[data-test=cat-schema]')
    await d.setValue('prod'); await d.trigger('change')
    await s.setValue('app'); await s.trigger('change')
    expect(a.store.nb.value.settings).toMatchObject({ defaultDatabase: 'prod', defaultSchema: 'app' })
    await d.setValue(''); await d.trigger('change')
    expect(a.store.nb.value.settings.defaultDatabase).toBeUndefined()
    expect(a.store.nb.value.settings.defaultSchema).toBe('app')
  })
})

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

describe('SqlBlock catalog reload after connection change', () => {
  beforeEach(() => setLocale('en'))
  async function twoConns() {
    const a = await setup('postgres')
    const reg = a.global.provide[ConnectionsKey as symbol] as any
    reg.seedFromContext({ id: 'c2', name: 'other', dbType: 'postgres', database: 'db2' })
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    return { a, w }
  }
  it('focus again after connection switch loads new options', async () => {
    const { a, w } = await twoConns()
    const i = w.find('[data-test=cat-database]')
    await i.trigger('focus'); await flushPromises()
    expect(a.queryData).toHaveBeenCalledTimes(1)
    a.store.updateMeta('b1', { connection: 'other' }); await flushPromises()
    expect(w.findAll('datalist')[0].findAll('option')).toHaveLength(0)
    await i.trigger('focus'); await flushPromises()
    expect(a.queryData).toHaveBeenCalledTimes(2)
    expect((a.queryData.mock.calls[1] as any)[0].connectionId).toBe('c2')
    expect(w.findAll('datalist')[0].findAll('option')).toHaveLength(2)
  })
  it('refresh after connection switch reloads', async () => {
    const { a, w } = await twoConns()
    await w.find('[data-test=cat-database]').trigger('focus'); await flushPromises()
    a.store.updateMeta('b1', { connection: 'other' }); await flushPromises()
    await w.find('[data-test=cat-refresh]').trigger('click'); await flushPromises()
    expect(a.queryData).toHaveBeenCalledTimes(3)
    expect(w.findAll('datalist')[0].findAll('option')).toHaveLength(2)
  })
  it('database change reloads schemas and never shows previous database schemas', async () => {
    const a = await setup('postgres')
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    a.queryData.mockResolvedValueOnce({ columns: [{ name: 'n' }], rows: [['s_db1']], truncated: false, elapsedMs: 1, dbType: 'postgres' } as any)
    await w.find('[data-test=cat-schema]').trigger('focus'); await flushPromises()
    expect(w.findAll('datalist')[1].findAll('option').map((o) => o.attributes('value'))).toEqual(['s_db1'])
    const d = deferred<any>()
    a.queryData.mockReturnValueOnce(d.promise)
    const di = w.find('[data-test=cat-database]')
    await di.setValue('other'); await di.trigger('change'); await flushPromises()
    expect(w.findAll('datalist')[1].findAll('option')).toHaveLength(0)
    expect(a.queryData).toHaveBeenCalledTimes(2)
    expect((a.queryData.mock.calls[1] as any)[0].database).toBe('other')
    d.resolve({ columns: [{ name: 'n' }], rows: [['s_other']], truncated: false, elapsedMs: 1, dbType: 'postgres' }); await flushPromises()
    expect(w.findAll('datalist')[1].findAll('option').map((o) => o.attributes('value'))).toEqual(['s_other'])
  })
  it('Run after change writes pending database before the run starts', async () => {
    const a = await setup('postgres')
    const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory: a.editorFactory }, global: a.global })
    const di = w.find('[data-test=cat-database]')
    await di.setValue('pending'); await di.trigger('change')
    await w.find('[data-test=run]').trigger('click'); await flushPromises()
    expect((a.queryData.mock.calls.at(-1) as any)[0].database).toBe('pending')
  })
})

describe('useCatalogOptions stale loads', () => {
  const conn = { id: 'c1', dialect: 'postgres' }
  it('slow load resolving after reset does not overwrite', async () => {
    const d = deferred<string[]>()
    const cache: any = { getDatabases: vi.fn(() => d.promise), getSchemas: vi.fn(), clear: vi.fn() }
    const o = useCatalogOptions(cache, () => conn, () => undefined)
    const p = o.loadDatabases()
    o.reset()
    expect(o.db.loading).toBe(false)
    d.resolve(['old']); await p
    expect(o.db.options).toEqual([])
  })
  it('old load resolving during a newer one does not overwrite or clear loading', async () => {
    const d1 = deferred<string[]>(); const d2 = deferred<string[]>()
    const cache: any = { getDatabases: vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise), getSchemas: vi.fn(), clear: vi.fn() }
    const o = useCatalogOptions(cache, () => conn, () => undefined)
    const p1 = o.refresh({ db: true, sc: false })
    const p2 = o.refresh({ db: true, sc: false })
    d1.resolve(['old']); await Promise.resolve(); await Promise.resolve()
    expect(o.db.options).toEqual([])
    expect(o.db.loading).toBe(true)
    d2.resolve(['new']); await Promise.all([p1, p2])
    expect(o.db.options).toEqual(['new'])
  })
  it('old getSchemas(oldDb) resolving after a database change does not win', async () => {
    const d1 = deferred<string[]>()
    let db = 'a'
    const cache: any = { getDatabases: vi.fn(), getSchemas: vi.fn((_c: any, d: string) => (d === 'a' ? d1.promise : Promise.resolve(['sb']))), clear: vi.fn() }
    const o = useCatalogOptions(cache, () => conn, () => db)
    const p1 = o.loadSchemas()
    db = 'b'
    await o.loadSchemas()
    d1.resolve(['sa']); await p1
    expect(o.sc.options).toEqual(['sb'])
  })
})
