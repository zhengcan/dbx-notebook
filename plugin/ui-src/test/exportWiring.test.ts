import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as modelMod from '../src/export/model'
import { mount, flushPromises } from '@vue/test-utils'
import { serializeNotebook, createEmptyNotebook } from '@sqlnb/format'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { notebookKey } from '../src/export/exportSettings'

const NB = serializeNotebook(createEmptyNotebook())

async function setup(opts: { storage?: Record<string, unknown>; browser?: any; extra?: Record<string, any>; clock?: () => Date } = {}) {
  setLocale('en')
  const bridge = createFakeBridge({
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: NB, mtimeMs: 1 }),
      'notebook/write': () => ({ mtimeMs: 2 }),
      'notebook/touchRecent': () => ({}),
      'export/browserStatus': () => opts.browser ?? { found: true, path: '/Applications/Chrome', source: 'auto' },
      'export/pickFolder': () => ({ path: '/o' }),
      'export/saveHtml': () => ({ path: '/o/r.html', bytes: 5 }),
      ...opts.extra,
    },
  } as any)
  for (const [k, v] of Object.entries(opts.storage ?? {})) await bridge.storageSet(k, v)
  bridge.calls.length = 0
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory(), clock: opts.clock }, attachTo: document.body })
  await flushPromises()
  return { w, bridge: bridge as any }
}
const inv = (b: any, m: string) => b.calls.filter((c: any) => c.method === 'invoke' && c.args.method === m)
async function openNb(w: any, withBlock = true) {
  await w.find('[data-test=new]').trigger('click')
  await flushPromises()
  if (withBlock) { (w.vm as any).store.nb.value.blocks.push({ id: 'm1', type: 'markdown', content: 'hello', metadata: {} }); await flushPromises() }
}

describe('export wiring', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  const modalButtons = () => Array.from(document.querySelectorAll('.cd-btn')) as HTMLButtonElement[]
  const modalText = () => document.querySelector('.cd')?.textContent ?? ''
  const click = async (el: Element | null | undefined) => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }
  const q = (k: string) => document.querySelector(`[data-test=${k}]`) as HTMLElement | null

  async function openDialog(w: any) {
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
  }
  async function chooseHtml(w: any) {
    await click(q('fmt-html'))
    await click(q('choose'))
    const n = q('file-name') as HTMLInputElement
    n.value = 'r'
    n.dispatchEvent(new Event('input'))
    await flushPromises()
  }

  it('toolbar export is disabled for an empty notebook and opens the dialog otherwise', async () => {
    const { w } = await setup()
    await openNb(w, false)
    expect(w.find('[data-test=export]').attributes('disabled')).toBeDefined()
    ;(w.vm as any).store.nb.value.blocks.push({ id: 'm1', type: 'markdown', content: 'x', metadata: {} })
    await flushPromises()
    expect(w.find('[data-test=export]').attributes('disabled')).toBeUndefined()
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    w.unmount()
  })

  it('dialog defaults come from the settings remembered for this notebook; another notebook gets defaults', async () => {
    const mem = { items: [{ key: notebookKey('/n/a.sqlnb'), options: { format: 'html', includeSql: true, orientation: 'landscape' }, fileName: 'a.html', folder: '/out' }] }
    const { w, bridge } = await setup({ storage: { 'export.notebooks.v1': mem } })
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    const pre = inv(bridge, 'export/browserStatus').length
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
    expect((document.querySelector('[data-test=opt-sql]') as HTMLInputElement).checked).toBe(true)
    expect((document.querySelector('[data-test=orient-landscape]') as HTMLInputElement).checked).toBe(true)
    expect(inv(bridge, 'export/browserStatus').length).toBe(pre + 1)
    ;(document.querySelector('[data-test=close]') as HTMLButtonElement).click()
    await flushPromises()
    ;(w.vm as any).store.path.value = '/n/b.sqlnb'
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
    expect((document.querySelector('[data-test=opt-sql]') as HTMLInputElement).checked).toBe(false)
    expect((document.querySelector('[data-test=orient-portrait]') as HTMLInputElement).checked).toBe(true)
    w.unmount()
  })

  it('export remembers settings locally per notebook and leaves the notebook files untouched', async () => {
    const { w, bridge } = await setup({ storage: { 'export.notebooks.v1': { items: [{ key: notebookKey('/n/a.sqlnb'), options: { format: 'html' }, fileName: '', folder: '' }] } } })
    await openNb(w)
    const store = (w.vm as any).store
    store.path.value = '/n/a.sqlnb'
    const before = serializeNotebook(store.nb.value)
    const dirty = store.dirty.value
    await openDialog(w)
    await click(q('go'))
    await click(modalButtons()[0])
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    const sets = bridge.calls.filter((c: any) => c.method === 'storageSet' && c.args.key === 'export.notebooks.v1')
    expect(sets.length).toBe(1)
    expect(sets[0].args.value.items[0]).toMatchObject({ key: notebookKey('/n/a.sqlnb'), folder: '/n' })
    expect('fileName' in sets[0].args.value.items[0]).toBe(false)
    expect(serializeNotebook(store.nb.value)).toBe(before)
    expect(store.dirty.value).toBe(dirty)
    expect(inv(bridge, 'notebook/write').length).toBe(0)
    expect(bridge.calls.some((c: any) => c.method === 'queryData')).toBe(false)
    w.unmount()
  })

  it('an unsaved notebook remembers only the last folder', async () => {
    const { w, bridge } = await setup({ storage: { 'export.options.v1': { format: 'html' } } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    await click(modalButtons()[0])
    expect(bridge.calls.some((c: any) => c.method === 'storageSet' && c.args.key === 'export.notebooks.v1')).toBe(false)
    expect(bridge.calls.some((c: any) => c.method === 'storageSet' && c.args.key === 'export.lastFolder.v1' && c.args.value === '/o')).toBe(true)
    w.unmount()
  })

  it('missing browser disables PDF in the dialog', async () => {
    const { w } = await setup({ browser: { found: false, source: 'none', reason: 'x' } })
    await openNb(w)
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
    expect((document.querySelector('[data-test=fmt-pdf]') as HTMLInputElement).disabled).toBe(true)
    expect(document.querySelector('[data-test=browser-hint]')).not.toBeNull()
    w.unmount()
  })

  it('StartPage manual browser path is saved and status re-queried with it', async () => {
    const { w, bridge } = await setup()
    const input = w.find('[data-test=browser-path]')
    await input.setValue('/opt/chrome')
    await input.trigger('change')
    await flushPromises()
    expect(bridge.calls.some((c: any) => c.method === 'storageSet' && c.args.key === 'export.browserPath.v1' && c.args.value === '/opt/chrome')).toBe(true)
    const last = inv(bridge, 'export/browserStatus').at(-1)
    expect(last.args.params).toEqual({ manualPath: '/opt/chrome' })
    w.unmount()
  })

  it('suggests a name; the folder must be chosen first; Export then writes without re-asking, and confirms in a modal', async () => {
    const { w, bridge } = await setup()
    await openNb(w)
    const store = (w.vm as any).store
    store.path.value = null
    await openDialog(w)
    expect((q('file-name') as HTMLInputElement).value).toMatch(/^Untitled notebook-\d{8}-\d{6}$/)
    expect(q('file-ext')!.textContent).toBe('.pdf')
    expect((q('go') as HTMLButtonElement).disabled).toBe(true)
    expect(q('file-hint')).not.toBeNull()
    await chooseHtml(w)
    expect(inv(bridge, 'export/pickFolder').length).toBe(1)
    expect(q('file-folder')!.textContent).toContain('/o')
    expect((q('go') as HTMLButtonElement).disabled).toBe(false)
    await click(q('go'))
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    expect(inv(bridge, 'export/saveHtml')[0].args.params.path).toBe('/o/r.html')
    expect(modalText()).toContain('Exported to /o/r.html')
    expect(document.querySelector('[data-test=result]')).toBeNull()
    await click(modalButtons()[0])
    expect(document.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    expect((q('go') as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })

  it('exporting again to the same path asks for overwrite inside the app; cancel writes nothing, confirm writes again', async () => {
    const { w, bridge } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    await click(modalButtons()[0])
    await click(q('go'))
    expect(modalText()).toContain('/o/r.html')
    expect(modalButtons().map((b) => b.textContent)).toContain('Overwrite')
    await click(modalButtons().find((b) => b.textContent === 'Cancel'))
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    await click(q('go'))
    await click(modalButtons().find((b) => b.textContent === 'Overwrite'))
    expect(inv(bridge, 'export/saveHtml').length).toBe(2)
    expect(modalText()).toContain('Exported to')
    await click(modalButtons()[0])
    w.unmount()
  })

  it('a remembered folder is prefilled with a fresh name; Export can be clicked directly', async () => {
    const mem = { items: [{ key: notebookKey('/n/a.sqlnb'), options: { format: 'html' }, fileName: 'a.html', folder: '/out' }] }
    const { w, bridge } = await setup({ storage: { 'export.notebooks.v1': mem } })
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await openDialog(w)
    expect(q('file-folder')!.textContent).toContain('/out')
    expect((q('file-name') as HTMLInputElement).value).toMatch(/^a-\d{8}-\d{6}$/)
    await click(q('go'))
    expect(inv(bridge, 'export/pickFolder').length).toBe(0)
    expect(inv(bridge, 'export/saveHtml')[0].args.params.path).toMatch(/^\/out\/a-\d{8}-\d{6}\.html$/)
    await click(modalButtons()[0])
    w.unmount()
  })

  it('opening export twice yields a new name each time', async () => {
    let now = new Date()
    const { w } = await setup({ clock: () => now })
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    now = new Date(2026, 9, 20, 8, 0, 0)
    await openDialog(w)
    const n1 = (q('file-name') as HTMLInputElement).value
    await click(q('close'))
    now = new Date(2026, 9, 20, 8, 0, 1)
    await openDialog(w)
    const n2 = (q('file-name') as HTMLInputElement).value
    expect(n1).toBe('a-20261020-080000')
    expect(n2).toBe('a-20261020-080001')
    w.unmount()
  })

  it('a name remembered earlier is not reused; no name is persisted', async () => {
    const mem = { items: [{ key: notebookKey('/n/a.sqlnb'), options: { format: 'html' }, fileName: 'old.html', folder: '/out' }] }
    const { w, bridge } = await setup({ storage: { 'export.notebooks.v1': mem } })
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await openDialog(w)
    expect((q('file-name') as HTMLInputElement).value).not.toBe('old')
    await click(q('go'))
    await click(modalButtons()[0])
    const sets = bridge.calls.filter((c: any) => c.method === 'storageSet' && c.args.key === 'export.notebooks.v1')
    expect('fileName' in sets[0].args.value.items[0]).toBe(false)
    w.unmount()
  })

  it('an unsaved notebook uses the i18n untitled label (en and zh)', async () => {
    const { w } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    expect((q('file-name') as HTMLInputElement).value).toMatch(/^Untitled notebook-\d{8}-\d{6}$/)
    await click(q('close') ?? document.querySelector('.exp-close'))
    setLocale('zh')
    await openDialog(w)
    expect((q('file-name') as HTMLInputElement).value).toMatch(/^未命名笔记-\d{8}-\d{6}$/)
    setLocale('en')
    w.unmount()
  })

  it('switching format changes only the extension', async () => {
    const { w } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await openDialog(w)
    const before = (q('file-name') as HTMLInputElement).value
    await click(q('fmt-html'))
    expect((q('file-name') as HTMLInputElement).value).toBe(before)
    expect(q('file-ext')!.textContent).toBe('.html')
    w.unmount()
  })

  it('a saved notebook without memory defaults to its own folder', async () => {
    const { w } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/docs/a.sqlnb'
    await openDialog(w)
    expect(q('file-folder')!.textContent).toContain('/n/docs')
    expect((q('go') as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })

  it('the confirmation lists skipped blocks and chart failures', async () => {
    const { w } = await setup()
    await openNb(w)
    const store = (w.vm as any).store
    store.path.value = null
    store.nb.value.blocks.push(
      { id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1', title: 'Orders' } },
      { id: 'q9', type: 'sql', content: 'x', metadata: { resultName: 'neverRun' } },
      { id: 'c1', type: 'chart', content: '', metadata: { data: 's1', spec: { mark: 'bar' } } },
    )
    store.runs.set('s1', { status: 'ok', result: { columns: [{ name: 'a' }], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' }, executedAt: '2026-10-18T00:00:00Z' })
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    const text = modalText()
    expect(text).toContain('Exported to /o/r.html')
    expect(text).toContain('neverRun')
    expect(text).toMatch(/c1.*No data/)
    await click(modalButtons()[0])
    expect(document.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    w.unmount()
  })

  it('save dialog cancelled keeps the dialog usable', async () => {
    const { w, bridge } = await setup({ extra: { 'export/pickFolder': () => ({ cancelled: true }) } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    expect((q('go') as HTMLButtonElement).disabled).toBe(true)
    expect(inv(bridge, 'export/saveHtml').length).toBe(0)
    w.unmount()
  })

  const guardedSave = (written: { path: string; overwrite?: boolean }[], existing: Set<string>) => (p: any) => {
    if (existing.has(p.path) && !p.overwrite) throw new Error('[-32030] Target already exists: ' + p.path)
    written.push({ path: p.path, overwrite: p.overwrite })
    return { path: p.path, bytes: 5 }
  }

  it('an existing target the app does not know about: sidecar refusal -> confirm -> retry with overwrite', async () => {
    const written: any[] = []
    const { w, bridge } = await setup({ extra: { 'export/saveHtml': guardedSave(written, new Set(['/o/r.html'])) } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    expect(inv(bridge, 'export/saveHtml')[0].args.params.overwrite).toBeFalsy()
    expect(written).toEqual([])
    expect(modalButtons().map((b) => b.textContent)).toContain('Overwrite')
    expect(modalText()).toContain('/o/r.html')
    await click(modalButtons().find((b) => b.textContent === 'Overwrite'))
    expect(inv(bridge, 'export/saveHtml')[1].args.params.overwrite).toBe(true)
    expect(written).toEqual([{ path: '/o/r.html', overwrite: true }])
    expect(modalText()).toContain('Exported to /o/r.html')
    await click(modalButtons()[0])
    w.unmount()
  })

  it('the overwrite confirmation focuses Cancel, not the destructive Overwrite; the done modal still focuses its first button', async () => {
    const written: any[] = []
    const { w } = await setup({ extra: { 'export/saveHtml': guardedSave(written, new Set(['/o/r.html'])) } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    await new Promise((r) => setTimeout(r, 0))
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel')
    expect(written).toEqual([])
    await click(modalButtons().find((b) => b.textContent === 'Cancel'))
    expect(written).toEqual([])
    w.unmount()
  })

  it('declining the overwrite writes nothing and leaves the dialog usable', async () => {
    const written: any[] = []
    const { w, bridge } = await setup({ extra: { 'export/saveHtml': guardedSave(written, new Set(['/o/r.html'])) } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('note'))
    await click(q('go'))
    await click(modalButtons().find((b) => b.textContent === 'Cancel'))
    expect(written).toEqual([])
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    expect(document.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    expect((q('file-name') as HTMLInputElement).value).toBe('r')
    expect((q('go') as HTMLButtonElement).disabled).toBe(false)
    expect(q('err')!.getAttribute('role')).toBe('alert')
    expect(q('err')!.textContent).toMatch(/already exists.*not overwritten|not overwritten/i)
    expect(document.querySelector('.cd')).toBeNull()
    w.unmount()
  })

  it.each([
    ['a write failure', () => { throw new Error('[-32013] Cannot write: disk full') }, /Could not write the file.*disk full/],
    ['an unknown error', () => { throw undefined }, /Could not write the file.*Unknown error/],
    ['a non-Error rejection', () => { throw { weird: true } }, /Could not write the file/],
  ])('%s is shown as a visible, selectable alert and the dialog stays usable', async (_n, fail, re) => {
    const { w } = await setup({ extra: { 'export/saveHtml': fail } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    expect(document.querySelector('.cd')).toBeNull()
    const err = q('err')!
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toMatch(re)
    expect(err.querySelector('.ed-sel')).not.toBeNull()
    expect((q('go') as HTMLButtonElement).disabled).toBe(false)
    expect(q('spinner')).toBeNull()
    w.unmount()
  })

  it('a write failure shows [code] raw message and logs the raw error once', async () => {
    const { w } = await setup({ extra: { 'export/saveHtml': () => { throw new Error('[-32013] Cannot write: disk full') } } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    expect(q('err')!.textContent).toMatch(/Could not write the file.*\[-32013\] .*disk full/)
    const calls = err.mock.calls.filter((c) => c[0] === '[sqlnb export]')
    expect(calls.length).toBe(1)
    expect(typeof calls[0][1]).toBe('string')
    expect(calls[0][1]).toContain('-32013')
    err.mockRestore()
    w.unmount()
  })

  it('a failing settings save after a successful export still reports success', async () => {
    const { w, bridge } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await openDialog(w)
    await chooseHtml(w)
    ;(w.vm as any).exportSettings.save = async () => { throw new Error('settings exploded') }
    const dbg = vi.spyOn(console, 'error').mockImplementation(() => {})
    await click(q('go'))
    expect(document.querySelector('.cd')).not.toBeNull()
    expect(document.querySelector('.cd')!.textContent).toContain('/o/r.html')
    expect(q('err')).toBeNull()
    expect(q('spinner')).toBeNull()
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    dbg.mockRestore()
    w.unmount()
  })

  it('the app-side fast path still asks the sidecar (no overwrite flag) before confirming', async () => {
    const written: any[] = []
    const { w, bridge } = await setup({ extra: { 'export/saveHtml': guardedSave(written, new Set()) } })
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
    await click(modalButtons()[0])
    await click(q('go'))
    await click(modalButtons().find((b) => b.textContent === 'Overwrite'))
    expect(inv(bridge, 'export/saveHtml').map((c: any) => c.args.params.overwrite)).toEqual([undefined, true])
    await click(modalButtons()[0])
    w.unmount()
  })

  const key = async (el: Element | null, k: string, shiftKey = false) => {
    el!.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }))
    await flushPromises()
  }
  const exportedOnce = async (w: any, extra?: Record<string, any>) => {
    await openNb(w)
    ;(w.vm as any).store.path.value = null
    await openDialog(w)
    await chooseHtml(w)
    await click(q('go'))
  }

  it('modals over the export dialog: focus moves in, Esc closes only the modal, focus returns to Export', async () => {
    const { w } = await setup()
    await exportedOnce(w)
    const modal = document.querySelector('.cd')!
    expect(modal.contains(document.activeElement)).toBe(true)
    await key(document.activeElement, 'Escape')
    expect(document.querySelector('.cd')).toBeNull()
    expect(document.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    expect(document.activeElement).toBe(q('go'))
    w.unmount()
  })

  it('overwrite modal: Esc cancels only the modal and writes nothing; Tab stays inside the modal', async () => {
    const written: any[] = []
    const { w, bridge } = await setup({ extra: { 'export/saveHtml': guardedSave(written, new Set(['/o/r.html'])) } })
    await exportedOnce(w)
    const modal = document.querySelector('.cd')!
    const btns = modalButtons()
    expect(modal.contains(document.activeElement)).toBe(true)
    btns[btns.length - 1].focus()
    await key(btns[btns.length - 1], 'Tab')
    expect(modal.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(btns[0])
    await key(btns[0], 'Tab', true)
    expect(document.activeElement).toBe(btns[btns.length - 1])
    await key(document.activeElement, 'Escape')
    expect(document.querySelector('.cd')).toBeNull()
    expect(document.querySelector('[role=dialog][aria-label]')).not.toBeNull()
    expect(written).toEqual([])
    expect(inv(bridge, 'export/saveHtml').length).toBe(1)
    expect(document.activeElement).toBe(q('go'))
    w.unmount()
  })

  it('toolbar Export is disabled while blocks run', async () => {
    const { w } = await setup()
    await openNb(w)
    ;(w.vm as any).running = true
    await flushPromises()
    const b = w.find('[data-test=export]')
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.attributes('aria-label')).toMatch(/running/i)
    ;(w.vm as any).running = false
    await flushPromises()
    expect(w.find('[data-test=export]').attributes('disabled')).toBeUndefined()
    w.unmount()
  }, 20000)

  it('a run starting while the dialog is open disables Go with a hint', async () => {
    const { w } = await setup()
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await w.find('[data-test=export]').trigger('click')
    await flushPromises()
    ;(w.vm as any).running = true
    await flushPromises()
    expect((document.querySelector('[data-test=go]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-test=hint-running]')).not.toBeNull()
    ;(w.vm as any).running = false
    await flushPromises()
    expect((document.querySelector('[data-test=go]') as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })

  it('double click on Export runs prepare once; note typing does not rebuild the model', async () => {
    const spy = vi.spyOn(modelMod, 'buildExportModel')
    const { w } = await setup()
    await openNb(w)
    const store = (w.vm as any).store
    store.refreshAnalysis = vi.fn(async () => ({}))
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1' } }, { id: 'c1', type: 'chart', content: '', metadata: { data: 's1' } })
    const btn = w.find('[data-test=export]')
    await btn.trigger('click'); await btn.trigger('click')
    await flushPromises()
    expect(store.refreshAnalysis).toHaveBeenCalledTimes(1)
    const n = spy.mock.calls.length
    const note = document.querySelector('[data-test=note]') as HTMLTextAreaElement
    note.value = 'hello'; note.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(spy.mock.calls.length).toBe(n)
    w.unmount()
  })
})

describe('exporter name wiring', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  const q = (k: string) => document.querySelector(`[data-test=${k}]`) as HTMLElement | null
  const click = async (el: Element | null | undefined) => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }
  const SENT = 'SENTINEL-USER <&>'
  async function run(storage: Record<string, unknown>, user: () => unknown = () => ({ name: SENT })) {
    const written: string[] = []
    const { w, bridge } = await setup({ storage, extra: { 'system/user': user, 'export/saveHtml': (p: any) => { written.push(p.html); return { path: '/o/r.html', bytes: 5 } } } })
    await openNb(w)
    ;(w.vm as any).store.path.value = '/n/a.sqlnb'
    await w.find('[data-test=export]').trigger('click'); await flushPromises()
    return { w, bridge, written }
  }
  async function exportHtml() {
    await click(q('fmt-html')); await click(q('choose'))
    const n = q('file-name') as HTMLInputElement; n.value = 'r'; n.dispatchEvent(new Event('input')); await flushPromises()
    await click(q('go'))
  }
  const mem = (options: unknown) => ({ 'export.notebooks.v1': { items: [{ key: notebookKey('/n/a.sqlnb'), options, fileName: '', folder: '/o' }] } })
  const on = mem({ format: 'html' })
  const off = mem({ format: 'html', header: { exporter: false } })

  it('on: sidecar called once per open (not again at export); name shown and written escaped', async () => {
    const { w, bridge, written } = await run(on)
    expect(inv(bridge, 'system/user').length).toBe(1)
    expect(q('exporter-name')).toBeNull()
    expect(document.body.textContent).not.toContain(SENT)
    await exportHtml()
    expect(inv(bridge, 'system/user').length).toBe(1)
    expect(inv(bridge, 'system/user')[0].method).toBe('invoke')
    expect(bridge.calls.some((c: any) => c.method === 'request' && c.args.method === 'system/user')).toBe(false)
    expect(written[0]).toContain('SENTINEL-USER &lt;&amp;&gt;')
    w.unmount()
  })
  it('remembered off: no sidecar call at open or export; name absent', async () => {
    const { w, bridge, written } = await run(off)
    await exportHtml()
    expect(inv(bridge, 'system/user').length).toBe(0)
    expect(written[0]).not.toContain('SENTINEL')
    w.unmount()
  })
  it('turned off after fetch: not written, no extra call', async () => {
    const { w, bridge, written } = await run(on)
    const c = q('opt-exporter') as HTMLInputElement; c.checked = false; c.dispatchEvent(new Event('change')); await flushPromises()
    await exportHtml()
    expect(inv(bridge, 'system/user').length).toBe(1)
    expect(written[0]).not.toContain('SENTINEL')
    w.unmount()
  })
  it('off at open, turned on later: fetched once', async () => {
    const { w, bridge, written } = await run(off)
    const c = q('opt-exporter') as HTMLInputElement; c.checked = true; c.dispatchEvent(new Event('change')); await flushPromises()
    expect(inv(bridge, 'system/user').length).toBe(1)
    await exportHtml()
    expect(inv(bridge, 'system/user').length).toBe(1)
    expect(written[0]).toContain('SENTINEL-USER')
    w.unmount()
  })
  it('failure: no row, no error, switch hidden', async () => {
    const { w, written } = await run(on, () => { throw new Error('nope') })
    expect(q('opt-exporter')).toBeNull()
    await exportHtml()
    expect(written.length).toBe(1)
    expect(document.querySelector('[data-test=error]')).toBeNull()
    expect(written[0]).not.toContain('Exported by')
    w.unmount()
  })
  it('export clicked while system/user is pending waits for it and includes the name', async () => {
    let resolve!: (v: unknown) => void
    const { w, written } = await run(on, () => new Promise((r) => { resolve = r }))
    await click(q('fmt-html')); await click(q('choose'))
    const n = q('file-name') as HTMLInputElement; n.value = 'r'; n.dispatchEvent(new Event('input')); await flushPromises()
    await click(q('go'))
    expect(written.length).toBe(0)
    resolve({ name: 'LATE-USER' }); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(written.length).toBe(1)
    expect(written[0]).toContain('LATE-USER')
    w.unmount()
  })
  it('lookup rejects: export succeeds without the row', async () => {
    const { w, written } = await run(on, () => { throw new Error('nope') })
    await exportHtml()
    expect(written.length).toBe(1)
    expect(written[0]).not.toContain('Exported by')
    w.unmount()
  })
  it('switch off: system/user never invoked; on: invoked once', async () => {
    const a = await run(off)
    await exportHtml()
    expect(inv(a.bridge, 'system/user').length).toBe(0)
    a.w.unmount(); document.body.innerHTML = ''
    const b = await run(on)
    await exportHtml()
    expect(inv(b.bridge, 'system/user').length).toBe(1)
    b.w.unmount()
  })
  it('dialog closed during lookup: no export started', async () => {
    let resolve!: (v: unknown) => void
    const { w, written, bridge } = await run(on, () => new Promise((r) => { resolve = r }))
    await click(q('fmt-html')); await click(q('choose'))
    const n = q('file-name') as HTMLInputElement; n.value = 'r'; n.dispatchEvent(new Event('input')); await flushPromises()
    await click(q('go'))
    await click(q('close'))
    resolve({ name: 'X' }); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(written.length).toBe(0)
    expect(inv(bridge, 'export/saveHtml').length).toBe(0)
    w.unmount()
  })
  it('stale response after close/reopen is ignored', async () => {
    let resolve1!: (v: unknown) => void
    let n = 0
    const { w, written } = await run(on, () => (++n === 1 ? new Promise((r) => { resolve1 = r }) : { name: 'second' }))
    await click(q('close'))
    await w.find('[data-test=export]').trigger('click'); await flushPromises()
    resolve1({ name: 'FIRSTUSER' }); await flushPromises()
    await exportHtml()
    expect(written[0]).toContain('second')
    expect(written[0]).not.toContain('FIRSTUSER')
    w.unmount()
  })
  it('privacy: name never reaches storage, .sqlnb, or AI prompts', async () => {
    const { w, bridge } = await run(on)
    await exportHtml()
    const store = (w.vm as any).store
    expect(serializeNotebook(store.nb.value)).not.toContain('SENTINEL')
    for (const c of bridge.calls) {
      if (c.method === 'storageSet') expect(JSON.stringify(c.args)).not.toContain('SENTINEL')
      if (c.method === 'invoke' && c.args.method !== 'export/saveHtml') expect(JSON.stringify(c.args)).not.toContain('SENTINEL')
    }
    expect(inv(bridge, 'notebook/write').length).toBe(0)
    w.unmount()
  })
})
