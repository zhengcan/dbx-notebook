import { describe, it, expect } from 'vitest'
import { buildRenderSpec } from '@sqlnb/format'
import { loadVega } from '../src/analysis/vegaRuntime'
import { toChartRows, compactTimeLabel } from '../src/analysis/chartRows'

const columns = [{ name: 'day', kind: 'temporal' as const }, { name: 'amount', kind: 'number' as const }]
const pivot = { rows: [{ field: 'day', grain: 'month' as const }], columns: [], values: [{ field: 'amount', agg: 'sum' as const }] }
const lab = { empty: '(empty)', measure: () => 'm' }
const long = { dims: [], measures: [], rows: [['2026-01-01', 1], [null, 9], ['2026-05-01', 2], ['nonsense', 3]] as unknown[][] }

async function ticks(chart: any, rows: unknown[]) {
  const res: any = buildRenderSpec({ pivot, chart, columns })
  const el = document.createElement('div')
  const rt = await loadVega()
  const c = await rt.render(el, res.spec, rows, { width: 400, height: 240, config: {} })
  const svg = await c.svg()
  c.destroy()
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return Array.from(doc.querySelectorAll('g[aria-label^="X-axis"] g.role-axis-label text')).map((n) => n.textContent)
}

describe('compact axis and NULL dates', () => {
  it('toChartRows drops NULL-date rows in compact mode only', () => {
    const c = toChartRows(long, pivot, { type: 'bar', timeAxis: 'compact' }, columns, lab) as any[]
    expect(c.map((r) => r.xLabel)).toEqual(['2026-01', '2026-05', 'nonsense'])
    const s = toChartRows(long, pivot, { type: 'bar' }, columns, lab) as any[]
    expect(s).toHaveLength(4)
  })
  it('render spec itself filters null xLabel (defensive)', () => {
    const spec: any = (buildRenderSpec({ pivot, chart: { type: 'bar', timeAxis: 'compact' }, columns }) as any).spec
    expect(JSON.stringify(spec.transform)).toContain('isValid')
  })
  it('real render: no "null" tick even if null rows reach vega; same dates as sparse', async () => {
    const rows = [{ x: '2026-01-01', xLabel: '2026-01', value: 1 }, { x: null, xLabel: null, value: 9 }, { x: '2026-05-01', xLabel: '2026-05', value: 2 }]
    const compact = await ticks({ type: 'bar', timeAxis: 'compact' }, rows)
    expect(compact).toEqual(['2026-01', '2026-05'])
    const sparse = await ticks({ type: 'bar', timeAxis: 'sparse' }, rows.map(({ x, value }) => ({ x, value })))
    expect(sparse.join(' ')).not.toContain('null')
  })
  it('labels: Date uses ISO, non-ISO passes through, same-day different shapes are not merged', () => {
    expect(compactTimeLabel(new Date('2026-03-07T10:00:00Z'), 'day')).toBe('2026-03-07')
    expect(compactTimeLabel('nonsense', 'day')).toBe('nonsense')
    const rows = toChartRows({ dims: [], measures: [], rows: [['2026-03-07 10:00:00', 1], ['2026-03-07T00:00:00', 2]] }, { ...pivot, rows: [{ field: 'day', grain: 'day' as const }] }, { type: 'bar', timeAxis: 'compact' }, columns, lab) as any[]
    expect(rows.map((r) => [r.xLabel, r.value])).toEqual([['2026-03-07', 1], ['2026-03-07', 2]])
  })
})
