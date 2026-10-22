import { describe, it, expect, vi } from 'vitest'
import { createImageClient, ImageError } from '../src/files/imageClient'
import { mapHostError } from '../src/host/bridge'

const OK = { mime: 'image/png', base64: 'AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 }
const bridge = (fn: (m: string, p: unknown) => Promise<unknown>) => ({ invoke: vi.fn(fn) }) as any

describe('imageClient.readImage', () => {
  it('calls notebook/readImage and builds a data URI', async () => {
    const b = bridge(async () => OK)
    const r = await createImageClient(b).readImage('/n/a.sqlnb', 'pic.png')
    expect(b.invoke.mock.calls[0][0]).toBe('notebook/readImage')
    expect(b.invoke.mock.calls[0][1]).toEqual({ notebookPath: '/n/a.sqlnb', relPath: 'pic.png' })
    expect(r).toEqual({ mime: 'image/png', dataUri: 'data:image/png;base64,AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 })
  })
  it.each(['notFound', 'unsupported', 'tooLarge', 'invalidPath', 'readFailed', 'needsSave'])('maps [%s] RPC errors to a typed ImageError', async (code) => {
    const b = bridge(async () => { throw mapHostError(new Error(`[-32040] [${code}] some text`)) })
    const e = await createImageClient(b).readImage('/n/a.sqlnb', 'x.png').catch((x) => x)
    expect(e).toBeInstanceOf(ImageError)
    expect(e.code).toBe(code)
  })
  it('unknown failures become readFailed and never carry a path', async () => {
    const b = bridge(async () => { throw new Error('boom /Users/me/secret.png') })
    const e = await createImageClient(b).readImage('/n/a.sqlnb', 'x.png').catch((x) => x)
    expect(e.code).toBe('readFailed')
    expect(e.message).not.toContain('/Users')
  })
  it('rejects a non-image mime or malformed result as readFailed', async () => {
    for (const bad of [{ ...OK, mime: 'image/svg+xml' }, { ...OK, base64: 5 }, null]) {
      const e = await createImageClient(bridge(async () => bad)).readImage('/n/a.sqlnb', 'x.png').catch((x) => x)
      expect(e.code).toBe('readFailed')
    }
  })
  it('an aborted signal rejects with AbortError and does not call the bridge', async () => {
    const b = bridge(async () => OK)
    const ac = new AbortController(); ac.abort()
    const e = await createImageClient(b).readImage('/n/a.sqlnb', 'x.png', ac.signal).catch((x) => x)
    expect(e.name).toBe('AbortError')
    expect(b.invoke).not.toHaveBeenCalled()
  })
  it('abort while pending rejects at once', async () => {
    const b = bridge(() => new Promise(() => {}))
    const ac = new AbortController()
    const p = createImageClient(b).readImage('/n/a.sqlnb', 'x.png', ac.signal).catch((x) => x)
    ac.abort()
    expect((await p).name).toBe('AbortError')
  })
})
