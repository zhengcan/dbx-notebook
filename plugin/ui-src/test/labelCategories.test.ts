import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import LabelsDialog from '../src/analysis/LabelsDialog.vue'
import { setLocale, messages } from '../src/i18n'

const ctx = { empty: '(empty)', summary: 'Summary' }
const mk = (n: number) => Array.from({ length: n }, (_, i) => (i % 10 === 0 ? `渠道${i}` : `Key${i}`))
let ws: VueWrapper<any>[] = []
afterEach(() => { ws.forEach((w) => { try { w.unmount() } catch { /* */ } }); ws = []; document.body.innerHTML = '' })

async function setup(n: number, valueLabels?: Record<string, string>) {
  setLocale('en')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const cfg = { pivot: { rows: [{ field: 'region', valueLabels }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chart: { type: 'bar' } } as any
  const w = mount(LabelsDialog, { props: { cfg, categories: { row: [mk(n)], column: [] }, ctx, container, returnFocus: container }, attachTo: document.body })
  ws.push(w)
  await flushPromises()
  const btn = container.querySelector('[data-tab=categories]') as HTMLElement
  btn.click()
  await flushPromises()
  const q = <T extends HTMLElement>(s: string) => container.querySelector(s) as T
  const inputs = () => container.querySelectorAll('section.lp-group .lp-row').length
  const type = async (v: string) => { const i = q<HTMLInputElement>('[data-test=label-search]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises() }
  return { w, container, q, inputs, type }
}

describe('category search', () => {
  it('absent at 50 keys, present at 51', async () => {
    expect((await setup(50)).q('[data-test=label-search]')).toBeNull()
    document.body.innerHTML = ''
    expect((await setup(51)).q('[data-test=label-search]')).not.toBeNull()
  })
  it('120 keys render 50 (+null) rows until search/show-all; search narrows to matches over the full list', async () => {
    const s = await setup(120)
    expect(s.inputs()).toBe(51)
    await s.type('key115')
    expect(s.inputs()).toBe(2)
    expect(s.q('[data-test=label-search-count]').textContent).toBe('1 of 120 match')
    await s.type('渠道')
    expect(s.inputs()).toBe(13)
    await s.type('')
    expect(s.inputs()).toBe(51)
  })
  it('matches display text and unused mappings and null row', async () => {
    const s = await setup(60, { Key1: '是的', gone: '已删' })
    await s.type('是的'); expect(s.inputs()).toBe(2)
    await s.type('已删'); expect(s.inputs()).toBe(2)
    await s.type('empty'); expect(s.inputs()).toBe(1)
    await s.type('Key1'); expect(s.inputs()).toBeGreaterThan(2)
  })
  it('count region is a polite status; no-match message is role=status', async () => {
    const s = await setup(60)
    const c = s.q('[data-test=label-search-count]')
    expect(c.getAttribute('role')).toBe('status'); expect(c.getAttribute('aria-live')).toBe('polite')
    await s.type('zzzz')
    expect(s.q('[data-test=label-search-empty]').getAttribute('role')).toBe('status')
    expect(s.q('[data-test=label-search-empty]').textContent).toBe('No matches')
    expect(s.q('[data-test=label-search-count]').textContent).toBe('0 of 60 match')
  })
  it('input has a real label with the field; wrapped in role=search', async () => {
    const s = await setup(60)
    const i = s.q<HTMLInputElement>('[data-test=label-search]')
    expect(s.container.querySelector(`label[for="${i.id}"]`)!.textContent).toBe('Search values · region')
    expect(i.closest('[role=search]')).not.toBeNull()
  })
  it('clear button has a name, empties the query and returns focus to the input', async () => {
    const s = await setup(60)
    await s.type('key')
    const b = s.q<HTMLButtonElement>('[data-test=label-search-clear]')
    expect(b.getAttribute('aria-label')).toBe('Clear search')
    b.focus(); b.click(); await flushPromises()
    expect(document.activeElement).toBe(s.q('[data-test=label-search]'))
    expect(s.q<HTMLInputElement>('[data-test=label-search]').value).toBe('')
  })
  it('caps at 200 with a message', async () => {
    const s = await setup(5000)
    await s.type('key')
    expect(s.inputs()).toBe(201)
    expect(s.q('[data-test=label-search-capped]').textContent).toContain('200')
  })
  it('typing never commits; committing keeps the query', async () => {
    const s = await setup(60)
    await s.type('key5')
    expect(s.w.emitted('commit')).toBeUndefined()
    const row = s.container.querySelector('section.lp-group input:not([data-test=label-search])') as HTMLInputElement
    row.focus(); row.value = 'X'; row.dispatchEvent(new Event('input', { bubbles: true })); row.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    expect(s.w.emitted('commit')).toHaveLength(1)
    expect(s.q<HTMLInputElement>('[data-test=label-search]').value).toBe('key5')
  })
  it('show-all toggle keeps aria-expanded/controls and search ignores toggle state', async () => {
    const s = await setup(120)
    const t = s.q('[data-test=label-showall]')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(s.container.querySelector(`#${t.getAttribute('aria-controls')}`)).not.toBeNull()
    t.click(); await flushPromises()
    expect(s.q('[data-test=label-showall]').getAttribute('aria-expanded')).toBe('true')
    expect(s.inputs()).toBe(121)
    await s.type('key115'); expect(s.inputs()).toBe(2)
  })
  it('120 keys show-all renders quickly', async () => {
    const s = await setup(120)
    const t0 = performance.now(); s.q('[data-test=label-showall]').click(); await flushPromises()
    expect(performance.now() - t0).toBeLessThan(500)
  })
  it('null row always present during a query (no match, some match)', async () => {
    const s = await setup(60)
    const nullRow = () => s.container.querySelectorAll('section.lp-group[data-group="row:0"] [data-label-target^="null:"]').length
    await s.type('zzzz')
    expect(s.q('[data-test=label-search-empty]').textContent).toBe('No matches')
    expect(s.inputs()).toBe(1)
    await s.type('key5')
    expect(s.inputs()).toBe(11)
    expect(nullRow()).toBe(1)
  })
  it('null row commit works while a query is active, query kept', async () => {
    const s = await setup(60)
    await s.type('zzzz')
    const row = s.container.querySelector('section.lp-group[data-group="row:0"] .lp-row input') as HTMLInputElement
    row.value = 'N/A'; row.dispatchEvent(new Event('input', { bubbles: true })); row.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const c = s.w.emitted('commit') as any[]
    expect(c).toHaveLength(1)
    expect(JSON.stringify(c[0])).toContain('N/A')
    expect(s.q<HTMLInputElement>('[data-test=label-search]').value).toBe('zzzz')
  })
  it('toggle hidden during a query and restored with aria-expanded kept', async () => {
    const s = await setup(120)
    s.q('[data-test=label-showall]').click(); await flushPromises()
    await s.type('key5')
    expect(s.q('[data-test=label-showall]')).toBeNull()
    await s.type('')
    expect(s.q('[data-test=label-showall]').getAttribute('aria-expanded')).toBe('true')
    await s.type('   ')
    expect(s.q('[data-test=label-showall]')).not.toBeNull()
  })
  it('query clears when the field at that index changes', async () => {
    const s = await setup(60)
    await s.type('key5')
    const cfg = JSON.parse(JSON.stringify(s.w.props('cfg')))
    cfg.pivot.rows[0].field = 'other'
    await s.w.setProps({ cfg })
    await flushPromises()
    expect(s.q<HTMLInputElement>('[data-test=label-search]').value).toBe('')
    expect(s.inputs()).toBe(51)
  })
  it('i18n parity', () => {
    for (const k of ['label.search', 'label.search.clear', 'label.search.count', 'label.search.capped', 'label.search.none']) {
      setLocale('zh-CN'); const z = (messages as any)['zh-CN']?.[k]; setLocale('en'); const e = (messages as any).en?.[k]
      expect(z, k).toBeTruthy(); expect(e, k).toBeTruthy()
    }
  })
})
