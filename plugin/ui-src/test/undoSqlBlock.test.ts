import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from '../src/connections/hostConnections'
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

function setup() {
  setLocale('en')
  const bridge = createFakeBridge({})
  const connections = createConnectionsStore(bridge)
  let t = 0
  const store = useNotebookStore({ now: () => new Date(t) })
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: {} })
  let ed: any
  const editorFactory = vi.fn((_p: HTMLElement, o: any) => {
    let doc: string = o.doc
    ed = { opts: o, setDoc: vi.fn((x: string) => { doc = x }), getDoc: () => doc, type(x: string) { doc = x; o.onChange(x) }, setDialect: vi.fn(), setFont: vi.fn(), setDark: vi.fn(), clearCache: vi.fn(), destroy: vi.fn() }
    return ed
  })
  const w = mount(SqlBlock, { props: { blockId: 'b1', editorFactory }, global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge } } })
  return { w, store, ed: () => ed, tick: (ms: number) => { t += ms } }
}

describe('SqlBlock undo wiring', () => {
  it('typing 10 keys = one step; store undo syncs the editor without a new entry', async () => {
    const { store, ed, tick, w } = setup()
    for (let i = 0; i < 10; i++) { tick(50); ed().type('select 1' + 'x'.repeat(i)) }
    await flushPromises()
    expect(store.history.undoDepth.value).toBe(1)
    store.undo()
    await flushPromises()
    expect(ed().getDoc()).toBe('select 1')
    expect(store.history.undoDepth.value).toBe(0)
    expect(store.history.redoDepth.value).toBe(1)
  })
  it('result name typing is one step and undo restores', async () => {
    const { store, w, tick } = setup()
    const input = w.find('[data-test=result-name]')
    for (const v of ['a', 'ab', 'abc']) { tick(20); await input.setValue(v) }
    expect(store.history.undoDepth.value).toBe(1)
    store.undo()
    expect((store.nb.value.blocks[0].metadata as any).resultName).toBeUndefined()
  })
})

describe('IME in the SQL result-name input and the analysis title', () => {
  it('result name: no store step while composing, text survives a re-render, one step at commit', async () => {
    const { store, w } = setup()
    const input = w.find('[data-test=result-name]')
    await input.trigger('compositionstart')
    ;(input.element as HTMLInputElement).value = 'ni'
    await input.trigger('input', { isComposing: true })
    expect(store.history.undoDepth.value).toBe(0)
    w.vm.$forceUpdate(); await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('ni')
    ;(input.element as HTMLInputElement).value = 'nihao'
    await input.trigger('compositionend')
    expect(store.history.undoDepth.value).toBe(1)
    expect((store.nb.value.blocks[0].metadata as any).resultName).toBe('nihao')
  })
  it('analysis title input keeps composed text across a re-render', async () => {
    const { mount: m } = await import('@vue/test-utils')
    const AnalysisBlock = (await import('../src/analysis/AnalysisBlock.vue')).default
    setLocale('en')
    const store = useNotebookStore()
    store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: '', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } } } as any)
    const w = m(AnalysisBlock, { props: { blockId: 'c1' }, global: { provide: { [StoreKey as symbol]: store } } })
    const el = w.find('[data-test=ab-title]')
    await el.trigger('compositionstart')
    ;(el.element as HTMLInputElement).value = 'zhong'
    await el.trigger('input', { isComposing: true })
    w.vm.$forceUpdate(); await flushPromises()
    expect((el.element as HTMLInputElement).value).toBe('zhong')
    ;(el.element as HTMLInputElement).value = '中文'
    await el.trigger('compositionend')
    w.vm.$forceUpdate(); await flushPromises()
    expect((el.element as HTMLInputElement).value).toBe('中文')
    await el.trigger('change')
    expect((store.nb.value.blocks[0].metadata as any).chartOptions.title).toBe('中文')
  })
})
