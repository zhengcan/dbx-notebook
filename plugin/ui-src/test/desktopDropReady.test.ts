import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import NotebookView from '../src/shell/NotebookView.vue'
import { BridgeKey, StoreKey } from '../src/injection'
import { useNotebookStore } from '../src/state/notebookStore'

function mountView() {
  const nb: any = createEmptyNotebook()
  nb.blocks = [{ id: 'm1', type: 'markdown', content: 'one' }]
  const store = useNotebookStore()
  store.load(serializeNotebook(nb), '/n/n.sqlnb', 1)
  return mount(NotebookView, { global: { provide: { [BridgeKey as symbol]: { invoke: vi.fn(async () => ({})) }, [StoreKey as symbol]: store } }, attachTo: document.body })
}
const host = () => {
  const onDrop = vi.fn(() => () => {})
  return { onDrop, host: { capabilities: { fileTransfer: { drop: true, pick: true, read: true } }, fileTransfer: { onDrop, onDragState: vi.fn(() => () => {}), pick: vi.fn(), read: vi.fn(), cancel: vi.fn() } } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); delete (window as any).dbxPlugin; document.body.innerHTML = '' })

describe('host appearing late', () => {
  it('subscribes once dbxPlugin shows up after mount', async () => {
    const w = mountView()
    await vi.advanceTimersByTimeAsync(600)
    const h = host()
    ;(window as any).dbxPlugin = h.host
    expect(h.onDrop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(h.onDrop).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.onDrop).toHaveBeenCalledTimes(1)
    w.unmount()
  })
  it('never present: no throw, retries stop, no timer left', async () => {
    const w = mountView()
    await vi.advanceTimersByTimeAsync(60000)
    expect(vi.getTimerCount()).toBe(0)
    w.unmount()
  })
  it('unmount cancels the pending retry', async () => {
    const w = mountView()
    await vi.advanceTimersByTimeAsync(300)
    w.unmount()
    expect(vi.getTimerCount()).toBe(0)
    const h = host()
    ;(window as any).dbxPlugin = h.host
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.onDrop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for dbxPlugin.ready when present', async () => {
    let go!: () => void
    const h = host()
    ;(window as any).dbxPlugin = { ...h.host, ready: new Promise<void>((r) => { go = r }) }
    const w = mountView()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.onDrop).not.toHaveBeenCalled()
    go()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.onDrop).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
