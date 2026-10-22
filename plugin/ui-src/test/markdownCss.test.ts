import { describe, it, expect, afterEach } from 'vitest'
import { markdownCss, MD_TOKEN_VARS, MD_EXPORT_VARS, installMarkdownCss } from '../src/ui/markdownCss'
import { contrast } from '../src/editor/sqlPalette'

const rules = (css: string) => [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1].trim())

describe('markdownCss', () => {
  it('prefixes every selector with the scope', () => {
    const rs = rules(markdownCss('.md-view', MD_TOKEN_VARS))
    expect(rs.length).toBeGreaterThan(20)
    for (const r of rs) for (const s of r.split(',')) expect(s.trim().startsWith('.md-view')).toBe(true)
  })
  it('every var() in MD_TOKEN_VARS css has a fallback; no bare hex colors', () => {
    const css = markdownCss('.md-view', MD_TOKEN_VARS)
    expect(css).not.toMatch(/var\(--[\w-]+\)/)
    expect(css.replace(/var\(--[\w-]+,[^)]*\)/g, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(MD_TOKEN_VARS.sub).toContain('color-mix')
  })
  it('wide tables scroll instead of being clipped', () => {
    const css = markdownCss('.md-view', MD_TOKEN_VARS)
    expect(css).toMatch(/\.md-view\{[^}]*overflow-x:auto/)
    expect(css).not.toMatch(/\.md-view table\{[^}]*overflow:hidden/)
  })
  it('export vars are fixed light values', () => {
    expect(markdownCss('.md', MD_EXPORT_VARS)).toContain('#0969da')
    expect(markdownCss('.md-view', MD_TOKEN_VARS)).toContain('ac 8%'.replace('ac', 'var(--color-primary,#0969da)'))
  })
  it('h1..h6 sizes', () => {
    const css = markdownCss('.md-view', MD_TOKEN_VARS)
    const sizes = ['2.1em', '1.6em', '1.3em', '1.1em', '1em', '.9em']
    sizes.forEach((s, i) => expect(css).toMatch(new RegExp(`\\.md-view h${i + 1}\\{[^}]*font-size:${s.replace('.', '\\.')}[;}]`)))
    expect(css).toContain('border-bottom:2px solid')
    expect(css).toContain('border-left:5px solid')
    expect(css).toContain('border-left:3px solid')
    expect(css).toContain('line-height:1.7')
    expect(css).not.toMatch(/\bth[^{]*\{[^}]*text-align/)
  })
  it('installMarkdownCss is idempotent', () => {
    installMarkdownCss(); installMarkdownCss()
    expect(document.head.querySelectorAll('style[data-md-css]').length).toBe(1)
  })
  afterEach(() => {})

  const palettes = {
    light: { bg: '#ffffff', fg: '#1f2328', mut: '#656d76', sub: '#f6f8fa', ac: '#0969da' },
    dark: { bg: '#1a1a1a', fg: '#e6e6e6', mut: '#9a9a9a', sub: '#242424', ac: '#58a6ff' },
  }
  const mix = (a: string, b: string, p: number) => {
    const n = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const [x, y] = [n(a), n(b)]
    return '#' + x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('')
  }
  for (const [mode, p] of Object.entries(palettes)) {
    it(`contrast ok in ${mode}`, () => {
      const tint = mix(p.ac, p.bg, 0.1)
      const nested = mix(p.ac, p.bg, 0.08)
      expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.fg, tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.fg, nested)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.ac, nested)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.ac, p.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.ac, tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.ac, p.sub)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.mut, p.bg)).toBeGreaterThanOrEqual(3)
    })
  }
})
