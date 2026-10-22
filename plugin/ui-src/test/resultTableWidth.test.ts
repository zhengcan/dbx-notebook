import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultTable from '../src/blocks/ResultTable.vue'

const src = (import.meta as any).glob('../src/blocks/ResultTable.vue', { query: '?raw', import: 'default', eager: true })['../src/blocks/ResultTable.vue'] as string
const css = src.slice(src.indexOf('<style'))
const rule = (sel: string) => css.split('\n').filter((l: string) => l.trim().startsWith(sel + ' {') || l.trim().startsWith(sel + ',')).join('\n')
const res = { columns: [{ name: 'dimension' }, { name: 'status' }], rows: [[1, 2]], truncated: false, elapsedMs: 1, dbType: 'x' }

describe('ResultTable column widths', () => {
  it('table never stretches columns beyond the colgroup widths', () => {
    expect(rule('table')).not.toMatch(/min-width/)
    expect(rule('table')).toMatch(/table-layout: fixed/)
  })
  it('transposed colgroup honours computed name width and table width is the sum', () => {
    const w = mount(ResultTable, { props: { result: res, transposed: true } })
    expect(w.findAll('col')[0].attributes('style')).toContain('width: 80px')
    expect(w.find('table').attributes('style')).toContain('width: 400px')
  })
})
