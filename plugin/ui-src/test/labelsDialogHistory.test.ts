import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { mount, flushPromises } from '@vue/test-utils'
import LabelsDialog from '../src/analysis/LabelsDialog.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { setLocale } from '../src/i18n'

function setup() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  s.load(serializeNotebook(createEmptyNotebook()), null, null)
  const a = s.addBlock('sql', null)
  const ch = s.addBlock('chart', a)
  s.nb.value.blocks.find((b) => b.id === ch)!.metadata = {
    data: '', spec: {}, view: 'both',
    chartOptions: { type: 'bar', title: 'T', axisTitles: { x: 'AX' } },
    pivot: { rows: [{ field: 'f', label: 'F', valueLabels: { a: 'A' } }], columns: [], values: [{ field: 'a', agg: 'sum', label: 'M' }], summaryLabel: 'S' },
  } as any
  const runner = vi.fn(async () => ({}) as any)
  s.setAnalysisRunner(runner)
  return { s, ch, runner }
}
const md = (s: any, ch: string) => s.nb.value.blocks.find((b: any) => b.id === ch).metadata
const mountDlg = (s: any, ch: string) => {
  setLocale('en')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const w = mount(LabelsDialog, {
    props: { cfg: { pivot: md(s, ch).pivot, chart: md(s, ch).chartOptions }, categories: { row: [['a']], column: [] }, ctx: { empty: '(e)', summary: 'S' }, container, returnFocus: null, onCommit: (p: any) => s.setAnalysis(ch, p) },
    attachTo: document.body,
  })
  return { w, container }
}
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

describe('dialog resets against the real store history', () => {
  it.each(['group', 'all'] as const)('reset %s = ONE history entry; undo restores, refresh runs, redo clears', async (mode) => {
    vi.useFakeTimers()
    const { s, ch, runner } = setup()
    s.setAnalysis(ch, { chartOptions: { title: 'T0' } })
    s.setAnalysis(ch, { chartOptions: { title: 'T' } })
    vi.advanceTimersByTime(500)
    const depth = s.history.undoDepth.value
    const before = JSON.stringify(md(s, ch))
    const { w, container } = mountDlg(s, ch)
    await flushPromises()
    if (mode === 'group') container.querySelector<HTMLElement>('[data-tab=chart]')!.click()
    await flushPromises()
    container.querySelector<HTMLElement>(`[data-test=labels-reset-${mode === 'group' ? 'tab' : 'all'}]`)!.click()
    expect(s.history.undoDepth.value).toBe(depth + 1)
    const m = md(s, ch)
    expect(m.chartOptions.title).toBeUndefined()
    expect(m.chartOptions.axisTitles).toBeUndefined()
    if (mode === 'all') {
      expect(m.pivot.rows[0].label).toBeUndefined()
      expect(m.pivot.rows[0].valueLabels).toBeUndefined()
      expect(m.pivot.values[0].label).toBeUndefined()
      expect(m.pivot.summaryLabel).toBeUndefined()
    } else {
      expect(m.pivot.rows[0].label).toBe('F')
      expect(m.pivot.summaryLabel).toBe('S')
    }
    const after = JSON.stringify(m)
    vi.advanceTimersByTime(500)
    runner.mockClear()
    expect(s.undo().ok).toBe(true)
    expect(JSON.stringify(md(s, ch))).toBe(before)
    vi.advanceTimersByTime(500)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(s.history.undoDepth.value).toBe(depth)
    runner.mockClear()
    expect(s.redo().ok).toBe(true)
    expect(JSON.stringify(md(s, ch))).toBe(after)
    vi.advanceTimersByTime(500)
    expect(runner).toHaveBeenCalledTimes(1)
    s.undo()
    s.undo()
    expect(md(s, ch).chartOptions.title).toBe('T0')
    w.unmount()
  })
})
