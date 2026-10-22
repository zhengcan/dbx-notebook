import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LabelsPreview from '../src/analysis/LabelsPreview.vue'

const ctx = { empty: '(空)', summary: '汇总' }
const cfg = (over: any = {}) => ({ pivot: { rows: [{ field: 'r', label: over.row }], columns: [{ field: 'q' }], values: [{ field: 'a', agg: 'sum', label: over.m, format: { kind: 'thousands', unit: over.unit } }], summaryLabel: over.sum }, chart: { type: 'bar', title: over.title } } as any)
const mnt = (c: any, active: any = null, categories?: any) => mount(LabelsPreview, { props: { cfg: c, ctx, active, categories } })

describe('LabelsPreview', () => {
  it('hostile labels are text', () => {
    const bad = ['<img src=x onerror=alert(1)>', '&amp;', 'x'.repeat(200), 'مبيعات', '🚀', '{{x}}', '"q"']
    const w = mnt(cfg({ row: bad[0], m: bad[1], title: bad[2], sum: bad[3], unit: bad[4] }), null, { rows: [[bad[5], bad[6]]] })
    expect(w.element.querySelector('img')).toBeNull()
    expect(w.html()).toContain('&lt;img')
    expect(w.text()).toContain('&amp;'); expect(w.text()).toContain('مبيعات'); expect(w.text()).toContain('🚀'); expect(w.text()).toContain('{{x}}')
    expect(w.text()).toContain('x'.repeat(200))
  })
  it('aria-hidden, no focusables, no injections', () => {
    const w = mnt(cfg())
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.element.querySelector('a,button,input,select,textarea,[tabindex]')).toBeNull()
  })
  it('highlights reactively', async () => {
    const w = mnt(cfg({ title: 'T' }))
    expect(w.findAll('[data-active="true"]').length).toBe(0)
    await w.setProps({ active: { kind: 'title' } })
    const a = w.findAll('[data-active="true"]')
    expect(a.length).toBe(1); expect(a[0].text()).toBe('T')
    await w.setProps({ cfg: cfg({ title: 'New' }) })
    expect(w.find('[data-active="true"]').text()).toBe('New')
  })
  it('no rows/values do not throw', () => {
    expect(() => mnt({ pivot: { rows: [], columns: [], values: [] }, chart: {} })).not.toThrow()
  })
  it('grid: group headers span their measure columns; one measure header per group x measure', () => {
    const c = { pivot: { rows: [{ field: 'r' }], columns: [{ field: 'q' }], values: [{ field: 'a', agg: 'sum', label: 'M1' }, { field: 'b', agg: 'sum', label: 'M2' }] }, chart: {} } as any
    const w = mnt(c, null, { columns: [['Q1', 'Q2']] })
    expect(w.findAll('.lpv-grp').map((g) => g.attributes('style'))).toEqual([expect.stringContaining('span 2'), expect.stringContaining('span 2')])
    expect(w.findAll('.lpv-meas').map((x) => x.text())).toEqual(['M1', 'M2', 'M1', 'M2'])
    expect(w.find('.lpv-grid').attributes('style')).toContain('repeat(1,')
    expect(w.findAll('.lpv-row,.lpv-num').length).toBeGreaterThan(0)
  })
})

describe('LabelsPreview badges', () => {
  const nums = new Map([['rowName:0', 1], ['title', 2], ['unit:0', 3], ['scale:0', 4]])
  const mn = (c: any, numbers?: Map<string, number>) => mount(LabelsPreview, { props: { cfg: c, ctx, active: null, categories: undefined, numbers } })
  it('badges are aria-hidden, textContent is the digit; no numbers -> none', () => {
    const w = mn(cfg({ title: 'T', unit: 'u' }), nums)
    const bs = w.findAll('.lp-badge')
    expect(bs.map((b) => b.text()).sort()).toEqual(['1', '2', '3', '4'])
    expect(bs.every((b) => b.attributes('aria-hidden') === 'true')).toBe(true)
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.element.querySelector('a,button,input,select,textarea,[tabindex]')).toBeNull()
    expect(mn(cfg({ title: 'T' })).findAll('.lp-badge').length).toBe(0)
    expect(mn(cfg({ title: 'T' }), new Map()).findAll('.lp-badge').length).toBe(0)
  })
  it('badge sits on the item it numbers (rowName 1 on the row header, title 2 on the title)', () => {
    const w = mn(cfg({ row: 'RR', title: 'TT' }), nums)
    expect(w.find('.lpv-hd .lp-badge').text()).toBe('1')
    expect(w.find('.lpv-hd .lp-badge').element.parentElement!.textContent).toContain('RR')
    expect(w.find('.lpv-title .lp-badge').text()).toBe('2')
    expect(w.findAll('.lpv-num')[0].findAll('.lp-badge').map((b) => b.text())).toEqual(['3', '4'])
  })
  it('measure headers repeat per column group but each measure digit is drawn once', () => {
    const c = { pivot: { rows: [{ field: 'r' }], columns: [{ field: 'q' }], values: [{ field: 'a', agg: 'sum', label: 'M1' }, { field: 'b', agg: 'sum', label: 'M2' }] }, chart: {} } as any
    const w = mount(LabelsPreview, { props: { cfg: c, ctx, active: null, categories: { columns: [['Q1', 'Q2']] }, numbers: new Map([['measureName:0', 1], ['measureName:1', 2]]) } })
    expect(w.findAll('.lpv-meas').length).toBe(4)
    expect(w.findAll('.lp-badge').map((b) => b.text())).toEqual(['1', '2'])
  })
  it('hostile labels stay text with badges present; digits unaffected', () => {
    const bad = ['<img src=x onerror=alert(1)>', 'x'.repeat(200), 'مبيعات']
    const w = mn(cfg({ row: bad[0], title: bad[1], sum: bad[2] }), nums)
    expect(w.element.querySelector('img')).toBeNull()
    expect(w.html()).toContain('&lt;img')
    expect(w.text()).toContain('x'.repeat(200)); expect(w.text()).toContain('مبيعات')
    expect(w.findAll('.lp-badge').map((b) => b.text()).sort()).toEqual(['1', '2', '3', '4'])
  })
  it('badge is absolutely positioned and non-interactive (no layout shift), on a relative item', () => {
    const css = (import.meta as any).glob('../src/analysis/LabelsPreview.vue', { query: '?raw', import: 'default', eager: true })['../src/analysis/LabelsPreview.vue'] as string
    const rule = css.match(/\.lp-badge\s*\{[^}]*\}/)![0]
    expect(rule).toMatch(/position:\s*absolute/); expect(rule).toMatch(/pointer-events:\s*none/)
    expect(css).toMatch(/\.lpv-c\s*\{[^}]*position:\s*relative/)
    expect(rule).toMatch(/min-width:\s*1[4-9]px|min-width:\s*[2-9]\d px/)
  })
})
