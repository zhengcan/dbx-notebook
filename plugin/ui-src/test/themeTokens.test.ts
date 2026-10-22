/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'

const ALLOWED = new Set([
  'background', 'foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border', 'destructive',
  'primary', 'primary-foreground', 'warning', 'success', 'selection', 'overlay',
])

const files = import.meta.glob('../src/**/*.{vue,css,ts}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('theme tokens', () => {
  it('only uses DBX-provided (or allow-listed) --color-* variables', () => {
    const bad: string[] = []
    for (const [file, src] of Object.entries(files)) {
      for (const m of src.matchAll(/var\(\s*--color-([a-z0-9-]+)/g)) {
        if (!ALLOWED.has(m[1])) bad.push(`${file}: --color-${m[1]}`)
      }
    }
    expect(bad).toEqual([])
  })
})
