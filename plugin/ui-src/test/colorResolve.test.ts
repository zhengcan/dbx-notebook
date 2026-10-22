import { describe, expect, it } from 'vitest'
import { parseColor, resolveColor, readTokens, readableOn, vegaConfig } from '../src/analysis/theme'

const lum = (c: { r: number; g: number; b: number }) => {
  const [r, g, b] = [c.r, c.g, c.b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(parseColor(a)!), lum(parseColor(b)!)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

describe('parseColor', () => {
  const near = (s: string, r: number, g: number, b: number, a = 1) => {
    const c = parseColor(s)!
    expect(c, s).not.toBeNull()
    expect([c.r, c.g, c.b].map(Math.round)).toEqual([r, g, b])
    expect(c.a).toBeCloseTo(a, 2)
  }
  it('hex, rgb, percent, fractional, alpha forms', () => {
    near('#fff', 255, 255, 255)
    near('#11223380', 17, 34, 51, 0.5)
    near('rgb(10, 20, 30)', 10, 20, 30)
    near('rgb(200 200 200 / 0.9)', 200, 200, 200, 0.9)
    near('rgba(100%, 0%, 50%, 50%)', 255, 0, 128, 0.5)
    near('rgb(12.5 20.4 30.6)', 13, 20, 31)
    near('transparent', 0, 0, 0, 0)
  })
  it('hsl, color(srgb), oklch, oklab', () => {
    near('hsl(210 10% 80%)', 199, 204, 209)
    near('hsl(0, 100%, 50%)', 255, 0, 0)
    near('color(srgb 1 0.5 0 / 0.25)', 255, 128, 0, 0.25)
    near('oklch(1 0 0)', 255, 255, 255)
    near('oklch(0 0 0)', 0, 0, 0)
    near('oklab(0.5 0 0)', 99, 99, 99)
  })
  it('rejects garbage', () => {
    for (const s of ['', 'var(--x)', 'color-mix(in srgb, red, blue)', 'banana', 'rgb(1 2)']) expect(parseColor(s), s).toBeNull()
  })
})

describe('resolveColor / readTokens -> vegaConfig never leaves low-contrast or raw text colours', () => {
  const light = ['oklch(0.75 0.01 250)', 'hsl(210 10% 80%)', 'rgb(200 200 200 / 0.9)', '210 10% 80%', 'var(--x)', 'color-mix(in srgb, #fff 80%, #888)', 'banana']
  const dark = ['oklch(0.3 0.01 250)', 'hsl(210 10% 20%)', 'rgb(40 40 40 / 0.9)', '210 10% 20%', 'var(--x)', 'color-mix(in srgb, #000 80%, #777)', 'banana']
  const mk = (fg: string, bg: string, muted = fg) => {
    const el = document.createElement('div')
    el.style.setProperty('--x', fg === 'x' ? '#ccc' : '#ccc')
    el.style.setProperty('--color-foreground', fg)
    el.style.setProperty('--color-muted-foreground', muted)
    el.style.setProperty('--color-background', bg)
    el.style.setProperty('--color-border', 'hsl(0 0% 50% / 0.3)')
    document.body.appendChild(el)
    return el
  }
  for (const [name, list, bg] of [['light', light, '#ffffff'], ['dark', dark, '#0a0a0a']] as const) {
    for (const tok of list) {
      it(`${name}: ${tok}`, () => {
        const cfg: any = vegaConfig(readTokens(mk(tok, bg)), name, 500)
        for (const c of [cfg.title.color, cfg.text.color, cfg.axis.titleColor, cfg.axis.labelColor, cfg.legend.labelColor]) {
          expect(c).toMatch(/^#[0-9a-f]{6}$/i)
          expect(ratio(c, bg)).toBeGreaterThanOrEqual(4.5)
        }
        expect(cfg.axis.gridColor).toMatch(/^#[0-9a-f]{6}$/i)
      })
    }
  }
  it('a well-contrasted modern token is kept (not replaced by a fallback)', () => {
    const cfg: any = vegaConfig(readTokens(mk('hsl(0 0% 10%)', '#ffffff')), 'light', 500)
    expect(cfg.title.color).not.toBe('#1f2328')
    expect(ratio(cfg.title.color, '#ffffff')).toBeGreaterThan(15)
  })
  it('transparent background token is composited over an opaque ancestor', () => {
    const outer = document.createElement('div')
    outer.style.backgroundColor = '#0a0a0a'
    const el = mk('#222222', 'transparent')
    outer.appendChild(el); document.body.appendChild(outer)
    const cfg: any = vegaConfig(readTokens(el), 'dark', 500)
    expect(ratio(cfg.title.color, '#0a0a0a')).toBeGreaterThanOrEqual(4.5)
  })
  it('resolveColor returns null for unresolvable input', () => {
    expect(resolveColor(document.createElement('div'), 'banana')).toBeNull()
  })
  it('readableOn: unparseable colour never passes through', () => {
    expect(readableOn('var(--nope)', '#ffffff', '#1f2328', '#eeeeee')).toBe('#1f2328')
    expect(readableOn('#ccc', '#fff', '#1f2328', '#eeeeee')).toBe('#1f2328')
  })
  it('title uses the foreground colour only (no muted/opacity/subtitle grey)', () => {
    const cfg: any = vegaConfig({ foreground: '#111111', mutedForeground: '#777777', border: '#ddd', background: '#ffffff' }, 'light', 500)
    expect(cfg.title.color).toBe('#111111')
    expect(cfg.title.subtitleColor).toBe('#111111')
    expect(cfg.title.opacity).toBeUndefined()
    expect(cfg.title.color).toBe(cfg.axis.titleColor)
  })
})
