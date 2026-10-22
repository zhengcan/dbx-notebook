import { describe, it, expect, vi } from 'vitest'
import { createPluginSettings } from '../src/state/pluginSettings'
import { createFakeBridge } from '../src/host/fakeBridge'

const KEY = 'settings.maxRows.v1'
function shared() {
  const m = new Map<string, unknown>()
  return {
    m,
    opts: {
      async storageGet(k: string) { return (m.get(k) ?? null) as any },
      async storageSet(k: string, v: unknown) { m.set(k, v) },
    },
  }
}

describe('pluginSettings', () => {
  it('defaults to 5000 and persists via storage', async () => {
    const s = shared()
    const a = createPluginSettings(createFakeBridge(s.opts as any))
    await a.load()
    expect(a.maxRows.value).toBe(5000)
    expect(await a.setMaxRows(250)).toBe(250)
    expect(a.maxRows.value).toBe(250)
    expect(s.m.get(KEY)).toBe(250)
    const b = createPluginSettings(createFakeBridge(s.opts as any))
    await b.load()
    expect(b.maxRows.value).toBe(250)
  })
  it('clamps on set', async () => {
    const a = createPluginSettings(createFakeBridge(shared().opts as any))
    expect(await a.setMaxRows(99999)).toBe(5000)
    expect(await a.setMaxRows(0)).toBe(1)
    expect(await a.setMaxRows('abc')).toBe(5000)
  })
  it.each([0, 99999, 'abc', null, 12.5])('invalid stored %s -> clamped/default', async (v) => {
    const s = shared()
    s.m.set(KEY, v)
    const a = createPluginSettings(createFakeBridge(s.opts as any))
    await a.load()
    const exp = v === 0 ? 1 : v === 12.5 ? 12 : 5000
    expect([exp, 5000, 1]).toContain(a.maxRows.value)
    expect(a.maxRows.value).toBeGreaterThanOrEqual(1)
    expect(a.maxRows.value).toBeLessThanOrEqual(5000)
    if (v === null || v === 'abc') expect(a.maxRows.value).toBe(5000)
    if (v === 99999) expect(a.maxRows.value).toBe(5000)
  })
  it('storage unsupported: default, in-memory changes work', async () => {
    const a = createPluginSettings(createFakeBridge({ caps: { storage: false } }))
    await a.load()
    expect(a.maxRows.value).toBe(5000)
    await a.setMaxRows(100)
    expect(a.maxRows.value).toBe(100)
  })
  it('storage throws: never throws', async () => {
    const boom = async () => { throw new Error('x') }
    const a = createPluginSettings(createFakeBridge({ storageGet: boom, storageSet: boom } as any))
    await a.load()
    expect(await a.setMaxRows(77)).toBe(77)
    expect(a.maxRows.value).toBe(77)
  })
  it('hung storage: load resolves within the timeout with default', async () => {
    vi.useFakeTimers()
    try {
      const a = createPluginSettings(createFakeBridge({ storageGet: () => new Promise(() => {}), storageSet: () => new Promise(() => {}) } as any), { timeoutMs: 50 })
      const p = a.load()
      await vi.advanceTimersByTimeAsync(60)
      await p
      expect(a.maxRows.value).toBe(5000)
      const q = a.setMaxRows(10)
      await vi.advanceTimersByTimeAsync(60)
      expect(await q).toBe(10)
      expect(a.maxRows.value).toBe(10)
    } finally { vi.useRealTimers() }
  })
  it('refreshIfStale picks up changes from another instance, throttled', async () => {
    const s = shared()
    let t = 0
    const a = createPluginSettings(createFakeBridge(s.opts as any), { now: () => t, minRefreshMs: 1000 })
    const b = createPluginSettings(createFakeBridge(s.opts as any))
    await a.load()
    await b.setMaxRows(300)
    t = 10
    await a.refreshIfStale()
    expect(a.maxRows.value).toBe(5000)
    t = 2000
    await a.refreshIfStale()
    expect(a.maxRows.value).toBe(300)
  })
})
