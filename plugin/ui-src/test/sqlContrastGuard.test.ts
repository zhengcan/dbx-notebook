import { describe, expect, it } from 'vitest'
import { SQL_KINDS, SQL_PALETTE, SQL_TARGETS, adjustSqlPalette, applySqlContrastGuard, compositeOver, contrast, parseCssColor, type SqlTokenKind } from '../src/editor/sqlPalette'

const BGS = ['#ffffff', '#f5f5f5', '#fdf6e3', '#1a1a1a', '#0d1117', '#2d2d2d', '#3c3c3c', '#000000', '#1e1e1e', '#808080']
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (d === 0) return 0
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hdist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('runtime contrast guard (adjustSqlPalette)', () => {
  for (const bg of BGS) {
    it(`every token meets its target on ${bg}`, () => {
      const p = adjustSqlPalette(bg)
      for (const k of SQL_KINDS) expect(contrast(p[k], bg), `${bg} ${k} ${p[k]}`).toBeGreaterThanOrEqual(SQL_TARGETS[k] - 1e-9)
      expect(p.comment.toLowerCase()).not.toBe(p.plain.toLowerCase())
    })
  }
  it('already passing colours are returned unchanged; adjusted ones keep their hue', () => {
    for (const [bg, base] of [['#ffffff', SQL_PALETTE.light], ['#0d1117', SQL_PALETTE.dark]] as const) {
      const p = adjustSqlPalette(bg)
      for (const k of SQL_KINDS) expect(p[k]).toBe(base[k])
    }
    for (const bg of BGS) {
      const p = adjustSqlPalette(bg)
      const dark = parseInt(bg.slice(1, 3), 16) < 0x90
      const base = dark ? SQL_PALETTE.dark : SQL_PALETTE.light
      for (const k of SQL_KINDS as SqlTokenKind[]) {
        if (p[k] === base[k] || /^#(?:000000|ffffff)$/.test(p[k])) continue
        if (k === 'plain' || k === 'identifier') continue
        expect(hdist(hue(p[k]), hue(base[k])), `${bg} ${k}`).toBeLessThanOrEqual(12)
      }
    }
  })
  it('reports the matrix before/after (informational)', () => {
    const rows = BGS.map((bg) => {
      const dark = parseInt(bg.slice(1, 3), 16) < 0x90
      const base = dark ? SQL_PALETTE.dark : SQL_PALETTE.light
      const p = adjustSqlPalette(bg)
      return `${bg} comment ${contrast(base.comment, bg).toFixed(2)}->${contrast(p.comment, bg).toFixed(2)} keyword ${contrast(base.keyword, bg).toFixed(2)}->${contrast(p.keyword, bg).toFixed(2)}`
    })
    console.log(rows.join('\n'))
  })
  it('selection background does not hide tokens (dark + light)', () => {
    for (const [bg, fg] of [['#1a1a1a', '#eeeeee'], ['#2d2d2d', '#eeeeee'], ['#ffffff', '#111111'], ['#fdf6e3', '#111111']] as const) {
      const sel = compositeOver(parseCssColor(fg)!, 0.18, parseCssColor(bg)!)
      const selHex = '#' + sel.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
      const p = adjustSqlPalette(bg)
      for (const k of ['keyword', 'string', 'number', 'comment'] as const) expect(contrast(p[k], selHex), `${bg} ${k} on selection`).toBeGreaterThanOrEqual(2.8)
    }
  })
})

describe('applySqlContrastGuard (DOM)', () => {
  const mk = (bg: string) => {
    const surface = document.createElement('div')
    surface.style.backgroundColor = bg
    document.body.appendChild(surface)
    return surface
  }
  it('writes adjusted --sql-* vars for the computed surface and follows live changes', async () => {
    const s = mk('#2d2d2d')
    const g = applySqlContrastGuard(s, s)
    const c1 = s.style.getPropertyValue('--sql-comment')
    expect(contrast(c1, '#2d2d2d')).toBeGreaterThanOrEqual(SQL_TARGETS.comment)
    s.style.backgroundColor = '#fdf6e3'
    g.refresh()
    const c2 = s.style.getPropertyValue('--sql-comment')
    expect(c2).not.toBe(c1)
    expect(contrast(c2, '#fdf6e3')).toBeGreaterThanOrEqual(SQL_TARGETS.comment)
    g.dispose(); s.remove()
  })
  it('transparent surface composites over the nearest opaque ancestor', () => {
    const outer = mk('#1e1e1e')
    const inner = document.createElement('div'); inner.style.backgroundColor = 'rgba(0, 0, 0, 0)'
    outer.appendChild(inner)
    const g = applySqlContrastGuard(inner, inner)
    expect(contrast(inner.style.getPropertyValue('--sql-keyword'), '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
    g.dispose(); outer.remove()
  })
  it('does not rewrite unchanged values (no flicker)', () => {
    const s = mk('#ffffff')
    const g = applySqlContrastGuard(s, s)
    let writes = 0
    const orig = s.style.setProperty.bind(s.style)
    s.style.setProperty = ((...a: any[]) => { writes++; return (orig as any)(...a) }) as any
    g.refresh(); g.refresh()
    expect(writes).toBe(0)
    g.dispose(); s.remove()
  })
})
