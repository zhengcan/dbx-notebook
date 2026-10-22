import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import LabelsDialog from '../src/analysis/LabelsDialog.vue'
import { countOverrides, resetLabels, type ScopeKey } from '../src/analysis/labelPatch'
import { useNotebookStore } from '../src/state/notebookStore'
import { setLocale } from '../src/i18n'

const ctx = { empty: '(e)', summary: 'S' }
const keys = Array.from({ length: 80 }, (_, i) => `k${i}`)
const mkCfg = (rowOver: any = {}, extra: any = {}) => ({
  pivot: { rows: [{ field: 'f', ...rowOver }], columns: [], values: [{ field: 'a', agg: 'sum' }], ...extra },
  chart: { type: 'bar' },
}) as any
let ws: VueWrapper<any>[] = []
afterEach(() => { ws.forEach((w) => { try { w.unmount() } catch { /* */ } }); ws = []; document.body.innerHTML = '' })

async function open(cfg: any, onCommit?: (p: any) => void) {
  setLocale('en')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const w = mount(LabelsDialog, { props: { cfg, categories: { row: [keys], column: [] }, ctx, container, returnFocus: container, onCommit }, attachTo: document.body })
  ws.push(w)
  await flushPromises()
  const q = <T extends HTMLElement>(s: string) => container.querySelector(s) as T
  const count = () => (q('[data-tab=categories] .ld-n')?.textContent ?? '').replace('● ', '')
  return { q, count, w, container }
}

describe('dialog counts come from the config, not the rendered rows', () => {
  it('80 categories, only k70 mapped, group collapsed: count 1, resets enabled, reset clears it', async () => {
    const cfg = mkCfg({ valueLabels: { k70: 'X' } })
    const commits: any[] = []
    const { q, count } = await open(cfg, (p) => commits.push(p))
    expect(count()).toBe('1')
    q('[data-tab=categories]').click()
    await flushPromises()
    expect(q('[data-label-target="category:row:0:k70"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-test=labels-reset-tab]').disabled).toBe(false)
    expect(q<HTMLButtonElement>('[data-test=labels-reset-all]').disabled).toBe(false)
    q('[data-test=labels-reset-tab]').click()
    expect(commits).toHaveLength(1)
    expect(commits[0].pivot.rows[0].valueLabels).toBeUndefined()
  })

  it('an active search that hides the overridden row does not change the count', async () => {
    const { q, count } = await open(mkCfg({ valueLabels: { k70: 'X' } }))
    q('[data-tab=categories]').click()
    await flushPromises()
    const s = q<HTMLInputElement>('[data-test=label-search]')
    s.value = 'k1'
    s.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(q('[data-label-target="category:row:0:k70"]')).toBeNull()
    expect(count()).toBe('1')
    expect(q<HTMLButtonElement>('[data-test=labels-reset-tab]').disabled).toBe(false)
  })

  it('unused mapping keys and nullLabel are counted', async () => {
    const { count } = await open(mkCfg({ valueLabels: { gone: 'G', k1: 'A' }, nullLabel: 'N' }))
    expect(count()).toBe('3')
  })

  it('countOverrides equals what resetLabels removes (property check over scopes)', () => {
    const cfg = mkCfg({ label: 'L', nullLabel: 'N', valueLabels: { k70: 'X', gone: 'G' } }, { summaryLabel: 'S', values: [{ field: 'a', agg: 'sum', label: 'M', format: { kind: 'thousands', unit: 'u', scale: 100 } }, { field: 'b', agg: 'sum', format: { kind: 'percent', scale: 5 } }] })
    cfg.chart = { type: 'bar', title: 'T', axisTitles: { x: 'X', legend: 'L' } }
    const scopes: ('all' | ScopeKey)[] = ['all', 'table', 'chart', 'numbers', 'categories']
    for (const sc of scopes) {
      const n = countOverrides(cfg, sc)
      const p = resetLabels(cfg, sc)
      const after = { pivot: { ...cfg.pivot, ...(p.pivot ?? {}) }, chart: { ...cfg.chart, ...(p.chartOptions ?? {}) } }
      expect(countOverrides(after as any, sc), sc).toBe(0)
      expect(n > 0, sc).toBe(!!(p.pivot || p.chartOptions))
      expect(n, sc).toBe(countOverrides(cfg, sc) - countOverrides(after as any, sc))
    }
    expect(countOverrides(cfg, 'all')).toBe((['table', 'chart', 'numbers', 'categories'] as ScopeKey[]).reduce((a, k) => a + countOverrides(cfg, k), 0))
    expect(countOverrides(cfg, 'categories')).toBe(3)
    expect(countOverrides(cfg, 'numbers')).toBe(2)
  })

  it('hidden override reset is one history step in the real store', async () => {
    const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
    s.load(serializeNotebook(createEmptyNotebook()), null, null)
    const a = s.addBlock('sql', null)
    const ch = s.addBlock('chart', a)
    s.nb.value.blocks.find((b) => b.id === ch)!.metadata = { data: '', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [{ field: 'f', valueLabels: { k70: 'X' } }], columns: [], values: [{ field: 'a', agg: 'sum' }] } } as any
    const md = () => (s.nb.value.blocks.find((b) => b.id === ch)!.metadata as any)
    const depth = s.history.undoDepth.value
    const { q } = await open({ pivot: md().pivot, chart: md().chartOptions }, (p) => s.setAnalysis(ch, p))
    q('[data-test=labels-reset-all]').click()
    expect(s.history.undoDepth.value).toBe(depth + 1)
    expect(md().pivot.rows[0].valueLabels).toBeUndefined()
    s.undo()
    expect(md().pivot.rows[0].valueLabels).toEqual({ k70: 'X' })
  })
})
