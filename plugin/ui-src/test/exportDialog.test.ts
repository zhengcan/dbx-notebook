import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setLocale } from '../src/i18n'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import ExportDialog from '../src/export/ExportDialog.vue'
import ColumnBreakPicker from '../src/export/ColumnBreakPicker.vue'
import { exportHints } from '../src/export/estimate'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import type { ExportModel } from '../src/export/model'

const table = (id: string, ncols: number, total: number) => ({
  kind: 'table' as const, blockId: id, columns: Array.from({ length: ncols }, (_, i) => 'c' + i), rows: [], nullMask: [],
  totalRows: total, shownRows: total, limitedNote: null, groups: [{ cols: [] }], numeric: [], autoBreaks: ncols > 6 ? [Math.floor(ncols / 2) - 1] : [],
})
const catalogOf = (sections: any[]) => sections.map((s) => ({ blockId: s.blockId, type: 'sql', label: s.blockId, included: true, table: s }))
const model = (over: Partial<ExportModel> = {}): ExportModel => {
  const sections = over.sections ?? [table('b1', 3, 10) as any]
  return {
    documentTitle: '', exportedAt: '', runTimes: [], exporter: null, dataSources: [], note: '',
    sections, catalog: catalogOf(sections), skipped: [], staleBlockIds: [],
    estimate: { totalRows: 10, bigTables: [] }, exportable: true, ...over,
  }
}
const found = { found: true, path: '/c', checking: false }
const props = (o: any = {}) => ({ model: model(), browser: found, busy: false, initialFolder: '/out', initialName: 'report.pdf', ...o })
const sel = (w: any, k: string) => w.find(`[data-test="${k}"]`)

describe('ExportDialog', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('has the documented defaults', () => {
    const w = mount(ExportDialog, { props: props() })
    expect((sel(w, 'fmt-pdf').element as HTMLInputElement).checked).toBe(true)
    expect((sel(w, 'opt-sql').element as HTMLInputElement).checked).toBe(false)
    for (const k of ['opt-exported-at', 'opt-run-at', 'opt-datasource'])
      expect((sel(w, k).element as HTMLInputElement).checked).toBe(true)
    expect(w.find('[data-test=opt-title]').exists()).toBe(false)
    expect((sel(w, 'opt-filters').element as HTMLInputElement).checked).toBe(true)
    expect((sel(w, 'orient-portrait').element as HTMLInputElement).checked).toBe(true)
    expect((sel(w, 'row-limit-all').element as HTMLInputElement).checked).toBe(true)
    expect((sel(w, 'repeat-cols').element as HTMLInputElement).value).toBe('0')
  })
  it('opt-filters toggle emits filtersLine and is labelled as input variables', async () => {
    const w = mount(ExportDialog, { props: props() })
    expect(w.find('[data-test=opt-filters]').element.parentElement!.textContent).toContain('包含输入参数')
    await sel(w, 'opt-filters').setValue(false)
    await sel(w, 'go').trigger('click')
    expect((w.emitted('export')![0][0] as any).filtersLine).toBe(false)
    setLocale('en')
    const w2 = mount(ExportDialog, { props: props() })
    expect(w2.find('[data-test=opt-filters]').element.parentElement!.textContent).toContain('Include input parameters')
  })
  it('blocks tab shows input entries with type legend and variable-name label', async () => {
    const sections: any[] = [{ kind: 'input', blockId: 'in1', name: 'city', text: 'x' }]
    const catalog: any[] = [{ blockId: 'in1', type: 'input', label: 'city', included: true }]
    for (const [loc, legend] of [['zh-CN', '输入变量'], ['en', 'Input variable']]) {
      setLocale(loc)
      const w = mount(ExportDialog, { props: props({ model: model({ sections, catalog, exportable: false }) }) })
      const f = w.find('[data-test=blk-in1]')
      expect(f.find('legend').text()).toBe(legend)
      expect(f.find('label').text()).toBe('city')
      expect(w.find('.ed-warn').text()).toMatch(loc === 'en' ? /Input variables alone/ : /仅有输入变量/)
    }
  })
  it('no browser: pdf disabled, hint shown, html selected, go still enabled', async () => {
    const w = mount(ExportDialog, { props: props({ browser: { found: false, checking: false } }) })
    await nextTick()
    expect((sel(w, 'fmt-pdf').element as HTMLInputElement).disabled).toBe(true)
    expect(sel(w, 'browser-hint').exists()).toBe(true)
    expect(sel(w, 'browser-hint').text()).toContain('导出 HTML 后用浏览器打印')
    expect((sel(w, 'fmt-html').element as HTMLInputElement).checked).toBe(true)
    expect(sel(w, 'go').attributes('disabled')).toBeUndefined()
    await sel(w, 'go').trigger('click')
    expect(w.emitted('export')![0][0]).toMatchObject({ format: 'html' })
  })
  it('not exportable disables go', () => {
    const w = mount(ExportDialog, { props: props({ model: model({ exportable: false, sections: [] }) }) })
    expect(sel(w, 'go').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('没有可导出的内容')
  })
  it('shows skipped / stale / big hints', async () => {
    const w = mount(ExportDialog, { props: props({ model: model({
      skipped: [{ blockId: 'x', label: 'Orders', reason: 'no-result' }], staleBlockIds: ['b1'],
      sections: [table('b1', 3, 6000) as any],
    }) }) })
    expect(sel(w, 'hint-skipped').text()).toContain('Orders')
    expect(sel(w, 'hint-stale').exists()).toBe(true)
    expect(sel(w, 'hint-big').exists()).toBe(true)
    await sel(w, 'row-limit-n').setValue(true)
    await sel(w, 'row-limit-value').setValue('100')
    expect(sel(w, 'hint-big').exists()).toBe(false)
  })
  it('clamps row limit and emits consistent options', async () => {
    const w = mount(ExportDialog, { props: props() })
    await sel(w, 'row-limit-n').setValue(true)
    for (const bad of ['abc', '0', '-5']) {
      await sel(w, 'row-limit-value').setValue(bad)
      await sel(w, 'row-limit-value').trigger('change')
      const v = Number((sel(w, 'row-limit-value').element as HTMLInputElement).value)
      expect(v).toBeGreaterThanOrEqual(1)
    }
    await sel(w, 'row-limit-value').setValue('abc')
    await sel(w, 'row-limit-value').trigger('change')
    await sel(w, 'opt-sql').setValue(true)
    await sel(w, 'note').setValue('hello')
    await nextTick()
    expect(w.emitted('optionsChange')!.length).toBeGreaterThan(0)
    await sel(w, 'go').trigger('click')
    const o = w.emitted('export')![0][0] as any
    expect(o).toMatchObject({ includeSql: true, note: 'hello', rowLimit: 100, columnBreaks: {} })
    const last = w.emitted('optionsChange')!.at(-1)![0] as any
    expect(last).toEqual(o)
  })
  it('busy disables options, shows progress, stop cancels; error shown', async () => {
    const w = mount(ExportDialog, { props: props({ busy: true, progress: 'Rendering', error: 'boom' }) })
    expect((sel(w, 'opt-sql').element as HTMLInputElement).disabled).toBe(true)
    expect(w.text()).toContain('Rendering')
    expect(sel(w, 'err').text()).toContain('boom')
    await sel(w, 'stop').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
  })
  it('repeat-cols clamps to the widest table', async () => {
    const narrow = mount(ExportDialog, { props: props({ model: model({ sections: [table('b1', 3, 5) as any] }) }) })
    await sel(narrow, 'repeat-cols').setValue('4')
    await sel(narrow, 'repeat-cols').trigger('change')
    expect((sel(narrow, 'repeat-cols').element as HTMLInputElement).value).toBe('2')
  })
  it('picker emits sorted breaks, toggles off, and even split', async () => {
    const cols = Array.from({ length: 10 }, (_, i) => 'c' + i)
    const w = mount(ColumnBreakPicker, { props: { columns: cols, breaks: [] } })
    await w.find('[data-test="break-2"]').setValue(true)
    expect(w.emitted('update')![0][0]).toEqual([2])
    await w.setProps({ breaks: [2] })
    await w.find('[data-test="break-2"]').setValue(false)
    expect(w.emitted('update')![1][0]).toEqual([])
    await w.find('[data-test="parts-value"]').setValue('2')
    await w.find('[data-test="parts-apply"]').trigger('click')
    expect(w.emitted('update')![2][0]).toEqual([4])
  })
  it('break checkbox names the column', () => {
    const w = mount(ColumnBreakPicker, { props: { columns: ['alpha', 'b', 'c'], breaks: [] } })
    expect(w.find('[data-test="break-0"]').attributes('aria-label')).toContain('alpha')
  })
  it('row-limit-value has its own aria-label', () => {
    const w = mount(ExportDialog, { props: props() })
    expect(sel(w, 'row-limit-value').attributes('aria-label')).toBeTruthy()
  })
  it('Esc closes, or cancels while busy', async () => {
    const w = mount(ExportDialog, { props: props() })
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toBeTruthy()
    const b = mount(ExportDialog, { props: props({ busy: true }) })
    await b.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(b.emitted('cancel')).toBeTruthy()
    expect(b.emitted('close')).toBeFalsy()
  })
  it('Tab wraps within the dialog', async () => {
    const w = mount(ExportDialog, { props: props(), attachTo: document.body })
    const go = sel(w, 'go').element as HTMLElement
    go.focus()
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).not.toBe(go)
    expect(w.element.contains(document.activeElement)).toBe(true)
    ;(w.find('[role="tab"][tabindex="0"]').element as HTMLElement).focus()
    await w.find('[role="dialog"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(go)
    w.unmount()
  })
  it('returns focus to the opener on unmount', async () => {
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus()
    const w = mount(ExportDialog, { props: props(), attachTo: document.body })
    await nextTick()
    expect(document.activeElement).not.toBe(btn)
    w.unmount()
    expect(document.activeElement).toBe(btn)
  })
  it('fmt-pdf click selects pdf and is emitted', async () => {
    const w = mount(ExportDialog, { props: props({ initial: { ...DEFAULT_EXPORT_OPTIONS, format: 'html' } }) })
    await sel(w, 'fmt-pdf').setValue(true)
    await sel(w, 'go').trigger('click')
    expect((w.emitted('export')![0][0] as any).format).toBe('pdf')
  })
  it('exportHints', () => {
    const h = exportHints(model({ sections: [table('b1', 12, 6000) as any], staleBlockIds: ['a', 'b'] }), { ...DEFAULT_EXPORT_OPTIONS })
    expect(h.bigTables).toEqual([{ blockId: 'b1', rows: 6000 }])
    expect(h.stale).toBe(2)
    expect(h.wideTables).toEqual(['b1'])
    expect(exportHints(model({ sections: [table('b1', 3, 6000) as any] }), { ...DEFAULT_EXPORT_OPTIONS, rowLimit: 100 }).bigTables).toEqual([])
  })
  it('running prop disables go and shows a distinct hint; re-enabled after', async () => {
    const w = mount(ExportDialog, { props: props({ running: true }) })
    expect(sel(w, 'go').attributes('disabled')).toBeDefined()
    expect(sel(w, 'hint-running').exists()).toBe(true)
    await w.setProps({ running: false })
    expect(sel(w, 'go').attributes('disabled')).toBeUndefined()
    expect(sel(w, 'hint-running').exists()).toBe(false)
  })
  it('has no result panel any more: Go stays, Close closes', async () => {
    const w = mount(ExportDialog, { props: props() })
    expect(sel(w, 'result').exists()).toBe(false)
    expect(sel(w, 'go').exists()).toBe(true)
    await sel(w, 'close').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
  describe('file chooser', () => {
    const name = (w: any) => sel(w, 'file-name').element as HTMLInputElement
    it('shows the folder and an editable base name with a fixed extension; Export emits options and the path', async () => {
      const w = mount(ExportDialog, { props: props() })
      expect(sel(w, 'file-folder').text()).toContain('/out')
      expect(name(w).tagName).toBe('INPUT')
      expect(name(w).value).toBe('report')
      expect(sel(w, 'file-ext').text()).toBe('.pdf')
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![0][1]).toBe('/out/report.pdf')
    })
    it('renaming is a plain text edit: the typed name plus the format extension', async () => {
      const w = mount(ExportDialog, { props: props() })
      await sel(w, 'file-name').setValue('Q3 sales')
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![0][1]).toBe('/out/Q3 sales.pdf')
      await sel(w, 'file-name').setValue('again.pdf')
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![1][1]).toBe('/out/again.pdf')
    })
    it('invalid characters are rejected inline and block Export', async () => {
      const w = mount(ExportDialog, { props: props() })
      for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '..', 'x.']) {
        await sel(w, 'file-name').setValue(bad)
        expect(sel(w, 'name-error').exists()).toBe(true)
        expect(sel(w, 'name-error').attributes('role')).toBe('alert')
        expect(sel(w, 'go').attributes('disabled')).toBeDefined()
      }
      await sel(w, 'file-name').setValue('')
      expect(sel(w, 'go').attributes('disabled')).toBeDefined()
      await sel(w, 'file-name').setValue('fine')
      expect(sel(w, 'name-error').exists()).toBe(false)
      expect(sel(w, 'go').attributes('disabled')).toBeUndefined()
    })
    it('Export is disabled until a folder is chosen, and says so', async () => {
      const w = mount(ExportDialog, { props: props({ initialFolder: '', initialName: 'report-20261018-0905' }) })
      expect(sel(w, 'go').attributes('disabled')).toBeDefined()
      expect(sel(w, 'file-hint').exists()).toBe(true)
      expect(name(w).value).toBe('report-20261018-0905')
      const pick = vi.fn(async () => ({ path: '/x/y' }))
      await w.setProps({ pickFolder: pick })
      await sel(w, 'choose').trigger('click')
      await flushPromises()
      expect(pick).toHaveBeenCalledWith(undefined)
      expect(sel(w, 'go').attributes('disabled')).toBeUndefined()
      expect(sel(w, 'file-hint').exists()).toBe(false)
    })
    it('Choose folder… only sets the folder; the name is kept', async () => {
      const pick = vi.fn(async () => ({ path: '/x/y' }))
      const w = mount(ExportDialog, { props: props({ pickFolder: pick }) })
      await sel(w, 'file-name').setValue('mine')
      await sel(w, 'choose').trigger('click')
      await flushPromises()
      expect(pick).toHaveBeenCalledWith('/out')
      expect(sel(w, 'file-folder').text()).toContain('/x/y')
      expect(name(w).value).toBe('mine')
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![0][1]).toBe('/x/y/mine.pdf')
    })
    it('a cancelled or failing folder dialog keeps the current folder', async () => {
      const pick = vi.fn(async () => ({ cancelled: true as const }))
      const w = mount(ExportDialog, { props: props({ pickFolder: pick }) })
      await sel(w, 'choose').trigger('click'); await flushPromises()
      expect(sel(w, 'file-folder').text()).toContain('/out')
      await w.setProps({ pickFolder: vi.fn(async () => { throw new Error('x') }) })
      await sel(w, 'choose').trigger('click'); await flushPromises()
      expect(sel(w, 'file-folder').text()).toContain('/out')
    })
    it('changing the format updates the extension', async () => {
      const w = mount(ExportDialog, { props: props() })
      await sel(w, 'fmt-html').setValue(true)
      expect(sel(w, 'file-ext').text()).toBe('.html')
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![0][1]).toBe('/out/report.html')
      await sel(w, 'fmt-pdf').setValue(true)
      expect(sel(w, 'file-ext').text()).toBe('.pdf')
    })
    it('Choose and the name are disabled while exporting', () => {
      const w = mount(ExportDialog, { props: props({ busy: true }) })
      expect(sel(w, 'choose').attributes('disabled')).toBeDefined()
      expect(sel(w, 'file-name').attributes('disabled')).toBeDefined()
    })
  })

  describe('tabs', () => {
    const wide = () => mount(ExportDialog, { props: props({ model: model({ sections: [table('b1', 10, 5) as any, table('b2', 3, 5) as any] }) }), attachTo: document.body })
    it('has ARIA tabs: General selected, Blocks hidden panel', async () => {
      const w = wide()
      const tabs = w.findAll('[role="tab"]')
      expect(w.find('[role="tablist"]').exists()).toBe(true)
      expect(tabs.map((x) => x.attributes('aria-selected'))).toEqual(['true', 'false'])
      expect(tabs.map((x) => x.attributes('tabindex'))).toEqual(['0', '-1'])
      const panels = w.findAll('[role="tabpanel"]')
      expect(panels).toHaveLength(2)
      expect(tabs[0].attributes('aria-controls')).toBe(panels[0].attributes('id'))
      expect(panels[1].attributes('aria-labelledby')).toBe(tabs[1].attributes('id'))
      expect(panels[0].attributes('hidden')).toBeUndefined()
      expect(panels[1].attributes('hidden')).toBeDefined()
      w.unmount()
    })
    it('arrow keys, Home and End switch tabs and move focus', async () => {
      const w = wide()
      const tabs = w.findAll('[role="tab"]')
      await tabs[0].trigger('keydown', { key: 'ArrowRight' })
      expect(tabs[1].attributes('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(tabs[1].element)
      await tabs[1].trigger('keydown', { key: 'ArrowRight' })
      expect(tabs[0].attributes('aria-selected')).toBe('true')
      await tabs[0].trigger('keydown', { key: 'End' })
      expect(tabs[1].attributes('aria-selected')).toBe('true')
      await tabs[1].trigger('keydown', { key: 'Home' })
      expect(tabs[0].attributes('aria-selected')).toBe('true')
      await tabs[0].trigger('keydown', { key: 'ArrowLeft' })
      expect(tabs[1].attributes('aria-selected')).toBe('true')
      w.unmount()
    })
    it('Tab trap skips the hidden panel', async () => {
      const w = wide()
      const hiddenEls = Array.from(w.element.querySelectorAll('[role="tabpanel"][hidden] input'))
      expect(hiddenEls.length).toBeGreaterThan(0)
      ;(sel(w, 'go').element as HTMLElement).focus()
      await w.find('[role="dialog"]').trigger('keydown', { key: 'Tab' })
      expect(hiddenEls).not.toContain(document.activeElement)
      w.unmount()
    })
    it('Blocks tab: every block included by default, per-table auto pagination', async () => {
      const w = wide()
      await w.findAll('[role="tab"]')[1].trigger('click')
      for (const id of ['b1', 'b2']) expect((sel(w, `blk-include-${id}`).element as HTMLInputElement).checked).toBe(true)
      expect((sel(w, 'pag-auto-b1').element as HTMLInputElement).checked).toBe(true)
      expect(sel(w, 'picker-b1').exists()).toBe(false)
      expect(sel(w, 'blk-info-b1').text()).toContain('5')
      expect(sel(w, 'blk-info-b1').text()).toContain('10')
      await sel(w, 'go').trigger('click')
      expect((w.emitted('export')![0][0] as any).columnBreaks).toEqual({})
      expect((w.emitted('export')![0][0] as any).blocks).toEqual({})
      w.unmount()
    })
    it('unchecking a block is emitted', async () => {
      const w = wide()
      await sel(w, 'blk-include-b2').setValue(false)
      await sel(w, 'go').trigger('click')
      expect((w.emitted('export')![0][0] as any).blocks).toEqual({ b2: { include: false, transpose: 'follow' } })
      w.unmount()
    })
    it('manual mode starts from the auto result, can be edited and switched back', async () => {
      const w = wide()
      await sel(w, 'pag-manual-b1').setValue(true)
      expect(sel(w, 'picker-b1').exists()).toBe(true)
      await sel(w, 'go').trigger('click')
      expect((w.emitted('export')![0][0] as any).columnBreaks).toEqual({ b1: [4] })
      await w.find('[data-test="picker-b1"] [data-test="break-2"]').setValue(true)
      await sel(w, 'go').trigger('click')
      expect((w.emitted('export')![1][0] as any).columnBreaks).toEqual({ b1: [2, 4] })
      await sel(w, 'pag-auto-b1').setValue(true)
      await sel(w, 'go').trigger('click')
      expect((w.emitted('export')![2][0] as any).columnBreaks).toEqual({})
      w.unmount()
    })
    it('transpose override per table; changing it resets manual breaks', async () => {
      const w = wide()
      await sel(w, 'pag-manual-b1').setValue(true)
      await sel(w, 'transpose-b1').setValue('on')
      await sel(w, 'go').trigger('click')
      const o = w.emitted('export')![0][0] as any
      expect(o.blocks).toEqual({ b1: { include: true, transpose: 'on' } })
      expect(o.columnBreaks).toEqual({})
      w.unmount()
    })
    it('transpose is disabled when the table has more than 20 rows', () => {
      const w = mount(ExportDialog, { props: props({ model: model({ sections: [table('big', 3, 50) as any] }) }) })
      expect(sel(w, 'transpose-big').attributes('disabled')).toBeDefined()
      w.unmount()
    })
    it('restores per-block settings from the initial options', async () => {
      const w = mount(ExportDialog, { props: props({ model: model({ sections: [table('b1', 10, 5) as any] }), initial: { ...DEFAULT_EXPORT_OPTIONS, columnBreaks: { b1: [1] }, blocks: { b1: { include: false, transpose: 'off' } } } }) })
      expect((sel(w, 'blk-include-b1').element as HTMLInputElement).checked).toBe(false)
      expect((sel(w, 'pag-manual-b1').element as HTMLInputElement).checked).toBe(true)
      await sel(w, 'go').trigger('click')
      expect(w.emitted('export')![0][0]).toMatchObject({ columnBreaks: { b1: [1] }, blocks: { b1: { include: false, transpose: 'off' } } })
    })
  })

  describe('browser settings', () => {
    it('hides the detected path until Settings is opened', async () => {
      const w = mount(ExportDialog, { props: props({ browser: { found: true, path: '/Applications/Chrome', checking: false }, manualPath: '/my/chrome' }) })
      expect(w.text()).not.toContain('/Applications/Chrome')
      expect(sel(w, 'browser-settings').exists()).toBe(false)
      const btn = sel(w, 'browser-settings-btn')
      expect(btn.attributes('aria-expanded')).toBe('false')
      await btn.trigger('click')
      expect(btn.attributes('aria-expanded')).toBe('true')
      const path = sel(w, 'browser-path')
      expect((path.element as HTMLInputElement).value).toBe('/Applications/Chrome')
      expect(path.attributes('readonly')).toBeDefined()
      expect((sel(w, 'browser-manual').element as HTMLInputElement).value).toBe('/my/chrome')
      await btn.trigger('click')
      expect(sel(w, 'browser-settings').exists()).toBe(false)
    })
    it('manual path can be changed and applied', async () => {
      const w = mount(ExportDialog, { props: props({ manualPath: '' }) })
      await sel(w, 'browser-settings-btn').trigger('click')
      await sel(w, 'browser-manual').setValue('  /opt/edge ')
      await sel(w, 'browser-apply').trigger('click')
      expect(w.emitted('setBrowser')![0]).toEqual(['/opt/edge'])
    })
    it('missing browser keeps the hint and can open the settings from it', async () => {
      const w = mount(ExportDialog, { props: props({ browser: { found: false, checking: false } }) })
      expect(sel(w, 'browser-hint').text()).toContain('导出 HTML 后用浏览器打印')
      await sel(w, 'browser-hint-open').trigger('click')
      expect(sel(w, 'browser-settings').exists()).toBe(true)
      expect(sel(w, 'browser-status').text()).toContain('未找到')
    })
  })
  it('keeps PDF selected while the browser is still being looked up, and falls back to HTML only when none is found', async () => {
    const w = mount(ExportDialog, { props: props({ browser: { found: false, checking: true } }) })
    await nextTick()
    expect((sel(w, 'fmt-pdf').element as HTMLInputElement).checked).toBe(true)
    expect((sel(w, 'fmt-pdf').element as HTMLInputElement).disabled).toBe(false)
    await w.setProps({ browser: { found: true, path: '/c', checking: false } })
    expect((sel(w, 'fmt-pdf').element as HTMLInputElement).checked).toBe(true)
    await w.setProps({ browser: { found: false, checking: false } })
    expect((sel(w, 'fmt-html').element as HTMLInputElement).checked).toBe(true)
  })
})

describe('export busy indicator', () => {
  it('shows a spinner and an Exporting… label on a disabled Export button only while busy; progress text stays', async () => {
    setLocale('en')
    const w = mount(ExportDialog, { props: props({ busy: false }) })
    expect(w.find('[data-test=spinner]').exists()).toBe(false)
    expect(sel(w, 'go').attributes('aria-busy')).toBe('false')
    expect(sel(w, 'go').text()).toBe('Export')
    await w.setProps({ busy: true, progress: 'Saving…' })
    expect(w.find('[data-test=spinner]').exists()).toBe(true)
    expect(sel(w, 'go').find('[data-test=spinner]').attributes('aria-hidden')).toBe('true')
    expect(sel(w, 'go').attributes('disabled')).toBeDefined()
    expect(sel(w, 'go').attributes('aria-busy')).toBe('true')
    expect(sel(w, 'go').text()).toBe('Exporting…')
    expect(w.text()).toContain('Saving…')
    await w.setProps({ busy: false, progress: '' })
    expect(w.find('[data-test=spinner]').exists()).toBe(false)
  })
})

describe('export error placement', () => {
  it('the error is outside the scrolling body so it is always visible, and is focusable-selectable text', () => {
    const w = mount(ExportDialog, { props: props({ error: 'boom' }) })
    const err = sel(w, 'err')
    expect(err.attributes('role')).toBe('alert')
    expect(w.find('.ed-body').element.contains(err.element)).toBe(false)
    expect(err.find('.ed-sel').text()).toBe('boom')
  })
})

describe('ExportDialog exporter switch', () => {
  beforeEach(() => setLocale('zh-CN'))
  const cb = (w: any) => w.find('[data-test=opt-exporter]')
  it('default on, shows the name, toggling off emits header.exporter=false', async () => {
    const w = mount(ExportDialog, { props: props({ exporterName: '张 三' }) })
    expect((cb(w).element as HTMLInputElement).checked).toBe(true)
    expect(cb(w).element.parentElement!.textContent).toContain('导出人')
    await cb(w).setValue(false)
    await sel(w, 'go').trigger('click')
    expect((w.emitted('export')![0][0] as any).header.exporter).toBe(false)
  })
  it('remembered off is restored; en label', () => {
    setLocale('en')
    const w = mount(ExportDialog, { props: props({ exporterName: 'bob', initial: { ...DEFAULT_EXPORT_OPTIONS, header: { ...DEFAULT_EXPORT_OPTIONS.header, exporter: false } } }) })
    expect((cb(w).element as HTMLInputElement).checked).toBe(false)
    expect(cb(w).element.parentElement!.textContent).toContain('Exporter')
  })
  it('failure (null) hides the switch and hint; pending (undefined) shows switch without a name', () => {
    expect(mount(ExportDialog, { props: props({ exporterName: null }) }).find('[data-test=opt-exporter]').exists()).toBe(false)
    const w = mount(ExportDialog, { props: props() })
    expect(cb(w).exists()).toBe(true)
    expect(w.find('[data-test=exporter-name]').exists()).toBe(false)
  })
})

describe('ExportDialog header options columns', () => {
  beforeEach(() => setLocale('zh-CN'))
  const keys = (el: Element) => Array.from(el.querySelectorAll('input[type=checkbox]')).map((i) => i.getAttribute('data-test'))
  it('left column holds opt-sql and opt-filters, right column holds exporter, exported-at, datasource, run-at in that order', () => {
    const w = mount(ExportDialog, { props: props({ exporterName: 'alice.zhang' }) })
    expect(w.find('[data-test=header-cols]').classes()).toContain('ed-cols')
    expect(keys(w.find('[data-test=col-left]').element)).toEqual(['opt-sql', 'opt-filters'])
    expect(keys(w.find('[data-test=col-right]').element)).toEqual(['opt-exporter', 'opt-exported-at', 'opt-datasource', 'opt-run-at'])
  })
  it("exporter name is not rendered (dialog text lacks 'alice.zhang', no [data-test=exporter-name])", () => {
    const w = mount(ExportDialog, { props: props({ exporterName: 'alice.zhang' }) })
    expect(w.text()).not.toContain('alice.zhang')
    expect(w.find('[data-test=exporter-name]').exists()).toBe(false)
  })
  it('exporterName null hides opt-exporter, other three right options remain', () => {
    const w = mount(ExportDialog, { props: props({ exporterName: null }) })
    expect(keys(w.find('[data-test=col-right]').element)).toEqual(['opt-exported-at', 'opt-datasource', 'opt-run-at'])
  })
  it('checkbox labels read zh and en', () => {
    const labels = (w: any) => ['opt-sql', 'opt-filters', 'opt-exporter', 'opt-exported-at', 'opt-datasource', 'opt-run-at'].map((k) => w.find(`[data-test=${k}]`).element.parentElement!.textContent!.trim())
    expect(labels(mount(ExportDialog, { props: props({ exporterName: 'x' }) }))).toEqual(['包含 SQL', '包含输入参数', '导出人', '导出时间', '数据源名称', '数据运行时间'])
    setLocale('en')
    expect(labels(mount(ExportDialog, { props: props({ exporterName: 'x' }) }))).toEqual(['Include SQL', 'Include input parameters', 'Exporter', 'Export time', 'Data source name', 'Data run time'])
  })
  it('both columns are labelled groups', () => {
    const w = mount(ExportDialog, { props: props() })
    for (const k of ['col-left', 'col-right']) {
      expect(w.find(`[data-test=${k}]`).attributes('role')).toBe('group')
      expect(w.find(`[data-test=${k}]`).attributes('aria-label')).toBeTruthy()
    }
  })
  it('toggling each checkbox writes the same option key as before', async () => {
    const w = mount(ExportDialog, { props: props({ exporterName: 'x' }) })
    for (const k of ['opt-sql', 'opt-filters', 'opt-exporter', 'opt-exported-at', 'opt-datasource', 'opt-run-at']) await sel(w, k).setValue(!(sel(w, k).element as HTMLInputElement).checked)
    await sel(w, 'go').trigger('click')
    const o = w.emitted('export')![0][0] as any
    expect([o.includeSql, o.filtersLine, o.header.exporter, o.header.exportedAt, o.header.dataSource, o.header.dataRunAt]).toEqual([true, false, false, false, false, false])
  })
  it('remembered off states (header.* and filtersLine) restore unchecked boxes', () => {
    const o = { ...DEFAULT_EXPORT_OPTIONS, filtersLine: false, header: { ...DEFAULT_EXPORT_OPTIONS.header, exporter: false, exportedAt: false, dataSource: false, dataRunAt: false } }
    const w = mount(ExportDialog, { props: props({ exporterName: 'x', initial: o }) })
    for (const k of ['opt-filters', 'opt-exporter', 'opt-exported-at', 'opt-datasource', 'opt-run-at']) expect((sel(w, k).element as HTMLInputElement).checked).toBe(false)
  })
  it('the note textarea follows the columns in DOM order', () => {
    const w = mount(ExportDialog, { props: props() })
    const cols = w.find('[data-test=header-cols]').element, note = w.find('[data-test=note]').element
    expect(cols.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cols.contains(note)).toBe(false)
  })
})
