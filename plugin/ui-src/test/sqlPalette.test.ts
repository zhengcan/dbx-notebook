import { describe, expect, it } from 'vitest'
import { SQL_KINDS, SQL_PALETTE, SQL_TARGETS, contrast, sqlPaletteCss, sqlPaletteVars } from '../src/editor/sqlPalette'

describe('sql palette contrast', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const k of SQL_KINDS) {
      it(`${mode} ${k}`, () => {
        const min = SQL_TARGETS[k]
        expect(contrast(SQL_PALETTE[mode][k], SQL_PALETTE.bg[mode])).toBeGreaterThanOrEqual(min)
      })
    }
  }
  it('contrast sanity', () => { expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0) })
  it('vars + css cover both themes', () => {
    expect(sqlPaletteVars(true)['--sql-keyword']).toBe(SQL_PALETTE.dark.keyword)
    const css = sqlPaletteCss()
    expect(css).toContain('[data-theme="dark"]')
    expect(css).toContain('.sql-keyword{color:var(--sql-keyword)}')
  })
  it('palette hex lives only in sqlPalette.ts', () => {
    const generic: string[] = [SQL_PALETTE.light.plain, SQL_PALETTE.dark.plain]
    const hexes = new Set([...Object.values(SQL_PALETTE.light), ...Object.values(SQL_PALETTE.dark)].filter((h) => !generic.includes(h)).map((h) => h.toLowerCase()))
    const files = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(files).length).toBeGreaterThan(20)
    for (const [f, src] of Object.entries(files)) {
      if (f.endsWith('sqlPalette.ts')) continue
      const found = (src.match(/#[0-9a-f]{6}\b/gi) ?? []).filter((h) => hexes.has(h.toLowerCase()))
      expect(found, f).toEqual([])
    }
  })
})
