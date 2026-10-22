import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { hashSql } from '../src/state/hash'

type B = { id: string; type: 'sql'; content: string; metadata: Record<string, unknown> }
async function setup(blocks: B[], target: string) {
  const bridge = createFakeBridge()
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' })
  const store = useNotebookStore()
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push(...(blocks as any))
  const editorFactory = vi.fn((_p: HTMLElement, o: any) => ({
    getDoc: () => o.doc, setDoc: vi.fn(), setDialect: vi.fn(), setFont: vi.fn(), setDark: vi.fn(), clearCache: vi.fn(), destroy: vi.fn(),
  }))
  const w = mount(SqlBlock, {
    props: { blockId: target, editorFactory },
    global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } },
  })
  return { w, store }
}
const db = (id: string, name?: string, content = 'select 1'): B => ({ id, type: 'sql', content, metadata: name ? { resultName: name } : {} })
const loc = (id: string, content: string, extra: Record<string, unknown> = {}): B => ({ id, type: 'sql', content, metadata: { source: 'results', ...extra } })
const okRun = (store: any, id: string, sql: string) =>
  store.runs.set(id, { status: 'ok', ranSqlHash: hashSql(sql), result: { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: '' } })

describe('local block header', () => {
  beforeEach(() => setLocale('en'))

  it('type switch writes source=results and removes it again, keeping connection keys', async () => {
    const { w, store } = await setup([{ ...db('b1'), metadata: { connection: 'main', database: 'd', schema: 's' } }], 'b1')
    const sel = w.find('[data-test=block-type]')
    expect((sel.element as HTMLSelectElement).value).toBe('database')
    expect(sel.text()).toContain('Database query')
    expect(sel.text()).toContain('Local result SQL')
    store.dirty.value = false
    await sel.setValue('results')
    expect(store.nb.value.blocks[0].metadata).toEqual({ connection: 'main', database: 'd', schema: 's', source: 'results' })
    expect(store.dirty.value).toBe(true)
    await sel.setValue('database')
    expect(store.nb.value.blocks[0].metadata).toEqual({ connection: 'main', database: 'd', schema: 's' })
    expect('source' in store.nb.value.blocks[0].metadata!).toBe(false)
  })

  it('hides connection/database/schema/refresh for local blocks only', async () => {
    const d = await setup([db('b1')], 'b1')
    for (const k of ['conn', 'cat-refresh']) expect(d.w.find(`[data-test=${k}]`).exists()).toBe(true)
    const l = await setup([loc('b1', 'select 1')], 'b1')
    for (const k of ['conn', 'cat-refresh']) expect(l.w.find(`[data-test=${k}]`).exists()).toBe(false)
    expect((l.w.find('[data-test=block-type]').element as HTMLSelectElement).value).toBe('results')
    expect(l.w.findAll('.catalog-picker, [data-test=cat-database], [data-test=cat-schema]').length).toBe(0)
  })

  it('chips list referenced names in notebook order, deduped, reactive', async () => {
    const { w, store } = await setup([db('a', 'orders'), db('b', 'users'), loc('c', 'select * from users u join orders o on 1 join users x on 1')], 'c')
    const names = () => w.findAll('[data-test=ref-chip]').map((c) => c.text().replace('⚠', '').trim())
    expect(names()).toEqual(['orders', 'users'])
    expect(w.find('[data-test=ref-results]').text()).toContain('Referenced results')
    store.updateContent('c', 'select * from orders')
    await flushPromises()
    expect(names()).toEqual(['orders'])
    store.updateMeta('b', { resultName: 'people' })
    store.updateContent('c', 'select * from people')
    await flushPromises()
    expect(names()).toEqual(['people'])
    store.updateMeta('a', { resultName: 'people2' })
    store.updateContent('c', 'select * from people2, people')
    await flushPromises()
    expect(names()).toEqual(['people2', 'people'].sort((x, y) => (x === 'people2' ? 0 : 1) - (y === 'people2' ? 0 : 1)))
  })

  it('database blocks show no chips', async () => {
    const { w } = await setup([db('a', 'orders'), db('b', undefined, 'select * from orders')], 'b')
    expect(w.find('[data-test=ref-results]').exists()).toBe(false)
  })

  it('chip click scrolls to and focuses the source block', async () => {
    const { w } = await setup([db('a', 'orders'), loc('c', 'select * from orders')], 'c')
    const host = document.createElement('div')
    host.setAttribute('data-block-id', 'a')
    const inp = document.createElement('button')
    host.appendChild(inp)
    document.body.appendChild(host)
    host.scrollIntoView = vi.fn()
    const focus = vi.spyOn(inp, 'focus')
    await w.find('[data-test=ref-chip]').trigger('click')
    expect(host.scrollIntoView).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    host.remove()
  })

  it('chip click is safe when scrollIntoView is missing', async () => {
    const { w } = await setup([db('a', 'orders'), loc('c', 'select * from orders')], 'c')
    const host = document.createElement('div')
    host.setAttribute('data-block-id', 'a')
    document.body.appendChild(host)
    ;(host as any).scrollIntoView = undefined
    await w.find('[data-test=ref-chip]').trigger('click')
    host.remove()
  })

  it('chip warns when source has no ok run, or is stale', async () => {
    const { w, store } = await setup([db('a', 'orders'), loc('c', 'select * from orders')], 'c')
    let chip = w.find('[data-test=ref-chip]')
    expect(chip.attributes('data-warn')).toBe('true')
    expect(chip.attributes('title')).toBe('no result yet — run it first')
    expect(chip.text()).toContain('⚠')
    okRun(store, 'a', 'select 1')
    await flushPromises()
    chip = w.find('[data-test=ref-chip]')
    expect(chip.attributes('data-warn')).toBeUndefined()
    store.updateContent('a', 'select 2')
    await flushPromises()
    chip = w.find('[data-test=ref-chip]')
    expect(chip.attributes('data-warn')).toBe('true')
    expect(chip.attributes('title')).not.toBe('no result yet — run it first')
  })

  it('zh chip warning title', async () => {
    setLocale('zh-CN')
    const { w } = await setup([db('a', 'orders'), loc('c', 'select * from orders')], 'c')
    expect(w.find('[data-test=ref-chip]').attributes('title')).toBe('还没有结果，请先运行')
    expect(w.find('[data-test=ref-results]').text()).toContain('引用的结果')
    expect(w.find('[data-test=block-type]').text()).toContain('本地结果 SQL')
  })

  it('DepError SELF and FORWARD render inline notes', async () => {
    const s = await setup([loc('c', 'select * from me', { resultName: 'me' })], 'c')
    expect(s.w.find('[data-test=dep-error]').text()).toBe('A block cannot reference its own result "me"')
    expect(s.w.find('[data-test=ref-chip]').exists()).toBe(false)
    const f = await setup([loc('c', 'select * from later'), db('d', 'later')], 'c')
    expect(f.w.find('[data-test=dep-error]').text()).toBe('The block for "later" comes after this block; reorder them')
  })

  it('DepError DUPLICATE note', async () => {
    const { w } = await setup([db('a', 'x'), db('b', 'X'), loc('c', 'select * from x')], 'c')
    expect(w.find('[data-test=dep-error]').text()).toContain('used by more than one block')
  })
})

describe('result name validation', () => {
  beforeEach(() => setLocale('en'))
  const name = (w: any, v: string) => w.find('[data-test=result-name]').setValue(v)

  it('invalid name not written', async () => {
    const { w, store } = await setup([db('b1')], 'b1')
    await name(w, '1bad')
    expect(store.nb.value.blocks[0].metadata).toEqual({})
    expect(w.find('[data-test=result-name]').classes()).toContain('invalid')
  })

  it('duplicate (case-insensitive) not written, warns', async () => {
    const { w, store } = await setup([db('a', 'orders'), db('b1')], 'b1')
    await name(w, 'ORDERS')
    expect(store.nb.value.blocks[1].metadata).toEqual({})
    expect(w.find('[data-test=name-dup]').text()).toBe('Result name already used by another block')
    await name(w, 'fresh')
    expect(store.nb.value.blocks[1].metadata).toEqual({ resultName: 'fresh' })
    expect(w.find('[data-test=name-dup]').exists()).toBe(false)
  })

  it('duplicate warning zh', async () => {
    setLocale('zh-CN')
    const { w } = await setup([db('a', 'orders'), db('b1')], 'b1')
    await name(w, 'orders')
    expect(w.find('[data-test=name-dup]').text()).toBe('结果名已被「orders」使用')
  })

  it('reserved word is written and shows quoting note', async () => {
    const { w, store } = await setup([db('b1')], 'b1')
    await name(w, 'Order')
    expect(store.nb.value.blocks[0].metadata).toEqual({ resultName: 'Order' })
    expect(w.find('[data-test=name-quote]').text()).toBe('Quote it when referencing: "Order"')
    await name(w, 'orders')
    expect(w.find('[data-test=name-quote]').exists()).toBe(false)
  })

  it('clearing removes the key; works on local blocks too', async () => {
    const { w, store } = await setup([loc('b1', 'select 1', { resultName: 'abc' })], 'b1')
    await name(w, '')
    expect('resultName' in store.nb.value.blocks[0].metadata!).toBe(false)
    await name(w, 'xyz')
    expect(store.nb.value.blocks[0].metadata).toEqual({ source: 'results', resultName: 'xyz' })
  })
})
