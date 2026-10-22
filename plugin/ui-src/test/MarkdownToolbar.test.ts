import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownToolbar from '../src/blocks/MarkdownToolbar.vue'
import { setLocale } from '../src/i18n'

const ORDER = ['heading', 'bold', 'italic', 'code', 'codeBlock', 'link', 'quote', 'ul', 'ol', 'table', 'image']
const mk = (composing = false) => mount(MarkdownToolbar, { props: { composing }, attachTo: document.body })
const btns = (w: ReturnType<typeof mk>) => w.findAll('button')
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = '' })

describe('MarkdownToolbar', () => {
  it('is a labelled horizontal toolbar with 11 named buttons in order', () => {
    const w = mk()
    const tb = w.find('[role="toolbar"]')
    expect(tb.attributes('aria-label')).toBe('Markdown 格式工具栏')
    expect(tb.attributes('aria-orientation')).toBe('horizontal')
    const bs = btns(w)
    expect(bs.map((b) => b.attributes('data-action'))).toEqual(ORDER)
    for (const b of bs) {
      expect(b.attributes('type')).toBe('button')
      expect(b.attributes('aria-label')).toBeTruthy()
      expect(b.attributes('aria-label')).toBe(b.attributes('title'))
      expect(b.find('svg').attributes('aria-hidden')).toBe('true')
      expect(b.find('svg').element.children.length).toBeGreaterThan(0)
    }
    w.unmount()
  })
  it('exactly one tabindex=0 (roving)', () => {
    const w = mk()
    expect(btns(w).filter((b) => b.attributes('tabindex') === '0')).toHaveLength(1)
    expect(btns(w)[0].attributes('tabindex')).toBe('0')
    w.unmount()
  })
  it('arrows, Home and End move focus and the roving index without wrapping', async () => {
    const w = mk()
    const bs = btns(w)
    bs[0].element.focus()
    key(bs[0].element, 'ArrowLeft'); await w.vm.$nextTick(); await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[0].element)
    key(document.activeElement!, 'ArrowRight'); await w.vm.$nextTick(); await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[1].element)
    expect(bs[1].attributes('tabindex')).toBe('0'); expect(bs[0].attributes('tabindex')).toBe('-1')
    key(document.activeElement!, 'End'); await w.vm.$nextTick(); await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[10].element)
    key(document.activeElement!, 'ArrowRight'); await w.vm.$nextTick(); await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[10].element)
    key(document.activeElement!, 'Home'); await w.vm.$nextTick(); await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[0].element)
    w.unmount()
  })
  it('modified arrows are left alone', async () => {
    const w = mk()
    const bs = btns(w)
    bs[0].element.focus()
    bs[0].element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true }))
    await w.vm.$nextTick()
    expect(document.activeElement).toBe(bs[0].element)
    w.unmount()
  })
  it('click emits action with the right name; image emits image', async () => {
    const w = mk()
    for (const b of btns(w)) await b.trigger('click')
    expect(w.emitted('action')!.map((a) => a[0])).toEqual(ORDER.filter((o) => o !== 'image'))
    expect(w.emitted('image')).toHaveLength(1)
    w.unmount()
  })
  it('Escape emits escape', async () => {
    const w = mk()
    key(btns(w)[2].element, 'Escape')
    expect(w.emitted('escape')).toHaveLength(1)
    w.unmount()
  })
  it('mousedown is default-prevented (focus stays in the textarea)', () => {
    const w = mk()
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    btns(w)[1].element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    w.unmount()
  })
  it('while composing: aria-disabled, no disabled attribute, nothing emitted', async () => {
    const w = mk(true)
    for (const b of btns(w)) {
      expect(b.attributes('aria-disabled')).toBe('true')
      expect(b.attributes('disabled')).toBeUndefined()
      await b.trigger('click')
    }
    expect(w.emitted('action')).toBeUndefined()
    expect(w.emitted('image')).toBeUndefined()
    await w.setProps({ composing: false })
    expect(btns(w)[0].attributes('aria-disabled')).toBeUndefined()
    w.unmount()
  })
  it('titles carry the shortcut for bold/italic/link (Ctrl on non-Mac)', () => {
    const w = mk()
    const by = (a: string) => w.find(`[data-action="${a}"]`).attributes('title')
    expect(by('bold')).toContain('Ctrl+B'); expect(by('italic')).toContain('Ctrl+I'); expect(by('link')).toContain('Ctrl+K')
    expect(by('code')).not.toContain('Ctrl')
    w.unmount()
  })
  it('shows ⌘ on macOS', () => {
    const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      const w = mk()
      expect(w.find('[data-action="bold"]').attributes('title')).toContain('⌘B')
      w.unmount()
    } finally { delete (navigator as any).platform; if (orig) Object.defineProperty(Navigator.prototype, 'platform', orig) }
  })
  it('focusActive focuses the roving button', () => {
    const w = mk()
    ;(w.vm as any).focusActive()
    expect(document.activeElement).toBe(btns(w)[0].element)
    w.unmount()
  })
})
