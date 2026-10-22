import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultTable from '../src/blocks/ResultTable.vue'

const src = (import.meta as any).glob('../src/blocks/ResultTable.vue', { query: '?raw', import: 'default', eager: true })['../src/blocks/ResultTable.vue'] as string
const css = src.slice(src.indexOf('<style'))
const rule = (sel: string) => css.split('\n').filter((l: string) => l.trim().startsWith(sel + ' {') || l.trim().startsWith(sel + ',')).join('\n')
const res = { columns: [{ name: 'dimension' }, { name: 'status' }], rows: [[1, 2]], truncated: false, elapsedMs: 1, dbType: 'x' }

describe('ResultTable transposed alignment', () => {
  it('transposed view left-aligns numbers; normal keeps them right', () => {
    const t = mount(ResultTable, { props: { result: res, transposed: true } })
    expect(t.find('.viewport').classes()).toContain('transposed')
    expect(css).toMatch(/\.transposed td\.num[^{]*\{[^}]*text-align: left/)
    const n = mount(ResultTable, { props: { result: { ...res, rows: [[1, 2], [3, 4]] } } })
    expect(n.find('.viewport').classes()).not.toContain('transposed')
    expect(n.find('td.num').exists()).toBe(true)
  })
})
