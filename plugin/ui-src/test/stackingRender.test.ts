import { describe, it, expect } from 'vitest'
import { buildRenderSpec, type ChartOptions } from '@sqlnb/format'
import { loadVega } from '../src/analysis/vegaRuntime'

const columns = [{ name: 'region', kind: 'text' as const }, { name: 'tier', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }]
const pivot = { rows: [{ field: 'region' }], columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum' as const }] }
const rows: Record<string, unknown>[] = []
for (const [i, r] of ['n', 's', 'e', 'w'].entries()) for (const [j, t] of ['gold', 'silver'].entries()) rows.push({ x: r, series: t, value: 10 + i * 7 + j * 5 })

async function bars(chart: ChartOptions) {
  const res: any = buildRenderSpec({ pivot, chart, columns })
  expect(res.error).toBeUndefined()
  const el = document.createElement('div')
  const rt = await loadVega()
  const c = await rt.render(el, res.spec, rows, { width: 400, height: 240, config: {} })
  const svg = await c.svg()
  c.destroy()
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out = Array.from(doc.querySelectorAll('g.mark-rect path')).map((p) => {
    const m = /M([-\d.e]+),([-\d.e]+)h([-\d.e]+)v([-\d.e]+)h/.exec(p.getAttribute('d') ?? '')!
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }
  })
  return { out, svg, xs: new Set(out.map((b) => Math.round(b.x))).size, top: Math.min(...out.map((b) => b.y)) }
}

describe('bar stacking variants render differently (real vega)', () => {
  it('stacked: one column per x; grouped: one per x×series', async () => {
    const s = await bars({ type: 'bar', stacking: 'stacked' })
    const g = await bars({ type: 'bar', stacking: 'grouped' })
    expect(s.xs).toBe(4)
    expect(g.xs).toBe(8)
  })
  it('none lays series side by side like grouped: distinct x per series, no overlaps in a category', async () => {
    for (const stacking of ['none', 'grouped'] as const) {
      const n = await bars({ type: 'bar', stacking })
      expect(n.xs).toBe(8)
      const sorted = [...n.out].sort((a, b) => a.x - b.x)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w - 0.01)
    }
  })
  it('percent normalises every column to the full height', async () => {
    const p = await bars({ type: 'bar', stacking: 'percent' })
    expect(p.xs).toBe(4)
    const byX = new Map<number, number>()
    for (const b of p.out) byX.set(Math.round(b.x), (byX.get(Math.round(b.x)) ?? 0) + b.h)
    const sums = [...byX.values()].map((v) => Math.round(v))
    expect(new Set(sums).size).toBe(1)
  })
})
