import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import sfc from '../src/blocks/MarkdownBlock.vue?raw'
import { setLocale } from '../src/i18n'

describe('MarkdownBlock', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('renders markdown and sanitizes', () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '# Hi\n\n<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1)) [ok](https://a.com) https://b.com' } })
    const h = w.html()
    expect(h).toContain('<h1>Hi</h1>')
    // raw HTML is escaped to inert text, never parsed into elements
    expect(w.find('script').exists()).toBe(false)
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('[onerror]').exists()).toBe(false)
    expect(w.findAll('a').some(x => x.attributes('href')?.startsWith('javascript:'))).toBe(false)
    const a = w.findAll('a').filter(x => x.attributes('href')?.startsWith('https://'))
    expect(a.length).toBe(2)
    for (const l of a) {
      expect(l.attributes('target')).toBe('_blank')
      expect(l.attributes('rel')).toBe('noopener noreferrer')
    }
  })
  it('dblclick edits, input emits, blur returns', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: 'hello' }, attachTo: document.body })
    expect(w.find('textarea').exists()).toBe(false)
    await w.find('.md-preview').trigger('dblclick')
    const ta = w.find('textarea')
    expect(ta.exists()).toBe(true)
    expect(document.activeElement).toBe(ta.element)
    await ta.setValue('new')
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual(['new'])
    await ta.trigger('blur')
    expect(w.find('textarea').exists()).toBe(false)
    await w.find('.md-preview').trigger('dblclick')
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(w.find('textarea').exists()).toBe(false)
    w.unmount()
  })
  it('empty content is in edit mode with placeholder', () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '' } })
    expect(w.find('textarea').attributes('placeholder')).toBeTruthy()
    expect(w.find('textarea').attributes('placeholder')).toContain('Markdown')
  })
  it('drops remote images, keeps alt/url text', () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '![alt text](http://example.com/x.png)\n\n![](https://t.example/p.gif)' } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('alt text')
    expect(w.text()).toContain('https://t.example/p.gif')
  })
  it('keeps data:image images', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo='
    const w = mount(MarkdownBlock, { props: { modelValue: `![d](${src})` } })
    expect(w.find('img').attributes('src')).toBe(src)
  })
  describe('empty content', () => {
    for (const empty of ['', '  \n\t\n']) {
      it(`preview with hint is editable via click/dblclick/Enter for ${JSON.stringify(empty)}`, async () => {
        for (const how of ['click', 'dblclick', 'enter']) {
          const w = mount(MarkdownBlock, { props: { modelValue: empty }, attachTo: document.body })
          await w.find('textarea').trigger('blur')
          const pv = w.find('.md-preview')
          expect(pv.exists()).toBe(true)
          expect(pv.text()).toContain('双击或点击以编辑 Markdown')
          expect(pv.attributes('tabindex')).toBe('0')
          expect(w.html()).not.toContain('<script')
          if (how === 'enter') await pv.trigger('keydown', { key: 'Enter' })
          else await pv.trigger(how)
          expect(w.find('textarea').exists()).toBe(true)
          expect(w.emitted('update:modelValue')).toBeUndefined()
          w.unmount()
        }
      })
    }
    it('whitespace-only starts in edit mode', () => {
      const w = mount(MarkdownBlock, { props: { modelValue: ' \n ' } })
      expect(w.find('textarea').exists()).toBe(true)
    })
    it('non-empty preview has no hint and click does not edit', async () => {
      const w = mount(MarkdownBlock, { props: { modelValue: 'hello' } })
      expect(w.find('.md-preview').text()).not.toContain('双击或点击')
      await w.find('.md-preview').trigger('click')
      expect(w.find('textarea').exists()).toBe(false)
    })
  })
  describe('a11y', () => {
    it('empty preview is a labelled button; Space activates', async () => {
      const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
      await w.find('textarea').trigger('blur')
      const pv = w.find('.md-preview')
      expect(pv.attributes('role')).toBe('button')
      expect(pv.attributes('aria-label')).toBe('双击或点击以编辑 Markdown')
      await pv.trigger('keydown', { key: ' ' })
      expect(w.find('textarea').exists()).toBe(true)
      w.unmount()
    })
    async function editThenLeave(how: (w: any) => Promise<void>) {
      const sib = document.createElement('button')
      document.body.appendChild(sib)
      const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
      await flushPromises()
      expect(document.activeElement).toBe(w.find('textarea').element)
      await how(w)
      await flushPromises()
      await new Promise((r) => setTimeout(r, 0))
      return { w, sib }
    }
    it('blur to a sibling does not steal focus back', async () => {
      const { w, sib } = await editThenLeave(async (w) => { document.querySelector('button')!.focus(); await w.find('textarea').trigger('blur') })
      expect(document.activeElement).toBe(sib)
      w.unmount(); sib.remove()
    })
    it('Tab-out blur does not refocus preview', async () => {
      const { w, sib } = await editThenLeave(async (w) => { await w.find('textarea').trigger('blur') })
      expect(document.activeElement).not.toBe(w.find('.md-preview').element)
      w.unmount(); sib.remove()
    })
    for (const ev of [{ key: 'Escape' }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }]) {
      it(`${JSON.stringify(ev)} refocuses preview`, async () => {
        const { w, sib } = await editThenLeave(async (w) => { await w.find('textarea').trigger('keydown', ev) })
        expect(document.activeElement).toBe(w.find('.md-preview').element)
        w.unmount(); sib.remove()
      })
    }
    it('initial mount in edit mode focuses textarea, not preview', async () => {
      const w = mount(MarkdownBlock, { props: { modelValue: 'hi' }, attachTo: document.body })
      await flushPromises()
      expect(document.activeElement).not.toBe(w.find('.md-preview').element)
      w.unmount()
    })
  })
})

describe('MarkdownBlock D v2 preview', () => {
  it('preview has class md-view; empty-state and textarea do not', () => {
    expect(mount(MarkdownBlock, { props: { modelValue: '# a' } }).find('.md-preview').classes()).toContain('md-view')
    expect(mount(MarkdownBlock, { props: { modelValue: '' } }).find('.md-view').exists()).toBe(false)
  })
  it('renders nested lists, aligned table, nested blockquote, h1-h6', () => {
    const src = '# a\n## b\n### c\n#### d\n##### e\n###### f\n\n- x\n  - y\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\n> q\n>> n\n'
    const w = mount(MarkdownBlock, { props: { modelValue: src } })
    const h = w.find('.md-view').html()
    for (let i = 1; i <= 6; i++) expect(h).toContain(`<h${i}>`)
    expect(h).toMatch(/<ul>\s*<li>x\s*<ul>/)
    expect(h).toMatch(/style="text-align:right"/)
    expect(h).toMatch(/<blockquote>[\s\S]*<blockquote>/)
  })
  it('installs the scoped stylesheet', () => {
    mount(MarkdownBlock, { props: { modelValue: 'x' } })
    expect(document.head.querySelectorAll('style[data-md-css]').length).toBe(1)
  })
  it('still strips script/javascript links', () => {
    const h = mount(MarkdownBlock, { props: { modelValue: '<script>alert(1)</script>[x](javascript:alert(1))' } }).find('.md-view').html()
    expect(h).not.toContain('<script')
    const d = document.createElement('div'); d.innerHTML = h
    expect(Array.from(d.querySelectorAll("a")).filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') ?? ''))).toEqual([])
  })
  describe('edit height equals preview height', () => {
    let scrollH = 0
    let previewH = 0
    let orig: PropertyDescriptor | undefined
    let origRect: typeof Element.prototype.getBoundingClientRect
    beforeEach(() => {
      scrollH = 0; previewH = 0
      orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return scrollH } })
      origRect = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const h = this.classList.contains('md-preview') ? previewH : 0
        return { height: h, width: 300, top: 0, left: 0, right: 300, bottom: h, x: 0, y: 0, toJSON() {} } as DOMRect
      }
    })
    afterEach(() => {
      if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', orig); else delete (HTMLElement.prototype as any).scrollHeight
      Element.prototype.getBoundingClientRect = origRect
    })
    const h = (w: any) => (w.find('textarea').element as HTMLTextAreaElement).style.height
    const withBorder = (w: any, n: number) => {
      const cs = getComputedStyle(w.find('textarea').element)
      return `${n + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)}px`
    }
    it('edit() sets textarea height to the preview measured height', async () => {
      previewH = 412.5; scrollH = 60
      const w = mount(MarkdownBlock, { props: { modelValue: '# a\n\nb' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      expect(h(w)).toBe('412.5px')
      w.unmount()
    })
    it('height has a floor of 32px for tiny content', async () => {
      previewH = 10; scrollH = 5
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      expect(h(w)).toBe('32px')
      w.unmount()
    })
    it('input grows textarea to scrollHeight; overflow hidden, no resize handle', async () => {
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      scrollH = 200
      await w.find('textarea').setValue('x\n'.repeat(9))
      expect(h(w)).toBe(withBorder(w, 200))
      w.unmount()
    })
    it('restores the scroll position of ancestors clamped while measuring', async () => {
      previewH = 50
      const host = document.createElement('div')
      let top = 700
      Object.defineProperty(host, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
      document.body.appendChild(host)
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: host })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      const el = w.find('textarea').element as HTMLTextAreaElement
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get() { top = 0; return scrollH } })
      scrollH = 300; await w.find('textarea').setValue('long')
      expect(top).toBe(700)
      w.unmount(); host.remove()
    })
    it('never shrinks below the preview height; grows for taller text; deleting returns to the start height', async () => {
      previewH = 500
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      expect(h(w)).toBe('500px')
      scrollH = 40; await w.find('textarea').setValue('short')
      expect(h(w)).toBe('500px')
      scrollH = 900; await w.find('textarea').setValue('tall')
      expect(h(w)).toBe(withBorder(w, 900))
      scrollH = 120; await w.find('textarea').setValue('s')
      expect(h(w)).toBe('500px')
      w.unmount()
    })
    it('width change while pristine keeps the preview height floor', async () => {
      previewH = 500
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      scrollH = 60
      window.dispatchEvent(new Event('resize')); await flushPromises()
      expect(h(w)).toBe('500px')
      w.unmount()
    })
    it('trailing newline grows by one line', async () => {
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      scrollH = 60; await w.find('textarea').setValue('a')
      expect(h(w)).toBe(withBorder(w, 60))
      scrollH = 84; await w.find('textarea').setValue('a\n')
      expect(h(w)).toBe(withBorder(w, 84))
      w.unmount()
    })
    it('empty placeholder preview → edit keeps the placeholder height (>= 32)', async () => {
      const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
      await w.find('textarea').trigger('blur')
      previewH = 34; scrollH = 20
      await w.find('.md-preview').trigger('click'); await flushPromises()
      expect(h(w)).toBe('34px')
      w.unmount()
    })
    it('initially empty block (no preview to measure) is at least 32px', async () => {
      scrollH = 10
      const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
      await flushPromises()
      expect(h(w)).toBe('32px')
      w.unmount()
    })
    it('resize event refits while editing', async () => {
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      scrollH = 150
      window.dispatchEvent(new Event('resize')); await flushPromises()
      expect(h(w)).toBe(withBorder(w, 150))
      w.unmount()
    })
    it('external value change refits', async () => {
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      scrollH = 120
      await w.setProps({ modelValue: 'a\nb\nc' }); await flushPromises()
      expect(h(w)).toBe(withBorder(w, 120))
      w.unmount()
    })
    it('fonts.ready refit applies only to the current editing session', async () => {
      let resolve!: () => void
      const fonts = { ready: new Promise<void>((r) => { resolve = r }) }
      Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      await w.find('textarea').trigger('blur'); await flushPromises()
      let reads = 0
      const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => { reads++; return 0 })
      resolve(); await flushPromises()
      expect(w.find('textarea').exists()).toBe(false)
      expect(reads).toBe(0)
      spy.mockRestore()
      delete (document as any).fonts
      w.unmount()
    })
    it('unmount removes the resize listener', async () => {
      const spy = vi.spyOn(window, 'removeEventListener')
      previewH = 50
      const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
      await w.find('.md-preview').trigger('dblclick'); await flushPromises()
      w.unmount()
      expect(spy.mock.calls.some((c) => c[0] === 'resize')).toBe(true)
      spy.mockRestore()
    })
    it('source style (jsdom cannot compute shorthands; real computed metrics are asserted by smoke:markdown): textarea and .md-preview share box metrics', () => {
      const css = sfc.slice(sfc.indexOf('<style'))
      const rule = (sel: string) => new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}').exec(css)![1]
      const ed = rule('.md-editor'), pv = rule('.md-preview')
      for (const prop of ['padding', 'border', 'line-height', 'font-size']) {
        const get = (r: string) => new RegExp('(?:^|[;\\s])' + prop + ':\\s*([^;]+)').exec(r)?.[1].trim()
        expect(get(ed), prop).toBeDefined()
        const e = get(ed)!.replace(/solid .*/, '').trim(), p = get(pv)!.replace(/solid .*/, '').replace(/transparent/, '').trim()
        expect(e.replace(/\s+/g, ' ')).toBe(p.replace(/\s+/g, ' '))
      }
      expect(ed).toMatch(/overflow:\s*hidden/)
      expect(ed).toMatch(/resize:\s*none/)
      expect(ed).toMatch(/box-sizing:\s*border-box/)
      expect(pv).toMatch(/box-sizing:\s*border-box/)
      expect(css).not.toMatch(/min-height:\s*80px/)
    })
  })
})
