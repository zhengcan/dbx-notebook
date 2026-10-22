import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { normalizeAnalysis } from '@sqlnb/format'
import AnalysisBlock from '../src/analysis/AnalysisBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const run = { status: 'ok' as const, executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['a', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } }
const longRes = { status: 'ok', long: { dims: ['a'], measures: ['m'], rows: [['a', 1], ['b', 5]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any

function setup(agg: string) {
  setLocale('en')
  const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
  store.nb.value.blocks.push(src as any)
  store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg }], totals: { column: true } } } } as any)
  store.runs.set('s1', run as any)
  store.setAnalysisRunner(async () => longRes)
  const w = mount(AnalysisBlock, { props: { blockId: 'c1' }, global: { provide: { [StoreKey as symbol]: store } } })
  store.analysis.set('c1', longRes)
  return { w, meta: () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any }
}
const pickIn = async (w: any, v: string) => {
  await w.vm.$nextTick()
  await w.find('tr.total-row td.total').trigger('dblclick')
  await w.find('select[data-test="summary-select"]').setValue(v)
}

describe('picking the default-family summary', () => {
  it('stores no explicit summary key; a non-default pick stores it; picking the default again removes it', async () => {
    const { w, meta } = setup('sum')
    await pickIn(w, 'max')
    expect(meta().pivot.values[0].summary).toBe('max')
    await pickIn(w, 'sum')
    expect(Object.keys(meta().pivot.values[0])).not.toContain('summary')
    expect(normalizeAnalysis(meta()).pivot!.values[0].summary).toBeUndefined()
  })
  it('default depends on the aggregate family (count → sum, avg → avg)', async () => {
    const a = setup('count')
    await pickIn(a.w, 'sum')
    expect(Object.keys(a.meta().pivot.values[0])).not.toContain('summary')
    const b = setup('avg')
    await pickIn(b.w, 'sum')
    expect(b.meta().pivot.values[0].summary).toBe('sum')
    await pickIn(b.w, 'avg')
    expect(Object.keys(b.meta().pivot.values[0])).not.toContain('summary')
  })
})
