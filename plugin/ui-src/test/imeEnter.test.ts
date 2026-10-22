import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createImeGuard, IME_WINDOW_MS } from '../src/ui/imeEnter'
import ChatPane from '../src/ai/ChatPane.vue'
import ExportDialog from '../src/export/ExportDialog.vue'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import PathPrompt from '../src/shell/PathPrompt.vue'
import StartPage from '../src/shell/StartPage.vue'
import { setLocale } from '../src/i18n'

const kd = (init: KeyboardEventInit & { keyCode?: number }) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode })
  return e
}
const enter = (o: KeyboardEventInit = {}) => kd({ key: 'Enter', ...o })
const webkitCommit = (el: Element) => {
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  el.dispatchEvent(kd({ key: 'Process', keyCode: 229, isComposing: true }))
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
}

describe('createImeGuard', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })
  it('window constant', () => expect(IME_WINDOW_MS).toBe(50))
  it('plain Enter is not IME', () => expect(createImeGuard().isImeEnter(enter())).toBe(false))
  it('composing is IME', () => { const g = createImeGuard(); g.onCompositionStart(); expect(g.isImeEnter(enter())).toBe(true) })
  it('grace window after compositionend', () => {
    const g = createImeGuard(); g.onCompositionStart(); g.onCompositionEnd()
    expect(g.isImeEnter(enter())).toBe(true)
    vi.advanceTimersByTime(49); expect(g.isImeEnter(enter())).toBe(true)
    vi.advanceTimersByTime(2); expect(g.isImeEnter(enter())).toBe(false)
  })
  it('keyCode 229 / Process / isComposing', () => {
    const g = createImeGuard()
    expect(g.isImeEnter(enter({ keyCode: 229 } as any))).toBe(true)
    expect(g.isImeEnter(kd({ key: 'Process' }))).toBe(true)
    expect(g.isImeEnter(enter({ isComposing: true }))).toBe(true)
  })
})

describe('ChatPane IME Enter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  const mk = () => mount(ChatPane, { props: { messages: [], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p' }, attachTo: document.body })
  const type = async (w: any, v: string) => { const ta = w.find('textarea'); (ta.element as HTMLTextAreaElement).value = v; await ta.trigger('input') }

  it('(a)(b)(e) Chinese flow: IME-commit Enter not sent, real Enter after window sends once', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, '你好')
    webkitCommit(ta)
    ta.dispatchEvent(kd({ key: 'Enter', keyCode: 229, isComposing: false }))
    ta.dispatchEvent(enter())
    expect(w.emitted('send')).toBeUndefined()
    expect(ta.value).toBe('你好')
    vi.advanceTimersByTime(100)
    ta.dispatchEvent(enter())
    expect(w.emitted('send')).toEqual([['你好']])
    await w.vm.$nextTick()
    expect(ta.value).toBe('')
    w.unmount()
  })
  it('(c) plain Enter sends; Shift+Enter does not and is not prevented', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, 'hi')
    const sh = enter({ shiftKey: true }); ta.dispatchEvent(sh)
    expect(w.emitted('send')).toBeUndefined(); expect(sh.defaultPrevented).toBe(false)
    ta.dispatchEvent(enter()); expect(w.emitted('send')).toEqual([['hi']])
    w.unmount()
  })
  it('(d) Enter with isComposing not sent', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, 'hi'); ta.dispatchEvent(enter({ isComposing: true }))
    expect(w.emitted('send')).toBeUndefined(); w.unmount()
  })
})

describe('ExportDialog file-name IME Enter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  it('IME commit Enter does not export; later Enter does', () => {
    const sections: any[] = [{ kind: 'table', blockId: 'b1', columns: ['a'], rows: [], nullMask: [], totalRows: 1, shownRows: 1, limitedNote: null, groups: [{ cols: [] }], numeric: [], autoBreaks: [] }]
    const model: any = { title: '', exportedAt: '', runTimes: [], exporter: null, dataSources: [], note: '', sections, catalog: [], skipped: [], staleBlockIds: [], estimate: { totalRows: 1, bigTables: [] }, exportable: true }
    const w = mount(ExportDialog, { props: { model, browser: { found: true, path: '/c', checking: false }, busy: false, initialFolder: '/out', initialName: 'r.pdf' } as any, attachTo: document.body })
    const el = w.find('[data-test="file-name"]').element
    webkitCommit(el)
    el.dispatchEvent(kd({ key: 'Enter', keyCode: 229 }))
    expect(w.emitted('export')).toBeUndefined()
    vi.advanceTimersByTime(100)
    el.dispatchEvent(enter())
    expect(w.emitted('export')?.length).toBe(1)
    w.unmount()
  })
})

describe('MarkdownBlock IME Ctrl+Enter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  it('IME commit does not leave editing; later Ctrl+Enter does', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: 'x' }, attachTo: document.body })
    await w.find('.md-preview').trigger('dblclick')
    const el = w.find('textarea').element
    webkitCommit(el)
    el.dispatchEvent(enter({ ctrlKey: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('textarea').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    el.dispatchEvent(enter({ ctrlKey: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('textarea').exists()).toBe(false)
    w.unmount()
  })
})

describe('PathPrompt IME Enter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  it('IME commit Enter is default-prevented (no implicit submit); later Enter is left to the form', () => {
    const w = mount(PathPrompt, { props: { open: true, initial: '/a' }, attachTo: document.body })
    const el = w.find('[data-test="path-input"]').element
    webkitCommit(el)
    const e1 = kd({ key: 'Enter', keyCode: 229 }); el.dispatchEvent(e1)
    expect(e1.defaultPrevented).toBe(true)
    vi.advanceTimersByTime(100)
    const e2 = enter(); el.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    w.unmount()
  })
})

describe('StartPage path form IME Enter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  const mk = () => mount(StartPage, { props: { recent: [], hasSidecar: true }, attachTo: document.body })
  it('IME commit Enter prevented (no implicit submit); real Enter not prevented; button submits', async () => {
    const w = mk()
    const el = w.find('.sp-path input').element as HTMLInputElement
    await w.find('.sp-path input').setValue('/tmp/半')
    webkitCommit(el)
    const e1 = kd({ key: 'Enter', keyCode: 229 }); el.dispatchEvent(e1)
    expect(e1.defaultPrevented).toBe(true)
    expect(w.emitted('openPath')).toBeUndefined()
    vi.advanceTimersByTime(100)
    const e2 = enter(); el.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    await w.find('[data-test="open-path"]').trigger('click')
    expect(w.emitted('openPath')).toEqual([['/tmp/半']])
    w.unmount()
  })
})

describe('guard robustness', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }); setLocale('zh-CN') })
  afterEach(() => { vi.useRealTimers() })
  const mk = () => mount(ChatPane, { props: { messages: [], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p' }, attachTo: document.body })
  const type = async (w: any, v: string) => { const ta = w.find('textarea'); (ta.element as HTMLTextAreaElement).value = v; await ta.trigger('input') }
  it('guard: blur without compositionend resets composing', () => {
    const g = createImeGuard(); g.onCompositionStart(); g.onReset(); vi.advanceTimersByTime(100)
    expect(g.isImeEnter(enter())).toBe(false)
  })
  it('ChatPane: blur mid-composition then normal Enter sends', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, 'hi')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await w.find('textarea').trigger('blur')
    ta.dispatchEvent(enter()); expect(w.emitted('send')).toEqual([['hi']]); w.unmount()
  })
  it('ChatPane: compositioncancel resets', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, 'hi')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ta.dispatchEvent(new CompositionEvent('compositioncancel', { bubbles: true }))
    vi.advanceTimersByTime(100)
    ta.dispatchEvent(enter()); expect(w.emitted('send')).toEqual([['hi']]); w.unmount()
  })
  it('ChatPane: 229 Enter 80ms after compositionend still swallowed', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, '你好'); webkitCommit(ta); vi.advanceTimersByTime(80)
    ta.dispatchEvent(kd({ key: 'Enter', keyCode: 229 }))
    expect(w.emitted('send')).toBeUndefined(); w.unmount()
  })
  it('ChatPane: keyCode 13 Enter 60ms after compositionend sends', async () => {
    const w = mk(); const ta = w.find('textarea').element as HTMLTextAreaElement
    await type(w, '你好'); webkitCommit(ta); vi.advanceTimersByTime(60)
    ta.dispatchEvent(kd({ key: 'Enter', keyCode: 13 }))
    expect(w.emitted('send')).toEqual([['你好']]); w.unmount()
  })
})
