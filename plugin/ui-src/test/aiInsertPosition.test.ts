import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook, parseNotebook } from '@sqlnb/format'

vi.mock('../src/editor/sqlEditor', async (orig) => ({
  ...(await orig<typeof import('../src/editor/sqlEditor')>()),
  createSqlEditor: (_p: HTMLElement, o: any) => {
    const e = { doc: o.doc as string }
    return { setDoc(s: string) { e.doc = s }, getDoc: () => e.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus() {} }
  },
}))
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { applySqlSuggestion } from '../src/ai/applySql'

const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const PATH = '/tmp/a.sqlnb'
const GEN = 'host.ai.generateTextStream'
const GEN_ONCE = 'host.ai.generateText'

function notebook() {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.blocks.push(
    { id: 'b1', type: 'sql', content: 'select 1', metadata: {} } as any,
    { id: 'b2', type: 'markdown', content: 'two' } as any,
    { id: 'b3', type: 'sql', content: 'select 3', metadata: {} } as any,
    { id: 'b4', type: 'sql', content: 'select 4', metadata: {} } as any,
    { id: 'b5', type: 'markdown', content: 'five' } as any,
    { id: 'b6', type: 'sql', content: 'select 6', metadata: {} } as any,
  )
  return serializeNotebook(nb)
}

const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

async function boot() {
  setLocale('en')
  document.body.innerHTML = ''
  const gen = () => '## Findings\n\nFine.'
  const bridge: any = createFakeBridge({
    caps: { aiCompletion: true, aiCompletionStream: true },
    context: () => CTX,
    onContext: () => () => {},
    queryData: async () => ({ columns: [{ name: 'a', dataType: 'integer' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' }),
    getTableMetadata: async () => ({ columns: [] }),
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: notebook(), mtimeMs: 1 }),
      'notebook/write': () => ({ mtimeMs: 2 }),
      'notebook/writeOut': () => ({}),
      'notebook/deleteOut': () => ({}),
      'notebook/touchRecent': () => ({}),
    },
    requestHandlers: { 'host.ai.listModels': () => MODELS, [GEN]: gen, [GEN_ONCE]: gen, 'host.ai.cancelGeneration': () => ({ cancelled: true }) },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  await w.find('[data-test=home]').trigger('click'); await flushPromises()
  const discard = w.findAll('button').find((b) => b.text() === 'Discard')
  if (discard) { await discard.trigger('click'); await flushPromises() }
  await w.find('.sp-path input').setValue(PATH)
  await w.find('[data-test=open-path]').trigger('click')
  await flushPromises()
  const store = () => (w.vm as any).store
  const block = (id: string) => w.find(`[data-block-id=${id}]`)
  const ids = () => store().nb.value.blocks.map((b: any) => b.id) as string[]
  const domIds = () => w.findAll('[data-block-id]').map((e) => e.attributes('data-block-id')!)
  const run = async (id: string) => { await block(id).find('[data-test=run]').trigger('click'); await flushPromises(); await flushPromises() }
  const interpret = async (id: string) => {
    await run(id)
    await block(id).find('[data-test=ai-interpret]').trigger('click'); await settle()
  }
  const confirm = async () => { await w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises() }
  return { w, store, ids, domIds, interpret, confirm, run }
}

beforeEach(() => setLocale('en'))
// writers that bypass history (a recorded edit after an undo would clear the redo stack)
const rawMove = (store: any, id: string, d: number) => { const bl = store.nb.value.blocks; const i = bl.findIndex((b: any) => b.id === id); const [b] = bl.splice(i, 1); bl.splice(i + d, 0, b) }
const rawRemove = (store: any, id: string) => { const bl = store.nb.value.blocks; bl.splice(bl.findIndex((b: any) => b.id === id), 1) }
const newIdIn = (ids: string[]) => ids.find((i) => !/^b[1-6]$/.test(i))!

describe('AI insert position', () => {
  it('App-level: Interpret from the middle SQL block inserts directly below it', async () => {
    const s = await boot()
    await s.interpret('b3')
    await s.confirm()
    const ids = s.ids()
    expect(ids.length).toBe(7)
    expect(ids.indexOf(newIdIn(ids))).toBe(ids.indexOf('b3') + 1)
    expect(s.domIds().filter((i) => ids.includes(i))).toEqual(ids)
    expect(s.store().nb.value.blocks[ids.indexOf('b3') + 1].type).toBe('markdown')
  })

  it('same after moving the block (store.moveBlock) while the drawer is open', async () => {
    const s = await boot()
    await s.interpret('b3')
    s.store().moveBlock('b3', 5)
    await flushPromises()
    await s.confirm()
    const ids = s.ids()
    expect(ids.indexOf(newIdIn(ids))).toBe(ids.indexOf('b3') + 1)
    expect(s.domIds().filter((i) => ids.includes(i))).toEqual(ids)
  })

  it('block deleted while open: insert refused, document unchanged, no append', async () => {
    const s = await boot()
    await s.interpret('b3')
    s.store().removeBlock('b3')
    await flushPromises()
    const before = s.ids()
    const depth = s.store().history.undoDepth.value
    await s.confirm()
    expect(s.ids()).toEqual(before)
    expect(s.store().history.undoDepth.value).toBe(depth)
  })

  it('undo then redo puts the block back below the same predecessor', async () => {
    const s = await boot()
    await s.interpret('b3')
    await s.confirm()
    const ids0 = s.ids()
    const newId = newIdIn(ids0)
    expect(s.store().undo().ok).toBe(true)
    rawMove(s.store(), 'b1', 5)
    await flushPromises()
    expect(s.store().redo().ok).toBe(true)
    const ids = s.ids()
    expect(ids.indexOf(newId)).toBe(ids.indexOf('b3') + 1)
  })

  it('SQL insert-new from the middle block lands below it, undo/redo too', async () => {
    const s = await boot()
    const store = s.store()
    const deps: any = { store, runBlocked: () => true }
    const r = await applySqlSuggestion(deps, 'insert-new', 'b3', 'select 9')
    let ids = s.ids()
    expect(ids.indexOf(r.newBlockId!)).toBe(ids.indexOf('b3') + 1)
    store.undo()
    expect(s.ids()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
    rawMove(store, 'b1', 5)
    store.redo()
    ids = s.ids()
    expect(ids.indexOf(r.newBlockId!)).toBe(ids.indexOf('b3') + 1)
  })

  it('serialized notebook order matches the in-memory order', async () => {
    const s = await boot()
    await s.interpret('b3')
    await s.confirm()
    const parsed = parseNotebook(serializeNotebook(s.store().nb.value)) as any
    const nb = parsed.notebook ?? parsed
    expect(nb.blocks.map((b: any) => b.id)).toEqual(s.ids())
  })

  it('insertAfter with an unknown anchor throws and rolls back', async () => {
    const s = await boot()
    const store = s.store()
    const before = s.ids()
    expect(() => store.applyAiEdit({ label: 'x', run: (tx: any) => { tx.insertAfter('markdown', 'nope', 'md') } })).toThrow('anchor-missing')
    expect(s.ids()).toEqual(before)
    expect(store.history.undoDepth.value).toBe(0)
  })

  it('addBlock with an unknown anchor throws and never appends; null still inserts at the top', async () => {
    const s = await boot()
    const store = s.store()
    const before = s.ids()
    expect(() => store.addBlock('markdown', 'nope')).toThrow('anchor-missing')
    expect(s.ids()).toEqual(before)
    const n = store.addBlock('markdown', null)
    expect(s.ids()).toEqual([n, ...before])
  })

  it('interpret drawer open on a block whose add is undone shows the deleted state; undoing the delete of its block restores the normal state, nothing throws', async () => {
    const s = await boot()
    const store = s.store()
    const nid = store.addBlock('sql', 'b3')
    store.updateContent(nid, 'select 5')
    await flushPromises()
    await s.interpret(nid)
    store.undo(); store.undo(); await flushPromises()
    expect(s.ids()).not.toContain(nid)
    const btn = s.w.find('[data-test=drawer-confirm]')
    expect(btn.attributes('disabled') ?? btn.attributes('aria-disabled')).toBeDefined()
    expect(s.w.text()).toContain('The SQL block was deleted')
    store.redo(); store.redo(); await flushPromises()
    expect(s.ids()).toContain(nid)
    expect(s.w.text()).not.toContain('The SQL block was deleted')
  })

  it('interpret: Insert disabled with the reason when the block is deleted while open', async () => {
    const s = await boot()
    await s.interpret('b3')
    s.store().removeBlock('b3')
    await flushPromises()
    const btn = s.w.find('[data-test=drawer-confirm]')
    expect(btn.attributes('disabled') ?? btn.attributes('aria-disabled')).toBeDefined()
    expect(s.w.text()).toContain('The SQL block was deleted')
  })

  it('interpret: anchor vanishing between check and write shows an alert, stays open, no change', async () => {
    const s = await boot()
    await s.interpret('b3')
    const store = s.store()
    const orig = store.applyAiEdit
    store.applyAiEdit = (e: any) => { store.removeBlock('b3'); return orig(e) }
    const before = s.ids().filter((i) => i !== 'b3')
    await s.confirm()
    store.applyAiEdit = orig
    expect(s.ids()).toEqual(before)
    expect(s.w.find('[data-test=interpret-insert-error]').attributes('role')).toBe('alert')
    expect(s.w.find('[data-test=interpret-drawer]').exists()).toBe(true)
  })

  it('applySqlSuggestion insert-new with a missing anchor rejects with anchor-missing, doc unchanged', async () => {
    const s = await boot()
    const store = s.store()
    const before = s.ids()
    await expect(applySqlSuggestion({ store, runBlocked: () => true } as any, 'insert-new', 'ghost', 'select 1')).rejects.toThrow('anchor-missing')
    expect(s.ids()).toEqual(before)
    expect(store.history.undoDepth.value).toBe(0)
  })

  it('two inserts in one edit: order, undo/redo, undo-redo-undo exact', async () => {
    const s = await boot()
    const store = s.store()
    const base = serializeNotebook(store.nb.value)
    let a = '', b = ''
    store.applyAiEdit({ label: 'two', run: (tx: any) => { a = tx.insertAfter('markdown', 'b3', 'A'); b = tx.insertAfter('markdown', a, 'B') } })
    const order = ['b1', 'b2', 'b3', a, b, 'b4', 'b5', 'b6']
    expect(s.ids()).toEqual(order)
    const after = serializeNotebook(store.nb.value)
    store.undo(); expect(serializeNotebook(store.nb.value)).toBe(base)
    rawMove(store, 'b1', 5)
    rawMove(store, 'b1', -5)
    store.redo(); expect(s.ids()).toEqual(order)
    expect(serializeNotebook(store.nb.value)).toBe(after)
    store.undo(); expect(serializeNotebook(store.nb.value)).toBe(base)
  })

  it('predecessor deleted then redo → conflict, no crash, no insert', async () => {
    const s = await boot()
    const store = s.store()
    store.applyAiEdit({ label: 'one', run: (tx: any) => { tx.insertAfter('markdown', 'b3', 'A') } })
    store.undo()
    rawRemove(store, 'b3')
    const before = s.ids()
    const r = store.redo()
    expect(r.ok).toBe(false)
    expect(s.ids()).toEqual(before)
  })
})
