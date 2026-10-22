import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useLabelRows } from '../src/analysis/labels/useLabelRows'
import { setLocale } from '../src/i18n'

const ctx = { empty: '(empty)', summary: 'Summary' }
const mk = (pivotOver: any = {}, chartOver: any = {}, cats: any = { row: [['a', 'b']], column: [['0', '1']] }) => {
  setLocale('en')
  const cfg = ref({
    pivot: { rows: [{ field: 'region' }], columns: [{ field: 'flag' }], values: [{ field: 'amount', agg: 'sum' }, { field: 'n', agg: 'count' }], ...pivotOver },
    chart: { type: 'bar', ...chartOver },
  } as any)
  const c = ref(ctx)
  const categories = ref(cats)
  return { cfg, ...useLabelRows(cfg, c, categories) }
}
const ids = (g: any) => g.rows.map((r: any) => r.id)

describe('useLabelRows groups', () => {
  it('groups map to the five sidebar groups with the same rows as before', () => {
    const { groups } = mk()
    expect(groups.value.map((g) => g.key)).toEqual(['names', 'measures', 'chart', 'units', 'row:0', 'column:0'])
    const by = Object.fromEntries(groups.value.map((g) => [g.key, ids(g)]))
    expect(by.names).toEqual(['rowName:0', 'columnName:0'])
    expect(by.measures).toEqual(['measureName:0', 'measureName:1', 'summary'])
    expect(by.chart).toEqual(['title', 'axis:x', 'axis:y', 'axis:legend'])
    expect(by.units).toEqual(['unit:0', 'scale:0', 'unit:1', 'scale:1'])
    expect(by['row:0']).toEqual(['category:row:0:a', 'category:row:0:b', 'null:row:0'])
    expect(by['column:0']).toEqual(['category:column:0:0', 'category:column:0:1', 'null:column:0'])
  })
  it('every row carries a non-empty affects chip text', () => {
    const { groups } = mk()
    for (const g of groups.value) for (const r of g.rows) expect(r.affects, r.id).toMatch(/^Affects: /)
    expect(groups.value[1].rows[2].affects).toBe('Affects: Totals row · Export')
  })
  it('percent measure scale row disabled', () => {
    const { groups } = mk({ values: [{ field: 'amount', agg: 'sum', format: { kind: 'percent' } }, { field: 'n', agg: 'count' }] })
    const units = groups.value.find((g) => g.key === 'units')!
    expect(units.rows.find((r) => r.id === 'scale:0')!.disabled).toBe(true)
    expect(units.rows.find((r) => r.id === 'scale:1')!.disabled).toBeFalsy()
  })
  it('unused valueLabels listed as unused', () => {
    const { groups } = mk({ rows: [{ field: 'region', valueLabels: { a: 'A!', gone: 'G' } }] })
    const g = groups.value.find((x) => x.key === 'row:0')!
    const gone = g.rows.find((r) => r.id === 'category:row:0:gone')!
    expect(gone.unused).toBe(true)
    expect(g.rows.find((r) => r.id === 'category:row:0:a')!.unused).toBeFalsy()
  })
  it('no columns / no values: missing groups are omitted', () => {
    const { groups } = mk({ columns: [], values: [] })
    expect(groups.value.map((g) => g.key)).toEqual(['names', 'measures', 'chart', 'row:0'])
  })
  it('over 50 categories are capped until expanded; expandFor opens the group holding a target', () => {
    const many = Array.from({ length: 60 }, (_, i) => `k${i}`)
    const { groups, expandFor } = mk({}, {}, { row: [many], column: [['0']] })
    const cnt = () => groups.value.find((g) => g.key === 'row:0')!.rows.length
    expect(cnt()).toBe(51)
    expandFor({ kind: 'category', axis: 'row', index: 0, key: 'k55' })
    expect(cnt()).toBe(61)
  })
  it('commitRow rejects an invalid scale without a patch and flags it; a valid value emits a patch', () => {
    const out: any[] = []
    setLocale('en')
    const cfg = ref({ pivot: { rows: [], columns: [], values: [{ field: 'a', agg: 'sum' }] }, chart: { type: 'bar' } } as any)
    const l = useLabelRows(cfg, ref(ctx), ref({ row: [], column: [] }), (p) => out.push(p))
    const sc = l.groups.value.find((g) => g.key === 'units')!.rows.find((r) => r.id === 'scale:0')!
    l.commitRow(sc, 'abc')
    expect(out).toEqual([]); expect(l.invalid.value['scale:0']).toBe(true)
    l.commitRow(sc, '1000')
    expect(out.length).toBe(1); expect(l.invalid.value['scale:0']).toBeUndefined()
  })
})
