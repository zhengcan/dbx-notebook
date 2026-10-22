import { describe, it, expect } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore } from '../src/state/notebookStore'

const cols = (dType: string) => [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: dType }]
const run = (dType: string) => ({ status: 'ok' as const, executedAt: 'T1', result: { columns: cols(dType), rows: [['a', 1, '2026-01-01']], truncated: false, elapsedMs: 1, dbType: 'sqlite' } }) as any
const pv = { rows: [{ field: 'd' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }

function mk() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  const nb: any = createEmptyNotebook()
  nb.blocks = [
    { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } },
    { id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } } },
  ]
  s.load(serializeNotebook(nb), '/x.sqlnb', 1)
  s.runs.set('s1', run('date'))
  const meta = () => s.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any
  return { s, meta }
}

describe('undo vs derived chart spec', () => {
  it('upstream column type change regenerates spec; undoing the earlier chart edit still works and spec follows current data', () => {
    const { s, meta } = mk()
    s.setAnalysis('c1', { pivot: pv as any })
    s.setAnalysis('c1', { chartOptions: { type: 'line' } })
    const specInt = JSON.stringify(meta().spec)
    s.runs.set('s1', run('text'))
    const specText = JSON.stringify(meta().spec)
    expect(specText).not.toBe(specInt)
    const r = s.undo()
    expect(r.ok).toBe(true)
    expect(meta().chartOptions.type).toBe('bar')
    const s2 = useNotebookStore()
    const copy: any = JSON.parse(JSON.stringify(s.nb.value))
    copy.blocks[1].metadata.spec = { stale: 1 }
    s2.load(serializeNotebook(copy), null, null)
    s2.runs.set('s1', run('text'))
    expect(JSON.stringify(meta().spec)).toBe(JSON.stringify((s2.nb.value.blocks[1].metadata as any).spec))
    s.redo()
    expect(meta().chartOptions.type).toBe('line')
    expect(JSON.stringify(meta().spec)).toBe(specText)
  })
  it('a derived-only (spec) difference never conflicts; a user-field divergence still does', () => {
    const { s, meta } = mk()
    s.setAnalysis('c1', { pivot: pv as any })
    meta().spec = { ...meta().spec, derivedTouch: 1 }
    expect(s.undo().ok).toBe(true)
    s.redo()
    meta().chartOptions = { ...meta().chartOptions, type: 'area' }
    const r = s.undo()
    expect(r.ok).toBe(false); expect(!r.ok && r.reason).toBe('conflict')
  })
  it('undo at the saved state with unchanged data stays byte-identical and clean', () => {
    const { s } = mk()
    const t0 = s.toText()
    s.setAnalysis('c1', { pivot: pv as any })
    s.undo()
    expect(s.toText()).toBe(t0)
    expect(s.dirty.value).toBe(false)
  })
  it('setAnalysis entry has a history.label key', () => {
    const { s } = mk()
    s.setAnalysis('c1', { chartOptions: { type: 'line' } })
    const r = s.undo()
    expect(r.ok && r.entry.label).toBe('history.label.editChart')
  })
})
