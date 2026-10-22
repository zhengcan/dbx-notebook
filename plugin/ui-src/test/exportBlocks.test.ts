import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/export/options'
import { buildExportModel } from '../src/export/model'

const res = (rows: unknown[][]) => ({ columns: [{ name: 'x' }, { name: 'y' }], rows, truncated: false, elapsedMs: 1, dbType: 'x' })
const store = () => ({
  nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks: [
    { id: 'm', type: 'markdown', content: '\n# Intro text\nmore', metadata: {} },
    { id: 'a', type: 'sql', content: 'select', metadata: { resultName: 'Alpha' } },
    { id: 'b', type: 'sql', content: 'select', metadata: { resultName: 'Beta' } },
    { id: 'n', type: 'sql', content: 'select', metadata: { resultName: 'NeverRun' } },
  ] }),
  runs: new Map<string, any>([
    ['a', { status: 'ok', result: res([[1, 2]]), executedAt: '2026-10-18T09:00:00Z' }],
    ['b', { status: 'ok', result: res([[3, 4], [5, 6]]), executedAt: '2026-10-18T09:30:00Z' }],
  ]),
  analysis: new Map(), bigNumbers: new Map(), isStale: (id: string) => id === 'b', isPartial: () => false, transposed: new Map(),
}) as any
const build = (o: Partial<ExportOptions> = {}) =>
  buildExportModel({ store: store(), options: { ...DEFAULT_EXPORT_OPTIONS, ...o }, now: new Date('2026-10-18T10:00:00Z'), dataSourceName: () => 'db' })

describe('block catalog and include', () => {
  it('lists every exportable block, included by default', () => {
    const m = build()
    expect(m.catalog.map((c) => [c.blockId, c.type, c.label, c.included])).toEqual([
      ['m', 'markdown', '# Intro text', true], ['a', 'sql', 'Alpha', true], ['b', 'sql', 'Beta', true],
    ])
    expect(m.catalog[1].table!.shownRows).toBe(1)
    expect(m.catalog[0].table).toBeUndefined()
    expect(m.sections).toHaveLength(3)
  })
  it('excluded blocks leave the report but stay in the catalog, with no side effects', () => {
    const m = build({ blocks: { b: { include: false, transpose: 'follow' }, m: { include: false, transpose: 'follow' } }, header: { ...DEFAULT_EXPORT_OPTIONS.header, dataSource: true } })
    expect(m.sections.map((s) => s.blockId)).toEqual(['a'])
    expect(m.catalog.map((c) => c.included)).toEqual([false, true, false])
    expect(m.staleBlockIds).toEqual([])
    expect(m.runTimes.map((r) => r.at)).toEqual(['2026-10-18T09:00:00Z'])
    expect(m.estimate.totalRows).toBe(1)
  })
  it('excluded blocks are not reported as skipped; excluding all makes it not exportable', () => {
    const blocks = Object.fromEntries(['m', 'a', 'b', 'n'].map((i) => [i, { include: false, transpose: 'follow' as const }]))
    const m = build({ blocks })
    expect(m.skipped).toEqual([])
    expect(m.exportable).toBe(false)
    expect(m.catalog).toHaveLength(3)
  })
})
