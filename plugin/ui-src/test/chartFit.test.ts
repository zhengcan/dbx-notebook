import { describe, it, expect } from 'vitest'
import { buildRenderSpec } from '@sqlnb/format'
import { loadVega } from '../src/analysis/vegaRuntime'
import { vegaConfig } from '../src/analysis/theme'

const columns = [{ name: 'region', kind: 'text' as const }, { name: 'tier', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }]
const pivot = { rows: [{ field: 'region' }], columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum' as const }] }
const rows: Record<string, unknown>[] = []
for (const [i, r] of ['north america region', 'south america region', 'east', 'west'].entries()) for (const [j, t] of ['gold', 'silver'].entries()) rows.push({ x: r, series: t, value: 10 + i * 7 + j * 5 })
const tokens = { foreground: '#111', mutedForeground: '#666', border: '#ccc', background: '#fff' }

async function svgSize(type: any, width: number, title?: string) {
  const res: any = buildRenderSpec({ pivot, chart: { type, title }, columns })
  const el = document.createElement('div')
  const rt = await loadVega()
  const c = await rt.render(el, res.spec, rows, { width, height: 240, config: vegaConfig(tokens, 'light') })
  const svg = el.querySelector('svg')!
  const out = { w: +svg.getAttribute('width')!, h: +svg.getAttribute('height')! }
  c.destroy()
  return out
}

describe('chart fits the container (real vega)', () => {
  for (const type of ['bar', 'barHorizontal', 'line', 'area']) {
    it(`${type}: svg width equals the container width incl. legend/axes, height equals the requested height`, async () => {
      for (const w of [300, 480, 700]) {
        const s = await svgSize(type, w, 'A title')
        expect(s.w).toBe(w)
        expect(s.h).toBe(240)
      }
    })
  }
})
