import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultTable from '../src/blocks/ResultTable.vue'

const src = (import.meta as any).glob('../src/blocks/ResultTable.vue', { query: '?raw', import: 'default', eager: true })['../src/blocks/ResultTable.vue'] as string
const css = src.slice(src.indexOf('<style'))
const rule = (sel: string) => css.split('\n').filter((l: string) => l.trim().startsWith(sel + ' {') || l.trim().startsWith(sel + ',')).join('\n')
const res = { columns: [{ name: 'dimension' }, { name: 'status' }], rows: [[1, 2]], truncated: false, elapsedMs: 1, dbType: 'x' }

describe('ResultTable sticky column', () => {
  it('sticky rowno cells have no bleed: separate borders, opaque bg, left shadow', () => {
    expect(rule('table')).toMatch(/border-collapse: separate/)
    expect(rule('table')).toMatch(/border-spacing: 0/)
    for (const s of ['td.rowno', 'th.rowno']) expect(rule(s)).toMatch(/border-right: 1px solid var\(--color-border/)
    for (const s of ['td.rowno', 'th.rowno']) expect(rule(s)).not.toMatch(/box-shadow/)
  })
  it('border is on the wrapper, not the scroller; scroller isolates stacking', () => {
    expect(rule('.vp-wrap')).toMatch(/border: 1px solid/)
    expect(rule('.viewport')).not.toMatch(/border:/)
    expect(rule('.viewport')).toMatch(/isolation: isolate/)
    const w = mount(ResultTable, { props: { result: res } })
    expect(w.find('.vp-wrap > .viewport').exists()).toBe(true)
  })
})
