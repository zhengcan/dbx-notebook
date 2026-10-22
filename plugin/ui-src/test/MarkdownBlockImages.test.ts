import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises as flush } from '@vue/test-utils'
import { ref } from 'vue'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import { BridgeKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { mapHostError } from '../src/host/bridge'

const flushPromises = async () => { await flush(); await new Promise((r) => setTimeout(r, 0)); await flush() }
const OK = { mime: 'image/png', base64: 'AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 }
function setup(md: string, path: string | null, invoke: (m: string, p: any) => Promise<unknown>) {
  const bridge = { invoke: vi.fn(invoke) } as any
  const store = { path: ref(path) } as any
  const w = mount(MarkdownBlock, { props: { modelValue: md }, global: { provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: store } }, attachTo: document.body })
  return { w, bridge, store }
}

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = '' })

describe('MarkdownBlock images', () => {
  it('loads a relative image through the RPC and sets the data URI', async () => {
    const { w, bridge } = setup('![pic](assets/a.png)', '/n/a.sqlnb', async () => OK)
    await flushPromises()
    const img = w.find('img')
    expect(img.attributes('src')).toBe('data:image/png;base64,AAAA')
    expect(img.attributes('alt')).toBe('pic')
    expect(bridge.invoke.mock.calls.map((c: any) => [c[0], c[1]])).toEqual([['notebook/readImage', { notebookPath: '/n/a.sqlnb', relPath: 'assets/a.png' }]])
    w.unmount()
  })
  it('unsaved notebook shows the save hint without RPC', async () => {
    const { w, bridge } = setup('![pic](a.png)', null, async () => OK)
    await flushPromises()
    expect(w.text()).toContain('保存笔记本后显示图片')
    expect(w.text()).toContain('pic')
    expect(bridge.invoke).not.toHaveBeenCalled()
    w.unmount()
  })
  it('RPC error shows a placeholder', async () => {
    const { w } = setup('![pic](a.png)', '/n/a.sqlnb', async () => { throw mapHostError(new Error('[-32040] [notFound] nope')) })
    await flushPromises()
    const ph = w.find('[data-state="error"]')
    expect(ph.attributes('role')).toBe('img')
    expect(ph.text()).toContain('找不到图片')
    w.unmount()
  })
  it('remote image: no remote src, no fetch, no RPC', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const { w, bridge } = setup('![r](https://evil.example/x.png) ![p](//evil.example/y.png) ![f](file:///etc/passwd)', '/n/a.sqlnb', async () => OK)
    await flushPromises()
    expect(w.findAll('img').every((i) => !(i.attributes('src') ?? '').startsWith('http'))).toBe(true)
    expect(w.html()).not.toContain('evil.example')
    expect(f).not.toHaveBeenCalled()
    expect(bridge.invoke).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    w.unmount()
  })
  it('content change cancels stale loads and re-resolves', async () => {
    const pend: Array<(v: unknown) => void> = []
    const { w, bridge } = setup('![a](a.png)', '/n/a.sqlnb', () => new Promise((r) => { pend.push(r) }))
    await flushPromises()
    await w.setProps({ modelValue: '![b](b.png)' })
    await flushPromises()
    expect(bridge.invoke.mock.calls.map((c: any) => c[1].relPath)).toEqual(['a.png', 'b.png'])
    pend[0](OK); pend[1]({ ...OK, base64: 'BBBB' })
    await flushPromises()
    expect(w.findAll('img').length).toBe(1)
    expect(w.find('img').attributes('src')).toContain('BBBB')
    w.unmount()
  })
  it('unmount aborts: no DOM work after unmount, no errors', async () => {
    let res!: (v: unknown) => void
    const { w } = setup('![a](a.png)', '/n/a.sqlnb', () => new Promise((r) => { res = r }))
    await flushPromises()
    const el = w.element as HTMLElement
    w.unmount()
    res(OK)
    await flushPromises()
    expect(el.querySelector('img')).toBeNull()
  })
  it('saving the notebook (path appears) resolves images', async () => {
    const { w, store, bridge } = setup('![a](a.png)', null, async () => OK)
    await flushPromises()
    expect(bridge.invoke).not.toHaveBeenCalled()
    store.path.value = '/n/new.sqlnb'
    await flushPromises()
    expect(w.find('img').attributes('src')).toContain('data:image/png')
    w.unmount()
  })
  it('works without any provider (no store/bridge): placeholder only', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '![a](a.png)' } })
    await flushPromises()
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('a')
    w.unmount()
  })
})

import { defineComponent, h } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'
import { file, fakeDt, SVG_BYTES, JPG_BYTES, PNG_BYTES } from './mdImageHelpers'
import { MAX_IMAGE_BYTES } from '../src/blocks/mdImagePaste'

describe('MarkdownBlock paste/drop images', () => {
  function mk(content: string, path: string | null, saveImage: (p: any) => Promise<unknown> = async (p) => ({ relPath: `n.sqlnb.assets/image-${p.n ?? 1}.png`, size: 3 })) {
    const nb: any = createEmptyNotebook()
    nb.blocks = [{ id: 'm1', type: 'markdown', content }]
    const store = useNotebookStore()
    store.load(serializeNotebook(nb), path, path ? 1 : null)
    let n = 0
    const bridge = { invoke: vi.fn(async (m: string, p: any) => {
      if (m === 'notebook/saveImage') return saveImage({ ...p, n: ++n })
      if (m === 'notebook/readImage') return OK
      throw new Error('unexpected ' + m)
    }) } as any
    const Host = defineComponent({
      setup: () => () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }),
      provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: { ...store, path: store.path } as any },
    })
    const w = mount(Host, { attachTo: document.body })
    return { w, store, bridge, saves: () => bridge.invoke.mock.calls.filter((c: any) => c[0] === 'notebook/saveImage').map((c: any) => c[1]) }
  }
  async function edit(w: ReturnType<typeof mount>) {
    await w.find('.md-view').trigger('dblclick')
    await flushPromises()
    return w.find('textarea')
  }
  const body = (s: ReturnType<typeof useNotebookStore>) => s.nb.value.blocks[0].content
  const paste = (ta: any, dt: DataTransfer) => { const ev = new Event('paste', { bubbles: true, cancelable: true }) as any; ev.clipboardData = dt; ta.element.dispatchEvent(ev); return ev as Event }
  const drop = (ta: any, dt: DataTransfer, type = 'drop') => { const ev = new Event(type, { bubbles: true, cancelable: true }) as any; ev.dataTransfer = dt; ev.clientX = 5; ev.clientY = 5; ta.element.dispatchEvent(ev); return ev as Event }
  const settle = async () => { await new Promise((r) => setTimeout(r, 40)); await flushPromises() }
  const png = () => file('image.png', 'image/png')

  it('edit mode shows the textarea only (notice element never splits the v-if chain), also while a notice is visible', async () => {
    const { w } = mk('hello', null)
    const ta = await edit(w)
    expect(w.find('.md-view').exists()).toBe(false)
    paste(ta, fakeDt([png()])); await settle()
    expect(w.find('.md-notice').exists()).toBe(true)
    expect(w.find('.md-view').exists()).toBe(false)
    expect(w.findAll('textarea')).toHaveLength(1)
    w.unmount()
  })
  it('paste: saves, inserts the link at the caret, one history entry, caret after, focus kept', async () => {
    const { w, store, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(2, 2)
    const ev = paste(ta, fakeDt([png()]))
    expect(ev.defaultPrevented).toBe(true)
    await settle()
    expect(saves()).toEqual([{ notebookPath: '/n/n.sqlnb', mime: 'image/png', base64: btoa(String.fromCharCode(...PNG_BYTES)) }])
    expect(body(store)).toBe('he![](n.sqlnb.assets/image-1.png)llo')
    expect((ta.element as HTMLTextAreaElement).value).toBe('he![](n.sqlnb.assets/image-1.png)llo')
    expect(store.history.undoDepth.value).toBe(1)
    expect((ta.element as HTMLTextAreaElement).selectionStart).toBe(2 + '![](n.sqlnb.assets/image-1.png)'.length)
    expect(document.activeElement).toBe(ta.element)
    w.unmount()
  })
  it('several files: sequential saves, links joined by \\n in one entry, selection replaced', async () => {
    let active = 0, maxActive = 0
    const { w, store, saves } = mk('hello', '/n/n.sqlnb', async (p) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; return { relPath: `n.sqlnb.assets/image-${p.n}.png`, size: 1 } })
    const ta = await edit(w)
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(1, 4)
    paste(ta, fakeDt([png(), png()]))
    await new Promise((r) => setTimeout(r, 40)); await flushPromises()
    expect(saves()).toHaveLength(2)
    expect(maxActive).toBe(1)
    expect(body(store)).toBe('h![](n.sqlnb.assets/image-1.png)\n![](n.sqlnb.assets/image-2.png)o')
    expect(store.history.undoDepth.value).toBe(1)
    w.unmount()
  })
  it('undo restores exact text and leaves no dangling state; redo reapplies; no merge with typing', async () => {
    const { w, store } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    await ta.setValue('hello1')
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(6, 6)
    paste(ta, fakeDt([png()])); await settle()
    await ta.setValue(body(store) + 'z')
    expect(store.history.undoDepth.value).toBe(3)
    store.undo(); store.undo()
    expect(body(store)).toBe('hello1')
    store.redo()
    expect(body(store)).toBe('hello1![](n.sqlnb.assets/image-1.png)')
    w.unmount()
  })
  it('IME composing: ignored (no RPC, default not prevented)', async () => {
    const { w, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    await ta.trigger('compositionstart')
    const ev = paste(ta, fakeDt([png()]))
    await settle()
    expect(saves()).toHaveLength(0)
    expect(ev.defaultPrevented).toBe(false)
    w.unmount()
  })
  it('text paste is untouched; text + image keeps text', async () => {
    const { w, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    expect(paste(ta, fakeDt([], 'plain')).defaultPrevented).toBe(false)
    expect(paste(ta, fakeDt([png()], 'plain')).defaultPrevented).toBe(false)
    await settle()
    expect(saves()).toHaveLength(0)
    w.unmount()
  })
  it('saveImage error: visible alert, content unchanged, no entry, no path in the message', async () => {
    const { w, store } = mk('hello', '/n/n.sqlnb', async () => { throw mapHostError(new Error('[-32040] [readFailed] /Users/me/secret/x.png')) })
    const ta = await edit(w)
    paste(ta, fakeDt([png()])); await settle()
    const n = w.find('[role="alert"]')
    expect(n.exists()).toBe(true)
    expect(n.text()).toContain('无法插入图片')
    expect(n.text()).not.toMatch(/Users|secret|\//)
    expect(body(store)).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    w.unmount()
  })
  it('sidecar needsSave/tooLarge/unsupported map to localized messages', async () => {
    for (const [code, msg] of [['needsSave', '请先保存笔记本'], ['tooLarge', '图片过大'], ['unsupported', '不支持的图片']] as const) {
      const { w, store } = mk('hello', '/n/n.sqlnb', async () => { throw mapHostError(new Error(`[-32040] [${code}] x`)) })
      const ta = await edit(w)
      paste(ta, fakeDt([png()])); await settle()
      expect(w.find('[role="alert"]').text()).toContain(msg)
      expect(store.history.undoDepth.value).toBe(0)
      w.unmount()
    }
  })
  it('unsaved notebook: saveFirst message, no RPC, no entry; image default prevented', async () => {
    const { w, store, bridge } = mk('hello', null)
    const ta = await edit(w)
    const ev = paste(ta, fakeDt([png()]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(w.find('[role="alert"]').text()).toContain('请先保存笔记本，再粘贴图片')
    expect(bridge.invoke).not.toHaveBeenCalledWith('notebook/saveImage', expect.anything())
    expect(body(store)).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    const ev2 = drop(ta, fakeDt([png()]))
    expect(ev2.defaultPrevented).toBe(true)
    expect(paste(ta, fakeDt([], 'text')).defaultPrevented).toBe(false)
    w.unmount()
  })
  it('over 10 MiB: tooLarge message, nothing saved or inserted', async () => {
    const { w, store, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    const big = png(); Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
    paste(ta, fakeDt([png(), big])); await settle()
    expect(saves()).toHaveLength(0)
    expect(w.find('[role="alert"]').text()).toContain('图片过大')
    expect(body(store)).toBe('hello')
    w.unmount()
  })
  it('drop of svg/avif: prevented, message mdimg.unsupportedSkipped, nothing saved', async () => {
    const { w, store, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    const ev = drop(ta, fakeDt([file('a.svg', 'image/svg+xml', SVG_BYTES), file('b.avif', 'image/avif')]))
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(saves()).toHaveLength(0)
    expect(w.find('[role="status"], [role="alert"]').text()).toContain('2 个文件不是支持的图片')
    expect(body(store)).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    w.unmount()
  })
  it('mixed drop png + txt + svg: only the png is saved, the svg is reported', async () => {
    const { w, store, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    drop(ta, fakeDt([png(), file('a.txt', 'text/plain'), file('c.svg', 'image/svg+xml', SVG_BYTES)]))
    await settle()
    expect(saves()).toHaveLength(1)
    expect(body(store)).toContain('![](n.sqlnb.assets/image-1.png)')
    expect(w.text()).toContain('1 个文件不是支持的图片')
    w.unmount()
  })
  it('a .png that is really SVG: save refused client-side, message, nothing saved', async () => {
    const { w, saves, store } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    paste(ta, fakeDt([file('x.png', 'image/png', SVG_BYTES)])); await settle()
    expect(saves()).toHaveLength(0)
    expect(w.find('[role="alert"]').text()).toContain('不支持的图片')
    expect(store.history.undoDepth.value).toBe(0)
    w.unmount()
  })
  it('non-image file drop is swallowed (no navigation) but not handled; dragover prevented only for files', async () => {
    const { w } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    expect(drop(ta, fakeDt([file('a.txt', 'text/plain')])).defaultPrevented).toBe(true)
    expect(drop(ta, fakeDt([png()]), 'dragover').defaultPrevented).toBe(true)
    expect(drop(ta, fakeDt([], 'x'), 'dragover').defaultPrevented).toBe(false)
    w.unmount()
  })
  it('11 images: first 10 saved, message about the rest', async () => {
    const { w, saves } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    drop(ta, fakeDt(Array.from({ length: 11 }, () => png())))
    await new Promise((r) => setTimeout(r, 30)); await flushPromises()
    expect(saves()).toHaveLength(10)
    expect(w.text()).toContain('已忽略其余 1 张')
    w.unmount()
  })
  it('drop inserts at the drop caret position', async () => {
    const { w, store } = mk('hello world', '/n/n.sqlnb')
    const ta = await edit(w)
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(0, 0)
    ;(document as any).caretPositionFromPoint = () => ({ offsetNode: ta.element, offset: 5 })
    drop(ta, fakeDt([png()])); await settle()
    expect(body(store)).toBe('hello![](n.sqlnb.assets/image-1.png) world')
    delete (document as any).caretPositionFromPoint
    w.unmount()
  })
  it('after insert, leaving edit mode renders the new image through the resolver', async () => {
    const { w, bridge } = mk('hello', '/n/n.sqlnb')
    const ta = await edit(w)
    paste(ta, fakeDt([png()])); await settle()
    await ta.trigger('keydown', { key: 'Escape' }); await flushPromises()
    expect(bridge.invoke.mock.calls.some((c: any) => c[0] === 'notebook/readImage' && c[1].relPath === 'n.sqlnb.assets/image-1.png')).toBe(true)
    expect(w.find('img').exists()).toBe(true)
    w.unmount()
  })
  it('typing before the caret while the image is saved: link still lands at the original spot', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { w, store } = mk('hello', '/n/n.sqlnb', async () => { await gate; return { relPath: 'n.sqlnb.assets/image-1.png', size: 1 } })
    const ta = await edit(w)
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(5, 5)
    paste(ta, fakeDt([png()])); await new Promise((r) => setTimeout(r, 20))
    store.updateContent('m1', 'XX' + body(store), { coalesce: true })
    release(); await settle()
    expect(body(store)).toBe('XXhello![](n.sqlnb.assets/image-1.png)')
    expect(w.find('.md-notice').exists()).toBe(false)
    w.unmount()
  })
  it('an edit inside the selected range while saving: inserted at the caret with a notice', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { w, store } = mk('hello world', '/n/n.sqlnb', async () => { await gate; return { relPath: 'n.sqlnb.assets/image-1.png', size: 1 } })
    const ta = await edit(w)
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(2, 8)
    paste(ta, fakeDt([png()])); await new Promise((r) => setTimeout(r, 20))
    store.updateContent('m1', 'helXlo world', { coalesce: true })
    await flushPromises()
    ;(ta.element as HTMLTextAreaElement).setSelectionRange(4, 4)
    release(); await settle()
    expect(body(store)).toBe('helX![](n.sqlnb.assets/image-1.png)lo world')
    expect(w.find('[role="status"]').text()).toContain('保存图片期间文本已被修改')
    w.unmount()
  })
  it('unmounted while saving: nothing is inserted and no timer is created', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { w, store } = mk('hello', '/n/n.sqlnb', async () => { await gate; throw mapHostError(new Error('[-32040] [readFailed] x')) })
    const ta = await edit(w)
    paste(ta, fakeDt([png()])); await new Promise((r) => setTimeout(r, 20))
    w.unmount()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    release(); await new Promise((r) => setTimeout(r, 30))
    expect(spy.mock.calls.some((c) => c[1] === 8000)).toBe(false)
    spy.mockRestore()
    expect(body(store)).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
  })
  it('unmounted while saving successfully: no insertion into the (possibly different) notebook', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { w, store } = mk('hello', '/n/n.sqlnb', async () => { await gate; return { relPath: 'n.sqlnb.assets/image-1.png', size: 1 } })
    const ta = await edit(w)
    paste(ta, fakeDt([png()])); await new Promise((r) => setTimeout(r, 20))
    w.unmount()
    release(); await new Promise((r) => setTimeout(r, 30))
    expect(body(store)).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
  })
  it('notice clears itself and is localized', async () => {
    vi.useFakeTimers()
    setLocale('en')
    const { w } = mk('hello', null)
    await w.find('.md-view').trigger('dblclick'); await vi.advanceTimersByTimeAsync(0)
    paste(w.find('textarea'), fakeDt([png()])); await vi.advanceTimersByTimeAsync(0)
    expect(w.find('[role="alert"]').text()).toBe('Save the notebook before pasting images')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.find('[role="alert"]').exists()).toBe(false)
    vi.useRealTimers()
    w.unmount()
  })
})

describe('MarkdownBlock paste/drop never splits an emoji (fallback path without store insert)', () => {
  function mk2(content: string) {
    const bridge = { invoke: vi.fn(async (m: string) => { if (m === 'notebook/saveImage') return { relPath: 'n.sqlnb.assets/i.png', size: 1 }; throw new Error('x') }) } as any
    const store = { path: ref('/n/n.sqlnb') } as any
    const w = mount(MarkdownBlock, { props: { modelValue: content }, global: { provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: store } }, attachTo: document.body })
    return w
  }
  const settle = async () => { await new Promise((r) => setTimeout(r, 40)); await flush() }
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  const send = (el: Element, type: string, dt: DataTransfer) => { const ev = new Event(type, { bubbles: true, cancelable: true }) as any; ev.clipboardData = dt; ev.dataTransfer = dt; ev.clientX = 1; ev.clientY = 1; el.dispatchEvent(ev) }
  const last = (w: any) => (w.emitted('update:modelValue') as string[][]).at(-1)![0]

  it('drop offset in the middle of a pair lands before the emoji', async () => {
    const w = mk2('a😀b')
    await w.find('.md-view').trigger('dblclick'); await flush()
    ;(document as any).caretPositionFromPoint = () => ({ offsetNode: w.find('textarea').element, offset: 2 })
    send(w.find('textarea').element, 'drop', fakeDt([file('a.png', 'image/png')])); await settle()
    expect(last(w)).toBe('a![](n.sqlnb.assets/i.png)😀b')
    delete (document as any).caretPositionFromPoint
    w.unmount()
  })
  it('every drop offset across a😀b😀c😀😀😀d leaves no lone surrogate', async () => {
    const text = 'a😀b😀c😀😀😀d'
    for (let off = 0; off <= text.length; off++) {
      const w = mk2(text)
      await w.find('.md-view').trigger('dblclick'); await flush()
      ;(document as any).caretPositionFromPoint = () => ({ offsetNode: w.find('textarea').element, offset: off })
      send(w.find('textarea').element, 'drop', fakeDt([file('a.png', 'image/png')])); await settle()
      const out = last(w)
      expect(lone.test(out), `offset ${off}: ${JSON.stringify(out)}`).toBe(false)
      expect(out.replace('![](n.sqlnb.assets/i.png)', '')).toBe(text)
      delete (document as any).caretPositionFromPoint
      w.unmount()
    }
  })
  it('a selection ending inside a pair is extended over it; one starting inside begins before it', async () => {
    const w = mk2('a😀b')
    await w.find('.md-view').trigger('dblclick'); await flush()
    const el = w.find('textarea').element as HTMLTextAreaElement
    el.setSelectionRange(2, 2)
    send(el, 'paste', fakeDt([file('a.png', 'image/png')])); await settle()
    expect(last(w)).toBe('a![](n.sqlnb.assets/i.png)😀b')
    w.unmount()
    const w2 = mk2('a😀b')
    await w2.find('.md-view').trigger('dblclick'); await flush()
    const el2 = w2.find('textarea').element as HTMLTextAreaElement
    el2.setSelectionRange(2, 3)
    send(el2, 'paste', fakeDt([file('a.png', 'image/png')])); await settle()
    expect(last(w2)).toBe('a![](n.sqlnb.assets/i.png)b')
    w2.unmount()
  })
})
