import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import tb from '../src/shell/Toolbar.vue?raw'
import nv from '../src/shell/NotebookView.vue?raw'
import appSrc from '../src/App.vue?raw'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { serializeNotebook, createEmptyNotebook } from '@sqlnb/format'

const NB = serializeNotebook(createEmptyNotebook())
let cb: ((entries: any[]) => void) | null = null
let disconnected = 0
class RO {
  constructor(fn: any) { cb = fn }
  observe() {}
  unobserve() {}
  disconnect() { disconnected++ }
}

async function boot() {
  setLocale('en')
  const bridge = createFakeBridge({
    context: () => ({ id: 'c1', name: 'main', dbType: 'postgres' }),
    invokeHandlers: { 'notebook/recent': () => ({ items: [] }), 'notebook/read': () => ({ text: NB, mtimeMs: 1 }), 'notebook/write': () => ({ mtimeMs: 2 }), 'notebook/touchRecent': () => ({}) },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  await flushPromises()
  return w
}

afterEach(() => { vi.unstubAllGlobals(); cb = null; disconnected = 0 })

describe('sticky toolbar', () => {
  it('toolbar root carries tb-sticky', async () => {
    const w = await boot()
    expect(w.find('[data-test=toolbar]').classes()).toContain('tb-sticky')
    w.unmount()
  })

  it('sets --toolbar-h from ResizeObserver and removes it on unmount', async () => {
    vi.stubGlobal('ResizeObserver', RO)
    const w = await boot()
    const app = w.find('.app').element as HTMLElement
    cb!([{ target: w.find('[data-test=toolbar]').element, contentRect: { height: 90 }, borderBoxSize: [{ blockSize: 91 }] }])
    expect(app.style.getPropertyValue('--toolbar-h')).toBe('91px')
    w.unmount()
    expect(disconnected).toBeGreaterThan(0)
    expect(app.style.getPropertyValue('--toolbar-h')).toBe('')
  })

  it('blocks carry the scroll-margin class', async () => {
    const w = await boot()
    await w.find('[data-test=empty-add-md]').trigger('click')
    expect(w.find('[data-test=block]').classes()).toContain('nv-block')
    w.unmount()
  })

  it('CSS: sticky, opaque, below modals, scroll-margin', () => {
    expect(tb).toMatch(/\.tb-sticky\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0/)
    expect(tb).toMatch(/\.tb-sticky\s*\{[^}]*background:\s*var\(--nb-bg/)
    expect(tb).toMatch(/\.tb-sticky\s*\{[^}]*z-index:\s*(\d+)/)
    const z = Number(/\.tb-sticky\s*\{[^}]*z-index:\s*(\d+)/.exec(tb)![1])
    expect(z).toBeGreaterThan(4)
    expect(z).toBeLessThan(1000)
    expect(nv).toMatch(/\.nv-block\s*\{[^}]*scroll-margin-top:\s*var\(--toolbar-h,\s*56px\)/)
  })
})

describe('scroll padding + dialog stacking', () => {
  it('mirrors --toolbar-h on documentElement and removes it on unmount', async () => {
    vi.stubGlobal('ResizeObserver', RO)
    const w = await boot()
    cb!([{ target: w.find('[data-test=toolbar]').element, contentRect: { height: 90 }, borderBoxSize: [{ blockSize: 91 }] }])
    expect(document.documentElement.style.getPropertyValue('--toolbar-h')).toBe('91px')
    w.unmount()
    expect(document.documentElement.style.getPropertyValue('--toolbar-h')).toBe('')
  })
  it('CSS: html scroll-padding-top', () => {
    expect(appSrc).toMatch(/html\s*\{\s*scroll-padding-top:\s*var\(--toolbar-h,\s*56px\)/)
  })
})
