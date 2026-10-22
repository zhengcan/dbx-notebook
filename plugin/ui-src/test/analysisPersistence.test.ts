import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { serializeNotebook, parseNotebook, createEmptyNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

const NOW = () => new Date('2026-01-02T03:04:05.000Z')
const pv = { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }
const okRun = (executedAt = 'T1', cols = ['region', 'amount']) => ({
  status: 'ok' as const, executedAt,
  result: { columns: cols.map((n) => ({ name: n, dataType: n === 'amount' ? 'integer' : 'text' })), rows: [['SECRET_ROW', 7]], truncated: false, elapsedMs: 1, dbType: 'sqlite' },
})
const sqlB = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const chart = (md: any, extra: any = {}) => ({ id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: pv, ...md }, ...extra })

function text(blocks: any[], settings: any = { outputs: 'separate' }, metadata: any = {}) {
  const nb = createEmptyNotebook() as any
  nb.blocks = blocks; nb.settings = settings; nb.metadata = { ...nb.metadata, ...metadata }
  return serializeNotebook(nb)
}
function loaded(blocks: any[], o: { run?: boolean; settings?: any; metadata?: any } = {}) {
  const s = useNotebookStore({ now: NOW })
  s.load(text(blocks, o.settings, o.metadata), null, null)
  if (o.run) s.runs.set('s1', okRun() as any)
  return s
}
const meta = (s: any, id = 'c1') => s.nb.value.blocks.find((b: any) => b.id === id).metadata
const rt = (s: any) => { const t = useNotebookStore({ now: NOW }); t.load(s.toText(), null, null); return t }

describe('analysis persistence', () => {
  it('round-trips pivot/view/chartOptions', () => {
    const s = loaded([sqlB, chart({ view: 'chart', chartOptions: { type: 'line' } })], { run: true })
    s.setAnalysis('c1', { view: 'chart' })
    const r = rt(s)
    for (const k of ['pivot', 'view', 'chartOptions']) expect(meta(r)[k]).toEqual(meta(s)[k])
    expect(r.dirty.value).toBe(false)
  })
  it('spec follows config change and is saved', () => {
    const s = loaded([sqlB, chart({})], { run: true })
    s.setAnalysis('c1', { chartOptions: { type: 'line' } })
    const spec = JSON.stringify(meta(s).spec)
    expect(spec).not.toBe('{}')
    expect(JSON.stringify(meta(rt(s)).spec)).toBe(spec)
    s.setAnalysis('c1', { chartOptions: { type: 'bar' } })
    expect(JSON.stringify(meta(s).spec)).not.toBe(spec)
  })
  it('hand-edited spec is ignored when pivot exists', () => {
    const s = loaded([sqlB, chart({ spec: { hand: 'edited' } })])
    s.runs.set('s1', okRun() as any)
    const r = loaded([sqlB, chart({ spec: { hand: 'edited' } })], { run: true })
    expect(meta(r).spec.hand).toBeUndefined()
    expect(meta(s).spec.hand).toBeUndefined()
  })
  it('spec-only chart is unchanged byte for byte', () => {
    const md = { data: 'sales', spec: { mark: 'bar', note: 'hand' } }
    const s = loaded([sqlB, { id: 'c1', type: 'chart', metadata: md }], { run: true })
    expect(s.dirty.value).toBe(false)
    expect(JSON.stringify(meta(s))).toBe(JSON.stringify(md))
    const t1 = s.toText(), t2 = rt(s).toText()
    expect(t2).toBe(t1)
  })
  it('preserves unknown metadata keys and unknown block types', () => {
    const s = loaded([sqlB, chart({ future: { a: 1 } }), { id: 'u1', type: 'weird', content: 'x', metadata: { k: 1 } }])
    const r = rt(s)
    expect(meta(r).future).toEqual({ a: 1 })
    expect(r.nb.value.blocks.find((b) => b.id === 'u1')).toMatchObject({ type: 'weird', metadata: { k: 1 } })
  })
  it('tampered pivot is normalised, noticed and dirty', () => {
    const s = loaded([sqlB, chart({ pivot: { rows: [{ field: 'region' }], columns: [{ field: 'a', grain: 'bogus' }], values: [{ field: 'amount', agg: 'nope' }] } })])
    const p = meta(s).pivot
    expect(Array.isArray(p.rows) && Array.isArray(p.columns) && Array.isArray(p.values)).toBe(true)
    expect(JSON.stringify(p)).not.toMatch(/bogus|nope/)
    expect(s.dirty.value).toBe(true)
    expect(s.loadNotices.value).toEqual(['c1'])
  })
  it('clean load is not dirty and has no notice', () => {
    const s = loaded([sqlB, chart({})])
    expect(s.dirty.value).toBe(false)
    expect(s.loadNotices.value).toEqual([])
  })
  it('regenerates lazily when source result arrives; dirty only if different', async () => {
    const s = loaded([sqlB, chart({ spec: { hand: 1 } })])
    expect(s.dirty.value).toBe(false)
    s.runs.set('s1', okRun() as any)
    await nextTick()
    expect(s.dirty.value).toBe(true)
    expect(meta(s).spec.hand).toBeUndefined()
    const saved = s.toText()
    const s2 = useNotebookStore({ now: NOW })
    s2.load(saved, null, null)
    s2.runs.set('s1', okRun() as any)
    await nextTick()
    expect(s2.dirty.value).toBe(false)
  })
  it('collectEntries excludes chart and big-number', () => {
    const s = loaded([sqlB, chart({}), { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', agg: 'sum' } } }], { run: true })
    s.runs.set('c1', okRun() as any); s.runs.set('n1', okRun() as any)
    expect(Object.keys(s.collectEntries())).toEqual(['s1'])
  })
  it('inline mode writes no outputs for chart/big-number', () => {
    const s = loaded([sqlB, chart({}), { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', agg: 'sum' } } }], { run: true, settings: { outputs: 'inline' } })
    s.runs.set('c1', okRun() as any); s.runs.set('n1', okRun() as any)
    const nb = parseNotebook(s.toText())
    expect(nb.blocks.find((b) => b.id === 's1')!.outputs).toBeDefined()
    expect(nb.blocks.find((b) => b.id === 'c1')!.outputs).toBeUndefined()
    expect(nb.blocks.find((b) => b.id === 'n1')!.outputs).toBeUndefined()
  })
  it('stale .out chart entry is ignored', () => {
    const s = loaded([sqlB, chart({})])
    s.applyEntries({ c1: { columns: [], rows: [], executedAt: 'x', elapsedMs: 0, truncated: false } as any })
    expect(s.runs.has('c1')).toBe(false)
  })
  it('duplicate keeps config', () => {
    const s = loaded([sqlB, chart({ view: 'chart' })], { run: true })
    const id = s.duplicateBlock('c1')
    expect(meta(s, id).pivot).toEqual(meta(s).pivot)
    expect(meta(s, id).view).toBe('chart')
  })
  it('file contains no data values', () => {
    const s = loaded([sqlB, chart({})], { run: true })
    s.setAnalysis('c1', { chartOptions: { type: 'line' } })
    const t = s.toText()
    expect(t).not.toContain('SECRET_ROW')
    expect(JSON.stringify(meta(s).spec.data)).not.toContain('values')
    expect(t).not.toMatch(/"values"/)
  })
})

describe('load ordering and malformed config repair', () => {
  it('loading a second notebook does not regenerate/touch from stale runs of the first', () => {
    const s = loaded([sqlB], { run: true })
    const rev = s.revision.value
    s.load(text([sqlB, chart({ spec: { keep: 1 } })]), null, null)
    expect(s.revision.value).toBe(rev)
    expect(s.dirty.value).toBe(false)
    expect(meta(s).spec).toEqual({ keep: 1 })
  })
  for (const [name, md] of [
    ['view number', { view: 3 }], ['view junk', { view: 'weird' }], ['chartOptions string', { chartOptions: 'x' }],
    ['pivot string', { pivot: 'x' }], ['pivot number', { pivot: 5 }], ['pivot array', { pivot: [1] }],
    ['pivot fields wrong', { pivot: { rows: 'x', columns: 3, values: {} } }],
  ] as const) {
    it('repairs ' + name + ' with notice and dirty, without throwing', () => {
      const s = loaded([sqlB, chart(md as any, {})])
      expect(s.dirty.value).toBe(true)
      expect(s.loadNotices.value).toEqual(['c1'])
      const m = meta(s)
      expect(['table', 'chart', 'both']).toContain(m.view)
      expect(typeof m.chartOptions).toBe('object')
      if ('pivot' in m) expect(Array.isArray(m.pivot.rows) && Array.isArray(m.pivot.values)).toBe(true)
    })
  }
  it('non-object pivot with a non-empty spec becomes a read-only legacy chart', () => {
    const s = loaded([sqlB, chart({ pivot: 'x', spec: { mark: 'bar' } })])
    expect('pivot' in meta(s)).toBe(false)
    expect(meta(s).spec).toEqual({ mark: 'bar' })
  })
  it('non-object pivot with empty spec gets an empty pivot', () => {
    const s = loaded([sqlB, chart({ pivot: 'x', spec: {} })])
    expect(meta(s).pivot).toMatchObject({ rows: [], columns: [], values: [] })
  })

  describe('label patches (0.5.11)', () => {
    const settle = (s: any) => { const t = rt(s); t.runs.set('s1', okRun() as any); expect(t.dirty.value).toBe(false); return t }
    const labelled = () => settle(loaded([sqlB, chart({ pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }], summaryLabel: '合计' }, chartOptions: { type: 'bar', axisTitles: { x: 'X', y: 'Y' } } })], { run: true }))
    it('opening a pre-0.5.11 file leaves dirty false and save output byte-identical', () => {
      const s = settle(loaded([sqlB, chart({})], { run: true }))
      const t1 = s.toText()
      const r = rt(s)
      expect(r.dirty.value).toBe(false)
      expect(r.toText()).toBe(t1)
    })
    it('{pivot:{summaryLabel:undefined}} removes the key', () => {
      const s = labelled()
      s.setAnalysis('c1', { pivot: { summaryLabel: undefined } })
      expect('summaryLabel' in meta(s).pivot).toBe(false)
      expect(s.toText()).not.toContain('合计')
    })
    it('axisTitles patch merges and undefined deletes one key', () => {
      const s = labelled()
      s.setAnalysis('c1', { chartOptions: { axisTitles: { x: undefined, legend: 'L' } } })
      expect(meta(s).chartOptions.axisTitles).toEqual({ y: 'Y', legend: 'L' })
      s.setAnalysis('c1', { chartOptions: { axisTitles: { y: undefined, legend: undefined } } })
      expect('axisTitles' in meta(s).chartOptions).toBe(false)
    })
    it('a no-op patch creates no history entry and no dirty flag', () => {
      const s = labelled()
      s.setAnalysis('c1', { pivot: { summaryLabel: '合计' } })
      s.setAnalysis('c1', { pivot: { summaryLabel: '合计' }, chartOptions: { axisTitles: { x: 'X' } } })
      s.setAnalysis('c1', { chartOptions: { title: undefined } })
      expect(s.dirty.value).toBe(false)
      expect(s.history.undoDepth.value).toBe(0)
    })
    it('two label patches are two undo steps and undo restores key absence', () => {
      const s = settle(loaded([sqlB, chart({})], { run: true }))
      const before = JSON.stringify(meta(s))
      s.setAnalysis('c1', { pivot: { summaryLabel: 'S' } })
      s.setAnalysis('c1', { chartOptions: { axisTitles: { x: 'X' } } })
      expect(s.history.undoDepth.value).toBe(2)
      s.undo()
      expect(meta(s).pivot.summaryLabel).toBe('S')
      expect('axisTitles' in meta(s).chartOptions).toBe(false)
      s.undo()
      expect('summaryLabel' in meta(s).pivot).toBe(false)
      expect(JSON.stringify(meta(s))).toBe(before)
      s.redo()
      expect(meta(s).pivot.summaryLabel).toBe('S')
    })
    it('a setAnalysis inside an AI edit adds only the single AI history entry', () => {
      const s = loaded([sqlB, chart({})], { run: true })
      s.applyAiEdit({ label: 'ai', run: (tx) => { tx.setAnalysis('c1', { pivot: { summaryLabel: 'S' } }) } })
      expect(s.history.undoDepth.value).toBe(1)
    })
    it('label fields survive save/reopen with dirty false', () => {
      const s = labelled()
      s.setAnalysis('c1', { pivot: { rows: [{ field: 'region', label: '地区', valueLabels: { a: 'A' }, nullLabel: '无' }] } })
      const r = rt(s)
      expect(meta(r).pivot.rows[0]).toEqual({ field: 'region', label: '地区', valueLabels: { a: 'A' }, nullLabel: '无' })
      expect(r.dirty.value).toBe(false)
      expect(r.toText()).toBe(s.toText())
    })
    it('unknown keys inside pivot/refs are not an error on open', () => {
      const s = settle(loaded([sqlB, chart({ pivot: { ...pv, futureKey: 1 } })], { run: true }))
      expect(s.dirty.value).toBe(false)
    })
  })
})
