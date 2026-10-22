import { describe, it, expect } from 'vitest'

const files = (import.meta as any).glob(['../src/blocks/ResultTable.vue', '../src/analysis/PivotTable.vue'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const rulesOf = (src: string) => src.slice(src.indexOf('<style')).split('\n').map((l) => l.trim()).filter((l) => /(:hover|\.selected)/.test(l) && /\{/.test(l))

describe('hover / selected row and cell colours (dark-mode readability)', () => {
  for (const [file, src] of Object.entries(files)) {
    const rules = rulesOf(src)
    it(`${file.split('/').pop()}: has hover rules`, () => expect(rules.length).toBeGreaterThan(0))
    it(`${file.split('/').pop()}: no bare light colour or the (host-defined, possibly light) accent/selection tokens as a background`, () => {
      for (const r of rules) {
        const bare = r.replace(/var\((--[a-z-]+),[^)]*\)/g, 'var($1)') // fallbacks inside var() are ignored
        expect(bare, r).not.toMatch(/#f{3,6}\b|#fff|\bwhite\b|rgb\(\s*255/i)
        expect(r, r).not.toMatch(/background[^;]*var\(--color-(accent|selection)\b/)
      }
    })
  }
  const rt = files['../src/blocks/ResultTable.vue']
  it('ResultTable: row hover and selected cell set an explicit text colour with the background', () => {
    const rules = rulesOf(rt)
    const bgRules = rules.filter((r) => /background(-color)?:/.test(r) && !/background-image/.test(r))
    expect(bgRules.length).toBeGreaterThanOrEqual(2)
    expect(rules.some((r) => /:hover td[^{]*\{[^}]*color: var\(--color-foreground/.test(r))).toBe(true)
    expect(rules.some((r) => /td\.selected[^{]*\{[^}]*[^-]color: var\(--color-foreground/.test(r))).toBe(true)
  })
  it('hover/selected backgrounds are mixed from foreground/primary over the background token', () => {
    const rules = rulesOf(rt)
    expect(rules.join('\n')).toMatch(/color-mix\(in srgb, var\(--color-foreground[^)]*\) \d+%, var\(--color-background/)
    expect(rules.join('\n')).toMatch(/color-mix\(in srgb, var\(--color-primary[^)]*\) \d+%, var\(--color-background/)
  })
})
