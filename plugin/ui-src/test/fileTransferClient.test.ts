import { describe, expect, it, vi } from 'vitest'
import { createFileTransferClient, type HostHandle } from '../src/files/fileTransferClient'
import { ImageError } from '../src/files/imageClient'

const MIB = 1024 * 1024
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s) }
const handle = (size: number, id = 'h1'): HostHandle => ({ handleId: id, name: 'a.png', size, contentType: 'image/png' })

function fakeFile(bytes: Uint8Array, over = 0) {
  const calls: Array<[string, number, number | undefined]> = []
  const read = vi.fn(async (id: string, off: number, len?: number) => {
    calls.push([id, off, len])
    const end = Math.min(bytes.length + over, off + (len ?? bytes.length))
    const part = off < bytes.length ? bytes.subarray(off, Math.min(end, bytes.length)) : new Uint8Array(0)
    const extra = over && end > bytes.length ? new Uint8Array(end - bytes.length).fill(7) : new Uint8Array(0)
    const out = new Uint8Array(part.length + extra.length)
    out.set(part); out.set(extra, part.length)
    return { dataBase64: b64(out), length: out.length, eof: end >= bytes.length + over }
  })
  return { read, calls }
}

describe('capabilities', () => {
  it('no fileTransfer → all false, no-ops, pick null', async () => {
    const c = createFileTransferClient({})
    expect(c.caps()).toEqual({ pick: false, drop: false, read: false })
    expect(() => c.onDrop(() => {})()).not.toThrow()
    expect(() => c.onDragState(() => {})()).not.toThrow()
    expect(await c.pick()).toBeNull()
  })
  it.each([undefined, { fileTransfer: {} }, { fileTransfer: { drop: false } }])('drop flag %j → not subscribed', (capabilities) => {
    const onDrop = vi.fn()
    const c = createFileTransferClient({ fileTransfer: { onDrop }, capabilities: capabilities as any })
    expect(c.caps().drop).toBe(false)
    c.onDrop(() => {})
    expect(onDrop).not.toHaveBeenCalled()
  })
  it('drop:true subscribes once, delivers normalized event and unsubscribes', () => {
    const off = vi.fn()
    let cb: any
    const onDrop = vi.fn((fn) => { cb = fn; return off })
    const c = createFileTransferClient({ fileTransfer: { onDrop }, capabilities: { fileTransfer: { drop: true } } })
    const got: any[] = []
    const un = c.onDrop((d) => got.push(d))
    expect(onDrop).toHaveBeenCalledTimes(1)
    cb([handle(1)], { dropId: 'd', truncated: true })
    expect(got).toEqual([{ files: [handle(1)], dropId: 'd', truncated: true }])
    un(); un()
    expect(off).toHaveBeenCalledTimes(1)
  })
  it('callback exceptions and subscribe throws do not escape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let cb: any
    const c = createFileTransferClient({ fileTransfer: { onDrop: (fn: any) => { cb = fn; return () => {} } }, capabilities: { fileTransfer: { drop: true } } })
    c.onDrop(() => { throw new Error('boom') })
    expect(() => cb([], { dropId: 'x', truncated: false })).not.toThrow()
    const c2 = createFileTransferClient({ fileTransfer: { onDrop: () => { throw new Error('no') } }, capabilities: { fileTransfer: { drop: true } } })
    expect(() => c2.onDrop(() => {})()).not.toThrow()
    warn.mockRestore()
  })
  it('onDragState forwards booleans only when drop capable', () => {
    let cb: any
    const c = createFileTransferClient({ fileTransfer: { onDrop: () => () => {}, onDragState: (fn: any) => { cb = fn; return () => {} } }, capabilities: { fileTransfer: { drop: true } } })
    const got: boolean[] = []
    c.onDragState((a) => got.push(a))
    cb(true); cb(false)
    expect(got).toEqual([true, false])
    const sub = vi.fn()
    const c2 = createFileTransferClient({ fileTransfer: { onDrop: () => () => {}, onDragState: sub }, capabilities: { fileTransfer: { drop: false } } })
    c2.onDragState(() => {})
    expect(sub).not.toHaveBeenCalled()
  })
})

describe('pick', () => {
  const mkPick = (impl: () => Promise<unknown>) => createFileTransferClient({ fileTransfer: { pick: impl }, capabilities: { fileTransfer: { pick: true, read: true } } })
  it('cancel forms → null', async () => {
    expect(await mkPick(async () => null).pick()).toBeNull()
    expect(await mkPick(async () => undefined).pick()).toBeNull()
    expect(await mkPick(async () => ({ files: [] })).pick()).toBeNull()
    expect(await mkPick(async () => []).pick()).toBeNull()
    expect(await mkPick(async () => { throw new Error('user cancelled') }).pick()).toBeNull()
  })
  it.each([
    [{ code: 'cancelled' }], [{ code: 'CANCELED' }], [{ code: 'ABORT' }], [{ code: 'USER_CANCELLED' }], [{ name: 'AbortError' }], [{ name: 'CancelError' }],
  ])('error shape %j → cancel', async (shape) => {
    const e = Object.assign(new Error('x'), shape)
    expect(await mkPick(async () => { throw e }).pick()).toBeNull()
  })
  it('plain-object rejects with code are recognised too', async () => {
    expect(await mkPick(async () => { throw { code: 'cancelled' } }).pick()).toBeNull()
  })
  it('unrelated code still propagates', async () => {
    await expect(mkPick(async () => { throw Object.assign(new Error('nope'), { code: 'EIO' }) }).pick()).rejects.toThrow('nope')
  })
  it('other rejects propagate', async () => {
    await expect(mkPick(async () => { throw new Error('disk on fire') }).pick()).rejects.toThrow('disk on fire')
  })
  it('returns handles, passes multiple', async () => {
    const pick = vi.fn(async () => ({ files: [handle(3)] }))
    const c = createFileTransferClient({ fileTransfer: { pick }, capabilities: { fileTransfer: { pick: true } } })
    expect(await c.pick()).toEqual([handle(3)])
    expect(pick).toHaveBeenCalledWith({ multiple: true })
  })
  it('pick:false → null without calling', async () => {
    const pick = vi.fn()
    const c = createFileTransferClient({ fileTransfer: { pick }, capabilities: { fileTransfer: { pick: false } } })
    expect(c.caps().pick).toBe(false)
    expect(await c.pick()).toBeNull()
    expect(pick).not.toHaveBeenCalled()
  })
})

describe('readBytes', () => {
  const mk = (read: any) => createFileTransferClient({ fileTransfer: { read }, capabilities: { fileTransfer: { read: true } } })
  it('reads 600 KiB in 256 KiB chunks', async () => {
    const bytes = new Uint8Array(600 * 1024).map((_, i) => i % 251)
    const f = fakeFile(bytes)
    const out = await mk(f.read).readBytes(handle(bytes.length), { maxBytes: 10 * MIB })
    expect(out).toEqual(bytes)
    expect(f.calls).toEqual([['h1', 0, 262144], ['h1', 262144, 262144], ['h1', 524288, 262144]])
  })
  it('over the limit → tooLarge with zero reads', async () => {
    const f = fakeFile(new Uint8Array(1))
    await expect(mk(f.read).readBytes(handle(10 * MIB + 1), { maxBytes: 10 * MIB })).rejects.toMatchObject({ code: 'tooLarge' })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('stream longer than declared → tooLarge and stops', async () => {
    const bytes = new Uint8Array(300 * 1024)
    const f = fakeFile(bytes, 600 * 1024)
    const p = mk(f.read).readBytes(handle(bytes.length), { maxBytes: 10 * MIB })
    await expect(p).rejects.toBeInstanceOf(ImageError)
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(2)
  })
  it('abort between chunks → AbortError, no further read', async () => {
    const bytes = new Uint8Array(600 * 1024)
    const f = fakeFile(bytes)
    const ac = new AbortController()
    const read = vi.fn(async (...a: any[]) => { const r = await (f.read as any)(...a); ac.abort(); return r })
    await expect(mk(read).readBytes(handle(bytes.length), { maxBytes: 10 * MIB, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('already aborted → no read', async () => {
    const f = fakeFile(new Uint8Array(5))
    const ac = new AbortController(); ac.abort()
    await expect(mk(f.read).readBytes(handle(5), { maxBytes: MIB, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('sequential reads keep only one file buffer alive (no read overlap)', async () => {
    let live = 0, max = 0
    const read = async (_id: string, _o: number, len?: number) => {
      live++; max = Math.max(max, live)
      await Promise.resolve()
      live--
      return { dataBase64: btoa('abc'), length: 3, eof: true }
    }
    const c = mk(read)
    for (const id of ['a', 'b', 'c']) await c.readBytes(handle(3, id), { maxBytes: MIB })
    expect(max).toBe(1)
  })
})

describe('readBytes with unreliable size', () => {
  const mk = (read: any) => createFileTransferClient({ fileTransfer: { read }, capabilities: { fileTransfer: { read: true } } })
  it('size 0 handle still reads the real content', async () => {
    const bytes = new Uint8Array(300 * 1024).map((_, i) => i % 200)
    const f = fakeFile(bytes)
    expect(await mk(f.read).readBytes(handle(0), { maxBytes: 10 * MIB })).toEqual(bytes)
  })
  it('size 0 handle whose stream exceeds maxBytes → tooLarge, stops early', async () => {
    const read = vi.fn(async () => ({ dataBase64: btoa('x'.repeat(1000)), length: 1000, eof: false }))
    await expect(mk(read).readBytes(handle(0), { maxBytes: 2500 })).rejects.toMatchObject({ code: 'tooLarge' })
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('size missing (undefined) behaves like 0', async () => {
    const f = fakeFile(new Uint8Array([1, 2, 3]))
    const h = { handleId: 'h1', name: 'a.png', contentType: '' } as unknown as HostHandle
    expect(await mk(f.read).readBytes(h, { maxBytes: 100 })).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('release', () => {
  it('releasing keeps only a bounded memory of released ids', async () => {
    const cancel = vi.fn(async () => {})
    const c = createFileTransferClient({ fileTransfer: { cancel } })
    for (let i = 0; i < 300; i++) await c.release(handle(1, `h${i}`))
    await c.release(handle(1, 'h299'))
    expect(cancel).toHaveBeenCalledTimes(300)
    await c.release(handle(1, 'h0'))
    expect(cancel).toHaveBeenCalledTimes(301)
  })
  it('cancels once per handle, swallows rejections', async () => {
    const cancel = vi.fn(async () => { throw new Error('x') })
    const c = createFileTransferClient({ fileTransfer: { cancel } })
    await c.release(handle(1, 'a'))
    await c.release(handle(1, 'a'))
    await c.release(handle(1, 'b'))
    expect(cancel.mock.calls.map((x: any) => x[0])).toEqual(['a', 'b'])
  })
})
