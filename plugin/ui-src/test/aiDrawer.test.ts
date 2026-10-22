import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import drawerSrc from '../src/ai/AiDrawer.vue?raw'
import paneSrc from '../src/ai/ChatPane.vue?raw'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { fakeEditorFactory } from './helpers'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createDrawerManager } from '../src/ai/drawerState'
import AiDrawer from '../src/ai/AiDrawer.vue'
import App from '../src/App.vue'
import { DrawerKey } from '../src/injection'
import { serializeNotebook as ser } from '@sqlnb/format'
import ChatPane from '../src/ai/ChatPane.vue'
import { setLocale } from '../src/i18n'

let wrappers: VueWrapper<any>[] = []
afterEach(() => { wrappers.forEach((w) => w.unmount()); wrappers = []; document.body.innerHTML = '' })
beforeEach(() => setLocale('en'))

function setup(dirty = false, reason?: string) {
  const store = useNotebookStore({ maxRows: () => 100 })
  const bridge = createFakeBridge()
  const mgr = createDrawerManager(store)
  const events: string[] = []
  const Host = defineComponent({
    setup: () => () => h('div', [
      h('button', { id: 'opener' }, 'open'),
      mgr.current.value
        ? h(AiDrawer, { title: 'Ask AI', dirty, busy: false, confirmDisabledReason: reason, onClose: () => { events.push('close'); mgr.close() }, onConfirm: () => events.push('confirm'), onDiscard: () => events.push('discard') }, {
          left: () => h('button', { 'data-test': 'left-btn' }, 'L'),
          chat: () => h(ChatPane, { messages: [], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p' }),
        })
        : null,
    ]),
  })
  const w = mount(Host, { attachTo: document.body })
  wrappers.push(w)
  const opener = document.getElementById('opener') as HTMLElement
  opener.focus()
  return { store, bridge, mgr, w, events, opener }
}
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}
const spec = { purpose: 'sql', blockId: 'b1' } as const

describe('AI drawer', () => {
  it('open() twice: second returns false, only one drawer in DOM', async () => {
    const e = setup()
    expect(e.mgr.open(spec)).toBe(true)
    expect(e.mgr.open({ purpose: 'chart', blockId: 'b2' })).toBe(false)
    await nextTick()
    expect(document.querySelectorAll('[role=dialog]').length).toBe(1)
  })
  it('dialog has role=dialog aria-modal and labelled title', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    const d = document.querySelector('[role=dialog]')!
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toContain('Ask AI')
  })
  it('focus lands in chat input; closing returns focus to opener', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('[data-test=chat-input]'))
    e.mgr.close(); await flushPromises()
    expect(document.activeElement).toBe(e.opener)
  })
  it('Escape with dirty=false closes', async () => {
    const e = setup(false); e.mgr.open(spec); await flushPromises()
    await document.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(e.events).toEqual(['close'])
    expect(e.mgr.current.value).toBeNull()
  })
  it('Escape with dirty=true confirms: cancel keeps open, accept closes', async () => {
    const e = setup(true); e.mgr.open(spec); await flushPromises()
    const press = () => document.querySelector('[data-test=ai-drawer]')!.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    press(); await flushPromises()
    const dlgs = document.querySelectorAll('[role=dialog]')
    expect(dlgs.length).toBe(2)
    expect(e.events).toEqual([])
    const btns = Array.from(dlgs[1].querySelectorAll('button'))
    btns.find((b) => b.textContent === 'Keep editing')!.click(); await flushPromises()
    expect(document.querySelectorAll('[role=dialog]').length).toBe(1)
    expect(e.events).toEqual([])
    press(); await flushPromises()
    Array.from(document.querySelectorAll('[role=dialog]')[1].querySelectorAll('button')).find((b) => b.textContent === 'Discard draft')!.click()
    await flushPromises()
    expect(e.events).toEqual(['close'])
  })
  it('Discard button emits discard', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    ;(document.querySelector('[data-test=drawer-discard]') as HTMLElement).click()
    expect(e.events).toEqual(['discard'])
  })
  it('Tab from last control wraps to first and Shift+Tab back', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    const panel = document.querySelector('[role=dialog]') as HTMLElement
    const f = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]),textarea:not([disabled])'))
    const last = f[f.length - 1]; last.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f[0])
    const sh = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    f[0].dispatchEvent(sh)
    expect(document.activeElement).toBe(last)
  })
  it('store.load() (generation change) closes the drawer', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    e.store.load(serializeNotebook(createEmptyNotebook()), null, null)
    await flushPromises()
    expect(e.mgr.current.value).toBeNull()
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('confirm disabled shows reason via aria-describedby', async () => {
    const e = setup(false, 'Block was edited'); e.mgr.open(spec); await flushPromises()
    const b = document.querySelector('[data-test=drawer-confirm]') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toContain('Block was edited')
  })
})

describe('ChatPane', () => {
  const mk = (props: Record<string, unknown> = {}) => {
    const w = mount(ChatPane, { props: { messages: [], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p', ...props }, attachTo: document.body })
    wrappers.push(w)
    return w
  }
  it('send disabled while busy and for empty/whitespace; Enter sends', async () => {
    const w = mk()
    const send = () => w.find('[data-test=chat-send]')
    expect((send().element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-test=chat-input]').setValue('   ')
    expect((send().element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-test=chat-input]').setValue(' hi ')
    expect((send().element as HTMLButtonElement).disabled).toBe(false)
    await w.find('[data-test=chat-input]').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(w.emitted('send')).toBeUndefined()
    await w.find('[data-test=chat-input]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('send')![0]).toEqual(['hi'])
    await w.setProps({ busy: true })
    await w.find('[data-test=chat-input]').setValue('again')
    expect(w.find('[data-test=chat-send]').exists()).toBe(false)
  })
  it('input capped at 2000 chars; Cancel emits cancel while busy', async () => {
    const w = mk()
    expect(w.find('[data-test=chat-input]').attributes('maxlength')).toBe('2000')
    await w.find('[data-test=chat-input]').setValue('x'.repeat(2500))
    expect((w.find('[data-test=chat-input]').element as HTMLTextAreaElement).value.length).toBe(2000)
    await w.setProps({ busy: true })
    await w.find('[data-test=chat-cancel]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })
  it('disabledReason disables sending and is described', async () => {
    const w = mk({ disabledReason: 'AI off' })
    await w.find('[data-test=chat-input]').setValue('hi')
    const b = w.find('[data-test=chat-send]')
    expect((b.element as HTMLButtonElement).disabled).toBe(true)
    expect(document.getElementById(b.attributes('aria-describedby')!)!.textContent).toContain('AI off')
  })
})

describe('fix round 1', () => {
  it('ChatPane hides data-tagged parts', () => {
    const w = mount(ChatPane, { props: { messages: [{ id: 'm', role: 'assistant', at: 1, parts: [{ kind: 'text', text: 'visible' }, { kind: 'data', text: 'SECRET-ROWS' }] }], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p' } })
    expect(w.text()).toContain('visible')
    expect(w.text()).not.toContain('SECRET-ROWS')
  })
  it('Tab skips controls inside a closed <details> (RawOutput)', async () => {
    const store = useNotebookStore({ maxRows: () => 100 })
    const mgr = createDrawerManager(store)
    const Host = defineComponent({ setup: () => () => mgr.current.value ? h(AiDrawer, { title: 'T', dirty: false, busy: false, onClose: () => mgr.close() }, { chat: () => h(ChatPane, { messages: [], busy: false, progress: '', error: '', rawOutput: 'raw text', placeholder: 'p' }) }) : h('div') })
    wrappers.push(mount(Host, { attachTo: document.body }))
    mgr.open(spec); await flushPromises()
    const input = document.querySelector('[data-test=chat-input]') as HTMLElement
    const pre = document.querySelector('[data-test=raw-output-text]') as HTMLElement
    expect(pre).not.toBeNull()
    input.focus()
    let seen = new Set<Element | null>()
    for (let i = 0; i < 12; i++) { press(document.activeElement!, 'Tab'); seen.add(document.activeElement) }
    expect(seen.has(pre)).toBe(false)
    expect(document.activeElement).not.toBe(document.body)
  })
  it('Esc still works after Send turned into Cancel (focus lost)', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    ;(document.querySelector('[data-test=drawer-confirm]') as HTMLElement).focus()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    press(document.body, 'Escape'); await flushPromises()
    expect(e.events).toEqual(['close'])
  })
  it('ChatPane keeps focus when busy flips', async () => {
    const w = mount(ChatPane, { props: { messages: [], busy: false, progress: '', error: '', rawOutput: '', placeholder: 'p' }, attachTo: document.body })
    wrappers.push(w)
    await w.find('[data-test=chat-input]').setValue('hi')
    ;(w.find('[data-test=chat-send]').element as HTMLElement).focus()
    await w.setProps({ busy: true }); await flushPromises()
    expect(document.activeElement).not.toBe(document.body)
  })
  it('ignores already-handled (defaultPrevented) Esc/Tab', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    const input = document.querySelector('[data-test=chat-input]') as HTMLElement
    input.addEventListener('keydown', (ev) => ev.preventDefault())
    press(input, 'Escape'); press(input, 'Tab')
    await flushPromises()
    expect(e.events).toEqual([])
    expect(document.activeElement).toBe(input)
  })
  it('Tab inside .cm-editor is not trapped', async () => {
    const e = setup(); e.mgr.open(spec); await flushPromises()
    const cm = document.createElement('div'); cm.className = 'cm-editor'
    const inner = document.createElement('div'); inner.setAttribute('contenteditable', 'true'); inner.tabIndex = 0
    cm.appendChild(inner); document.querySelector('[data-test=drawer-left]')!.appendChild(cm)
    inner.focus()
    const ev = press(inner, 'Tab')
    expect(ev.defaultPrevented).toBe(false)
  })
  it('open() refused without a registered body', async () => {
    const store = useNotebookStore({ maxRows: () => 100 })
    const mgr = createDrawerManager(store, (p) => p === 'sql')
    expect(mgr.open({ purpose: 'chart', blockId: 'x' })).toBe(false)
    expect(mgr.current.value).toBeNull()
    expect(mgr.open({ purpose: 'sql', blockId: 'x' })).toBe(true)
  })
  it('locks page scroll while open and restores on close', async () => {
    const e = setup(); document.body.style.overflow = 'auto'
    e.mgr.open(spec); await flushPromises()
    expect(document.body.style.overflow).toBe('hidden')
    e.mgr.close(); await flushPromises()
    expect(document.body.style.overflow).toBe('auto')
  })
  it('focus returns to opener even when opener was inside inert content', async () => {
    const e = setup()
    const wrap = document.getElementById('opener')!.parentElement!
    wrap.setAttribute('inert', '')
    e.mgr.open(spec); await flushPromises()
    wrap.removeAttribute('inert'); e.mgr.close(); await flushPromises()
    expect(document.activeElement).toBe(e.opener)
  })
})

describe('App drawer host', () => {
  async function mkApp(bodies: any) {
    setLocale('en')
    const NB = ser(createEmptyNotebook())
    const bridge = createFakeBridge({
      context: () => ({ id: 'c1', name: 'main', dbType: 'postgres' }),
      invokeHandlers: { 'notebook/recent': () => ({ items: [] }), 'notebook/read': () => ({ text: NB, mtimeMs: 1 }), 'notebook/write': () => ({ mtimeMs: 2 }), 'notebook/touchRecent': () => ({}) },
    } as any)
    const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory(), drawerBodies: bodies }, attachTo: document.body })
    wrappers.push(w)
    await flushPromises()
    const mgr = (w.findComponent({ name: 'Toolbar' }).vm.$ as any).provides[DrawerKey as symbol]
    return { w, mgr }
  }
  it('no body registered: open refused and app not inert', async () => {
    const { w, mgr } = await mkApp({})
    expect(mgr.open({ purpose: 'sql', blockId: 'b' })).toBe(false)
    await flushPromises()
    expect(w.find('[data-test=app-content]').attributes('inert')).toBeUndefined()
  })
  it('content is inert while a body is open; host closes on body close event even if body forgets', async () => {
    const Body = defineComponent({ props: { spec: { type: Object, required: true } }, emits: ['close'], setup: (_p, { emit }) => () => h('button', { 'data-test': 'body-close', onClick: () => emit('close') }, 'x') })
    const { w, mgr } = await mkApp({ sql: Body })
    expect(mgr.open({ purpose: 'sql', blockId: 'b' })).toBe(true)
    await flushPromises()
    expect(w.find('[data-test=app-content]').attributes('inert')).toBeDefined()
    await w.find('[data-test=body-close]').trigger('click'); await flushPromises()
    expect(mgr.current.value).toBeNull()
    expect(w.find('[data-test=app-content]').attributes('inert')).toBeUndefined()
  })
})

describe('dark tokens only', () => {
  it('no hex colors in AiDrawer.vue/ChatPane.vue <style>', () => {
    for (const src of [drawerSrc, paneSrc]) {
      const style = src.slice(src.indexOf('<style'))
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })
})

describe('AiDrawer closeRequest mode', () => {
  it('closeRequest mode emits close-request and shows no discard dialog', async () => {
    const w = mount(AiDrawer, { props: { title: 'T', dirty: true, busy: false, closeRequest: true }, attachTo: document.body, slots: { left: () => h('button', 'L'), chat: () => h('div') } })
    wrappers.push(w)
    await w.find('[data-test=drawer-close]').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(w.emitted('close-request')?.length).toBe(2)
    expect(w.emitted('close')).toBeFalsy()
    expect(document.querySelectorAll('[role=dialog]').length).toBe(1)
  })
})

describe('AiDrawer backdrop click', () => {
  const mk = (props: Record<string, unknown> = {}) => {
    const w = mount(AiDrawer, { props: { title: 'T', dirty: false, busy: false, ...props }, slots: { left: '<span>L</span>', chat: '<span>C</span>' }, attachTo: document.body })
    wrappers.push(w)
    return w
  }
  const bd = (w: VueWrapper<any>) => w.find('.dr-backdrop')
  const click = async (w: VueWrapper<any>) => { await bd(w).trigger('mousedown'); await bd(w).trigger('mouseup'); await bd(w).trigger('click') }
  it('backdrop mousedown+click closes when not dirty', async () => {
    const w = mk(); await click(w)
    expect(w.emitted('close')?.length).toBe(1)
  })
  it('dirty: backdrop click opens discard confirm, close only after Discard', async () => {
    const w = mk({ dirty: true }); await click(w)
    expect(w.emitted('close')).toBeFalsy()
    expect(document.querySelectorAll('[role=alertdialog],[role=dialog]').length).toBeGreaterThan(1)
    const btn = document.querySelector('[data-test=cd-discard]') as HTMLElement
    btn.click(); await flushPromises()
    expect(w.emitted('close')?.length).toBe(1)
  })
  it('closeRequest prop: emits close-request, not close', async () => {
    const w = mk({ closeRequest: true }); await click(w)
    expect(w.emitted('close-request')?.length).toBe(1)
    expect(w.emitted('close')).toBeFalsy()
  })
  it('mousedown inside .dr then click on backdrop does not close', async () => {
    const w = mk({ dirty: false })
    await w.find('.dr').trigger('mousedown'); await bd(w).trigger('click')
    expect(w.emitted('close')).toBeFalsy()
  })
  it('stale mousedown flag does not leak into a later lone click', async () => {
    const w = mk({ closeRequest: true }); await click(w)
    await bd(w).trigger('click')
    expect(w.emitted('close-request')?.length).toBe(1)
  })
  it('clicks on panel / footer do not close', async () => {
    const w = mk()
    for (const s of ['.dr', '.dr-foot', '[data-test=drawer-left]']) { await w.find(s).trigger('mousedown'); await w.find(s).trigger('click') }
    expect(w.emitted('close')).toBeFalsy()
  })
  it('click while discard confirm open does not stack a second confirm', async () => {
    const w = mk({ dirty: true }); await click(w)
    const n = document.querySelectorAll('[role=alertdialog],[role=dialog]').length
    await click(w)
    expect(document.querySelectorAll('[role=alertdialog],[role=dialog]').length).toBe(n)
  })
  it('press on backdrop, release inside drawer (click fires on backdrop) does not close', async () => {
    const w = mk()
    await bd(w).trigger('mousedown'); await w.find('.dr').trigger('mouseup'); await bd(w).trigger('click')
    expect(w.emitted('close')).toBeFalsy()
  })
  it('synthetic click with no mousedown does not close', async () => {
    const w = mk(); await bd(w).trigger('click')
    expect(w.emitted('close')).toBeFalsy()
  })
  it('touch/pen compat sequence (pointer + mouse events) closes', async () => {
    const w = mk()
    await bd(w).trigger('pointerdown'); await bd(w).trigger('pointerup')
    await click(w)
    expect(w.emitted('close')?.length).toBe(1)
  })
  it('Escape still closes', async () => {
    const w = mk(); press(document.body, 'Escape'); await nextTick()
    expect(w.emitted('close')?.length).toBe(1)
  })
})
