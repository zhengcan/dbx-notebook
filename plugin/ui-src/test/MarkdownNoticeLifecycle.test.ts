import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import { createDropTargets } from '../src/blocks/mdDropTargets'
import { BridgeKey, DropTargetsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { useNotebookStore } from '../src/state/notebookStore'

const OK = { mime: 'image/png', base64: 'AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 }
const src = () => ({ name: 'a.png', size: 3, type: 'image/png', read: async () => ({ mime: 'image/png', base64: 'AAAA' }) })
const summary = { ignored: 0, unsupported: 0, truncated: 0, hostTruncated: false } as any

function mk() {
  const nb: any = createEmptyNotebook()
  nb.blocks = [{ id: 'm1', type: 'markdown', content: 'hello' }]
  const store = useNotebookStore()
  store.load(serializeNotebook(nb), '/n/n.sqlnb', 1)
  let n = 0
  const bridge = { invoke: vi.fn(async (m: string) => {
    if (m === 'notebook/saveImage') return { relPath: `n.sqlnb.assets/image-${++n}.png`, size: 3 }
    if (m === 'notebook/readImage') return OK
    throw new Error('unexpected ' + m)
  }) } as any
  const targets = createDropTargets()
  const Host = defineComponent({
    setup: () => () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }),
    provide: { [BridgeKey as symbol]: bridge, [DropTargetsKey as symbol]: targets, [StoreKey as symbol]: { ...store, path: store.path } as any },
  })
  const w = mount(Host, { attachTo: document.body })
  const drop = async () => { await targets.list()[0].insert([src()], { summary, viaRecent: true }); await flushPromises() }
  return { w, store, drop }
}
const notice = (w: ReturnType<typeof mk>['w']) => w.find('.md-notice')

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

describe('insert-bound notice lifecycle', () => {
  it('shows the undoable hint after a recent-block drop', async () => {
    const { w, drop } = mk()
    await drop()
    expect(notice(w).text()).toContain('可撤销')
  })
  it('undo clears the hint immediately', async () => {
    const { w, store, drop } = mk()
    await drop()
    store.undo(); await flushPromises()
    expect(notice(w).exists()).toBe(false)
  })
  it('undo then redo does not bring the old hint back', async () => {
    const { w, store, drop } = mk()
    await drop()
    store.undo(); store.redo(); await flushPromises()
    expect(notice(w).exists()).toBe(false)
  })
  it('another edit of the document clears the hint', async () => {
    const { w, store, drop } = mk()
    await drop()
    store.updateContent('m1', 'changed'); await flushPromises()
    expect(notice(w).exists()).toBe(false)
  })
})

describe('notice duration', () => {
  it('info notice stays at 2999ms and disappears at 3000ms', async () => {
    vi.useFakeTimers()
    const { w, drop } = mk()
    const p = drop(); await vi.advanceTimersByTimeAsync(0); await p
    await vi.advanceTimersByTimeAsync(0)
    expect(notice(w).exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2999)
    expect(notice(w).exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(notice(w).exists()).toBe(false)
  })
})
