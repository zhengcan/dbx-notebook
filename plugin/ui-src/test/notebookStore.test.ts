import { describe, it, expect } from 'vitest'
import { computed, watchEffect, nextTick } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { useNotebookStore, NotebookInvalidError } from '../src/state/notebookStore'
import { upstreamOf } from '../src/run/deps'
import { hashSql } from '../src/state/hash'

function fresh() {
  const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
  s.load(serializeNotebook(createEmptyNotebook()), null, null)
  return s
}
const ids = (s: ReturnType<typeof fresh>) => s.nb.value.blocks.map((b) => b.id)

describe('notebookStore', () => {
  it('load resets dirty/runs; instances independent', () => {
    const a = fresh(), b = fresh()
    a.addBlock('sql', null)
    expect(a.dirty.value).toBe(true)
    expect(b.nb.value.blocks).toHaveLength(0)
    a.runs.set('x', { status: 'ok' }); a.runs.set('y', { status: 'error' }); a.runs.set('z', { status: 'running' })
    a.load(serializeNotebook(createEmptyNotebook()), '/p', 5)
    expect(a.dirty.value).toBe(false)
    expect(a.runs.size).toBe(0)
    expect(a.runs.has('x') || a.runs.has('y') || a.runs.has('z')).toBe(false)
    expect(a.path.value).toBe('/p'); expect(a.mtimeMs.value).toBe(5)
  })
  it('add shapes and positions', () => {
    const s = fresh()
    const a = s.addBlock('markdown', null)
    const b = s.addBlock('sql', a)
    const c = s.addBlock('sql', null)
    expect(() => s.addBlock('markdown', 'nope')).toThrow('anchor-missing')
    expect(ids(s)).toEqual([c, a, b])
    expect(s.nb.value.blocks.find((x) => x.id === a)).toEqual({ id: a, type: 'markdown', content: '' })
    expect(s.nb.value.blocks.find((x) => x.id === b)).toEqual({ id: b, type: 'sql', content: '', metadata: {} })
  })
  it('remove deletes run; move no-op at edges', () => {
    const s = fresh()
    const a = s.addBlock('sql', null), b = s.addBlock('sql', a)
    s.runs.set(a, { status: 'ok' })
    s.markSaved('/p', 1)
    s.moveBlock(a, -1); s.moveBlock(b, 1)
    expect(s.dirty.value).toBe(false)
    s.moveBlock(a, 1)
    expect(ids(s)).toEqual([b, a]); expect(s.dirty.value).toBe(true)
    s.removeBlock(a)
    expect(ids(s)).toEqual([b]); expect(s.runs.has(a)).toBe(false)
  })
  it('duplicate deep copies, renames resultName', () => {
    const s = fresh()
    const a = s.addBlock('sql', null)
    s.updateMeta(a, { resultName: 'r', nested: { k: 1 } })
    const b = s.duplicateBlock(a)
    const c = s.duplicateBlock(a)
    const [x] = s.nb.value.blocks
    expect(ids(s)).toEqual([a, c, b])
    expect(b).not.toBe(a)
    const blk = s.nb.value.blocks.find((q) => q.id === b)!
    expect(blk.metadata!.resultName).toBe('r_copy')
    expect(s.nb.value.blocks.find((q) => q.id === c)!.metadata!.resultName).toBe('r_copy2')
    ;(blk.metadata!.nested as any).k = 2
    expect((x.metadata!.nested as any).k).toBe(1)
    const m = s.addBlock('markdown', null)
    const md = s.duplicateBlock(m)
    expect(s.nb.value.blocks.find((q) => q.id === md)!.metadata).toBeUndefined()
  })
  it('updates set dirty; markSaved clears', () => {
    const s = fresh()
    const a = s.addBlock('sql', null)
    s.markSaved('/q', 9)
    expect(s.dirty.value).toBe(false)
    s.updateContent(a, 'select 1'); expect(s.dirty.value).toBe(true)
    s.markSaved('/q', 10); s.updateMeta(a, { connection: 'c' }); expect(s.dirty.value).toBe(true)
    expect(s.path.value).toBe('/q')
  })
  it('unknown block types survive; toText sets modifiedAt', () => {
    const s = useNotebookStore({ now: () => new Date('2026-01-02T03:04:05.000Z') })
    const nb: any = createEmptyNotebook(); nb.blocks.push({ id: 'b_0', type: 'markdown', content: 'x' }, { id: 'b_1', type: 'weird', foo: 1 }, { id: 'b_2', type: 'sql', content: '' })
    nb.metadata.createdAt = '2020-01-01T00:00:00.000Z'
    s.load(serializeNotebook(nb), null, null)
    const t = s.toText()
    expect(t).toContain('weird')
    s.load(t, null, null)
    expect(s.nb.value.blocks.map((b) => b.id)).toEqual(['b_0', 'b_1', 'b_2'])
    expect(s.nb.value.blocks[1]).toMatchObject({ type: 'weird', foo: 1 })
    expect(t).toContain('2026-01-02T03:04:05.000Z')
    expect(t).toContain('2020-01-01T00:00:00.000Z')
  })
  it('isStale', () => {
    const s = fresh()
    const a = s.addBlock('sql', null), m = s.addBlock('markdown', a)
    s.updateContent(a, 'select 1')
    expect(s.isStale(a)).toBe(false)
    s.runs.set(a, { status: 'idle' }); expect(s.isStale(a)).toBe(false)
    s.runs.set(a, { status: 'ok', ranSqlHash: hashSql('select 1') })
    expect(s.isStale(a)).toBe(false)
    s.updateContent(a, 'select 2'); expect(s.isStale(a)).toBe(true)
    s.runs.set(m, { status: 'ok', ranSqlHash: 'zz' }); expect(s.isStale(m)).toBe(false)
    expect(hashSql('a\r\nb')).toBe(hashSql('a\nb'))
  })
  it('isStale edge cases', () => {
    const s = fresh()
    const a = s.addBlock('sql', null), m = s.addBlock('markdown', a)
    s.updateContent(a, 'select 1')
    s.runs.set(a, { status: 'ok', ranSqlHash: hashSql('select 1') })
    s.updateContent(a, 'select 2'); expect(s.isStale(a)).toBe(true)
    s.updateContent(a, 'select 1'); expect(s.isStale(a)).toBe(false)
    s.updateContent(a, 'other')
    s.runs.set(a, { status: 'error', ranSqlHash: hashSql('select 1') }); expect(s.isStale(a)).toBe(true)
    s.runs.set(a, { status: 'running', ranSqlHash: hashSql('select 1') }); expect(s.isStale(a)).toBe(false)
    s.runs.set(a, { status: 'idle', ranSqlHash: hashSql('select 1') }); expect(s.isStale(a)).toBe(false)
    s.runs.set(m, { status: 'ok', ranSqlHash: 'zz' }); expect(s.isStale(m)).toBe(false)
  })
  it('runs and isStale are reactive', async () => {
    const s = fresh()
    const a = s.addBlock('sql', null)
    s.updateContent(a, 'select 1')
    const status = computed(() => s.runs.get(a)?.status)
    const stale = computed(() => s.isStale(a))
    const seen: Array<[string | undefined, boolean]> = []
    watchEffect(() => { seen.push([status.value, stale.value]) })
    expect(seen.at(-1)).toEqual([undefined, false])
    s.runs.set(a, { status: 'ok', ranSqlHash: hashSql('select 1') })
    await nextTick()
    expect(seen.at(-1)).toEqual(['ok', false])
    s.updateContent(a, 'select 2')
    await nextTick()
    expect(seen.at(-1)).toEqual(['ok', true])
    s.runs.delete(a)
    await nextTick()
    expect(seen.at(-1)).toEqual([undefined, false])
  })
  it('setDefaultConnection adds once', () => {
    const s = fresh()
    s.setDefaultConnection('wh', 'pg'); s.setDefaultConnection('wh')
    expect(s.nb.value.settings.defaultConnection).toBe('wh')
    expect(s.nb.value.connections).toEqual([{ name: 'wh', dialect: 'pg' }])
    expect(s.dirty.value).toBe(true)
  })

  it('removeMetaKey removes key, marks dirty, no-op if absent', () => {
    const s = useNotebookStore()
    const a = s.addBlock('sql', null)
    s.updateMeta(a, { connection: 'c', x: 1 })
    s.markSaved('/q', 1)
    s.removeMetaKey(a, 'nope')
    expect(s.dirty.value).toBe(false)
    s.removeMetaKey(a, 'connection')
    expect(s.nb.value.blocks[0].metadata).toEqual({ x: 1 })
    expect(s.dirty.value).toBe(true)
  })
})

describe('notebookStore load validation (C1)', () => {
  it('round-trips every spec example', () => {
    const files = (import.meta as any).glob('../../../spec/examples/*.sqlnb', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(files).length).toBeGreaterThan(0)
    for (const text of Object.values(files)) {
      const s = useNotebookStore()
      s.load(text, null, null)
      const s2 = useNotebookStore()
      s2.load(s.toText(), null, null)
      expect(s2.nb.value.blocks).toEqual(s.nb.value.blocks)
    }
  })
  it('minimal file loads and accepts mutators', () => {
    const s = useNotebookStore()
    s.load('sqlnb: "1"\nblocks: []\n', null, null)
    expect(s.nb.value.metadata).toEqual({})
    expect(s.nb.value.settings).toEqual({ outputs: 'separate' })
    expect(s.nb.value.connections).toEqual([])
    s.addBlock('sql', null); s.setDefaultConnection('c', 'postgres')
    expect(() => s.toText()).not.toThrow()
  })
  it('keeps unknown fields while normalizing', () => {
    const s = useNotebookStore()
    s.load('sqlnb: "1"\nfoo: 1\nsettings:\n  x: 2\nblocks: []\n', null, null)
    expect(s.nb.value.foo).toBe(1)
    expect(s.nb.value.settings).toEqual({ outputs: 'separate', x: 2 })
    expect(s.toText()).toContain('foo: 1')
  })
  for (const [name, text] of [
    ['missing id', 'sqlnb: "1"\nblocks:\n  - type: sql\n'],
    ['duplicate ids', 'sqlnb: "1"\nblocks:\n  - {id: b_aaaaaa, type: sql}\n  - {id: b_aaaaaa, type: sql}\n'],
    ['blocks not array', 'sqlnb: "1"\nblocks: 5\n'],
  ] as const) {
    it(`rejects ${name} and keeps the open notebook`, () => {
      const s = fresh()
      s.addBlock('sql', null)
      const before = s.nb.value
      expect(() => s.load(text, '/x', 1)).toThrow(NotebookInvalidError)
      expect(s.nb.value).toBe(before)
      expect(s.dirty.value).toBe(true)
      expect(s.path.value).toBeNull()
    })
  }
})

describe('notebookStore revision (I2)', () => {
  it('markSaved with stale revision keeps dirty', () => {
    const s = fresh()
    s.addBlock('sql', null)
    const rev = s.revision.value
    s.addBlock('sql', null)
    s.markSaved('/p', 3, rev)
    expect(s.dirty.value).toBe(true)
    expect(s.path.value).toBe('/p'); expect(s.mtimeMs.value).toBe(3)
    s.markSaved('/p', 4, s.revision.value)
    expect(s.dirty.value).toBe(false)
  })
  it('load and markSaved do not bump revision', () => {
    const s = fresh()
    const r = s.revision.value
    s.markSaved('/p', 1, r)
    expect(s.revision.value).toBe(r)
  })
  it('setDefaultCatalog writes, removes, and only dirties on change', () => {
    const s = fresh()
    s.setDefaultCatalog('db', 'sc')
    expect(s.nb.value.settings.defaultDatabase).toBe('db')
    expect(s.nb.value.settings.defaultSchema).toBe('sc')
    expect(s.dirty.value).toBe(true)
    const rev = s.revision.value
    s.setDefaultCatalog('db', 'sc')
    expect(s.revision.value).toBe(rev)
    s.setDefaultCatalog('db', '  ')
    expect('defaultSchema' in s.nb.value.settings).toBe(false)
    expect(s.revision.value).toBe(rev + 1)
    s.setDefaultCatalog()
    expect('defaultDatabase' in s.nb.value.settings).toBe(false)
  })
  it('setDefaultCatalog works on legacy notebook without settings', () => {
    const s = fresh()
    ;(s.nb.value as any).settings = undefined
    s.setDefaultCatalog('d')
    expect(s.nb.value.settings.defaultDatabase).toBe('d')
    expect(s.nb.value.settings.outputs).toBe('separate')
  })
})

import { parseNotebook, parseOutFile, serializeOutFile, type OutputEntry } from '@sqlnb/format'

describe('notebookStore results plumbing (2b-4a)', () => {
  const okRun = (h = 'h'): any => ({ status: 'ok', result: { columns: [{ name: 'x', dataType: 'int' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'pg' }, ranSqlHash: h })
  const entry = (): OutputEntry => ({ columns: [{ name: 'x' }], rows: [[2]], executedAt: 'T', elapsedMs: 3, truncated: false, sqlHash: 'q' })
  function withSql() {
    const s = fresh()
    const a = s.addBlock('sql', null), b = s.addBlock('sql', a), m = s.addBlock('markdown', b)
    s.dirty.value = false
    return { s, a, b, m }
  }

  it('collectEntries only existing, sorted', () => {
    const { s, a, b } = withSql()
    s.runs.set(b, okRun()); s.runs.set(a, okRun()); s.runs.set('gone', okRun())
    expect(Object.keys(s.collectEntries())).toEqual([a, b].sort())
    s.removeBlock(a)
    expect(Object.keys(s.collectEntries())).toEqual([b])
  })
  it('applyEntries rules', () => {
    const { s, a, b, m } = withSql()
    s.runs.set(a, okRun('keep'))
    s.applyEntries({ [a]: entry(), [b]: entry(), [m]: entry(), nope: entry() }, 'pg')
    expect(s.runs.get(a)!.ranSqlHash).toBe('keep')
    expect(s.runs.get(b)).toMatchObject({ status: 'ok', fromFile: true })
    expect(s.runs.has(m)).toBe(false); expect(s.runs.has('nope')).toBe(false)
    expect(s.dirty.value).toBe(false); expect(s.resultsDirty.value).toBe(false)
    s.runs.set(a, { ...okRun('live') })
    const e2 = entry(); e2.sqlHash = 'new'
    s.applyEntries({ [a]: e2, [b]: e2 }, 'pg', { overwrite: true })
    expect(s.runs.get(a)!.ranSqlHash).toBe('live')
    expect(s.runs.get(b)!.ranSqlHash).toBe('new')
  })
  it('setOutputsMode', () => {
    const s = fresh()
    s.setOutputsMode('separate'); expect(s.dirty.value).toBe(false)
    s.setOutputsMode('inline'); expect(s.dirty.value).toBe(true); expect(s.nb.value.settings.outputs).toBe('inline')
  })
  it('effectiveMaxRows comes from the getter option, clamped; no setMaxRows', () => {
    expect(fresh().effectiveMaxRows()).toBe(5000)
    let v: number = 100
    const s = useNotebookStore({ maxRows: () => v })
    expect(s.effectiveMaxRows()).toBe(100)
    v = 99999; expect(s.effectiveMaxRows()).toBe(5000)
    v = 0; expect(s.effectiveMaxRows()).toBe(1)
    expect((s as any).setMaxRows).toBeUndefined()
    expect(s.dirty.value).toBe(false)
  })
  it('toText by mode; no mutation; stale outputs stripped', () => {
    const { s, a, b } = withSql()
    s.runs.set(a, okRun())
    s.setOutputsMode('inline')
    const t = (parseNotebook(s.toText()) as any)
    expect(t.blocks[0].outputs).toMatchObject({ rows: [[1]], sqlHash: 'fnv1a32:h' })
    expect(t.blocks[0].outputs.entry).toBeUndefined()
    expect(t.blocks[1].outputs).toBeUndefined()
    expect((s.nb.value.blocks[0] as any).outputs).toBeUndefined()
    const text = s.toText()
    const s2 = fresh(); s2.load(text, null, null)
    expect(s2.runs.get(a)).toMatchObject({ status: 'ok', fromFile: true, ranSqlHash: 'h' })
    expect(s2.dirty.value).toBe(false)
    s2.setOutputsMode('separate')
    expect((parseNotebook(s2.toText()) as any).blocks[0].outputs).toBeUndefined()
    s2.setOutputsMode('none')
    expect((parseNotebook(s2.toText()) as any).blocks[0].outputs).toBeUndefined()
    expect(b).toBeTruthy()
  })
  it('load ignores invalid inline outputs', () => {
    const { s, a, b } = withSql()
    const doc = (parseNotebook(s.toText()) as any)
    doc.settings.outputs = 'inline'
    doc.blocks[0].outputs = entry(); doc.blocks[1].outputs = { junk: 1 }
    const s2 = fresh(); s2.load(serializeNotebook(doc), null, null)
    expect(s2.runs.get(a)).toMatchObject({ status: 'ok', fromFile: true, ranSqlHash: 'q' })
    expect(s2.runs.has(b)).toBe(false)
  })
  it('noteRunFinished dirty rules', () => {
    const s = fresh(); const a = s.addBlock('sql', null); s.dirty.value = false
    s.noteRunFinished(a); expect(s.dirty.value).toBe(false); expect(s.resultsDirty.value).toBe(true)
    s.markResultsSaved(); expect(s.resultsDirty.value).toBe(false)
    s.setOutputsMode('inline'); s.dirty.value = false
    const r = s.revision.value
    s.noteRunFinished(a); expect(s.dirty.value).toBe(true); expect(s.revision.value).toBe(r + 1); expect(s.resultsDirty.value).toBe(false)
    s.setOutputsMode('none'); s.noteRunFinished(a); expect(s.resultsDirty.value).toBe(true)
  })
  it('load resets resultsDirty', () => {
    const s = fresh(); s.resultsDirty.value = true
    s.load(serializeNotebook(createEmptyNotebook()), null, null)
    expect(s.resultsDirty.value).toBe(false)
  })
  it('5000x50 round trip < 2s', () => {
    const { s, a } = withSql()
    const cols = Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, dataType: 'int' }))
    const rows = Array.from({ length: 5000 }, (_, r) => cols.map((_, c) => r * c))
    s.runs.set(a, { status: 'ok', result: { columns: cols, rows, truncated: false, elapsedMs: 1, dbType: 'pg' }, ranSqlHash: 'h' })
    const t0 = Date.now()
    const parsed = parseOutFile(serializeOutFile(s.collectEntries()))
    s.runs.clear(); s.applyEntries(parsed.entries, 'pg')
    expect(Date.now() - t0).toBeLessThan(2000)
    const r = s.runs.get(a)!.result!
    expect(r.rows).toHaveLength(5000); expect(r.columns).toHaveLength(50); expect(r.rows[4999][49]).toBe(4999 * 49)
  })
})

describe('upstream staleness for results blocks', () => {
  const ok = (executedAt: string, sql: string, upstream?: Record<string, string>) => ({
    status: 'ok' as const, result: { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' }, ranSqlHash: hashSql(sql), executedAt, ...(upstream ? { upstream } : {}),
  })
  function chain() {
    const s = fresh()
    s.nb.value.blocks.push(
      { id: 'A', type: 'sql', content: 'select 1', metadata: { resultName: 'a' } },
      { id: 'B', type: 'sql', content: 'select * from a', metadata: { source: 'results', resultName: 'b' } },
      { id: 'C', type: 'sql', content: 'select * from b', metadata: { source: 'results' } },
    )
    s.runs.set('A', ok('t1', 'select 1'))
    s.runs.set('B', ok('t2', 'select * from a', { a: 't1' }))
    s.runs.set('C', ok('t3', 'select * from b', { b: 't2' }))
    return s
  }
  it('fresh chain', () => {
    const s = chain()
    expect(['A', 'B', 'C'].map((i) => s.staleReasons(i))).toEqual([[], [], []])
  })
  it('A sql change -> B,C upstream', () => {
    const s = chain()
    s.updateContent('A', 'select 2')
    expect(s.staleReasons('A')).toEqual(['sql'])
    expect(s.staleReasons('B')).toEqual(['upstream'])
    expect(s.staleReasons('C')).toEqual(['upstream'])
  })
  it('rerun A: B stale until rerun; then C stale until rerun', () => {
    const s = chain()
    s.updateContent('A', 'select 2')
    s.runs.set('A', ok('t4', 'select 2'))
    expect(s.staleReasons('B')).toEqual(['upstream'])
    s.runs.set('B', ok('t5', 'select * from a', { a: 't4' }))
    expect(s.staleReasons('B')).toEqual([])
    expect(s.staleReasons('C')).toEqual(['upstream'])
    s.runs.set('C', ok('t6', 'select * from b', { b: 't5' }))
    expect(s.staleReasons('C')).toEqual([])
  })
  it('missing upstream record -> stale; upstream without ok run -> stale', () => {
    const s = chain()
    s.runs.set('B', ok('t2', 'select * from a'))
    expect(s.staleReasons('B')).toEqual(['upstream'])
    const s2 = chain()
    s2.runs.delete('A')
    expect(s2.staleReasons('B')).toEqual(['upstream'])
  })
  it('saved results with executedAt/upstream load into a fresh chain', () => {
    const s = chain()
    const entries = s.collectEntries()
    const s2 = useNotebookStore()
    s2.load(serializeNotebook({ ...s.nb.value, blocks: s.nb.value.blocks.map((b) => ({ ...b })) } as any), null, null)
    s2.applyEntries(entries, 'x')
    expect(['A', 'B', 'C'].map((i) => s2.staleReasons(i))).toEqual([[], [], []])
  })
  it('deleting upstream block -> downstream stale', () => {
    const s = chain()
    s.removeBlock('A')
    expect(s.staleReasons('B')).toEqual(['upstream'])
    expect(s.staleReasons('C')).toEqual(['upstream'])
  })
  it('forward reference / cycle does not recurse forever', () => {
    const s = fresh()
    s.nb.value.blocks.push(
      { id: 'A', type: 'sql', content: 'select * from b', metadata: { source: 'results', resultName: 'a' } },
      { id: 'B', type: 'sql', content: 'select * from a', metadata: { source: 'results', resultName: 'b' } },
    )
    s.runs.set('A', ok('t1', 'select * from b', { b: 't2' }))
    s.runs.set('B', ok('t2', 'select * from a', { a: 't1' }))
    expect(s.staleReasons('A')).toEqual(['upstream'])
    expect(s.staleReasons('B')).toEqual(['upstream'])
  })
  it('is reactive', async () => {
    const s = chain()
    const c = computed(() => s.isStale('C'))
    const seen: boolean[] = []
    watchEffect(() => { seen.push(c.value) })
    expect(c.value).toBe(false)
    s.updateContent('A', 'select 9')
    await nextTick()
    expect(c.value).toBe(true)
  })
  it('explicit upstream option wins', () => {
    const s = useNotebookStore({ upstream: () => null })
    s.nb.value.blocks.push({ id: 'B', type: 'sql', content: 'x', metadata: { source: 'results' } })
    s.runs.set('B', ok('t', 'x'))
    expect(s.staleReasons('B')).toEqual([])
  })
  it('running upstream does not mark dependents stale; stale after rerun finishes', () => {
    const s = chain()
    s.runs.set('A', { status: 'running' })
    expect(s.staleReasons('B')).toEqual([])
    expect(s.staleReasons('C')).toEqual([])
    s.runs.set('A', ok('t9', 'select 1'))
    expect(s.staleReasons('B')).toEqual(['upstream'])
  })
  it('error upstream and missing upstream still stale', () => {
    const s = chain()
    s.runs.set('A', { status: 'error', error: { code: 'UNKNOWN', message: 'x' } })
    expect(s.staleReasons('B')).toEqual(['upstream'])
  })
  it('duplicating the upstream keeps downstream bound to the original', () => {
    const s = chain()
    const copy = s.duplicateBlock('A')
    expect(s.nb.value.blocks.find((b) => b.id === copy)!.metadata!.resultName).toBe('a_copy')
    expect(upstreamOf(s.nb.value.blocks.find((b) => b.id === 'B')!, s.nb.value.blocks).map((b) => b.id)).toEqual(['A'])
    expect(s.staleReasons('B')).toEqual([])
  })
  it('renaming resultName makes dependents stale', () => {
    const s = chain()
    s.updateMeta('A', { resultName: 'renamed' })
    expect(s.staleReasons('B')).toEqual(['upstream'])
  })
})

describe('addBlock results', () => {
  it('creates a local sql block with source results and no connection keys', () => {
    const s = fresh()
    const id = s.addBlock('results', null)
    const b = s.nb.value.blocks.find((x) => x.id === id)!
    expect(b.type).toBe('sql')
    expect(b.content).toBe('')
    expect(b.metadata).toEqual({ source: 'results' })
    expect(s.dirty.value).toBe(true)
  })
})
