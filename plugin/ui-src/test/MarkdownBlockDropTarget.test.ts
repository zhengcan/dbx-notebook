import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises as flush } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import { BridgeKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { useNotebookStore } from '../src/state/notebookStore'
import { file, fakeDt, SVG_BYTES } from './mdImageHelpers'

const flushPromises = async () => { await flush(); await new Promise((r) => setTimeout(r, 0)); await flush() }
const settle = async () => { await new Promise((r) => setTimeout(r, 40)); await flushPromises() }
const OK = { mime: 'image/png', base64: 'AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 }
const LINK = '![](n.sqlnb.assets/image-1.png)'
const png = () => file('image.png', 'image/png')

function mk(content: string, path: string | null = '/n/n.sqlnb') {
  const nb: any = createEmptyNotebook()
  nb.blocks = [{ id: 'm1', type: 'markdown', content }]
  const store = useNotebookStore()
  store.load(serializeNotebook(nb), path, path ? 1 : null)
  let n = 0
  const bridge = { invoke: vi.fn(async (m: string) => {
    if (m === 'notebook/saveImage') return { relPath: `n.sqlnb.assets/image-${++n}.png`, size: 3 }
    if (m === 'notebook/readImage') return OK
    throw new Error('unexpected ' + m)
  }) } as any
  const Host = defineComponent({
    setup: () => () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }),
    provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: { ...store, path: store.path } as any },
  })
  const w = mount(Host, { attachTo: document.body })
  return { w, store, bridge, saves: () => bridge.invoke.mock.calls.filter((c: any) => c[0] === 'notebook/saveImage') }
}
const body = (s: ReturnType<typeof useNotebookStore>) => s.nb.value.blocks[0].content
const fire = (el: Element, type: string, dt: DataTransfer) => {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as any
  ev.dataTransfer = dt; ev.clientX = 5; ev.clientY = 5
  el.dispatchEvent(ev)
  return ev as Event
}

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = '' })

describe('MarkdownBlock: whole block is the drop target', () => {
  it('preview drop appends the link as a new paragraph, stays in preview, one undo step', async () => {
    const { w, store, saves } = mk('hello')
    await flushPromises()
    const ev = fire(w.find('.md-block').element, 'drop', fakeDt([png()]))
    expect(ev.defaultPrevented).toBe(true)
    await settle()
    expect(saves().length).toBe(1)
    expect(body(store)).toBe(`hello\n\n${LINK}`)
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('.md-view').exists()).toBe(true)
    store.undo()
    expect(body(store)).toBe('hello')
  })
  it('drop onto the preview element itself (event bubbles to the block)', async () => {
    const { w, store } = mk('hello')
    await flushPromises()
    fire(w.find('.md-view').element, 'drop', fakeDt([png()]))
    await settle()
    expect(body(store)).toBe(`hello\n\n${LINK}`)
  })
  it('trailing newlines: only the missing blank line is added', async () => {
    const a = mk('hello\n')
    await flushPromises()
    fire(a.w.find('.md-block').element, 'drop', fakeDt([png()])); await settle()
    expect(body(a.store)).toBe(`hello\n\n${LINK}`)
    document.body.innerHTML = ''
    const b = mk('hello\n\n')
    await flushPromises()
    fire(b.w.find('.md-block').element, 'drop', fakeDt([png()])); await settle()
    expect(body(b.store)).toBe(`hello\n\n${LINK}`)
  })
  it('empty content (empty-hint preview): link only, no leading blank lines', async () => {
    const { w, store } = mk('')
    await flushPromises()
    await w.find('textarea').trigger('blur'); await flushPromises()
    expect(w.find('.md-empty').exists()).toBe(true)
    fire(w.find('.md-block').element, 'drop', fakeDt([png()])); await settle()
    expect(body(store)).toBe(LINK)
    expect(w.find('textarea').exists()).toBe(false)
  })
  it('multiple images are appended together in one paragraph and one undo step', async () => {
    const { w, store } = mk('x')
    await flushPromises()
    fire(w.find('.md-block').element, 'drop', fakeDt([png(), png()])); await settle()
    expect(body(store)).toBe('x\n\n![](n.sqlnb.assets/image-1.png)\n![](n.sqlnb.assets/image-2.png)')
    store.undo()
    expect(body(store)).toBe('x')
  })
  it('unsupported formats: prevented, notice, nothing saved', async () => {
    const { w, store, saves } = mk('x')
    await flushPromises()
    const ev = fire(w.find('.md-block').element, 'drop', fakeDt([file('a.svg', 'image/svg+xml', SVG_BYTES)]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(saves().length).toBe(0)
    expect(body(store)).toBe('x')
    expect(w.find('.md-notice').text()).toContain('不是支持的图片')
  })
  it('more than 10 images: ten saved, the rest reported', async () => {
    const { w, saves } = mk('x')
    await flushPromises()
    fire(w.find('.md-block').element, 'drop', fakeDt(Array.from({ length: 11 }, () => png()))); await settle()
    expect(saves().length).toBe(10)
    expect(w.find('.md-notice').text()).toContain('最多')
  })
  it('unsaved notebook: alert, no RPC, no edit', async () => {
    const { w, store, saves } = mk('x', null)
    await flushPromises()
    const ev = fire(w.find('.md-block').element, 'drop', fakeDt([png()]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(saves().length).toBe(0)
    expect(body(store)).toBe('x')
    expect(w.find('.md-notice').attributes('role')).toBe('alert')
    expect(w.find('.md-notice').text()).toContain('请先保存笔记本')
  })
  it('non-Files drags (text, links, in-app selections) are left alone', async () => {
    const { w, saves } = mk('x')
    await flushPromises()
    const root = w.find('.md-block').element
    for (const type of ['dragenter', 'dragover', 'drop']) {
      expect(fire(root, type, fakeDt([], 'plain text', ['text/plain'])).defaultPrevented).toBe(false)
      expect(fire(root, type, fakeDt([], '', ['text/uri-list'])).defaultPrevented).toBe(false)
      expect(fire(root, type, fakeDt([], '', ['application/x-block-reorder'])).defaultPrevented).toBe(false)
    }
    expect(w.find('.md-block').classes()).not.toContain('md-drop')
    await settle()
    expect(saves().length).toBe(0)
  })
  it('non-image files are always prevented (no navigation) but not droppable and not highlighted', async () => {
    const { w, saves, store } = mk('x')
    await flushPromises()
    const root = w.find('.md-block').element
    for (const f of [file('a.txt', 'text/plain'), file('a.pdf', 'application/pdf')]) {
      const dt = fakeDt([f])
      expect(fire(root, 'dragenter', dt).defaultPrevented).toBe(true)
      expect(fire(root, 'dragover', dt).defaultPrevented).toBe(true)
      expect((dt as any).dropEffect).toBe('none')
      expect(w.find('.md-block').classes()).not.toContain('md-drop')
      expect(fire(root, 'drop', dt).defaultPrevented).toBe(true)
    }
    await settle()
    expect(saves().length).toBe(0)
    expect(body(store)).toBe('x')
  })
  it('a drop that does reach us with only non-image files is prevented and ignored silently', async () => {
    const { w, saves, store } = mk('x')
    await flushPromises()
    const ev = fire(w.find('.md-block').element, 'drop', fakeDt([file('a.zip', 'application/zip')]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(saves().length).toBe(0)
    expect(body(store)).toBe('x')
  })
  it('mixed png + txt: copy effect, highlight, only the png saved', async () => {
    const { w, saves } = mk('x')
    await flushPromises()
    const root = w.find('.md-block').element
    const dt = fakeDt([png(), file('a.txt', 'text/plain')])
    fire(root, 'dragenter', dt); fire(root, 'dragover', dt); await flushPromises()
    expect((dt as any).dropEffect).toBe('copy')
    expect(w.find('.md-block').classes()).toContain('md-drop')
    fire(root, 'drop', dt); await settle()
    expect(saves().length).toBe(1)
  })
  it('svg is image-like: copy effect so the drop fires and the unsupported notice is shown', async () => {
    const { w } = mk('x')
    await flushPromises()
    const dt = fakeDt([file('a.svg', 'image/svg+xml', SVG_BYTES)])
    fire(w.find('.md-block').element, 'dragover', dt)
    expect((dt as any).dropEffect).toBe('copy')
  })
  it('whitespace-only content is replaced by the link (no stray blank lines)', async () => {
    const { w, store } = mk('  \n\n')
    await flushPromises()
    await w.find('textarea').trigger('blur'); await flushPromises()
    fire(w.find('.md-block').element, 'drop', fakeDt([png()])); await settle()
    expect(body(store)).toBe(LINK)
    store.undo()
    expect(body(store)).toBe('  \n\n')
  })
  it('image dragover is prevented in preview too', async () => {
    const { w } = mk('x')
    await flushPromises()
    expect(fire(w.find('.md-block').element, 'dragover', fakeDt([png()])).defaultPrevented).toBe(true)
  })

  it('edit mode: drop on the textarea still inserts at the drop point', async () => {
    const { w, store } = mk('abc')
    await w.find('.md-view').trigger('dblclick'); await flushPromises()
    fire(w.find('textarea').element, 'drop', fakeDt([png()])); await settle()
    expect(body(store)!.includes(LINK)).toBe(true)
    expect(body(store)!.replace(LINK, '')).toBe('abc')
    expect(w.find('textarea').exists()).toBe(true)
  })
  it('edit mode: drop outside the textarea inserts at the current selection', async () => {
    const { w, store } = mk('abcdef')
    await w.find('.md-view').trigger('dblclick'); await flushPromises()
    const ta = w.find('textarea').element as HTMLTextAreaElement
    ta.focus(); ta.setSelectionRange(2, 2)
    fire(w.find('.md-block').element, 'drop', fakeDt([png()])); await settle()
    expect(body(store)).toBe(`ab${LINK}cdef`)
    expect(w.find('textarea').exists()).toBe(true)
  })
  it('paste still needs the textarea: a paste on the preview does nothing', async () => {
    const { w, saves } = mk('x')
    await flushPromises()
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as any
    ev.clipboardData = fakeDt([png()])
    w.find('.md-block').element.dispatchEvent(ev)
    await settle()
    expect(ev.defaultPrevented).toBe(false)
    expect(saves().length).toBe(0)
  })
})

describe('MarkdownBlock: drop hint', () => {
  it('shows on dragenter, survives child enter/leave jitter, hides on the final leave', async () => {
    const { w } = mk('x')
    await flushPromises()
    const root = w.find('.md-block')
    const dt = fakeDt([png()])
    fire(root.element, 'dragenter', dt); await flushPromises()
    expect(root.classes()).toContain('md-drop')
    fire(w.find('.md-view').element, 'dragenter', dt)
    fire(root.element, 'dragleave', dt); await flushPromises()
    expect(root.classes()).toContain('md-drop')
    fire(w.find('.md-view').element, 'dragleave', dt); await flushPromises()
    expect(root.classes()).not.toContain('md-drop')
  })
  it('drop clears the hint', async () => {
    const { w } = mk('x')
    await flushPromises()
    const root = w.find('.md-block')
    fire(root.element, 'dragenter', fakeDt([png()]))
    fire(root.element, 'drop', fakeDt([png()])); await settle()
    expect(root.classes()).not.toContain('md-drop')
  })
  it('window-level drop / dragend reset a stuck hint', async () => {
    for (const type of ['drop', 'dragend']) {
      const { w } = mk('x')
      await flushPromises()
      fire(w.find('.md-block').element, 'dragenter', fakeDt([png()])); await flushPromises()
      expect(w.find('.md-block').classes()).toContain('md-drop')
      window.dispatchEvent(new Event(type)); await flushPromises()
      expect(w.find('.md-block').classes()).not.toContain('md-drop')
      document.body.innerHTML = ''
    }
  })
  it('dragleave out of the viewport (relatedTarget null) resets; inside the viewport it does not', async () => {
    const { w } = mk('x')
    await flushPromises()
    const root = w.find('.md-block').element
    const dt = fakeDt([png()])
    fire(root, 'dragenter', dt); fire(root, 'dragenter', dt); await flushPromises()
    const leave = (x: number, y: number) => { const ev = new Event('dragleave', { bubbles: true }) as any; ev.dataTransfer = dt; ev.clientX = x; ev.clientY = y; ev.relatedTarget = null; document.body.dispatchEvent(ev) }
    leave(50, 50); await flushPromises()
    expect(w.find('.md-block').classes()).toContain('md-drop')
    leave(-1, 50); await flushPromises()
    expect(w.find('.md-block').classes()).not.toContain('md-drop')
  })
  it('a cancelled drag (no more dragover) clears the hint after a timeout', async () => {
    vi.useFakeTimers()
    try {
      const { w } = mk('x')
      const root = w.find('.md-block').element
      const dt = fakeDt([png()])
      fire(root, 'dragenter', dt); fire(root, 'dragover', dt); await vi.advanceTimersByTimeAsync(0)
      expect(w.find('.md-block').classes()).toContain('md-drop')
      await vi.advanceTimersByTimeAsync(600)
      fire(root, 'dragover', dt)
      await vi.advanceTimersByTimeAsync(600)
      expect(w.find('.md-block').classes()).toContain('md-drop')
      await vi.advanceTimersByTimeAsync(1000)
      expect(w.find('.md-block').classes()).not.toContain('md-drop')
    } finally { vi.useRealTimers() }
  })
})

describe('MarkdownBlock: window deactivation does not leave edit mode', () => {
  const hasFocus = (v: boolean) => vi.spyOn(document, 'hasFocus').mockReturnValue(v)
  afterEach(() => vi.restoreAllMocks())

  it('blur while the window is inactive keeps the textarea; a later click elsewhere still leaves', async () => {
    const { w } = mk('abc')
    await w.find('.md-view').trigger('dblclick'); await flushPromises()
    const ta = w.find('textarea').element as HTMLTextAreaElement
    ta.focus()
    expect(document.activeElement).toBe(ta)
    hasFocus(false)
    await w.find('textarea').trigger('blur'); await flushPromises()
    expect(w.find('textarea').exists()).toBe(true)
    hasFocus(true)
    ta.blur(); await flushPromises()
    expect(w.find('textarea').exists()).toBe(false)
  })
  it('blur with the window active leaves edit mode', async () => {
    const { w } = mk('abc')
    await w.find('.md-view').trigger('dblclick'); await flushPromises()
    ;(w.find('textarea').element as HTMLTextAreaElement).focus()
    hasFocus(true)
    await w.find('textarea').trigger('blur'); await flushPromises()
    expect(w.find('textarea').exists()).toBe(false)
  })
  it('focus moved to another element while the window reports inactive still leaves', async () => {
    const { w } = mk('abc')
    const btn = document.createElement('button'); document.body.appendChild(btn)
    await w.find('.md-view').trigger('dblclick'); await flushPromises()
    ;(w.find('textarea').element as HTMLTextAreaElement).focus()
    hasFocus(false)
    btn.focus(); await flushPromises()
    expect(w.find('textarea').exists()).toBe(false)
  })
  it('a modal dialog open: block ignores file drops (no insert) but still swallows them', async () => {
    const { w, store, saves } = mk('hello')
    await flushPromises()
    const m = document.createElement('div'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m)
    const ev = fire(w.find('.md-block').element, 'drop', fakeDt([png()]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(saves().length).toBe(0)
    expect(body(store)).toBe('hello')
    const over = fire(w.find('.md-block').element, 'dragenter', fakeDt([png()]))
    expect(w.find('.md-block').classes()).not.toContain('md-drop')
    expect(over.defaultPrevented).toBe(true)
  })
})
