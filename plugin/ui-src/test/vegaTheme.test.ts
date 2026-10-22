import { describe, expect, it } from 'vitest'
import { PALETTE, readTokens, vegaConfig } from '../src/analysis/theme'

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

describe('vega theme', () => {
  it('palette: 8 colours, ≥3:1 on light and dark backgrounds', () => {
    expect(PALETTE).toHaveLength(8)
    for (const c of PALETTE) {
      expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(3)
      expect(contrast(c, '#1a1a1a')).toBeGreaterThanOrEqual(3)
    }
  })
  it('config uses tokens, transparent background, palette', () => {
    const tokens = { foreground: '#111111', mutedForeground: '#666666', border: '#dddddd', background: '#ffffff' }
    const c = vegaConfig(tokens, 'light') as any
    expect(c.background).toBe('transparent')
    expect(c.axis.labelColor).toBe('#666666')
    expect(c.axis.gridColor).toBe('#dddddd')
    expect(c.legend.labelColor).toBeTruthy()
    expect(c.range.category).toEqual(PALETTE)
    expect((vegaConfig({ ...tokens, foreground: '#eeeeee', background: '#1a1a1a' }, 'dark') as any).title.color).toBe('#eeeeee')
  })
  it('readTokens reads --color-* and falls back', () => {
    const el = document.createElement('div')
    el.style.setProperty('--color-foreground', '#abcdef')
    document.body.appendChild(el)
    const t = readTokens(el)
    expect(t.foreground).toBe('#abcdef')
    expect(t.border).toMatch(/^#/)
    expect(t.mutedForeground).toMatch(/^#/)
  })
})

describe('vegaConfig fits narrow panes', () => {
  const t = { foreground: '#111', mutedForeground: '#666', border: '#ccc', background: '#fff' }
  it('narrow: legend at the bottom with limited labels; title centered and limited to the width; padding present', () => {
    const c = vegaConfig(t, 'light', 360) as any
    expect(c.legend.orient).toBe('bottom')
    expect(c.legend.labelLimit).toBeLessThanOrEqual(360)
    expect(c.title.anchor).toBe('middle')
    expect(c.title.limit).toBeLessThanOrEqual(360)
    expect(c.padding).toMatchObject({ top: 8, right: 12 })
  })
  it('wide: legend on the right with bounded labels', () => {
    const c = vegaConfig(t, 'light', 700) as any
    expect(c.legend.orient).toBe('right')
    expect(c.legend.labelLimit).toBeLessThanOrEqual(160)
  })
  it('uses the document font stack for text (canvas cannot measure "inherit")', () => {
    const tokens = { foreground: '#111111', mutedForeground: '#666666', border: '#dddddd', background: '#ffffff', fontFamily: 'Georgia, serif' }
    const c = vegaConfig(tokens, 'light') as any
    expect([c.font, c.title.font, c.axis.labelFont, c.axis.titleFont, c.legend.labelFont, c.legend.titleFont]).toEqual(Array(6).fill('Georgia, serif'))
    expect((vegaConfig({ ...tokens, fontFamily: undefined }, 'light') as any).axis.labelFont).toBe('inherit')
  })
  it('readTokens carries the element computed font family', () => {
    const el = document.createElement('div')
    el.style.fontFamily = 'Georgia, serif'
    document.body.appendChild(el)
    expect(readTokens(el).fontFamily).toContain('Georgia')
    el.remove()
  })
})
