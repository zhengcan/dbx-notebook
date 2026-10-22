import { describe, it, expect } from 'vitest'
import { buildRenderSpec, buildPortableSpec, type ChartOptions } from '@sqlnb/format'
import { loadVega } from '../src/analysis/vegaRuntime'

const columns = [{ name: 'day', kind: 'temporal' as const }, { name: 'a', kind: 'number' as const }, { name: 'b', kind: 'number' as const }, { name: 'c', kind: 'number' as const }]
const mk = (n: number) => ({ rows: [{ field: 'day', grain: 'day' as const }], columns: [], values: ['a', 'b', 'c'].slice(0, n).map((f) => ({ field: f, agg: 'sum' as const })) })
const days = ['2024-01-01', '2024-01-02', '2024-01-05']
function longRows(n: number, compact: boolean) {
  const out: Record<string, unknown>[] = []
  for (const [i, d] of days.entries()) for (const [j, m] of ['a', 'b', 'c'].slice(0, n).entries())
    out.push({ x: new Date(d + 'T00:00:00Z').toISOString(), xLabel: d, series: m, value: 10 + i * 3 + j * 4 })
  return out
}
async function bars(chart: ChartOptions, n: number) {
  const res: any = buildRenderSpec({ pivot: mk(n), chart, columns })
  expect(res.error).toBeUndefined()
  const el = document.createElement('div')
  const rt = await loadVega()
  const c = await rt.render(el, res.spec, longRows(n, chart.timeAxis === 'compact'), { width: 400, height: 240, config: {} })
  const svg = await c.svg()
  c.destroy()
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out = Array.from(doc.querySelectorAll('g.mark-rect path')).map((p) => {
    const m = /M([-\d.e]+),([-\d.e]+)h([-\d.e]+)v([-\d.e]+)h/.exec(p.getAttribute('d') ?? '')!
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }
  })
  return { out, xs: new Set(out.map((b) => Math.round(b.x))).size }
}

describe('multi-value series without column field', () => {
  for (const timeAxis of ['sparse', 'compact'] as const) for (const n of [2, 3]) {
    it(`${timeAxis} ${n} values: grouped side by side, stacked stacked`, async () => {
      const g = await bars({ type: 'bar', stacking: 'grouped', timeAxis }, n)
      const s = await bars({ type: 'bar', stacking: 'stacked', timeAxis }, n)
      expect(g.out.length).toBe(3 * n)
      expect(g.xs).toBe(3 * n)
      expect(s.xs).toBe(3)
    })
  }
  it('portable spec carries a shared series dimension (fold) so grouped/stacked work', () => {
    const r: any = buildPortableSpec({ pivot: mk(2), chart: { type: 'bar', stacking: 'grouped' }, columns, dataName: 't' })
    expect(r.spec.layer).toBeUndefined()
    expect(r.spec.transform.some((t: any) => t.fold)).toBe(true)
    expect(r.spec.encoding.xOffset).toBeDefined()
    const s: any = buildPortableSpec({ pivot: mk(2), chart: { type: 'bar', stacking: 'stacked' }, columns, dataName: 't' })
    expect(s.spec.encoding.y.stack).toBe('zero')
  })
})
