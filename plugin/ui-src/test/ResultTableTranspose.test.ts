import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultTable from '../src/blocks/ResultTable.vue'
import { TRANSPOSE_MAX_ROWS } from '../src/blocks/grid/transpose'
import { setLocale } from '../src/i18n'

const make = (rows: unknown[][], names = ['id', 'name']) => ({
  columns: names.map((n) => ({ name: n, dataType: n === 'id' ? 'int' : 'text' })),
  rows, truncated: false, elapsedMs: 1, dbType: 'x',
})
const rows3 = [[1, 'a'], [2, null], [3, 'c']]
const btn = (w: any) => w.find('[data-test="transpose"]')
const keyC = async (w: any, shift = false) => w.find('.viewport').trigger('keydown', { key: 'c', ctrlKey: true, shiftKey: shift })

describe('ResultTable transpose', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('exports max rows', () => { expect(TRANSPOSE_MAX_ROWS).toBe(20) })
  it('toggle visible only for 1..20 rows with columns', async () => {
    expect(btn(mount(ResultTable, { props: { result: make(rows3) } })).exists()).toBe(true)
    const twenty = Array.from({ length: 20 }, (_, i) => [i, 'x'])
    expect(btn(mount(ResultTable, { props: { result: make(twenty) } })).exists()).toBe(true)
    const many = Array.from({ length: 21 }, (_, i) => [i, 'x'])
    expect(btn(mount(ResultTable, { props: { result: make(many) } })).exists()).toBe(false)
    expect(btn(mount(ResultTable, { props: { result: make([]) } })).exists()).toBe(false)
    expect(btn(mount(ResultTable, { props: { result: make([[]], []) } })).exists()).toBe(false)
  })
  it('aria-pressed and labels zh/en', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    expect(btn(w).attributes('aria-pressed')).toBe('false')
    expect(btn(w).attributes('aria-label')).toBe('转置结果表')
    expect(btn(w).text()).toBe('转置')
    await btn(w).trigger('click')
    expect(btn(w).attributes('aria-pressed')).toBe('true')
    setLocale('en')
    const e = mount(ResultTable, { props: { result: make(rows3) } })
    expect(btn(e).attributes('aria-label')).toBe('Transpose result table')
    expect(btn(e).text()).toBe('Transpose')
  })
  it('renders transposed headers and rows', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    await btn(w).trigger('click')
    expect(w.findAll('thead th').map((t) => t.text())).toEqual(['#', '#1', '#2', '#3'])
    const trs = w.findAll('tbody tr[data-row]')
    expect(trs.map((r) => r.find('td.rowno').text())).toEqual(['id', 'name'])
    expect(trs[0].find('td.rowno').attributes('title')).toBe('id (int)')
    expect(trs[1].findAll('td[data-c]').map((t) => t.text())).toEqual(['a', 'NULL', 'c'])
  })
  it('copies transposed selection and with header', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    await btn(w).trigger('click')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    await w.find('.viewport').trigger('keydown', { key: 'a', ctrlKey: true })
    await keyC(w)
    await Promise.resolve()
    expect(writeText).toHaveBeenLastCalledWith('1\t2\t3\na\tNULL\tc'.replace('NULL', ''))
    await keyC(w, true)
    await Promise.resolve()
    expect(writeText).toHaveBeenLastCalledWith('\t#1\t#2\t#3\nid\t1\t2\t3\nname\ta\t\tc')
  })
  it('cell detail has original context', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    await btn(w).trigger('click')
    await w.findAll('tbody tr[data-row]')[1].findAll('td[data-c]')[2].trigger('dblclick')
    expect(w.emitted('cell-detail')![0][0]).toMatchObject({ row: 2, col: 1, value: 'c', column: 'name' })
  })
  it('disables sort in transposed view and restores it', async () => {
    const w = mount(ResultTable, { props: { result: make([[2, 'b'], [1, 'a']]) } })
    await w.findAll('th')[1].trigger('click')
    expect(w.findAll('th')[1].text()).toContain('▲')
    await btn(w).trigger('click')
    await w.findAll('th')[1].trigger('click')
    expect(w.text()).not.toContain('▲')
    expect(w.findAll('tbody tr[data-row]')[0].findAll('td[data-c]').map((t) => t.text())).toEqual(['2', '1'])
    await btn(w).trigger('click')
    expect(w.findAll('th')[1].text()).toContain('▲')
    expect(w.find('tbody tr[data-row] td[data-c]').text()).toBe('1')
  })
  it('keeps toggle if eligible, shows normal view when not, preference kept', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    await btn(w).trigger('click')
    await w.setProps({ result: make([[9, 'z']]) })
    expect(btn(w).attributes('aria-pressed')).toBe('true')
    await w.setProps({ result: make(Array.from({ length: 21 }, (_, i) => [i, 'x'])) })
    expect(btn(w).exists()).toBe(false)
    expect(w.findAll('thead th').map((t) => t.text()).slice(0, 3)).toEqual(['#', 'id', 'name'])
    await w.setProps({ result: make(rows3) })
    expect(btn(w).attributes('aria-pressed')).toBe('true')
  })
  it('restores selection when switching back', async () => {
    const w = mount(ResultTable, { props: { result: make(rows3) } })
    await w.findAll('tbody tr[data-row]')[1].findAll('td[data-c]')[1].trigger('mousedown')
    await btn(w).trigger('click')
    expect(w.findAll('td.selected').length).toBe(0)
    await btn(w).trigger('click')
    expect(w.findAll('td.selected').length).toBe(1)
  })
  it('renders all of 600 original columns without virtualization', async () => {
    const names = Array.from({ length: 600 }, (_, i) => `c${i}`)
    const w = mount(ResultTable, { props: { result: make([names.map((_, i) => i), names.map((_, i) => -i)], names) } })
    await btn(w).trigger('click')
    expect(w.findAll('tbody tr[data-row]').length).toBe(600)
    expect(w.findAll('thead th').length).toBe(3)
  })
  describe('compact layout', () => {
    const colW = (w: any) => parseInt(w.find('colgroup col').attributes('style').match(/width: (\d+)px/)[1])
    const on = async (names: string[], rows: unknown[][] = rows3.map((r) => names.map((_, i) => r[i % 2]))) => {
      const w = mount(ResultTable, { props: { result: make(rows, names) } })
      await btn(w).trigger('click')
      return w
    }
    it('name column fits the longest name within min/max', async () => {
      expect(colW(await on(['a', 'b']))).toBe(80)
      const mid = colW(await on(['a', 'a_fairly_long_name']))
      expect(mid).toBeGreaterThan(80)
      expect(mid).toBeLessThan(240)
      expect(colW(await on(['x'.repeat(100), 'b']))).toBe(240)
    })
    it('truncated names carry a title tooltip with the full name', async () => {
      const long = 'x'.repeat(100)
      const w = await on([long, 'b'])
      expect(w.find('td.rowno').attributes('title')).toContain(long)
    })
    it('no inner vertical scroll and every column rendered with 200 columns', async () => {
      const names = Array.from({ length: 200 }, (_, i) => `c${i}`)
      const w = await on(names, [names.map((_, i) => i), names.map((_, i) => i)])
      expect(w.findAll('tbody tr[data-row]')).toHaveLength(200)
      expect(w.find('.viewport').attributes('style') ?? '').not.toContain('max-height')
      expect(w.find('tr.spacer').exists()).toBe(false)
    })
    it('normal view keeps the max-height viewport', () => {
      const w = mount(ResultTable, { props: { result: make(rows3) } })
      expect(w.find('.viewport').attributes('style')).toContain('max-height')
    })
  })
})
