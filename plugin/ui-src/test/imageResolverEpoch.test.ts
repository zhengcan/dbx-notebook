import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises as flush } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { createImageResolver } from '../src/markdown/imageResolver'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import { BridgeKey, StoreKey } from '../src/injection'
import { useNotebookStore } from '../src/state/notebookStore'

const flushPromises = async () => { await flush(); await new Promise((r) => setTimeout(r, 0)); await flush() }
const img = (b64: string) => ({ mime: 'image/png', base64: b64, size: 3, mtimeMs: 1, width: 2, height: 2 })
const el = (_html: string) => { const d = document.createElement('div'); d.innerHTML = '<p><img data-sqlnb-src="a.png" alt="a"></p>'; document.body.appendChild(d); return d }

describe('resolver cache epoch', () => {
  it('same path, same client: the cache is dropped when the epoch changes', async () => {
    let n = 0
    const client = vi.fn(async () => { const x = img(n++ === 0 ? 'AAAA' : 'BBBB'); return { ...x, dataUri: `data:image/png;base64,${x.base64}` } })
    let epoch = 0
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: client as any, epoch: () => epoch })
    const a = el('<img data-sqlnb-src="a.png" alt="a">')
    await r.resolve(a); await flushPromises()
    expect(a.querySelector('img')!.getAttribute('src')).toContain('AAAA')
    const b = el('<img data-sqlnb-src="a.png" alt="a">')
    await r.resolve(b); await flushPromises()
    expect(client).toHaveBeenCalledTimes(1)
    epoch++
    const c = el('<img data-sqlnb-src="a.png" alt="a">')
    await r.resolve(c); await flushPromises()
    expect(client).toHaveBeenCalledTimes(2)
    expect(c.querySelector('img')!.getAttribute('src')).toContain('BBBB')
    r.dispose()
  })
})

describe('reopening the same notebook path re-reads changed images', () => {
  it('store.load() of the same path bumps the epoch and the block shows the new bytes', async () => {
    const nb: any = createEmptyNotebook()
    nb.blocks = [{ id: 'm1', type: 'markdown', content: '![p](pic.png)' }]
    const text = serializeNotebook(nb)
    const store = useNotebookStore()
    store.load(text, '/n/a.sqlnb', 1)
    let version = 'AAAA'
    const bridge = { invoke: vi.fn(async () => img(version)) } as any
    const mountIt = () => mount(MarkdownBlock, { props: { modelValue: '![p](pic.png)', blockId: 'm1' }, global: { provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: store } }, attachTo: document.body })
    const w = mountIt()
    await flushPromises()
    expect(w.find('img').attributes('src')).toContain('AAAA')
    w.unmount()
    version = 'BBBB'
    store.load(text, '/n/a.sqlnb', 2)
    const w2 = mountIt()
    await flushPromises()
    expect(w2.find('img').attributes('src')).toContain('BBBB')
    expect(bridge.invoke).toHaveBeenCalledTimes(2)
    w2.unmount()
  })
})
