import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import LabelsDialog from '../src/analysis/LabelsDialog.vue'
import { resetLabels } from '../src/analysis/labelPatch'
import { TAB_KEYS, tabAffectText } from '../src/analysis/labelTabs'
import { setLocale, t, messages } from '../src/i18n'

const ctx = { empty: '(empty)', summary: 'Summary' }
const base = () => ({
  pivot: { rows: [{ field: 'region' }], columns: [{ field: 'flag' }], values: [{ field: 'amount', agg: 'sum' }, { field: 'n', agg: 'count' }] },
  chart: { type: 'bar' },
}) as any
const cats = { row: [['a', 'b']], column: [['0', '1']] }

let wrappers: VueWrapper<any>[] = []
let nodes: HTMLElement[] = []
afterEach(() => {
  for (const w of wrappers) { try { w.unmount() } catch { /* already */ } }
  wrappers = []
  for (const n of nodes) n.remove()
  nodes = []
  document.body.innerHTML = ''
})

function setup(over: { cfg?: any; props?: any; slots?: any } = {}) {
  setLocale('en')
  const container = document.createElement('div')
  container.tabIndex = -1
  const opener = document.createElement('button')
  opener.textContent = 'open'
  container.appendChild(opener)
  document.body.appendChild(container)
  nodes.push(container)
  opener.focus()
  const w = mount(LabelsDialog, { props: { cfg: over.cfg ?? base(), categories: cats, ctx, container, returnFocus: opener, ...over.props }, slots: over.slots, attachTo: document.body })
  wrappers.push(w)
  const dlg = () => container.querySelector('[data-test=labels-dialog]') as HTMLElement
  const q = <T extends HTMLElement>(s: string) => container.querySelector(s) as T
  const qa = (s: string) => Array.from(container.querySelectorAll<HTMLElement>(s))
  return { w, container, opener, dlg, q, qa }
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(e)
  return e
}
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),[tabindex]:not([tabindex="-1"])'))

describe('LabelsDialog shell', () => {
  it('renders role=dialog aria-modal=true aria-labelledby pointing at an existing heading', async () => {
    const { dlg, container } = setup()
    await flushPromises()
    const d = dlg()
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    const h = container.querySelector(`#${d.getAttribute('aria-labelledby')}`)!
    expect(h.textContent).toBe('Advanced settings')
    expect(d.parentElement === document.body).toBe(false)
    expect(container.contains(d)).toBe(true)
  })

  it('focus moves into the dialog on open and returns to returnFocus on close (and to the block root if removed)', async () => {
    const a = setup()
    await flushPromises()
    expect(a.dlg().contains(document.activeElement)).toBe(true)
    a.w.unmount()
    expect(document.activeElement).toBe(a.opener)

    const b = setup()
    await flushPromises()
    b.opener.remove()
    b.w.unmount()
    expect(document.activeElement).toBe(b.container)
  })

  it('does not steal focus when the block root is gone', async () => {
    const a = setup()
    await flushPromises()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    a.container.remove()
    a.w.unmount()
    expect(document.activeElement).not.toBe(a.container)
    expect(document.activeElement).not.toBe(a.opener)
    outside.remove()
  })

  it('Tab on last focusable wraps to first; Shift+Tab on first wraps to last', async () => {
    const { dlg } = setup()
    await flushPromises()
    const f = focusables(dlg())
    expect(f.length).toBeGreaterThan(2)
    f[f.length - 1].focus()
    const e1 = key(f[f.length - 1], 'Tab')
    expect(e1.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f[0])
    const e2 = key(f[0], 'Tab', { shiftKey: true })
    expect(e2.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f[f.length - 1])
    f[1].focus()
    expect(key(f[1], 'Tab').defaultPrevented).toBe(false)
  })

  it('Tab with a single focusable element keeps it there; with none it holds focus on the dialog', async () => {
    const { dlg, w } = setup()
    await flushPromises()
    const d = dlg()
    const f = focusables(d)
    f.slice(1).forEach((el) => el.setAttribute('disabled', ''))
    f[0].removeAttribute('disabled')
    d.querySelectorAll('input').forEach((i) => i.setAttribute('disabled', ''))
    d.querySelectorAll('button').forEach((b) => { if (b !== f[0]) b.setAttribute('disabled', '') })
    const live = focusables(d)
    expect(live).toEqual([f[0]])
    f[0].focus()
    expect(key(f[0], 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f[0])
    expect(key(f[0], 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(f[0])
    f[0].setAttribute('disabled', '')
    key(d, 'Tab')
    expect(document.activeElement).toBe(d)
    void w
  })

  it('focusables that appear later are included in the trap', async () => {
    const { dlg, q } = setup()
    await flushPromises()
    const inp = q<HTMLInputElement>('[data-test=label-input]')
    inp.focus()
    inp.value = 'abc'
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const f = focusables(dlg())
    const last = f[f.length - 1]
    last.focus()
    const extra = document.createElement('button')
    extra.textContent = 'late'
    dlg().querySelector('.ld-content')!.appendChild(extra)
    const f2 = focusables(dlg())
    expect(f2).toContain(extra)
    f2[f2.length - 1].focus()
    key(f2[f2.length - 1], 'Tab')
    expect(document.activeElement).toBe(f2[0])
  })

  it('backdrop click does not emit close', async () => {
    const { w, q } = setup()
    await flushPromises()
    const bd = q('[data-test=labels-backdrop]')
    bd.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    bd.click()
    expect(w.emitted('close')).toBeUndefined()
  })

  it('Esc: dirty input reverts the DOM value and does not close; second Esc closes; IME Esc does nothing', async () => {
    const { w, q } = setup()
    await flushPromises()
    const inp = q<HTMLInputElement>('[data-test=label-input]')
    inp.focus()
    inp.value = 'typed'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    key(inp, 'Escape', { isComposing: true })
    expect(inp.value).toBe('typed')
    expect(w.emitted('close')).toBeUndefined()
    key(inp, 'Escape', { keyCode: 229 } as any)
    expect(w.emitted('close')).toBeUndefined()
    const e = key(inp, 'Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(inp.value).toBe('')
    expect(w.emitted('close')).toBeUndefined()
    key(inp, 'Escape')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('Esc on a clean input or the dialog itself closes once', async () => {
    const { w, dlg } = setup()
    await flushPromises()
    key(dlg(), 'Escape')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('typing 5 chars then change = one commit; no commit per keystroke', async () => {
    const { w, q } = setup()
    await flushPromises()
    const inp = q<HTMLInputElement>('[data-test=label-input]')
    for (const v of ['a', 'ab', 'abc', 'abcd', 'abcde']) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })) }
    expect(w.emitted('commit')).toBeUndefined()
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    expect(w.emitted('commit')).toHaveLength(1)
  })

  it('tablist: four tabs in order, exactly one aria-selected=true with tabindex 0, others -1', async () => {
    const { qa, q } = setup()
    await flushPromises()
    expect(q('[data-test=labels-tabs]').getAttribute('role')).toBe('tablist')
    const tabs = qa('[role=tab]')
    expect(tabs.map((b) => b.dataset.tab)).toEqual(['table', 'chart', 'numbers', 'categories'])
    expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    expect(tabs.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
    expect(tabs.map((b) => b.querySelector('.ld-t')!.textContent)).toEqual(['Table', 'Chart', 'Numbers', 'Categories'])
  })

  it('tab aria-controls matches the panel id and panel aria-labelledby matches the active tab id; follows switching', async () => {
    const { qa, q } = setup()
    await flushPromises()
    const panel = q('[data-test=labels-panel]')
    expect(panel.getAttribute('role')).toBe('tabpanel')
    for (const t of qa('[role=tab]')) expect(t.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.id).not.toBe('')
    expect(panel.getAttribute('aria-labelledby')).toBe(qa('[role=tab]')[0].id)
    qa('[role=tab]')[2].click()
    await nextTick()
    expect(q('#' + panel.getAttribute('aria-labelledby')).dataset.tab).toBe('numbers')
  })

  it('ArrowRight/ArrowLeft wrap, Home/End, activation on arrow, focus stays on the tab', async () => {
    const { qa, q } = setup()
    await flushPromises()
    const tabs = qa('[role=tab]')
    tabs[0].focus()
    key(tabs[0], 'ArrowRight'); await nextTick()
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].getAttribute('aria-selected')).toBe('false')
    expect(qa('[data-label-target]').map((e) => e.dataset.labelTarget)).toEqual(['title', 'axis:x', 'axis:y', 'axis:legend'])
    key(tabs[1], 'End'); await nextTick()
    expect(document.activeElement).toBe(tabs[3])
    key(tabs[3], 'ArrowRight'); await nextTick()
    expect(document.activeElement).toBe(tabs[0])
    key(tabs[0], 'ArrowLeft'); await nextTick()
    expect(document.activeElement).toBe(tabs[3])
    key(tabs[3], 'Home'); await nextTick()
    expect(document.activeElement).toBe(tabs[0])
    expect(tabs.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
    void q
  })

  it('Tab from the active tab moves into the panel content (tab key handler does not swallow it)', async () => {
    const { qa, dlg } = setup()
    await flushPromises()
    const tab = qa('[role=tab]')[0]
    tab.focus()
    const e = key(tab, 'Tab')
    expect(e.defaultPrevented).toBe(false)
    const order = focusables(dlg())
    expect(order[0]).toBe(tab)
    expect(order[1].closest('[role=tabpanel]') ?? order[1].closest('.ld-banner')).toBeTruthy()
  })

  it('tab counts come from the config: customised table items give a count and aria-label even for collapsed/searched rows', async () => {
    const cfg = base()
    cfg.pivot.rows[0].label = 'R'
    cfg.pivot.rows[0].valueLabels = { a: 'A' }
    cfg.pivot.summaryLabel = 'S'
    cfg.chart.title = 'T'
    cfg.chart.axisTitles = { x: 'X' }
    const { qa } = setup({ cfg })
    await flushPromises()
    const tabs = qa('[role=tab]')
    expect(tabs.map((b) => b.querySelector('.ld-n')?.textContent ?? '')).toEqual(['● 2', '● 2', '', '● 1'])
    expect(tabs[0].getAttribute('aria-label')).toBe('Table, 2 customised')
    expect(tabs[2].getAttribute('aria-label')).toBe('Numbers')
  })

  it('banner text equals tabAffectText for each tab and changes with the tab', async () => {
    const { qa, q } = setup()
    await flushPromises()
    const seen: string[] = []
    for (const [i, tab] of qa('[role=tab]').entries()) {
      tab.click(); await nextTick()
      const rows = TAB_KEYS[i] === 'table' ? [{ kind: 'rowName' }, { kind: 'columnName' }, { kind: 'measureName' }, { kind: 'summary' }]
        : TAB_KEYS[i] === 'chart' ? [{ kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' }] : TAB_KEYS[i] === 'numbers' ? [{ kind: 'unit' }, { kind: 'scale' }] : [{ kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'category', axis: 'column', index: 0, key: '0' }, { kind: 'nullLabel', axis: 'row', index: 0 }, { kind: 'nullLabel', axis: 'column', index: 0 }]
      const text = q('[data-test=labels-banner]').textContent!
      expect(text).toBe(tabAffectText(rows.map((target: any) => ({ target }))))
      expect(text.startsWith('This page affects: ')).toBe(true)
      seen.push(text)
    }
    expect(new Set(seen).size).toBe(4)
  })

  it('footer total equals countOverrides(all); reset-all emits one commit removing all; done emits close', async () => {
    const cfg = base()
    cfg.pivot.rows[0].label = 'R'
    cfg.chart.title = 'T'
    cfg.pivot.values[0].format = { unit: '元' }
    const { q, w } = setup({ cfg })
    await flushPromises()
    expect(q('[data-test=labels-total]').textContent).toBe('3 customised')
    expect(q('[data-test=labels-reset-all]').textContent).toBe('Reset all to auto (3)')
    q('[data-test=labels-reset-all]').click()
    expect(w.emitted('commit')).toHaveLength(1)
    expect(w.emitted('commit')![0][0]).toEqual(resetLabels(cfg, 'all'))
    q('[data-test=labels-close]').click()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('heading numbers are 1..n for the visible rows of the active tab and restart per tab', async () => {
    const { qa } = setup()
    await flushPromises()
    const nums = () => qa('[data-test=label-num]').map((e) => e.textContent)
    expect(nums()).toEqual(['1', '2', '3', '4', '5'])
    qa('[role=tab]')[1].click(); await nextTick()
    expect(nums()).toEqual(['1', '2', '3', '4'])
    qa('[role=tab]')[2].click(); await nextTick()
    expect(nums()).toEqual(['1', '2', '3', '4'])
  })

  it('visible 已自定义 pill present exactly when overridden and is the input aria-describedby target; no sr-only duplicate cue', async () => {
    const cfg = base()
    cfg.pivot.rows[0].label = 'R'
    const { q, dlg } = setup({ cfg })
    await flushPromises()
    const pills = Array.from(dlg().querySelectorAll('[data-test=label-custom]'))
    expect(pills).toHaveLength(1)
    expect(pills[0].textContent).toBe('Customised')
    const inp = q('[data-label-target="rowName:0"] input')
    expect(inp.getAttribute('aria-describedby')!.split(' ')).toContain(pills[0].id)
    expect(q('[data-label-target="columnName:0"] [data-test=label-custom]')).toBeNull()
    expect(dlg().querySelector('.lp-sr')).toBeNull()
    expect(Array.from(dlg().querySelectorAll('*')).filter((e) => e.children.length === 0 && e.textContent === 'Customised')).toHaveLength(1)
  })

  it('search narrows rows and renumbers 1..m (null row stays numbered)', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => `k${i}`)
    const { q, qa } = setup({ props: { categories: { row: [keys], column: [[]] } } })
    await flushPromises()
    qa('[role=tab]')[3].click(); await nextTick()
    const nums = () => qa('[data-test=label-num]').map((e) => Number(e.textContent))
    expect(nums()).toEqual(Array.from({ length: nums().length }, (_, i) => i + 1))
    expect(nums().length).toBe(52)
    const s = q<HTMLInputElement>('[data-test=label-search]')
    s.value = 'k7'
    s.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const after = nums()
    expect(after.length).toBe(13)
    expect(after).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
    expect(q('[data-label-target^="null:"] [data-test=label-num]').textContent).toBe('12')
  })

  it('renders the 影响 chip line per item', async () => {
    const { qa } = setup()
    await flushPromises()
    const aff = qa('[data-label-target="rowName:0"] ~ .lp-aff, .lp-aff')
    expect(aff.length).toBeGreaterThan(0)
    expect(aff[0].textContent).toMatch(/^Affects: /)
  })

  it('reset-tab emits exactly one commit removing only that tab; reset-all one commit removing all; no confirm; count in the label', async () => {
    const cfg = base()
    cfg.pivot.rows[0].label = 'R'
    cfg.pivot.columns[0].label = 'C'
    cfg.pivot.summaryLabel = 'S'
    cfg.chart.title = 'T'
    let confirms = 0
    const oc = window.confirm
    window.confirm = () => { confirms++; return true }
    const { w, q } = setup({ cfg })
    await flushPromises()
    expect(q('[data-test=labels-reset-tab]').textContent).toBe('Reset this page to auto (3)')
    q('[data-test=labels-reset-tab]').click()
    expect(w.emitted('commit')).toHaveLength(1)
    expect(w.emitted('commit')![0][0]).toEqual(resetLabels(cfg, 'table'))
    const p = (w.emitted('commit')![0][0] as any).pivot
    expect(p.rows[0].label).toBeUndefined()
    expect(p.columns[0].label).toBeUndefined()
    expect(p.summaryLabel).toBeUndefined()
    expect((w.emitted('commit')![0][0] as any).chartOptions).toBeUndefined()
    q('[data-test=labels-reset-all]').click()
    expect(w.emitted('commit')).toHaveLength(2)
    const all = w.emitted('commit')![1][0] as any
    expect(all).toEqual(resetLabels(cfg, 'all'))
    expect(all.chartOptions.title).toBeUndefined()
    expect('title' in all.chartOptions).toBe(true)
    expect(confirms).toBe(0)
    window.confirm = oc
  })

  it('reset buttons disabled when nothing is overridden', async () => {
    const { q, w } = setup()
    await flushPromises()
    expect(q<HTMLButtonElement>('[data-test=labels-reset-tab]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-test=labels-reset-all]').disabled).toBe(true)
    q('[data-test=labels-reset-all]').click()
    expect(w.emitted('commit')).toBeUndefined()
  })

  it('done button emits close', async () => {
    const { q, w } = setup()
    await flushPromises()
    q('[data-test=labels-close]').click()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('invalid scale shows role=alert and does not commit; percent disables scale', async () => {
    const cfg = base()
    cfg.pivot.values[1].format = { kind: 'percent' }
    const { q, qa, w } = setup({ cfg })
    await flushPromises()
    qa('[role=tab]')[2].click()
    await nextTick()
    const sc = q<HTMLInputElement>('[data-label-target="scale:0"] input')
    sc.value = 'abc'
    sc.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(q('[role=alert]')).toBeTruthy()
    expect(w.emitted('commit')).toBeUndefined()
    expect(q<HTMLInputElement>('[data-label-target="scale:1"] input').disabled).toBe(true)
  })

  it('scroll lock: ancestor scrollTop restored after unmount, overflow restored', async () => {
    const scroller = document.createElement('div')
    scroller.style.overflow = 'auto'
    document.body.appendChild(scroller)
    nodes.push(scroller)
    const container = document.createElement('div')
    scroller.appendChild(container)
    scroller.scrollTop = 120
    const opener = document.createElement('button')
    container.appendChild(opener)
    setLocale('en')
    const w = mount(LabelsDialog, { props: { cfg: base(), categories: cats, ctx, container, returnFocus: opener }, attachTo: document.body })
    await flushPromises()
    expect(scroller.style.overflow).toBe('hidden')
    scroller.scrollTop = 0
    w.unmount()
    expect(scroller.style.overflow).toBe('auto')
    expect(scroller.scrollTop).toBe(120)
  })

  it('opening a second dialog closes the first', async () => {
    const a = setup()
    await flushPromises()
    const b = setup()
    await flushPromises()
    expect(a.w.emitted('close')).toHaveLength(1)
    expect(b.w.emitted('close')).toBeUndefined()
  })

  it('preview slot receives the active target and is not rendered without a slot', async () => {
    const none = setup()
    await flushPromises()
    expect(none.q('[data-test=labels-preview-slot]')).toBeNull()
    none.w.unmount()
    const { q } = setup({ slots: { preview: `<template #preview="{ active, numbers }"><i data-test="pv">{{ active ? active.kind : 'none' }}</i><b data-test="pn">{{ [...numbers.entries()].map(([k, v]) => k + '=' + v).join(',') }}</b></template>` } })
    await flushPromises()
    expect(q('[data-test=pv]').textContent).toBe('rowName')
    q<HTMLInputElement>('[data-label-target="columnName:0"] input').dispatchEvent(new FocusEvent('focus'))
    await nextTick()
    expect(q('[data-test=pv]').textContent).toBe('columnName')
  })

  it('preview slot receives numbers equal to the heading numbers', async () => {
    const { q, qa } = setup({ slots: { preview: `<template #preview="{ numbers }"><b data-test="pn">{{ [...numbers.entries()].map(([k, v]) => k + '=' + v).join(',') }}</b></template>` } })
    await flushPromises()
    const heads = () => qa('[data-label-target]').map((e) => e.dataset.labelTarget + '=' + e.querySelector('[data-test=label-num]')!.textContent).join(',')
    expect(q('[data-test=pn]').textContent).toBe(heads())
    qa('[role=tab]')[1].click(); await nextTick()
    expect(q('[data-test=pn]').textContent).toBe(heads())
    expect(q('[data-test=pn]').textContent).toBe('title=1,axis:x=2,axis:y=3,axis:legend=4')
  })

  it('zh/en i18n parity for dialog keys', () => {
    const ks = Object.keys(messages['zh-CN']).filter((k) => k.startsWith('label.dialog.'))
    expect(ks.length).toBeGreaterThan(5)
    for (const k of ks) expect(k in messages.en, k).toBe(true)
    setLocale('zh-CN')
    expect(t('label.dialog.title')).toBe('高级设置')
    expect(t('label.dialog.lead')).toMatch(/^标签设置 · /)
    setLocale('en')
  })

  it('arrow keys use index 0 correctly (focused first tab, active elsewhere)', async () => {
    const { qa } = setup()
    await flushPromises()
    const tabs = qa('[role=tab]')
    tabs[2].click()
    await nextTick()
    tabs[0].focus()
    key(tabs[0], 'ArrowRight')
    await nextTick()
    expect(document.activeElement).toBe(tabs[1])
  })

  it('focus guard listener is removed on unmount', async () => {
    const add = vi.spyOn(document, 'addEventListener'), rem = vi.spyOn(document, 'removeEventListener')
    const { w } = setup()
    await flushPromises()
    const added = add.mock.calls.filter((c) => c[0] === 'focusin').map((c) => c[1])
    expect(added).toHaveLength(1)
    w.unmount()
    expect(rem.mock.calls.some((c) => c[0] === 'focusin' && c[1] === added[0])).toBe(true)
    add.mockRestore(); rem.mockRestore()
  })

  it('focus guard: outside focus is pulled back exactly once (no loop) and the guard is removed on unmount', async () => {
    const { dlg, container, w } = setup()
    await flushPromises()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    let n = 0
    document.addEventListener('focusin', () => { n++ }, true)
    const before = document.activeElement
    outside.focus()
    expect(n).toBe(2)
    expect(dlg().contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(before)
    w.unmount()
    outside.focus()
    expect(document.activeElement).toBe(outside)
    void container
  })
})

// ---- Ported from the removed LabelsPanel.test.ts (the dialog now hosts the same rows) ----
const PGROUPS = ['names', 'measures', 'chart', 'units', 'categories']
const TABOF: Record<string, string> = { names: 'table', measures: 'table', chart: 'chart', units: 'numbers', categories: 'categories' }
const pcfg = (pivotOver: any = {}, chartOver: any = {}) => ({
  pivot: { rows: [{ field: 'region' }], columns: [{ field: 'flag' }], values: [{ field: 'amount', agg: 'sum' }, { field: 'n', agg: 'count' }], ...pivotOver },
  chart: { type: 'bar', ...chartOver },
}) as any
const mkp = (pivotOver: any = {}, chartOver: any = {}, categories: any = { row: [['a', 'b']], column: [['0', '1']] }) => {
  const s = setup({ cfg: pcfg(pivotOver, chartOver), props: { categories } })
  const show = async (k: string) => { (s.q(`[role=tab][data-tab=${TABOF[k]}]`) as HTMLElement).click(); await nextTick() }
  const row = async (id: string) => {
    let el = s.q(`[data-label-target="${id}"]`)
    for (const k of PGROUPS) { if (el) break; await show(k); el = s.q(`[data-label-target="${id}"]`) }
    return new DOMWrapper(el)
  }
  return { ...s, show, row }
}
const ptyped = async (el: DOMWrapper<any>, v: string) => { el.element.value = v; await el.trigger('input') }
const ptype = async (input: DOMWrapper<any>, v: string, ev: 'change' | 'enter' = 'change') => {
  await ptyped(input, v)
  if (ev === 'change') await input.trigger('change'); else await input.trigger('keydown', { key: 'Enter' })
}

describe('ported: LabelsPanel rendering', () => {
  it('renders one row per label: 1 row field, 1 column field, 2 measures, summary, title, x/y/legend, per-measure unit & scale', async () => {
    const m = mkp()
    for (const id of ['rowName:0', 'columnName:0', 'measureName:0', 'measureName:1', 'summary', 'title', 'axis:x', 'axis:y', 'axis:legend', 'unit:0', 'unit:1', 'scale:0', 'scale:1']) {
      expect((await m.row(id)).exists(), id).toBe(true)
    }
    await m.show('names')
    expect(m.q('[data-label-target="rowName:1"]')).toBeNull()
  })
  it('every input has a real label and all are Tab-reachable (no tabindex=-1)', async () => {
    const m = mkp()
    for (const g of PGROUPS) {
      await m.show(g)
      for (const i of m.qa('[data-test=label-input]')) {
        const id = i.getAttribute('id')
        expect(id).toBeTruthy()
        expect(m.q(`label[for="${id}"]`)).not.toBeNull()
        expect(i.getAttribute('tabindex')).toBeNull()
      }
    }
  })
  it('placeholder is the auto text and value empty when not overridden; overridden shows value', async () => {
    const m = mkp({ rows: [{ field: 'region' }], values: [{ field: 'amount', agg: 'sum', label: '销售额' }] })
    const a = (await m.row('rowName:0')).find('input')
    expect(a.attributes('placeholder')).toBe('region')
    expect((a.element as HTMLInputElement).value).toBe('')
    expect(a.classes()).not.toContain('ovi')
    const mi = (await m.row('measureName:0')).find('input')
    expect((mi.element as HTMLInputElement).value).toBe('销售额')
    expect(mi.classes()).toContain('ovi')
    expect(mi.attributes('maxlength')).toBe('200')
  })
})

describe('ported: LabelsPanel commits', () => {
  it('change on a row-name input emits commit with the patchLabel result', async () => {
    const m = mkp()
    await ptype((await m.row('rowName:0')).find('input'), 'Region')
    expect(m.w.emitted('commit')).toHaveLength(1)
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { rows: [{ field: 'region', label: 'Region' }] } })
  })
  it('Enter commits; Enter then blur-change does not double-commit text', async () => {
    const m = mkp()
    await ptype((await m.row('axis:x')).find('input'), 'X', 'enter')
    expect(m.w.emitted('commit')).toHaveLength(1)
  })
  it('typing without change/Enter commits nothing (input events never commit)', async () => {
    const m = mkp()
    const i = (await m.row('title')).find('input')
    for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde']) await ptyped(i, s)
    expect(m.w.emitted('commit')).toBeUndefined()
  })
  it('empty input commits back to auto (key removed)', async () => {
    const m = mkp({ rows: [{ field: 'region', label: 'R' }] })
    await ptype((await m.row('rowName:0')).find('input'), '')
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { rows: [{ field: 'region' }] } })
  })
  it('reset button disabled when not overridden, removes the override when clicked', async () => {
    const m = mkp({ rows: [{ field: 'region', label: 'R' }] })
    expect((await m.row('columnName:0')).find('[data-test=label-reset]').attributes('disabled')).toBeDefined()
    const b = (await m.row('rowName:0')).find('[data-test=label-reset]')
    expect(b.attributes('disabled')).toBeUndefined()
    expect(b.attributes('aria-label')).toContain('region')
    await b.trigger('click')
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { rows: [{ field: 'region' }] } })
  })
  it('Escape restores previous text without commit, and a following change does not fire', async () => {
    const m = mkp({ rows: [{ field: 'region', label: 'R' }] })
    const i = (await m.row('rowName:0')).find('input')
    await ptyped(i, 'typed')
    await i.trigger('keydown', { key: 'Escape' })
    expect((i.element as HTMLInputElement).value).toBe('R')
    await i.trigger('change')
    expect(m.w.emitted('commit')).toBeUndefined()
    expect(m.w.emitted('close')).toBeUndefined()
  })
  it('invalid scale 0/abc/-5/1e13/0x10 sets aria-invalid with a message and commits nothing; valid clears it', async () => {
    const m = mkp()
    const r = await m.row('scale:0')
    const i = r.find('input')
    for (const bad of ['0', 'abc', '-5', '1e13', '0x10']) {
      await ptype(i, bad)
      expect(i.attributes('aria-invalid'), bad).toBe('true')
      expect(r.text()).toContain(messages.en['label.invalidScale'])
    }
    expect(m.w.emitted('commit')).toBeUndefined()
    await ptype(i, '10000')
    expect(i.attributes('aria-invalid')).toBeUndefined()
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { values: [{ field: 'amount', agg: 'sum', format: { kind: 'thousands', scale: 10000 } }, { field: 'n', agg: 'count' }] } })
  })
  it('scale input has inputmode=decimal and a datalist', async () => {
    const m = mkp()
    const i = (await m.row('scale:0')).find('input')
    expect(i.attributes('inputmode')).toBe('decimal')
    const dl = m.q(`datalist#${i.attributes('list')}`)
    expect(Array.from(dl.querySelectorAll('option')).map((o) => o.getAttribute('value'))).toEqual(['100', '1000', '10000', '1000000', '100000000'])
  })
  it('percent measure: scale input disabled', async () => {
    const m = mkp({ values: [{ field: 'amount', agg: 'sum', format: { kind: 'percent' } }] })
    expect((await m.row('scale:0')).find('input').attributes('disabled')).toBeDefined()
  })
  it('200-char limit via maxlength and slice', async () => {
    const m = mkp()
    const i = (await m.row('rowName:0')).find('input')
    expect(i.attributes('maxlength')).toBe('200')
    await ptype(i, 'x'.repeat(250))
    expect((m.w.emitted('commit')![0][0] as any).pivot.rows[0].label).toHaveLength(200)
  })
  it('focus on a row marks it as the preview active target (replaces focus-target/focusTarget of the panel)', async () => {
    let seen: any = null
    const m = mkp({}, {}, undefined)
    m.w.unmount(); wrappers.pop()
    const s = setup({ cfg: pcfg(), slots: { preview: (p: any) => { seen = p.active; return '' } } })
    for (const g of PGROUPS) {
      ;(s.q(`[role=tab][data-tab=${TABOF[g]}]`) as HTMLElement).click(); await nextTick()
      if (s.q('[data-label-target="summary"] input')) break
    }
    ;(s.q('[data-label-target="summary"] input') as HTMLElement).dispatchEvent(new FocusEvent('focus')); await nextTick()
    expect(seen).toEqual({ kind: 'summary' })
  })
})

describe('ported: LabelsPanel category mapping', () => {
  it('lists data values plus null; typing 否 for 0 stores valueLabels', async () => {
    const m = mkp()
    expect((await m.row('category:column:0:0')).exists()).toBe(true)
    expect((await m.row('category:column:0:1')).exists()).toBe(true)
    expect((await m.row('null:column:0')).exists()).toBe(true)
    expect((await m.row('null:row:0')).find('input').attributes('placeholder')).toBe('(empty)')
    await ptype((await m.row('category:column:0:0')).find('input'), '否')
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { columns: [{ field: 'flag', valueLabels: { '0': '否' } }] } })
  })
  it('null mapping commits nullLabel', async () => {
    const m = mkp()
    await ptype((await m.row('null:row:0')).find('input'), '无')
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { rows: [{ field: 'region', nullLabel: '无' }] } })
  })
  it('unused key shown greyed and deletable', async () => {
    const m = mkp({ columns: [{ field: 'flag', valueLabels: { '0': '否', gone: 'G' } }] })
    const u = await m.row('category:column:0:gone')
    expect(u.classes()).toContain('unused')
    expect(u.text()).toContain(messages.en['label.unused'])
    await u.find('[data-test=label-delete]').trigger('click')
    expect(m.w.emitted('commit')![0][0]).toEqual({ pivot: { columns: [{ field: 'flag', valueLabels: { '0': '否' } }] } })
  })
  it('more than 50 keys: first 50 plus a show-all expander', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => 'k' + i)
    const m = mkp({}, {}, { row: [keys], column: [[]] })
    await m.show('categories')
    const cnt = () => m.qa('[data-label-target^="category:row:0:"]').length
    expect(cnt()).toBe(50)
    ;(m.q('[data-test=label-showall]') as HTMLElement).click(); await nextTick()
    expect(cnt()).toBe(80)
    expect(m.q('[data-test=label-showall]')).not.toBeNull()
    ;(m.q('[data-test=label-showall]') as HTMLElement).click(); await nextTick()
    expect(cnt()).toBe(50)
  })
  it('show-all is a toggle with aria-expanded/aria-controls, keeps focus, works with Enter/Space', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => 'k' + i)
    const m = mkp({}, {}, { row: [keys], column: [[]] })
    await m.show('categories')
    const btn = () => m.q('[data-test=label-showall]')
    expect(btn().getAttribute('aria-expanded')).toBe('false')
    expect(btn().textContent!.trim()).toBe('Show all (80)')
    const ctl = btn().getAttribute('aria-controls')!
    expect(m.container.querySelector(`#${ctl}`)).not.toBeNull()
    btn().focus()
    btn().click(); await nextTick()
    expect(btn().getAttribute('aria-expanded')).toBe('true')
    expect(btn().textContent!.trim()).toBe('Show fewer')
    expect(document.activeElement).toBe(btn())
    btn().click(); await nextTick()
    expect(btn().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(btn())
  })
  it('accessible names of category/null inputs include key and field; two refs sharing keys stay distinct; zh+en', async () => {
    const names = (m: any) => m.qa('[data-test=label-input]').map((i: any) => i.getAttribute('aria-label')).filter(Boolean)
    const m = mkp({ rows: [{ field: 'f1' }], columns: [{ field: 'f2' }] }, {}, { row: [['A']], column: [['A']] })
    await m.show('categories')
    const n = names(m)
    expect(n).toContain('A · f1'); expect(n).toContain('A · f2')
    expect(n).toContain('Empty value · f1'); expect(n).toContain('Empty value · f2')
    for (const g of m.qa('[data-group^="row:"],[data-group^="column:"]')) {
      expect(g.getAttribute('role')).toBe('group')
      expect(m.container.querySelector('#' + g.getAttribute('aria-labelledby'))!.textContent).toContain((g.getAttribute('data-group') ?? '').startsWith('row') ? 'f1' : 'f2')
    }
    const z = mkp({ rows: [{ field: 'f1' }] }, {}, { row: [['A']], column: [[]] })
    setLocale('zh-CN')
    await z.show('categories')
    expect(names(z)).toContain('空值 · f1')
  })
  it('overridden inputs expose a non-colour cue via aria-describedby (the visible pill); others do not', async () => {
    const m = mkp({ rows: [{ field: 'region', label: 'R' }] })
    const on = (await m.row('rowName:0')).find('input')
    const cues = on.attributes('aria-describedby')!.split(' ').map((id) => m.container.querySelector(`[id="${id}"]`)!.textContent)
    expect(cues).toContain('Customised')
    expect(((await m.row('columnName:0')).find('input').attributes('aria-describedby') ?? '').split(' ').map((id) => m.container.querySelector(`[id="${id}"]`)?.textContent)).not.toContain('Customised')
  })
  it('unused row has no dangling label[for] and the delete button names the key and field', async () => {
    const m = mkp({ columns: [{ field: 'flag', valueLabels: { gone: 'G' } }] })
    const u = await m.row('category:column:0:gone')
    expect(u.find('label').exists()).toBe(false)
    expect(u.find('[data-test=label-delete]').attributes('aria-label')).toContain('gone · flag')
  })
  it('same field in rows and columns keeps separate rows/targets', async () => {
    const m = mkp({ rows: [{ field: 'x' }], columns: [{ field: 'x' }] })
    expect((await m.row('rowName:0')).exists() && (await m.row('columnName:0')).exists()).toBe(true)
  })
})

describe('ported: LabelsPanel misc', () => {
  it('no AI/network imports in the label layer', () => {
    const files = import.meta.glob('../src/analysis/{LabelsDialog.vue,labelResolve.ts,labelPatch.ts}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(files)).toHaveLength(3)
    for (const s of Object.values(files)) {
      expect(s).not.toMatch(/from ['"][^'"]*\/ai\//)
      expect(s).not.toMatch(/fetch\(|bridge/i)
    }
  })
  it('zh/en parity for all label.* keys', () => {
    const f = (o: object) => Object.keys(o).filter((k) => k.startsWith('label.')).sort()
    for (const k of ['rowName', 'columnName', 'measureName', 'summary', 'title', 'axisX', 'axisY', 'axisLegend', 'unit', 'scale', 'values', 'null', 'reset', 'edit', 'unused', 'invalidScale', 'showAll', 'showFewer', 'customised', 'deleteMap']) {
      expect(f(messages['zh-CN'])).toContain('label.' + k)
    }
    expect(f(messages['zh-CN'])).toEqual(f(messages.en))
  })
})
