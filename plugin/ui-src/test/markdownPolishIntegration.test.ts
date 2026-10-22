import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import MarkdownMessage from '../src/ai/MarkdownMessage.vue'
import AiDrawer from '../src/ai/AiDrawer.vue'
import { renderExportHtml } from '../src/export/html'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'

const SRC = '# Title\n\n> outer\n>\n> > inner\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n'
const wrappers: { unmount(): void }[] = []
afterEach(() => { wrappers.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
const mdStyles = () => Array.from(document.head.querySelectorAll('style[data-md-css]'))

describe('markdown polish integration', () => {
  it('installs D v2 preview styles once across several Markdown blocks', () => {
    for (let i = 0; i < 3; i++) wrappers.push(mount(MarkdownBlock, { props: { modelValue: SRC }, attachTo: document.body }))
    expect(mdStyles().length).toBe(1)
    expect(mdStyles()[0].textContent).toContain('.md-view h1{')
  })

  it('edit → preview round trip keeps content; Ctrl+Enter returns', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: SRC }, attachTo: document.body })
    wrappers.push(w)
    await w.find('.md-preview').trigger('dblclick'); await flushPromises()
    const ta = w.find('textarea')
    expect(ta.exists()).toBe(true)
    expect((ta.element as HTMLTextAreaElement).value).toBe(SRC)
    await ta.trigger('keydown', { key: 'Enter', ctrlKey: true }); await flushPromises()
    expect(w.find('textarea').exists()).toBe(false)
    const pv = w.find('.md-view')
    expect(pv.find('h1').text()).toBe('Title')
    expect(pv.findAll('blockquote').length).toBe(2)
    expect(pv.find('table').exists()).toBe(true)
  })

  it('AI drawer backdrop press+release closes via the same path; dirty asks first', async () => {
    const mk = (dirty: boolean) => {
      const w = mount(AiDrawer, { props: { title: 'T', dirty, busy: false }, slots: { left: '<span>L</span>', chat: '<span>C</span>' }, attachTo: document.body })
      wrappers.push(w)
      return w
    }
    const press = async (w: any) => { const b = w.find('.dr-backdrop'); await b.trigger('mousedown'); await b.trigger('mouseup'); await b.trigger('click') }
    const clean = mk(false); await press(clean)
    expect(clean.emitted('close')?.length).toBe(1)
    const dirty = mk(true); await press(dirty)
    expect(dirty.emitted('close')).toBeFalsy()
    ;(document.querySelector('[data-test=cd-discard]') as HTMLElement).click(); await flushPromises()
    expect(dirty.emitted('close')?.length).toBe(1)
  })

  it('chat Markdown bubbles stay compact: md-view styles are scoped and do not leak', () => {
    wrappers.push(mount(MarkdownBlock, { props: { modelValue: SRC }, attachTo: document.body }))
    const chat = mount(MarkdownMessage, { props: { text: '# Head\n\n> q' }, attachTo: document.body })
    wrappers.push(chat)
    const el = chat.find('[data-test=chat-md]').element
    expect(el.classList.contains('md-view')).toBe(false)
    expect(el.closest('.md-view')).toBeNull()
    const css = mdStyles()[0].textContent!
    const selectors = css.split('\n').filter(Boolean)
    expect(selectors.every((l: string) => l.startsWith('.md-view'))).toBe(true)
    for (const sel of ['h1', 'blockquote', 'table']) {
      expect(el.querySelector(sel) === null || !(el.matches('.md-view *'))).toBe(true)
    }
    expect(css).not.toMatch(/(^|[\s,}])\.md[\s{]/)
  })

  it('exported HTML contains the D v2 rules and the rendered table/blockquote', () => {
    const model: any = {
      documentTitle: 'T', exportedAt: '2026-10-18T00:00:00.000Z', runTimes: [], exporter: null, dataSources: [], note: '',
      sections: [{ kind: 'markdown', blockId: 'm', source: SRC }], catalog: [], skipped: [], staleBlockIds: [],
      estimate: { totalRows: 0, bigTables: [] }, exportable: true,
    }
    const labels: any = new Proxy({}, { get: () => () => '' })
    const h = renderExportHtml(model, DEFAULT_EXPORT_OPTIONS, {}, labels)
    const doc = new DOMParser().parseFromString(h, 'text/html')
    expect(h).toContain('.md h1{')
    expect(doc.querySelectorAll('.md blockquote blockquote').length).toBe(1)
    expect(doc.querySelector('.md table th')).not.toBeNull()
  })
})
