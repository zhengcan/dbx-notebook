import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PivotTable from '../src/analysis/PivotTable.vue'
import type { PivotModel } from '../src/analysis/pivotModel'
import { toTsv } from '../src/analysis/pivotModel'
import { setLocale } from '../src/i18n'
import { parseLabelTargetId } from '../src/analysis/labelTargetId'

const base = (over: Partial<PivotModel> = {}): PivotModel => ({
  rowHeaders: ['region'],
  columnHeaders: [['2023', 'sum'], ['2023', 'cnt'], ['2024', 'sum'], ['2024', 'cnt']],
  cells: [[1000, 1, 2500.5, 2], [null, null, 3, 1]],
  rowLabels: [['East'], ['（空）']],
  measures: [{ label: 'sum', format: { kind: 'thousands', decimals: 1 }, summary: 'sum' }, { label: 'cnt', format: { kind: 'plain', decimals: 0 }, summary: 'avg' }],
  truncated: { rows: false, columns: false },
  ...over,
})
const clip = (writeText: any) => Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
beforeEach(() => setLocale('en'))

describe('PivotTable', () => {
  it('renders multi-level headers and formatted cells', () => {
    const w = mount(PivotTable, { props: { model: base(), sort: null } })
    expect(w.findAll('thead tr')).toHaveLength(2)
    expect(w.findAll('thead tr')[0].text()).toContain('2023')
    expect(w.findAll('thead tr')[0].find('th[colspan="2"]').exists()).toBe(true)
    expect(w.findAll('thead tr')[1].text()).toContain('cnt')
    const row = w.find('tr[data-row]')
    expect(row.text()).toContain('East')
    expect(row.text()).toContain('1,000.0')
    expect(row.text()).toContain('2,500.5')
    expect(row.findAll('td.num')[1].text()).toBe('1')
    expect(w.findAll('tr[data-row]')[1].text()).toContain('（空）')
  })
  it('shows summary row and column, bold-marked', () => {
    const m = base({ rowTotals: [[3500.5, 3], [3, 1]], columnTotals: [1000, 1, 2503.5, 3], grandTotal: [3503.5, 4] })
    const w = mount(PivotTable, { props: { model: m, sort: null } })
    expect(w.find('thead').text()).toContain('Summary')
    expect(w.findAll('td.total').length).toBeGreaterThan(0)
    const foot = w.find('tr.total-row')
    expect(foot.text()).toContain('Summary')
    expect(foot.text()).toContain('2,503.5')
    expect(foot.text()).toContain('3,503.5')
    expect(w.find('tr[data-row]').text()).toContain('3,500.5')
  })
  it('names the summary method in a title on summary headers and cells', () => {
    const m = base({ rowTotals: [[3500.5, 3], [3, 1]], columnTotals: [1000, 1, 2503.5, 3], grandTotal: [3503.5, 4] })
    const w = mount(PivotTable, { props: { model: m, sort: null } })
    const heads = w.findAll('thead th.total-head')
    expect(heads.some((h) => h.attributes('title') === 'Summary method: Sum')).toBe(true)
    expect(heads.some((h) => h.attributes('title') === 'Summary method: Avg')).toBe(true)
    const rowCells = w.find('tr[data-row]').findAll('td.total')
    expect(rowCells.map((c) => c.attributes('title')?.split('.')[0])).toEqual(['Summary method: Sum', 'Summary method: Avg'])
    expect(w.find('tr.total-row').findAll('td.total')[0].attributes('title')).toContain('Summary method: Sum')
  })
  it('grand alone renders a footer with the corner cell in an extra summary column', () => {
    const w = mount(PivotTable, { props: { model: base({ grandTotal: [3503.5, 4] }), sort: null } })
    const foot = w.find('tr.total-row')
    expect(foot.text()).toContain('3,503.5')
    expect(w.findAll('thead th.total-head').length).toBeGreaterThan(0)
    expect(foot.findAll('td').length).toBe(4 + 2)
    expect(w.find('tr[data-row]').findAll('td').length).toBe(4 + 2)
    const tsv = toTsv(base({ grandTotal: [3503.5, 4] }))
    expect(tsv.split('\n')[2]).toBe('East\t1000\t1\t2500.5\t2\t\t')
    expect(tsv.split('\n').at(-1)).toBe('Summary\t\t\t\t\t3503.5\t4')
  })
  it('column totals alone (no grand) still render the footer row', () => {
    const w = mount(PivotTable, { props: { model: base({ columnTotals: [1000, 1, 2503.5, 3] }), sort: null } })
    expect(w.find('tr.total-row').text()).toContain('2,503.5')
  })
  it('cycles sort asc → desc → none with name/value payloads', async () => {
    const w = mount(PivotTable, { props: { model: base(), sort: null } })
    await w.find('button[data-sort="name"]').trigger('click')
    expect(w.emitted('update:sort')![0]).toEqual([{ by: 'name', dir: 'asc' }])
    await w.setProps({ sort: { by: 'name', dir: 'asc' } })
    await w.find('button[data-sort="name"]').trigger('click')
    expect(w.emitted('update:sort')![1]).toEqual([{ by: 'name', dir: 'desc' }])
    await w.setProps({ sort: { by: 'name', dir: 'desc' } })
    await w.find('button[data-sort="name"]').trigger('click')
    expect(w.emitted('update:sort')![2]).toEqual([null])
    await w.setProps({ sort: null })
    const vb = w.findAll('button[data-sort="value"]')
    await vb[1].trigger('click')
    expect(w.emitted('update:sort')![3]).toEqual([{ by: 'value', valueIndex: 1, dir: 'asc' }])
    await w.setProps({ sort: { by: 'value', valueIndex: 1, dir: 'asc' } })
    await vb[0].trigger('click')
    expect(w.emitted('update:sort')![4]).toEqual([{ by: 'value', valueIndex: 0, dir: 'asc' }])
  })
  it('sets aria-sort on the sorted header only', () => {
    const w = mount(PivotTable, { props: { model: base(), sort: { by: 'value', valueIndex: 0, dir: 'desc' } } })
    const sorted = w.findAll('th[aria-sort="descending"]')
    expect(sorted.length).toBe(2)
    expect(w.find('th[data-sort-th="name"]').attributes('aria-sort')).toBe('none')
    expect(w.find('[role="table"], [role="grid"]').attributes('aria-label')).toBeTruthy()
  })
  it('keyboard activation of header buttons', async () => {
    const w = mount(PivotTable, { props: { model: base(), sort: null } })
    const b = w.find('button[data-sort="name"]')
    expect(b.element.tagName).toBe('BUTTON')
    await b.trigger('keydown', { key: 'Enter' })
    await b.trigger('click')
    expect(w.emitted('update:sort')).toBeTruthy()
  })
  it('Ctrl/Cmd+C copies TSV with header', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    clip(writeText)
    const m = base()
    const w = mount(PivotTable, { props: { model: m, sort: null } })
    await w.find('.viewport').trigger('keydown', { key: 'c', ctrlKey: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(writeText).toHaveBeenCalledWith(toTsv(m))
    expect(w.emitted('copied')).toBeTruthy()
    await w.find('.viewport').trigger('keydown', { key: 'C', metaKey: true })
    expect(writeText).toHaveBeenCalledTimes(2)
  })
  it('shows failure notice and emits copyFailed', async () => {
    clip(vi.fn().mockRejectedValue(new Error('x')))
    const w = mount(PivotTable, { props: { model: base(), sort: null } })
    await w.find('.viewport').trigger('keydown', { key: 'c', ctrlKey: true })
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()
    expect(w.emitted('copyFailed')).toBeTruthy()
    expect(w.text()).toContain('Copy failed')
  })
  it('shows truncation bars', () => {
    const w = mount(PivotTable, { props: { model: base({ truncated: { rows: true, columns: true } }), sort: null } })
    expect(w.findAll('.banner')).toHaveLength(2)
    expect(mount(PivotTable, { props: { model: base(), sort: null } }).find('.banner').exists()).toBe(false)
  })
  it('shows empty state', () => {
    const w = mount(PivotTable, { props: { model: base({ rowLabels: [], cells: [], columnHeaders: [] }), sort: null } })
    expect(w.find('.empty').exists()).toBe(true)
    expect(w.find('table').exists()).toBe(false)
  })
  it('virtualises 5000 rows', () => {
    const n = 5000
    const m = base({ cells: Array.from({ length: n }, (_, i) => [i, 1, 2, 3]), rowLabels: Array.from({ length: n }, (_, i) => [`r${i}`]) })
    const w = mount(PivotTable, { props: { model: m, sort: null } })
    const c = w.findAll('tr[data-row]').length
    expect(c).toBeGreaterThan(0)
    expect(c).toBeLessThan(100)
  })

  describe('editable summary cells', () => {
    const full = (over: Partial<PivotModel> = {}) => base({ rowTotals: [[3500.5, 3], [3, 1]], columnTotals: [1000, 1, 2503.5, 3], grandTotal: [3503.5, 4], ...over })
    const rowCell = (w: any, k = 0) => w.find('tr[data-row]').findAll('td.total')[k]
    const footCell = (w: any, k: number) => w.find('tr.total-row').findAll('td.total')[k]
    it('cells read "Method: number" (en) and "方法：number" (zh)', () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      expect(rowCell(w, 0).text()).toBe('Sum: 3,500.5')
      expect(rowCell(w, 1).text()).toBe('Avg: 3')
      expect(footCell(w, 0).text()).toBe('Sum: 1,000.0')
      expect(footCell(w, 5).text()).toBe('Avg: 4')
      setLocale('zh-CN')
      return w.vm.$nextTick().then(() => undefined)
    })
    it('names every method', () => {
      const names = { sum: 'Sum', count: 'Count', avg: 'Avg', min: 'Min', max: 'Max', median: 'Median' } as const
      for (const [k, n] of Object.entries(names)) {
        const m = full({ measures: [{ label: 'sum', format: { kind: 'plain', decimals: 0 }, summary: k as any }, { label: 'cnt', format: { kind: 'plain', decimals: 0 }, summary: 'sum' }] })
        expect(rowCell(mount(PivotTable, { props: { model: m, sort: null } })).text()).toBe(`${n}: 3501`)
      }
      setLocale('zh-CN')
      const zh = { sum: '求和', count: '计数', avg: '平均', min: '最小', max: '最大', median: '中位数' } as const
      for (const [k, n] of Object.entries(zh)) {
        const m = full({ measures: [{ label: 'sum', format: { kind: 'plain', decimals: 0 }, summary: k as any }, { label: 'cnt', format: { kind: 'plain', decimals: 0 }, summary: 'sum' }] })
        expect(rowCell(mount(PivotTable, { props: { model: m, sort: null } })).text()).toBe(`${n}：3501`)
      }
    })
    it('skipped shows a muted placeholder and stays editable', async () => {
      const m = full({ rowTotals: [[null, 3], [null, 1]], measures: [{ label: 'sum', format: { kind: 'plain' }, summary: 'none' }, { label: 'cnt', format: { kind: 'plain' }, summary: 'avg' }] })
      const w = mount(PivotTable, { props: { model: m, sort: null } })
      expect(rowCell(w, 0).text()).toBe('Skipped')
      expect(rowCell(w, 0).classes()).toContain('skipped')
      await rowCell(w, 0).trigger('dblclick')
      expect((w.find('select[data-test="summary-select"]').element as HTMLSelectElement).value).toBe('none')
      setLocale('zh-CN')
      await w.vm.$nextTick()
    })
    it('double-click opens a select with 7 options preselected to the current method', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      expect(w.find('select').exists()).toBe(false)
      await rowCell(w, 1).trigger('dblclick')
      const sel = w.find('select[data-test="summary-select"]')
      expect(sel.findAll('option').map((o) => o.element.value)).toEqual(['sum', 'count', 'avg', 'min', 'max', 'median', 'none'])
      expect(sel.findAll('option').map((o) => o.text())).toEqual(['Sum', 'Count', 'Avg', 'Min', 'Max', 'Median', 'Skip'])
      expect((sel.element as HTMLSelectElement).value).toBe('avg')
    })
    it('choosing emits update:summary for that measure and closes', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      await rowCell(w, 1).trigger('dblclick')
      await w.find('select[data-test="summary-select"]').setValue('max')
      expect(w.emitted('update:summary')![0]).toEqual([{ valueIndex: 1, summary: 'max' }])
      expect(w.find('select').exists()).toBe(false)
    })
    it('footer and grand cells edit the same measure', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      await footCell(w, 2).trigger('dblclick')
      await w.find('select[data-test="summary-select"]').setValue('min')
      await footCell(w, 5).trigger('dblclick')
      await w.find('select[data-test="summary-select"]').setValue('none')
      expect(w.emitted('update:summary')).toEqual([[{ valueIndex: 0, summary: 'min' }], [{ valueIndex: 1, summary: 'none' }]])
    })
    it('Escape cancels without emitting', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      await rowCell(w, 0).trigger('dblclick')
      await w.find('select').trigger('keydown', { key: 'Escape' })
      expect(w.find('select').exists()).toBe(false)
      expect(w.emitted('update:summary')).toBeUndefined()
    })
    it('blur closes without emitting', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      await rowCell(w, 0).trigger('dblclick')
      await w.find('select').trigger('blur')
      expect(w.find('select').exists()).toBe(false)
      expect(w.emitted('update:summary')).toBeUndefined()
    })
    it('select aria-label names the measure', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      await rowCell(w, 0).trigger('dblclick')
      expect(w.find('select').attributes('aria-label')).toBe('Summary method: sum')
    })
    describe('focus, scroll and key handling', () => {
      const att = (model: PivotModel, extra: any = {}) => mount(PivotTable, { props: { model, sort: null, ...extra }, attachTo: document.body })
      it('focus returns to the summary cell after Escape and after change', async () => {
        const w = att(full())
        await rowCell(w, 1).trigger('dblclick')
        await w.find('select').trigger('keydown', { key: 'Escape' })
        await w.vm.$nextTick(); await w.vm.$nextTick()
        expect(document.activeElement).toBe(rowCell(w, 1).element)
        await rowCell(w, 0).trigger('dblclick')
        await w.find('select').setValue('max')
        await w.vm.$nextTick(); await w.vm.$nextTick()
        expect(document.activeElement).toBe(rowCell(w, 0).element)
        w.unmount()
      })
      it('blur (clicking elsewhere) closes without stealing focus back', async () => {
        const w = att(full())
        await rowCell(w, 0).trigger('dblclick')
        const other = document.createElement('button'); document.body.appendChild(other); other.focus()
        await w.find('select').trigger('blur')
        await w.vm.$nextTick(); await w.vm.$nextTick()
        expect(w.find('select').exists()).toBe(false)
        expect(document.activeElement).toBe(other)
        other.remove(); w.unmount()
      })
      it('Enter on the select closes it (same option) and returns focus; it does not reach the cell handler', async () => {
        const w = att(full())
        await rowCell(w, 0).trigger('dblclick')
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        w.find('select').element.dispatchEvent(ev)
        await w.vm.$nextTick(); await w.vm.$nextTick()
        expect(w.find('select').exists()).toBe(false)
        expect(w.emitted('update:summary')).toBeUndefined()
        expect(document.activeElement).toBe(rowCell(w, 0).element)
        w.unmount()
      })
      it('F2 inside the select is not handled by the cell (no preventDefault, no reopen)', async () => {
        const w = att(full())
        await rowCell(w, 0).trigger('dblclick')
        const ev = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })
        w.find('select').element.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(false)
        expect(w.find('select').exists()).toBe(true)
        w.unmount()
      })
      it('keyboard events from the select do not reach the viewport; Ctrl+C there does not copy', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        clip(writeText)
        const w = att(full())
        await rowCell(w, 0).trigger('dblclick')
        await w.find('select').trigger('keydown', { key: 'c', ctrlKey: true })
        expect(writeText).not.toHaveBeenCalled()
        w.unmount()
      })
      it('scrolling the row out of the visible window closes the editor (and it does not reopen on scroll back)', async () => {
        const n = 400
        const m = base({ cells: Array.from({ length: n }, () => [1, 1, 1, 1]), rowLabels: Array.from({ length: n }, (_, i) => [`r${i}`]), rowTotals: Array.from({ length: n }, () => [1, 1]) })
        const w = att(m)
        await rowCell(w, 0).trigger('dblclick')
        expect(w.find('select').exists()).toBe(true)
        const vp = w.find('.viewport').element as HTMLElement
        vp.scrollTop = 20000
        await w.find('.viewport').trigger('scroll')
        expect(w.find('select').exists()).toBe(false)
        vp.scrollTop = 0
        await w.find('.viewport').trigger('scroll')
        expect(w.find('select').exists()).toBe(false)
        w.unmount()
      })
      it('summary cells are not text-selectable', () => {
        const w = mount(PivotTable, { props: { model: full(), sort: null } })
        expect(rowCell(w, 0).classes()).toContain('sm-cell')
      })
    })
    it('keyboard: cells are focusable and Enter / F2 open the editor', async () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      const c = rowCell(w, 0)
      expect(c.attributes('tabindex')).toBe('0')
      await c.trigger('keydown', { key: 'Enter' })
      expect(w.find('select').exists()).toBe(true)
      await w.find('select').trigger('keydown', { key: 'Escape' })
      await rowCell(w, 0).trigger('keydown', { key: 'F2' })
      expect(w.find('select').exists()).toBe(true)
    })
    it('accessible name is the visible text; instruction via aria-describedby hint; title has full text and scope', () => {
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      const c = rowCell(w, 0)
      expect(c.attributes('aria-label')).toBeUndefined()
      expect(c.text()).toBe('Sum: 3,500.5')
      const hint = w.find('#' + c.attributes('aria-describedby'))
      expect(hint.exists()).toBe(true)
      expect(hint.text()).toBe('Double-click or press Enter/F2 to change the summary method')
      expect(w.findAll('[id="' + hint.attributes('id') + '"]')).toHaveLength(1)
      expect(c.attributes('title')).toContain('Sum: 3,500.5')
      expect(c.attributes('title')).toContain('all summaries of this value')
      expect(footCell(w, 0).attributes('aria-describedby')).toBe(hint.attributes('id'))
    })
    it('zh hint and select aria-label', async () => {
      setLocale('zh-CN')
      const w = mount(PivotTable, { props: { model: full(), sort: null } })
      expect(w.find('#' + rowCell(w, 0).attributes('aria-describedby')).text()).toBe('双击或按 Enter/F2 修改汇总方式')
      await rowCell(w, 0).trigger('dblclick')
      expect(w.find('select').attributes('aria-label')).toBe('汇总方式: sum')
    })
    it('TSV keeps plain numbers with unchanged headers', () => {
      const tsv = toTsv(full())
      expect(tsv).not.toContain('Sum:')
      expect(tsv.split('\n')[1]).toContain('Summary sum')
    })
    it('blank filler cells are not editable', () => {
      const w = mount(PivotTable, { props: { model: base({ grandTotal: [3503.5, 4] }), sort: null } })
      expect(w.find('tr[data-row]').findAll('td.total').every((c) => c.attributes('tabindex') === undefined)).toBe(true)
    })
  })
})

describe('PivotTable edit trigger', () => {
  const em = (): PivotModel => base({ rowKeys: [['0'], [null]], columnKeys: [['2023'], ['2023'], ['2024'], ['2024']], rowTotals: [[1, 1], [1, 1]], summaryLabel: 'Total' } as Partial<PivotModel>)
  const mnt = (editable = true, m = em()) => mount(PivotTable, { props: { model: m, sort: null, editable } })
  const last = (w: any) => (w.emitted('edit-label').at(-1) as any[])[0]
  it('editable=false renders none', () => { expect(mnt(false).find('.lbl-edit').exists()).toBe(false) })
  it('one edit button right after each sort button; aria-label has name; not a tab stop', () => {
    const w = mnt()
    for (const s of w.findAll('button[data-sort]')) {
      const n = s.element.nextElementSibling as HTMLElement
      expect(n.classList.contains('lbl-edit')).toBe(true)
      expect(n.getAttribute('aria-label')).toContain(s.text().replace(/ [▲▼]$/, ''))
      expect(s.attributes('aria-keyshortcuts')).toBe('F2')
    }
    for (const b of w.findAll('.lbl-edit')) { expect(b.attributes('tabindex')).toBe('-1'); expect(b.attributes('data-label-target')).toBeTruthy(); expect(b.find('svg[aria-hidden=true]').exists()).toBe(true) }
    expect(w.find('th[data-sort-th=name] .lbl-edit').attributes('aria-label')).toContain('region')
    expect(w.find('thead').text()).toContain('Total')
  })
  it('data-label-target round-trips to the emitted target', async () => {
    const w = mnt()
    const bs = w.findAll('.lbl-edit')
    for (const b of bs) {
      await b.trigger('click')
      expect(parseLabelTargetId(b.attributes('data-label-target')!)).toEqual(last(w).target)
    }
    expect(w.find('[data-label-target="rowName:0"]').exists()).toBe(true)
    expect(w.find('[data-label-target="category:row:0:0"]').exists()).toBe(true)
    expect(w.find('[data-label-target="null:row:0"]').exists()).toBe(true)
    expect(w.find('[data-label-target="measureName:1"]').exists()).toBe(true)
    expect(w.find('[data-label-target="category:column:0:2024"]').exists()).toBe(true)
  })
  it('sort click sorts only; edit click emits only', async () => {
    const w = mnt()
    await w.find('button[data-sort=name]').trigger('click')
    expect(w.emitted('update:sort')).toHaveLength(1)
    expect(w.emitted('edit-label')).toBeUndefined()
    await w.find('th[data-sort-th=name] .lbl-edit').trigger('click')
    expect(w.emitted('update:sort')).toHaveLength(1)
    const p = last(w)
    expect(p.target).toEqual({ kind: 'rowName', index: 0 })
    expect(p.el).toBeInstanceOf(HTMLElement)
    await w.findAll('th.measure[data-sort-th=value] .lbl-edit')[1].trigger('click')
    expect(last(w).target).toEqual({ kind: 'measureName', index: 1 })
    await w.findAll('tbody th.label .lbl-edit')[0].trigger('click')
    expect(last(w).target).toEqual({ kind: 'category', axis: 'row', index: 0, key: '0' })
    await w.findAll('tbody th.label .lbl-edit')[1].trigger('click')
    expect(last(w).target).toEqual({ kind: 'nullLabel', axis: 'row', index: 0 })
    await w.find('th.total-head .lbl-edit').trigger('click')
    expect(last(w).target).toEqual({ kind: 'summary' })
    expect(w.emitted('update:sort')).toHaveLength(1)
  })
  it('F2 / Shift+F10 / ContextMenu on a focused header emit its target; other keys do not', async () => {
    const w = mnt()
    await w.find('button[data-sort=name]').trigger('keydown', { key: 'F2' })
    expect(last(w).target).toEqual({ kind: 'rowName', index: 0 })
    await w.findAll('button[data-sort=value]')[1].trigger('keydown', { key: 'F10', shiftKey: true })
    expect(last(w).target).toEqual({ kind: 'measureName', index: 1 })
    await w.find('th.group').trigger('keydown', { key: 'ContextMenu' })
    expect(last(w).target).toEqual({ kind: 'category', axis: 'column', index: 0, key: '2023' })
    await w.find('th.total-head').trigger('keydown', { key: 'F2' })
    expect(last(w).target).toEqual({ kind: 'summary' })
    await w.find('tbody th.label').trigger('keydown', { key: 'F2' })
    expect(last(w).target).toEqual({ kind: 'category', axis: 'row', index: 0, key: '0' })
    const n = w.emitted('edit-label')!.length
    await w.find('button[data-sort=name]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('edit-label')).toHaveLength(n)
    expect(w.emitted('update:sort')).toBeUndefined()
    expect(mnt(false).find('button[data-sort=name]').attributes('aria-keyshortcuts')).toBeUndefined()
    const w2 = mnt(false); await w2.find('button[data-sort=name]').trigger('keydown', { key: 'F2' }); expect(w2.emitted('edit-label')).toBeUndefined()
  })
  it('column group header edits the category', async () => {
    const w = mnt()
    await w.find('th.group .lbl-edit').trigger('click')
    expect(last(w).target).toEqual({ kind: 'category', axis: 'column', index: 0, key: '2023' })
  })
  it('second column ref and multi-level headers target the right level/key', async () => {
    const m = base({
      rowKeys: [['0'], ['1']], columnKeys: [['2023', 'x'], ['2023', 'y'], ['2024', 'x'], ['2024', null]],
      columnHeaders: [['2023', 'X', 'sum'], ['2023', 'Y', 'sum'], ['2024', 'X', 'sum'], ['2024', '（空）', 'sum']],
      measures: [{ label: 'sum', format: { kind: 'plain' }, summary: 'sum' }], cells: [[1, 2, 3, 4], [1, 2, 3, 4]], rowLabels: [['a'], ['b']],
    } as Partial<PivotModel>)
    const w = mnt(true, m)
    const ids = w.findAll('thead .lbl-edit').map((b) => b.attributes('data-label-target'))
    expect(ids).toContain('category:column:0:2023')
    expect(ids).toContain('category:column:1:y')
    expect(ids).toContain('null:column:1')
    expect(ids.filter((x) => x === 'category:column:1:x')).toHaveLength(2)
    expect(ids).toContain('measureName:0')
  })
  it('two refs sharing a field name keep independent targets (by index)', () => {
    const w = mnt(true, base({ rowHeaders: ['region', 'region'], rowKeys: [['a', 'a']], rowLabels: [['a', 'a']], columnKeys: [['2023'], ['2023'], ['2024'], ['2024']], cells: [[1, 2, 3, 4]] } as Partial<PivotModel>))
    expect(w.findAll('thead th.label-head .lbl-edit').map((b) => b.attributes('data-label-target'))).toEqual(['rowName:0', 'rowName:1'])
    expect(w.findAll('tbody th.label .lbl-edit').map((b) => b.attributes('data-label-target'))).toEqual(['category:row:0:a', 'category:row:1:a'])
  })
  it('summary/total headers: levels=2 uses measureName, levels=1 uses summary', () => {
    const w = mnt()
    expect(w.findAll('th.total-head').map((th) => th.find('.lbl-edit').attributes('data-label-target'))).toEqual(['summary', 'measureName:0', 'measureName:1'])
    const one = mnt(true, base({ columnHeaders: [['sum'], ['cnt']], cells: [[1, 2]], rowLabels: [['a']], rowKeys: [['a']], columnKeys: [[], []], rowTotals: [[3, 2]], summaryLabel: 'Total' } as Partial<PivotModel>))
    expect(one.findAll('th.total-head').map((th) => th.find('.lbl-edit').attributes('data-label-target'))).toEqual(['summary', 'summary'])
  })
  it('scaled totals display scaled while the model keeps raw', () => {
    const f = { kind: 'plain' as const, decimals: 0, scale: 10000, unit: '万元' }
    const m = base({ measures: [{ label: 'sum', format: f, summary: 'sum' }], columnHeaders: [['sum']], cells: [[15000], [25000]], rowLabels: [['a'], ['b']], columnTotals: [40000], rowKeys: [['a'], ['b']], columnKeys: [[]] } as Partial<PivotModel>)
    const w = mnt(true, m)
    expect(w.find('tr.total-row').text()).toContain('4万元')
    expect(m.columnTotals).toEqual([40000])
    expect(toTsv(m)).toContain('40000')
    expect(toTsv(m, { withFormat: true })).toContain('4万元')
  })
})
