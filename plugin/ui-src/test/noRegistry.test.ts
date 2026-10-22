import { describe, expect, it } from 'vitest'

const files = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('legacy connection registry is gone', () => {
  it('module file is deleted and nothing imports it', () => {
    const names = Object.keys(files)
    expect(names.length).toBeGreaterThan(10)
    expect(names.some(n => n.endsWith('connections/registry.ts'))).toBe(false)
    for (const [f, t] of Object.entries(files)) expect(t, f).not.toMatch(/connections\/registry|ConnectionRegistry|RegistryKey/)
  })
  it('no source calls the removed sidecar routes or register-connection', () => {
    for (const [f, t] of Object.entries(files)) expect(t, f).not.toMatch(/connections\/(list|upsert|remove)|register-connection/)
  })
})
