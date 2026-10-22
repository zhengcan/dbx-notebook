import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConfirmDialog from '../src/shell/ConfirmDialog.vue'
import StartPage from '../src/shell/StartPage.vue'
import { setLocale, t } from '../src/i18n'
import { createFakeBridge } from '../src/host/fakeBridge'
import { PluginSettingsKey } from '../src/injection'
import { createPluginSettings } from '../src/state/pluginSettings'
const tr = (k: string) => t(k as any)

const buttons = [{ id: 'save', label: 'Save', variant: 'primary' }, { id: 'discard', label: 'Discard' }, { id: 'cancel', label: 'Cancel' }]

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    expect(mount(ConfirmDialog, { props: { open: false, title: 'T', message: 'M', buttons } }).text()).toBe('')
  })
  it('renders and emits ids', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons } })
    expect(w.text()).toContain('T'); expect(w.text()).toContain('M')
    const bs = w.findAll('button')
    expect(bs.length).toBe(3)
    await bs[1].trigger('click')
    expect(w.emitted('choose')![0]).toEqual(['discard'])
  })
  it('Esc emits cancel', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons } })
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('choose')![0]).toEqual(['cancel'])
  })
  it('Esc ignored without cancel button', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons: [buttons[0]] } })
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('choose')).toBeUndefined()
  })
})

describe('ConfirmDialog initialFocus', () => {
  it('focuses the named button instead of the first; default stays the first', async () => {
    const a = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons, initialFocus: 'cancel' }, attachTo: document.body })
    await new Promise((r) => setTimeout(r))
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel')
    a.unmount()
    const b = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons }, attachTo: document.body })
    await new Promise((r) => setTimeout(r))
    expect((document.activeElement as HTMLElement).textContent).toBe('Save')
    b.unmount()
  })
})

describe('ConfirmDialog escape button', () => {
  it('Esc chooses a button flagged escape when there is no cancel', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons: [{ id: 'ok', label: 'OK', escape: true }] } })
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('choose')![0]).toEqual(['ok'])
  })
})

describe('ConfirmDialog a11y', () => {
  it('labelledby points at title, Tab wraps', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 'T', message: 'M', buttons }, attachTo: document.body })
    await new Promise((r) => setTimeout(r))
    const d = w.find('[role="dialog"]')
    expect(w.find('#' + d.attributes('aria-labelledby')).text()).toBe('T')
    const bs = w.findAll('button')
    expect(document.activeElement).toBe(bs[0].element)
    await d.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(bs[2].element)
    await d.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(bs[0].element)
    w.unmount()
  })
  it('restores focus on close', async () => {
    const outer = document.createElement('button'); document.body.appendChild(outer); outer.focus()
    const w = mount(ConfirmDialog, { props: { open: false, title: 'T', message: 'M', buttons }, attachTo: document.body })
    await w.setProps({ open: true }); await new Promise((r) => setTimeout(r))
    await w.setProps({ open: false }); await new Promise((r) => setTimeout(r))
    expect(document.activeElement).toBe(outer)
    w.unmount(); outer.remove()
  })
})

describe('StartPage', () => {
  beforeEach(() => setLocale('en'))
  const recent = [{ path: '/home/u/work/report.sqlnb', title: 'Report', openedAt: Date.now() - 3600_000 }, { path: '/x/plain.sqlnb', openedAt: 0 }]
  it('renders recent items by file name (a legacy title is never shown)', () => {
    const w = mount(StartPage, { props: { recent, hasSidecar: true } })
    expect(w.text()).toContain('report.sqlnb'); expect(w.text()).not.toContain('Report'); expect(w.text()).toContain('/home/u/work')
    expect(w.text()).toContain('plain.sqlnb')
  })
  it('bad timestamps show no relative time; root dir shown as /', () => {
    const w = mount(StartPage, { props: { recent: [{ path: '/a.sqlnb', openedAt: 0 }, { path: '/b.sqlnb', openedAt: NaN }], hasSidecar: true } })
    expect(w.text()).not.toMatch(/NaN|d ago|NaN/)
    expect(w.findAll('.sp-dir')[0].text()).toBe('/')
  })
  it('empty state', () => {
    const w = mount(StartPage, { props: { recent: [], hasSidecar: true } })
    expect(w.find('[data-test="empty"]').exists()).toBe(true)
  })
  it('emits new/open/openRecent/openPath', async () => {
    const w = mount(StartPage, { props: { recent, hasSidecar: false } })
    await w.find('[data-test="new"]').trigger('click')
    await w.find('[data-test="open"]').trigger('click')
    await w.findAll('[data-test="recent-item"]')[1].trigger('click')
    await w.find('input').setValue('/p/q.sqlnb')
    await w.find('[data-test="open-path"]').trigger('click')
    expect(w.emitted('new')).toBeTruthy(); expect(w.emitted('open')).toBeTruthy()
    expect(w.emitted('openRecent')![0]).toEqual(['/x/plain.sqlnb'])
    expect(w.emitted('openPath')![0]).toEqual(['/p/q.sqlnb'])
  })
})

describe('StartPage max-rows setting', () => {
  const mk = () => {
    setLocale('en')
    const bridge = createFakeBridge()
    const pluginSettings = createPluginSettings(bridge)
    const w = mount(StartPage, { props: { recent: [], hasSidecar: true }, global: { provide: { [PluginSettingsKey as symbol]: pluginSettings } } })
    return { w, pluginSettings }
  }
  const input = (w: any) => w.find('[data-test=max-rows]')
  it('renders the control with the current value and explanation', async () => {
    const { w, pluginSettings } = mk()
    expect(w.text()).toContain('Settings')
    expect(w.text()).toContain('Max rows per block')
    expect(w.text()).toContain('all notebooks')
    expect((input(w).element as HTMLInputElement).value).toBe('5000')
    await pluginSettings.setMaxRows(120)
    await flushPromises()
    expect((input(w).element as HTMLInputElement).value).toBe('120')
  })
  it('valid input persists; invalid reverts with hint', async () => {
    const { w, pluginSettings } = mk()
    const inp = input(w)
    ;(inp.element as HTMLInputElement).value = '200'
    await inp.trigger('change')
    expect(pluginSettings.maxRows.value).toBe(200)
    expect(w.find('[data-test=max-rows-hint]').exists()).toBe(false)
    for (const bad of ['0', '99999', 'abc', '']) {
      ;(inp.element as HTMLInputElement).value = bad
      await inp.trigger('change')
      expect(pluginSettings.maxRows.value).toBe(200)
      expect((inp.element as HTMLInputElement).value).toBe('200')
      expect(w.find('[data-test=max-rows-hint]').text()).toBe('1–5000')
    }
    ;(inp.element as HTMLInputElement).value = '12'
    await inp.trigger('input')
    expect(w.find('[data-test=max-rows-hint]').exists()).toBe(false)
  })
  it('mounts without a provider: default 5000 and accepts a change', async () => {
    setLocale('en')
    const w = mount(StartPage, { props: { recent: [], hasSidecar: true } })
    const inp = input(w)
    expect((inp.element as HTMLInputElement).value).toBe('5000')
    ;(inp.element as HTMLInputElement).value = '42'
    await inp.trigger('change')
    expect((inp.element as HTMLInputElement).value).toBe('42')
  })
  it('partial-data hint points to the start page settings; i18n zh/en', () => {
    setLocale('zh'); expect(tr('result.partial')).toContain('开始页')
    setLocale('en'); expect(tr('result.partial')).toContain('start page')
    for (const k of ['set.maxRows', 'set.maxRowsHelp', 'start.settings']) {
      setLocale('zh'); const z = tr(k); setLocale('en'); const e = tr(k)
      expect(z).not.toBe(k); expect(e).not.toBe(k); expect(z).not.toBe(e)
    }
  })
})
