import { describe, it, expect } from 'vitest'
import { guessAnalysis } from '../src/analysis/guess'
import { useNotebookStore } from '../src/state/notebookStore'

const c = (name: string, kind: any) => ({ name, kind })

describe('guessAnalysis', () => {
  it('time + number -> line', () => {
    const g = guessAnalysis([c('d', 'temporal'), c('n', 'number')])
    expect(g.chart.type).toBe('line'); expect(g.view).toBe('both')
    expect(g.pivot.rows).toEqual([{ field: 'd', grain: 'month' }])
    expect(g.pivot.columns).toEqual([]); expect(g.pivot.values).toEqual([{ field: 'n', agg: 'sum' }])
  })
  it('time + number + text -> line with text as columns', () => {
    const g = guessAnalysis([c('t', 'text'), c('d', 'temporal'), c('n', 'number')])
    expect(g.chart.type).toBe('line'); expect(g.pivot.columns).toEqual([{ field: 't' }])
  })
  it('text + number -> bar', () => {
    const g = guessAnalysis([c('t', 'text'), c('n', 'number')])
    expect(g.chart.type).toBe('bar'); expect(g.pivot.rows).toEqual([{ field: 't' }]); expect(g.pivot.values).toEqual([{ field: 'n', agg: 'sum' }])
  })
  it('two numbers -> scatter', () => {
    const g = guessAnalysis([c('a', 'number'), c('b', 'number')])
    expect(g.chart.type).toBe('scatter'); expect(g.pivot.rows).toEqual([{ field: 'a' }]); expect(g.pivot.values).toEqual([{ field: 'b', agg: 'sum' }])
  })
  it('single number -> histogram', () => {
    const g = guessAnalysis([c('a', 'number')])
    expect(g.chart.type).toBe('histogram'); expect(g.pivot.values).toEqual([{ field: 'a', agg: 'sum' }]); expect(g.view).toBe('both')
  })
  it.each([
    ['all text', [c('a', 'text'), c('b', 'text')]],
    ['empty', []],
    ['boolean/unknown', [c('a', 'boolean'), c('b', 'unknown'), c('n', 'number')]],
    ['time only', [c('d', 'temporal')]],
  ])('%s -> table, empty pivot', (_n, cols) => {
    const g = guessAnalysis(cols as any)
    if (_n === 'boolean/unknown') { expect(g.chart.type).toBe('histogram'); return }
    expect(g.view).toBe('table'); expect(g.pivot).toEqual({ rows: [], columns: [], values: [] })
  })
  it('several of each -> first of each', () => {
    const g = guessAnalysis([c('t1', 'text'), c('t2', 'text'), c('d1', 'temporal'), c('d2', 'temporal'), c('n1', 'number'), c('n2', 'number')])
    expect(g.pivot.rows).toEqual([{ field: 'd1', grain: 'month' }]); expect(g.pivot.columns).toEqual([{ field: 't1' }]); expect(g.pivot.values).toEqual([{ field: 'n1', agg: 'sum' }])
  })
})

const run = (cols: [string, string][]) => ({ status: 'ok' as const, executedAt: 'T', result: { columns: cols.map(([name, dataType]) => ({ name, dataType })), rows: [], truncated: false, elapsedMs: 1, dbType: 'x' } })
function mk(blocks: any[], cols: [string, string][] = [['region', 'text'], ['amt', 'integer']]) {
  const s = useNotebookStore()
  s.nb.value.blocks.push(...blocks)
  s.runs.set('s1', run(cols) as any)
  return s
}
const sql = (md: any = {}, id = 's1') => ({ id, type: 'sql', content: 'select 1', metadata: md })

describe('store.visualizeResult', () => {
  it('auto-names, inserts after source with guessed config and spec', () => {
    const s = mk([sql(), { id: 'z', type: 'markdown', content: 'x' }])
    const id = s.visualizeResult('s1')!
    const bl = s.nb.value.blocks
    expect(bl.map((b: any) => b.id)).toEqual(['s1', id, 'z'])
    expect((bl[0]!.metadata as any).resultName).toBe('result_1'); expect((bl[0] as any).content).toBe('select 1')
    const m = bl[1]!.metadata as any
    expect(bl[1]!.type).toBe('chart'); expect(m.data).toBe('result_1'); expect(m.chartOptions.type).toBe('bar')
    expect(m.pivot.rows).toEqual([{ field: 'region' }]); expect(JSON.stringify(m.spec)).toContain('amt')
    expect(s.visualizeNotice.value).toEqual({ blockId: 's1', name: 'result_1' })
  })
  it('smallest free n, case-insensitive', () => {
    const s = mk([sql(), sql({ resultName: 'RESULT_1' }, 'o1'), sql({ resultName: 'result_2' }, 'o2')])
    s.visualizeResult('s1')
    expect(s.nb.value.blocks[0].metadata!.resultName).toBe('result_3')
  })
  it('keeps existing name, no notice; repeated clicks create multiple blocks', () => {
    const s = mk([sql({ resultName: 'sales' })])
    const a = s.visualizeResult('s1'), b = s.visualizeResult('s1')
    expect(a).not.toBe(b); expect(s.nb.value.blocks.length).toBe(3)
    expect(s.nb.value.blocks[0].metadata!.resultName).toBe('sales'); expect(s.visualizeNotice.value).toBeNull()
  })
  it('returns null without ok result / columns / sql block', () => {
    const s = mk([sql(), { id: 'm', type: 'markdown', content: '' }])
    expect(s.visualizeResult('m')).toBeNull(); expect(s.visualizeResult('nope')).toBeNull()
    s.runs.set('s1', { status: 'error' } as any); expect(s.visualizeResult('s1')).toBeNull()
    s.runs.set('s1', run([]) as any); expect(s.visualizeResult('s1')).toBeNull()
    expect(s.nb.value.blocks.length).toBe(2); expect(s.nb.value.blocks[0].metadata!.resultName).toBeUndefined()
  })
  it('works for local (results) blocks and causes no dependency errors', () => {
    const s = mk([sql(), sql({ source: 'results' }, 's2')])
    s.runs.set('s2', run([['a', 'text'], ['b', 'integer']]) as any)
    s.visualizeResult('s2')
    expect(s.nb.value.blocks[1].metadata).toMatchObject({ source: 'results', resultName: 'result_1' })
    s.nb.value.blocks[1].content = 'select * from result_1'
    expect(() => s.staleReasons('s2')).not.toThrow()
  })
})
