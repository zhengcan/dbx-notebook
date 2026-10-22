import { describe, it, expect } from 'vitest'
import { mkStore } from './undoHelpers'
import type { Block } from '@sqlnb/format'

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 } }

describe('undo property: text/meta/big-number/settings', () => {
  it('200 seeded sequences: undo all = original bytes + clean; redo all = final bytes', () => {
    for (let seq = 0; seq < 200; seq++) {
      const r = rng(seq + 1)
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
      const { s, clock, text } = mkStore()
      const orig = text()
      const n = 5 + Math.floor(r() * 25)
      for (let k = 0; k < n; k++) {
        clock.t += pick([5, 50, 900])
        const co = r() < 0.5
        pick<() => void>([
          () => s.updateContent('s1', 'q' + Math.floor(r() * 5), { coalesce: co }),
          () => s.updateContent('m1', 'm' + Math.floor(r() * 5), { coalesce: co }),
          () => s.updateMeta('s1', { maxRows: Math.floor(r() * 4) + 1 }),
          () => s.removeMetaKey('s1', pick(['connection', 'maxRows', 'resultName'])),
          () => s.updateMeta('i1', { value: pick([1, 2, 3]) }),
          () => s.updateMeta('i1', { variable: pick(['v', 'w', 'z']) }, { coalesce: co ? 'variable' : undefined }),
          () => s.setBigNumber('n1', { aggregate: pick(['sum', 'avg', 'count']) }),
          () => s.setBigNumber('n1', { label: pick(['', 'a', 'b']) }, { coalesce: co }),
          () => s.addBigNumberMetric('n1'),
          () => s.removeBigNumberMetric('n1', 1),
          () => s.moveBigNumberMetric('n1', 1, -1),
          () => s.setDefaultConnection(pick(['pg', 'my'])),
          () => s.setDefaultCatalog(pick(['a', undefined]), pick(['b', undefined])),
          () => s.setOutputsMode(pick(['separate', 'inline', 'none'] as const)),
          () => s.setTransposed('s1', r() < 0.5),
          () => s.sealHistory(),
        ])()
      }
      const final = text()
      const finalDirty = s.dirty.value
      while (s.history.canUndo.value) expect(s.undo().ok).toBe(true)
      expect(text()).toBe(orig)
      expect(s.dirty.value).toBe(false)
      while (s.history.canRedo.value) expect(s.redo().ok).toBe(true)
      expect(text()).toBe(final)
      expect(s.dirty.value).toBe(finalDirty)
    }
  })
})

const BLOCKS = () => [
  { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales', connection: 'c' } },
  { id: 'm1', type: 'markdown', content: 'hello' },
  { id: 'i1', type: 'input', metadata: { variable: 'v', inputType: 'select', options: [1, 2, 3], value: 1 } },
  { id: 'n1', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' } } },
  { id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [], columns: [], values: [] } } },
] as unknown as Block[]
const RUN = { status: 'ok', executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }], rows: [['a', 1, '2026-01-01']], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any

describe('undo property: all families with interleaved saves', () => {
  it('200 seeded sequences', () => {
    for (let seq = 0; seq < 200; seq++) {
      const r = rng(1000 + seq)
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
      const { s, clock, text } = mkStore(BLOCKS())
      s.runs.set('s1', RUN)
      s.markClean()
      const orig = text()
      let saved = { text: orig, depth: 0 }
      const n = 8 + Math.floor(r() * 30)
      for (let k = 0; k < n; k++) {
        clock.t += pick([5, 50, 900])
        const co = r() < 0.5
        pick<() => void>([
          () => s.updateContent('s1', 'q' + Math.floor(r() * 5), { coalesce: co }),
          () => s.updateContent('m1', 'm' + Math.floor(r() * 5), { coalesce: co }),
          () => s.updateMeta('s1', { [pick(['database', 'schema', 'maxRows'])]: pick(['a', 'b']) }),
          () => s.removeMetaKey('s1', pick(['database', 'schema', 'connection'])),
          () => s.editBlock('i1', () => { s.updateMeta('i1', { inputType: pick(['text', 'select']) }); s.removeMetaKey('i1', 'options'); s.updateMeta('i1', { value: pick(['x', 'y']) }) }),
          () => s.editBlock('i1', () => { s.updateMeta('i1', { options: pick([[1], [1, 2], []]) }); s.removeMetaKey('i1', 'value') }, { key: 'i1:options' }),
          () => s.editBlock('i1', () => { s.updateMeta('i1', { multiple: true }); s.updateMeta('i1', { value: [] }) }),
          () => s.setBigNumber('n1', { field: pick(['amount', 'region']) }),
          () => s.setBigNumber('n1', { format: pick([null, { kind: 'thousands', decimals: 1 }]) }),
          () => s.setBigNumber('n1', { filter: pick([null, [{ field: 'region', op: 'eq', value: 'a' } as any]]) }),
          () => s.setBigNumber('n1', { compare: pick([null, { kind: 'previous', dateField: 'd' } as any]) }),
          () => s.setBigNumber('n1', { data: pick(['sales', 'other']) }),
          () => s.setAnalysis('c1', { pivot: pick([{ rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, { rows: [{ field: 'd' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }]) as any }),
          () => s.setAnalysis('c1', { chartOptions: { type: pick(['bar', 'line']) } as any }),
          () => s.setDefaultCatalog(pick(['a', undefined]), pick(['b', undefined])),
          () => s.sealHistory(),
          () => { s.markSaved('/x.sqlnb', 2, s.revision.value); saved = { text: text(), depth: s.history.undoDepth.value } },
          () => { s.markClean(); saved = { text: text(), depth: s.history.undoDepth.value } },
        ])()
      }
      const final = text()
      while (s.history.canUndo.value) {
        expect(s.undo().ok).toBe(true)
        if (s.history.undoDepth.value === saved.depth) {
          expect(text()).toBe(saved.text)
          expect(s.dirty.value).toBe(false)
        }
      }
      expect(text()).toBe(orig)
      while (s.history.canRedo.value) expect(s.redo().ok).toBe(true)
      expect(text()).toBe(final)
    }
  })
})

describe('undo property: structural families with edits and saves', () => {
  it('200 seeded sequences: bytes, ids and order follow a reference model; dirty at saved depths', () => {
    for (let seq = 0; seq < 200; seq++) {
      const r = rng(5000 + seq)
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
      const { s, clock, text } = mkStore(BLOCKS())
      s.runs.set('s1', RUN)
      s.markClean()
      const orig = text()
      const ids = () => s.nb.value.blocks.map((b) => b.id)
      let model: string[] = ids()   // independent reference model: expected ids, maintained by applying each op to a plain array
      const atDepth: string[][] = [[...model]]
      let saved = { text: orig, depth: 0 }
      const anyId = () => pick(ids())
      const ofType = (ty: string) => { const l = s.nb.value.blocks.filter((b) => b.type === ty); return l.length ? pick(l).id : null }
      const n = 8 + Math.floor(r() * 30)
      for (let k = 0; k < n; k++) {
        clock.t += pick([5, 50, 900])
        const co = r() < 0.5
        pick<() => void>([
          () => { const after = r() < 0.3 || !model.length ? null : pick(model); const id = s.addBlock(pick(['markdown', 'sql', 'results', 'input', 'chart', 'big-number'] as const), after); model.splice(after === null ? 0 : model.indexOf(after) + 1, 0, id) },
          () => { if (model.length) { const id = pick(model); s.removeBlock(id); model = model.filter((x) => x !== id) } },
          () => { if (model.length) { const id = pick(model); const d = pick([-1, 1] as const); const i = model.indexOf(id); const j = i + d; s.moveBlock(id, d); if (j >= 0 && j < model.length) { model.splice(i, 1); model.splice(j, 0, id) } } },
          () => { if (model.length) { const id = pick(model); const c = s.duplicateBlock(id); model.splice(model.indexOf(id) + 1, 0, c) } },
          () => { const id = ofType('sql'); if (id) { s.runs.set(id, RUN); const c = s.visualizeResult(id)!; model.splice(model.indexOf(id) + 1, 0, c) } },
          () => { const id = ofType('sql'); if (id) { s.runs.set(id, RUN); s.removeMetaKey(id, 'resultName'); atDepth[s.history.undoDepth.value] = [...model]; const c = s.visualizeResult(id)!; model.splice(model.indexOf(id) + 1, 0, c); expect((s.nb.value.blocks.find((b) => b.id === id)!.metadata as any).resultName).toBeTruthy() } },
          () => { const id = ofType('markdown'); if (id) s.updateContent(id, 'm' + Math.floor(r() * 5), { coalesce: co }) },
          () => { const id = ofType('sql'); if (id) s.updateContent(id, 'q' + Math.floor(r() * 5), { coalesce: co }) },
          () => { const id = ofType('sql'); if (id) s.updateMeta(id, { maxRows: Math.floor(r() * 4) + 1 }) },
          () => { const id = ofType('sql'); if (id) s.setTransposed(id, r() < 0.5) },
          () => { const id = ofType('input'); if (id) s.updateMeta(id, { value: pick([1, 2, 3]) }) },
          () => { const id = ofType('big-number'); if (id) s.setBigNumber(id, { aggregate: pick(['sum', 'avg', 'count']) }) },
          () => s.sealHistory(),
          () => { s.markSaved('/x.sqlnb', 2, s.revision.value); saved = { text: text(), depth: s.history.undoDepth.value } },
        ])()
        expect(ids()).toEqual(model)
        atDepth[s.history.undoDepth.value] = [...model]
      }
      const final = text()
      const finalIds = ids()
      while (s.history.canUndo.value) {
        expect(s.undo().ok).toBe(true)
        const d = s.history.undoDepth.value
        expect(ids()).toEqual(atDepth[d])
        if (d === saved.depth) { expect(text()).toBe(saved.text); expect(s.dirty.value).toBe(false) }
      }
      expect(text()).toBe(orig)
      expect(s.dirty.value).toBe(saved.depth !== 0) // clean only when the last save was the opening state
      while (s.history.canRedo.value) {
        expect(s.redo().ok).toBe(true)
        expect(ids()).toEqual(atDepth[s.history.undoDepth.value])
      }
      expect(text()).toBe(final)
      expect(ids()).toEqual(finalIds)
    }
  })
})
