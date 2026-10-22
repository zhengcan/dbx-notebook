import { describe, expect, it } from 'vitest'
import { buildRenderSpec } from '@sqlnb/format'
import { loadVega } from '../src/analysis/vegaRuntime'
import { vegaConfig, PALETTE, type ThemeTokens } from '../src/analysis/theme'
import { renderChartSvgs, EXPORT_THEME } from '../src/export/chartSvg'

const DARK: ThemeTokens = { foreground: '#fafafa', mutedForeground: '#a3a3a3', border: '#333333', background: '#0a0a0a' }
const LIGHT: ThemeTokens = { foreground: '#0a0a0a', mutedForeground: '#737373', border: '#e5e5e5', background: '#ffffff' }
const lum = (hex: string) => {
  const h = hex.length === 4 ? hex.replace(/[a-f0-9]/gi, '$&$&').replace('#', '#') : hex
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const cols: any = [{ name: 'r', kind: 'text' }, { name: 's', kind: 'text' }, { name: 'a', kind: 'number' }]
const spec = (series: boolean, type = 'bar'): any => (buildRenderSpec({
  pivot: { rows: [{ field: 'r' }], columns: series ? [{ field: 's' }] : [], values: [{ field: 'a', agg: 'sum' }] } as any,
  chart: { type, labels: true, title: 'Title' } as any, columns: cols,
}) as any).spec
const rows = (series: boolean) => (series
  ? [{ x: 'p', series: 'g', value: 3 }, { x: 'p', series: 'h', value: 5 }, { x: 'q', series: 'g', value: 4 }]
  : [{ x: 'p', value: 3 }, { x: 'q', value: 4 }])

async function labelFills(t: ThemeTokens, series: boolean, type = 'bar', cfg?: object) {
  const rt = await loadVega()
  const c = await rt.render(document.createElement('div'), spec(series, type), rows(series) as any[], { width: 400, height: 300, config: cfg ?? vegaConfig(t, 'light', 500) })
  const svg = await c.svg()
  c.destroy()
  const fills = [...svg.matchAll(/aria-roledescription="text mark"[^>]*?fill="([^"]+)"/g)].map((m) => m[1])
  const title = /role-title-text[\s\S]*?fill="([^"]+)"/.exec(svg)?.[1]
  return { fills, title }
}

describe('chart text colours follow the theme', () => {
  it('vegaConfig sets the text-mark colour to the foreground token', () => {
    expect((vegaConfig(DARK, 'dark') as any).text.color).toBe('#fafafa')
    expect((vegaConfig(LIGHT, 'light') as any).text.color).toBe('#0a0a0a')
  })
  it('a low-contrast foreground token still yields a >=4.5:1 title / data label colour', () => {
    const c = vegaConfig({ ...LIGHT, foreground: '#cccccc' }, 'light') as any
    expect(contrast(c.title.color, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.text.color, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    const d = vegaConfig({ ...DARK, foreground: '#222222' }, 'dark') as any
    expect(contrast(d.title.color, '#0a0a0a')).toBeGreaterThanOrEqual(4.5)
  })
  it('well-contrasted tokens are kept as-is', () => {
    expect((vegaConfig(LIGHT, 'light') as any).title.color).toBe('#0a0a0a')
    expect((vegaConfig({ ...LIGHT, foreground: '#111' }, 'light') as any).title.color).toBe('#111')
  })
  for (const [name, t] of [['dark', DARK], ['light', LIGHT]] as const) {
    for (const series of [false, true]) {
      it(`${name}: rendered data labels (${series ? 'with' : 'no'} series) use the foreground, title too`, async () => {
        const r = await labelFills(t, series)
        expect(r.fills.length).toBeGreaterThan(0)
        for (const f of r.fills) expect(f).toBe(t.foreground)
        expect(r.title).toBe(t.foreground)
      })
    }
  }
  it('stacked series labels keep their stacked positions while recoloured', async () => {
    const rt = await loadVega()
    const s: any = (buildRenderSpec({ pivot: { rows: [{ field: 'r' }], columns: [{ field: 's' }], values: [{ field: 'a', agg: 'sum' }] } as any, chart: { type: 'bar', labels: true, stacking: 'stacked' } as any, columns: cols }) as any).spec
    const c = await rt.render(document.createElement('div'), s, rows(true) as any[], { width: 400, height: 300, config: vegaConfig(DARK, 'dark', 500) })
    const svg = await c.svg()
    c.destroy()
    const ys = [...svg.matchAll(/aria-roledescription="text mark" text-anchor="middle" transform="translate\(([\d.]+),(-?[\d.]+)\)/g)].map((m) => `${m[1]}`)
    expect(new Set(ys).size).toBeGreaterThan(0)
    const pts = [...svg.matchAll(/aria-roledescription="text mark"[^>]*transform="translate\(([\d.]+),(-?[\d.]+)\)/g)].map((m) => `${m[1]},${m[2]}`)
    expect(new Set(pts).size).toBe(3)
  })
  it('export path: SVG data labels and title use the export foreground', async () => {
    for (const series of [false, true]) {
      const r = await renderChartSvgs([{ kind: 'chart', blockId: 'c', title: 'Title', spec: spec(series), rows: rows(series), usesRawRows: false }], 'portrait', { vega: loadVega })
      const svg = r.svgs.c.svg as string
      const fills = [...svg.matchAll(/aria-roledescription="text mark"[^>]*?fill="([^"]+)"/g)].map((m) => m[1])
      expect(fills.length).toBeGreaterThan(0)
      for (const f of fills) expect(f).toBe(EXPORT_THEME.foreground)
    }
  })
  for (const [name, t] of [['dark', DARK], ['light', LIGHT]] as const) {
    it(`${name}: pie/donut labels get a contrasting halo layer under a foreground label, for every palette slice`, async () => {
      for (const type of ['pie', 'donut']) {
        const rt = await loadVega()
        const data = PALETTE.map((_, i) => ({ x: `c${i}`, value: 5 + i }))
        const c = await rt.render(document.createElement('div'), spec(false, type), data as any[], { width: 400, height: 300, config: vegaConfig(t, 'light', 500) })
        const svg = await c.svg()
        c.destroy()
        const texts = [...svg.matchAll(/<text[^>]*aria-roledescription="text mark"[^>]*>/g)].map((m) => m[0])
        const labels = texts.filter((x) => x.includes(`fill="${t.foreground}"`) && !x.includes('stroke='))
        const halos = [...svg.matchAll(/<text(?=[^>]*stroke=)[^>]*>/g)].map((m) => m[0])
        expect(labels.length).toBe(PALETTE.length)
        expect(halos.length).toBe(PALETTE.length)
        for (const h of halos) {
          const fill = /fill="([^"]+)"/.exec(h)![1]
          expect(/stroke="([^"]+)"/.exec(h)![1]).toBe(fill)
          expect(contrast(fill, t.foreground)).toBeGreaterThanOrEqual(7)
          expect(Number(/stroke-width="([\d.]+)"/.exec(h)![1])).toBeGreaterThanOrEqual(2)
        }
        const pos = new Set(labels.map((l) => /transform="([^"]+)"/.exec(l)![1]))
        expect(pos.size, 'pie labels keep one angular position per slice').toBe(PALETTE.length)
      }
    })
  }
  it('bar/line labels get no halo layer', async () => {
    const r = await renderChartSvgs([{ kind: 'chart', blockId: 'c', spec: spec(false), rows: rows(false), usesRawRows: false }], 'portrait', { vega: loadVega })
    expect(/<text(?=[^>]*aria-roledescription="text mark")[^>]*stroke=/.test(r.svgs.c.svg as string)).toBe(false)
  })
})
