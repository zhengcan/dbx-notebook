import { describe, it, expect, vi } from 'vitest'
import { classifyName, inspectHandles, fileSource, handleSource, MAX_IMAGE_BYTES } from '../src/blocks/mdImagePaste'
import type { HostHandle } from '../src/files/fileTransferClient'
import { PNG_BYTES, file } from './mdImageHelpers'

const hh = (name: string, contentType = '', size = 10, id = name): HostHandle => ({ handleId: id, name, size, contentType })

describe('classifyName', () => {
  it.each([
    ['a.png', '', 'ok'], ['b.JPG', '', 'ok'], ['c.webp', 'image/webp', 'ok'], ['d.gif', '', 'ok'],
    ['a.svg', 'image/svg+xml', 'unsupported'], ['b.avif', '', 'unsupported'], ['c.heic', '', 'unsupported'],
    ['d.csv', 'text/csv', 'ignore'], ['e.csv', '', 'ignore'], ['noext', '', 'ignore'],
  ] as const)('%s / %s → %s', (name, type, want) => expect(classifyName(name, type)).toBe(want))
})

describe('inspectHandles', () => {
  it('12 images → 10 sources, truncated 2', () => {
    const r = inspectHandles(Array.from({ length: 12 }, (_, i) => hh(`p${i}.png`)), false)
    expect(r.sources).toHaveLength(10)
    expect(r.summary).toEqual({ unsupported: 0, ignored: 0, truncated: 2, hostTruncated: false })
  })
  it('mixed set counts unsupported and ignored and keeps order', () => {
    const r = inspectHandles([hh('a.png'), hh('b.csv'), hh('c.svg'), hh('d.jpg')], true)
    expect(r.sources.map((s) => s.name)).toEqual(['a.png', 'd.jpg'])
    expect(r.summary).toEqual({ unsupported: 1, ignored: 1, truncated: 0, hostTruncated: true })
  })
  it('oversize handles stay in sources (read rejects tooLarge, per-file notice)', async () => {
    const client = { readBytes: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'tooLarge' }) }) } as any
    const r = inspectHandles([hh('big.png', '', MAX_IMAGE_BYTES + 1)], false)
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0].size).toBe(MAX_IMAGE_BYTES + 1)
    expect(client.readBytes).not.toHaveBeenCalled()
  })
})

describe('sources', () => {
  it('fileSource over 10 MiB rejects tooLarge', async () => {
    const big = file('a.png', 'image/png'); Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
    await expect(fileSource(big).read()).rejects.toMatchObject({ code: 'tooLarge' })
  })
  it('fileSource reads a png', async () => {
    const s = fileSource(file('a.png', 'image/png'))
    expect(s).toMatchObject({ name: 'a.png', type: 'image/png' })
    expect((await s.read()).mime).toBe('image/png')
  })
  it('handleSource reads via the client, mime from the name, relativePath ignored, releases nothing', async () => {
    const readBytes = vi.fn(async () => PNG_BYTES)
    const release = vi.fn()
    const client = { readBytes, release } as any
    const h = { ...hh('x.jpg', '', 12), relativePath: '/abs/secret/x.jpg' }
    const s = handleSource(client, h)
    const ac = new AbortController()
    const r = await s.read(ac.signal)
    expect(r.mime).toBe('image/jpeg')
    expect(r.base64).toBe(btoa(String.fromCharCode(...PNG_BYTES)))
    expect(readBytes).toHaveBeenCalledWith(h, { signal: ac.signal, maxBytes: MAX_IMAGE_BYTES })
    expect(release).not.toHaveBeenCalled()
    expect(JSON.stringify(s)).not.toContain('secret')
  })
})
