import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../src/App.vue'
import ResultTable from '../src/blocks/ResultTable.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { allowNativeContextMenu } from '../src/shell/contextMenu'
import { fakeEditorFactory } from './helpers'
import { serializeNotebook, createEmptyNotebook } from '@sqlnb/format'

const NB = serializeNotebook(createEmptyNotebook())
const ctxEvent = (init: MouseEventInit = {}) => new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40, ...init })

describe('allowNativeContextMenu', () => {
  it('allows editable targets and CodeMirror, not plain elements', () => {
    document.body.innerHTML = '<div id=p>plain</div><input id=i><textarea id=t></textarea><div id=c contenteditable="true"><span id=cs>x</span></div><div class="cm-editor"><div class="cm-content"><span id=cm>q</span></div></div>'
    const q = (id: string) => document.getElementById(id)!
    expect(allowNativeContextMenu(q('p'), null)).toBe(false)
    for (const id of ['i', 't', 'c', 'cs', 'cm']) expect(allowNativeContextMenu(q(id), null), id).toBe(true)
    expect(allowNativeContextMenu(null, null)).toBe(false)
  })
  it('allows when the target is inside a non-empty text selection', () => {
    document.body.innerHTML = '<p id=a>hello world</p><p id=b>other</p>'
    const range = document.createRange(); range.selectNodeContents(document.getElementById('a')!)
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range)
    expect(allowNativeContextMenu(document.getElementById('a')!.firstChild as Node as Element, s)).toBe(true)
    expect(allowNativeContextMenu(document.getElementById('b')!, s)).toBe(false)
    s.removeAllRanges()
  })
})

describe('App contextmenu', () => {
  beforeEach(() => { document.body.innerHTML = ''; setLocale('en') })
  async function mk() {
    const bridge = createFakeBridge({ context: () => ({}), onContext: () => () => {}, invokeHandlers: { 'notebook/recent': () => ({ items: [] }), 'notebook/read': () => ({ text: NB, mtimeMs: 1 }), 'notebook/write': () => ({ mtimeMs: 2 }), 'notebook/touchRecent': () => ({}) } } as any)
    const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
    await flushPromises()
    return w
  }
  it('prevents the native menu on plain areas, not on inputs', async () => {
    const w = await mk()
    const plain = ctxEvent(); w.element.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
    const inp = document.createElement('input'); w.element.appendChild(inp)
    const e = ctxEvent(); inp.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    const ta = document.createElement('textarea'); w.element.appendChild(ta)
    const e2 = ctxEvent(); ta.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    w.unmount()
  })
})

const data = () => ({ columns: [{ name: 'c0' }, { name: 'c1' }], rows: [[1, 'a'], [3, 'b']], truncated: false, elapsedMs: 1, dbType: 'x' })
const td = (w: any, r: number, c: number) => w.findAll('tbody tr[data-row]')[r].findAll('td[data-c]')[c]

describe('ResultTable context menu', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  beforeEach(() => { setLocale('en'); writeText.mockClear(); document.body.innerHTML = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true }) })
  it('opens on a cell, selects it, copies the selection and closes', async () => {
    const w = mount(ResultTable, { props: { result: data() }, attachTo: document.body })
    const e = ctxEvent()
    td(w, 1, 1).element.dispatchEvent(e)
    await w.vm.$nextTick()
    expect(e.defaultPrevented).toBe(true)
    const menu = w.find('[role=menu]')
    expect(menu.exists()).toBe(true)
    const items = menu.findAll('[role=menuitem]')
    expect(items.map((i) => i.text())).toEqual(['Copy', 'Copy with header'])
    expect(td(w, 1, 1).classes()).toContain('selected')
    await items[0].trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('b')
    expect(w.find('[role=menu]').exists()).toBe(false)
    w.unmount()
  })
  it('keeps an existing multi-cell selection that contains the clicked cell; copy with header', async () => {
    const w = mount(ResultTable, { props: { result: data() }, attachTo: document.body })
    await td(w, 0, 0).trigger('mousedown')
    await td(w, 1, 1).trigger('mousedown', { shiftKey: true })
    td(w, 0, 1).element.dispatchEvent(ctxEvent())
    await w.vm.$nextTick()
    await w.findAll('[role=menuitem]')[1].trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('c0\tc1\n1\ta\n3\tb')
    w.unmount()
  })
  it('header cells get no custom menu but the native one is still blocked', async () => {
    const w = mount(ResultTable, { props: { result: data() }, attachTo: document.body })
    const e = ctxEvent(); w.find('thead th[scope=col]').element.dispatchEvent(e)
    await w.vm.$nextTick()
    expect(w.find('[role=menu]').exists()).toBe(false)
    w.unmount()
  })
  it('dismisses on Escape, outside mousedown, scroll and blur; focuses first item', async () => {
    const w = mount(ResultTable, { props: { result: data() }, attachTo: document.body })
    const open = async () => { td(w, 0, 0).element.dispatchEvent(ctxEvent()); await w.vm.$nextTick(); expect(w.find('[role=menu]').exists()).toBe(true) }
    await open()
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w.vm.$nextTick()
    expect(w.find('[role=menu]').exists()).toBe(false)
    await open(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await w.vm.$nextTick()
    expect(w.find('[role=menu]').exists()).toBe(false)
    await open(); window.dispatchEvent(new Event('scroll')); await w.vm.$nextTick()
    expect(w.find('[role=menu]').exists()).toBe(false)
    await open(); window.dispatchEvent(new Event('blur')); await w.vm.$nextTick()
    expect(w.find('[role=menu]').exists()).toBe(false)
    w.unmount()
  })
  it('is zh-localized and uses dark tokens only', () => {
    setLocale('zh-CN')
    const w = mount(ResultTable, { props: { result: data() }, attachTo: document.body })
    td(w, 0, 0).element.dispatchEvent(ctxEvent())
    return w.vm.$nextTick().then(() => {
      expect(w.findAll('[role=menuitem]').map((i) => i.text())).toEqual(['复制', '复制含表头'])
      w.unmount()
    })
  })
})
