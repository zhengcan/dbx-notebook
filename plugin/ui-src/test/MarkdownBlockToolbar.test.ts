import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import { BridgeKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { useNotebookStore } from '../src/state/notebookStore'
import { createHistoryActions } from '../src/shell/historyActions'
import { changedSpan } from '../src/markdown/toolbarActions'

function setup(content: string, o: { toolbarImage?: () => void } = {}) {
  const store = useNotebookStore()
  const nb: any = createEmptyNotebook()
  nb.blocks = [{ id: 'm1', type: 'markdown', content }]
  store.load(serializeNotebook(nb), '/n/a.sqlnb', 1)
  const Host = defineComponent({
    render: () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', toolbarImage: o.toolbarImage, 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }),
  })
  const w = mount(Host, { global: { provide: { [StoreKey as symbol]: store, [BridgeKey as symbol]: { invoke: vi.fn(async () => ({})) } } }, attachTo: document.body })
  return { w, store, text: () => store.nb.value.blocks[0].content as string }
}
const tick = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 0)); await flushPromises() }
async function edit(w: ReturnType<typeof setup>['w']) {
  await w.find('.md-view, .md-empty').trigger('dblclick'); await tick()
  return w.find('textarea').element as HTMLTextAreaElement
}
const select = (ta: HTMLTextAreaElement, a: number, b = a) => { ta.focus(); ta.setSelectionRange(a, b) }
const press = (ta: HTMLElement, init: KeyboardEventInit) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); ta.dispatchEvent(e); return e }
const btn = (w: any, a: string) => w.find(`[data-action="${a}"]`)

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = '' })

describe('MarkdownBlock toolbar', () => {
  it('is absent in preview and in the empty-state until editing; present in edit mode above the textarea', async () => {
    const { w } = setup('hello')
    expect(w.find('[role="toolbar"]').exists()).toBe(false)
    const ta = await edit(w)
    const tb = w.find('[role="toolbar"]')
    expect(tb.exists()).toBe(true)
    expect(tb.element.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    w.unmount()
    const e = setup('')
    expect(e.w.find('.md-editor').exists()).toBe(true)
    e.w.unmount()
    const p = setup('x')
    expect(p.w.find('[role="toolbar"]').exists()).toBe(false)
    p.w.unmount()
  })
  it('mousedown on a button keeps focus in the textarea and the block stays in edit mode', async () => {
    const { w } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    btn(w, 'bold').element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(ta)
    await tick()
    expect(w.find('.md-editor').exists()).toBe(true)
    w.unmount()
  })
  it('Bold on a selection rewrites the text, restores the selection and is one undo step', async () => {
    const { w, store, text } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    await btn(w, 'bold').trigger('click'); await tick()
    expect(text()).toBe('**hello**')
    expect(ta.value).toBe('**hello**')
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 7])
    expect(document.activeElement).toBe(ta)
    expect(store.history.undoDepth.value).toBe(1)
    expect(store.history.lastLabel.value).toBe('history.label.mdFormat')
    w.unmount()
  })
  it('two actions are two steps; each undoes alone, redo reapplies', async () => {
    const { w, store, text } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    await btn(w, 'italic').trigger('click'); await tick()
    await btn(w, 'bold').trigger('click'); await tick()
    expect(text()).toBe('***hello***')
    expect(store.history.undoDepth.value).toBe(2)
    const h = createHistoryActions(store)
    h.undo(); await tick()
    expect(text()).toBe('*hello*')
    h.undo(); await tick()
    expect(text()).toBe('hello')
    h.redo(); await tick()
    expect(text()).toBe('*hello*')
    w.unmount()
  })
  it('after undo the caret is at the end of the changed span', async () => {
    const { w, store, text } = setup('ab cd ef')
    const ta = await edit(w)
    select(ta, 3, 5)
    await btn(w, 'bold').trigger('click'); await tick()
    expect(text()).toBe('ab **cd** ef')
    const before = text()
    createHistoryActions(store).undo(); await tick()
    expect(ta.value).toBe('ab cd ef')
    const to = changedSpan(before, 'ab cd ef').to
    expect(to).toBe(5)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([to, to])
    w.unmount()
  })
  it.each([
    [{ code: 'KeyB', key: 'b' }, '**hello**'],
    [{ code: 'KeyI', key: 'i' }, '*hello*'],
    [{ code: 'KeyK', key: 'k' }, '[hello](https://)'],
    [{ code: 'KeyB', key: 'и' }, '**hello**'],
  ])('Ctrl+%j applies the action and is consumed', async (init, out) => {
    const { w, text } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    const bubbled = vi.fn(); document.addEventListener('keydown', bubbled)
    const e = press(ta, { ...init, ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    await tick()
    expect(bubbled).not.toHaveBeenCalled()
    document.removeEventListener('keydown', bubbled)
    expect(text()).toBe(out)
    w.unmount()
  })
  it('Shift/Alt/Meta variants, plain B and Ctrl+Z do nothing here', async () => {
    const { w, text, store } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    for (const init of [{ shiftKey: true, ctrlKey: true, code: 'KeyB' }, { altKey: true, ctrlKey: true, code: 'KeyB' }, { metaKey: true, code: 'KeyB' }, { ctrlKey: true, code: 'KeyZ', key: 'z' }, { code: 'KeyB' }, { ctrlKey: true, metaKey: true, code: 'KeyB' }]) {
      expect(press(ta, init).defaultPrevented).toBe(false)
    }
    await tick()
    expect(text()).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    w.unmount()
  })
  it('a held key (repeat) is consumed but does not run the action again', async () => {
    const { w, text, store } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    const bubbled = vi.fn(); document.addEventListener('keydown', bubbled)
    const e = press(ta, { code: 'KeyB', ctrlKey: true, repeat: true })
    await tick()
    document.removeEventListener('keydown', bubbled)
    expect(e.defaultPrevented).toBe(true)
    expect(bubbled).not.toHaveBeenCalled()
    expect(text()).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    w.unmount()
  })
  it.each([
    ['zh-CN', { bold: '**粗体文字**', italic: '*斜体文字*', code: '`代码`', link: '[链接文字](https://)' }],
    ['en', { bold: '**bold text**', italic: '*italic text*', code: '`code`', link: '[link text](https://)' }],
  ])('empty selection placeholders (%s) come from i18n', async (loc, want) => {
    setLocale(loc)
    for (const [a, out] of Object.entries(want)) {
      const { w, text } = setup('')
      const ta = w.find('textarea').element as HTMLTextAreaElement
      ta.focus()
      await btn(w, a).trigger('click'); await tick()
      expect(text(), `${loc} ${a}`).toBe(out)
      w.unmount()
    }
  })
  it('does not apply the old selection when the block no longer holds the written text', async () => {
    const { w, store } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    const spy = vi.spyOn(ta, 'setSelectionRange')
    const orig = store.replaceMarkdown
    ;(store as any).replaceMarkdown = () => { store.nb.value.blocks[0].content = 'other' }
    await btn(w, 'bold').trigger('click'); await tick()
    expect(spy).not.toHaveBeenCalled()
    ;(store as any).replaceMarkdown = orig
    w.unmount()
  })
  it('does not apply the old selection when replaceMarkdown silently refused the write', async () => {
    const { w, store } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    const spy = vi.spyOn(ta, 'setSelectionRange')
    ;(store as any).replaceMarkdown = () => {}
    await btn(w, 'bold').trigger('click'); await tick()
    expect(spy).not.toHaveBeenCalled()
    w.unmount()
  })
  it('on macOS Cmd is the modifier and Ctrl+B is left to the browser', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      const { w, text } = setup('hello')
      const ta = await edit(w)
      select(ta, 0, 5)
      expect(press(ta, { code: 'KeyB', ctrlKey: true }).defaultPrevented).toBe(false)
      expect(press(ta, { code: 'KeyB', metaKey: true }).defaultPrevented).toBe(true)
      await tick()
      expect(text()).toBe('**hello**')
      w.unmount()
    } finally { delete (navigator as any).platform }
  })
  it('composition: shortcuts and buttons do nothing and the draft is intact', async () => {
    const { w, text, store } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await tick()
    expect(press(ta, { code: 'KeyB', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(btn(w, 'bold').attributes('aria-disabled')).toBe('true')
    await btn(w, 'bold').trigger('click'); await tick()
    expect(text()).toBe('hello'); expect(ta.value).toBe('hello')
    expect(store.history.undoDepth.value).toBe(0)
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await tick()
    expect(btn(w, 'bold').attributes('aria-disabled')).toBeUndefined()
    w.unmount()
  })
  it('an action event arriving during composition is ignored by the block itself', async () => {
    const { w, text } = setup('hello')
    const ta = await edit(w)
    select(ta, 0, 5)
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await tick()
    w.findComponent({ name: 'MarkdownToolbar' }).vm.$emit('action', 'bold')
    await tick()
    expect(text()).toBe('hello')
    w.unmount()
  })
  it('Shift+Tab path: focus in the toolbar keeps edit mode; Tab order puts the toolbar before the textarea', async () => {
    const { w } = setup('hello')
    const ta = await edit(w)
    ;(w.findComponent({ name: 'MarkdownToolbar' }).vm as any).focusActive()
    expect(document.activeElement).toBe(btn(w, 'heading').element)
    await tick()
    expect(w.find('.md-editor').exists()).toBe(true)
    // the only tabbable toolbar stop is the active button, immediately before the textarea in DOM order
    const stops = Array.from(document.querySelectorAll<HTMLElement>('button, textarea')).filter((e) => e.tabIndex >= 0)
    expect(stops.indexOf(ta)).toBe(stops.indexOf(btn(w, 'heading').element as HTMLElement) + 1)
    w.unmount()
  })
  it('Esc in the toolbar returns focus to the textarea with the selection kept, still editing', async () => {
    const { w } = setup('hello')
    const ta = await edit(w)
    select(ta, 1, 3)
    ;(w.findComponent({ name: 'MarkdownToolbar' }).vm as any).focusActive()
    press(btn(w, 'heading').element as HTMLElement, { key: 'Escape' })
    await tick()
    expect(document.activeElement).toBe(ta)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 3])
    expect(w.find('.md-editor').exists()).toBe(true)
    w.unmount()
  })
  it('focus moving from the toolbar to the outside leaves edit mode; window deactivation does not', async () => {
    const out = document.createElement('button'); document.body.appendChild(out)
    const { w } = setup('hello')
    await edit(w)
    const tbc = w.findComponent({ name: 'MarkdownToolbar' })
    ;(tbc.vm as any).focusActive()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    btn(w, 'heading').element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await tick()
    expect(w.find('.md-editor').exists()).toBe(true)
    vi.mocked(document.hasFocus).mockReturnValue(true)
    btn(w, 'heading').element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: out }))
    await tick()
    expect(w.find('.md-editor').exists()).toBe(false)
    vi.restoreAllMocks()
    w.unmount()
  })
  it('textarea blur: into the toolbar keeps edit mode, outside leaves, window deactivation keeps', async () => {
    const out = document.createElement('button'); document.body.appendChild(out)
    const { w } = setup('hello')
    const ta = await edit(w)
    ta.dispatchEvent(new FocusEvent('blur', { relatedTarget: btn(w, 'bold').element }))
    await tick()
    expect(w.find('.md-editor').exists()).toBe(true)
    ta.dispatchEvent(new FocusEvent('blur', { relatedTarget: out }))
    await tick()
    expect(w.find('.md-editor').exists()).toBe(false)
    w.unmount()
  })
  it('table placeholders come from i18n: no Chinese header in the English UI', async () => {
    setLocale('en')
    const { w, text } = setup('')
    const ta = w.find('textarea').element as HTMLTextAreaElement
    ta.focus()
    await btn(w, 'table').trigger('click'); await tick()
    expect(text()).toContain('Column 1')
    expect(text()).toContain('Column 2')
    expect(text()).not.toMatch(/[\u3400-\u9fff]/)
    w.unmount()
    const b = setup('')
    const tb = b.w.find('textarea').element as HTMLTextAreaElement
    tb.focus()
    await btn(b.w, 'bold').trigger('click'); await tick()
    expect(b.text()).toBe('**bold text**')
    b.w.unmount()
  })
  it('the image button calls the injected handler (default: nothing)', async () => {
    const fn = vi.fn()
    const a = setup('hello', { toolbarImage: fn })
    await edit(a.w)
    await btn(a.w, 'image').trigger('click')
    expect(fn).toHaveBeenCalledTimes(1)
    a.w.unmount()
    const b = setup('hello')
    await edit(b.w)
    await btn(b.w, 'image').trigger('click')
    expect(b.text()).toBe('hello')
    b.w.unmount()
  })
  it('textarea height equals the preview height recorded on entering edit mode', async () => {
    const { w } = setup('hello')
    const pv = w.find('.md-view').element as HTMLElement
    pv.getBoundingClientRect = () => ({ height: 120, width: 100, top: 0, left: 0, right: 100, bottom: 120, x: 0, y: 0, toJSON() {} }) as DOMRect
    const ta = await edit(w)
    expect(parseFloat(ta.style.height)).toBeGreaterThanOrEqual(120)
    w.unmount()
  })
  it('without a store it falls back to update:modelValue', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: 'hello' }, attachTo: document.body })
    await w.find('.md-view').trigger('dblclick'); await tick()
    const ta = w.find('textarea').element as HTMLTextAreaElement
    select(ta, 0, 5)
    await btn(w, 'bold').trigger('click')
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual(['**hello**'])
    w.unmount()
  })
})
