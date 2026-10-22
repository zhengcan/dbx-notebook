import { ImageError } from './imageClient'

export interface HostHandle { handleId: string; name: string; size: number; contentType: string; relativePath?: string }
export interface HostDrop { files: HostHandle[]; dropId: string; truncated: boolean }

export interface FileTransferClient {
  caps(): { pick: boolean; drop: boolean; read: boolean }
  onDrop(fn: (d: HostDrop) => void): () => void
  onDragState(fn: (active: boolean) => void): () => void
  pick(): Promise<HostHandle[] | null>
  readBytes(h: HostHandle, o: { signal?: AbortSignal; maxBytes: number }): Promise<Uint8Array>
  release(h: HostHandle): Promise<void>
}

interface FileTransferLike {
  pick?: (o?: { multiple?: boolean }) => Promise<unknown>
  read?: (handleId: string, offset: number, length?: number) => Promise<{ dataBase64: string; length: number; eof: boolean }>
  cancel?: (handleId: string) => Promise<unknown>
  onDrop?: (fn: (files: HostHandle[], meta: { dropId: string; truncated: boolean }) => void) => unknown
  onDragState?: (fn: (active: boolean) => void) => unknown
}
export interface DbxPluginLike {
  fileTransfer?: FileTransferLike
  capabilities?: { fileTransfer?: { pick?: boolean; read?: boolean; drop?: boolean } }
  ready?: Promise<unknown>
}

const CHUNK = 256 * 1024
const noop = () => {}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

const CANCEL_RE = /cancel|abort/i

function isCancel(e: unknown): boolean {
  const o = e as { code?: unknown; name?: unknown; message?: unknown } | null
  if (o && typeof o === 'object') {
    if (typeof o.code === 'string' && CANCEL_RE.test(o.code)) return true
    if (typeof o.name === 'string' && CANCEL_RE.test(o.name)) return true
    if (typeof o.message === 'string' && /cancel/i.test(o.message)) return true
    return false
  }
  return typeof e === 'string' && /cancel/i.test(e)
}

const MAX_RELEASED = 256

function toHandle(h: any): HostHandle | null {
  if (!h || typeof h.handleId !== 'string') return null
  const out: HostHandle = {
    handleId: h.handleId,
    name: typeof h.name === 'string' ? h.name : '',
    size: typeof h.size === 'number' && Number.isFinite(h.size) && h.size >= 0 ? h.size : 0,
    contentType: typeof h.contentType === 'string' ? h.contentType : '',
  }
  if (typeof h.relativePath === 'string') out.relativePath = h.relativePath
  return out
}

export function createFileTransferClient(host?: DbxPluginLike): FileTransferClient {
  const h = (): DbxPluginLike | undefined => host ?? (typeof window !== 'undefined' ? (window as any).dbxPlugin : undefined)
  const ft = () => h()?.fileTransfer
  const flags = () => h()?.capabilities?.fileTransfer
  const released = new Set<string>()
  let warned = false
  const warn = (e: unknown) => {
    if (warned) return
    warned = true
    console.warn('fileTransfer unavailable', e instanceof Error ? e.message : '')
  }

  const caps = () => ({
    pick: typeof ft()?.pick === 'function' && flags()?.pick !== false && flags()?.read !== false,
    drop: typeof ft()?.onDrop === 'function' && flags()?.drop === true,
    read: typeof ft()?.read === 'function' && flags()?.read !== false,
  })

  function subscribe<A extends unknown[]>(name: 'onDrop' | 'onDragState', ok: boolean, wrap: (...a: A) => void): () => void {
    if (!ok) return noop
    let off: unknown
    try {
      off = (ft() as any)[name]((...a: A) => {
        try { wrap(...a) } catch (e) { warn(e) }
      })
    } catch (e) {
      warn(e)
      return noop
    }
    let done = false
    return () => {
      if (done) return
      done = true
      try { if (typeof off === 'function') off() } catch { /* ignore */ }
    }
  }

  return {
    caps,
    onDrop(fn) {
      return subscribe<[HostHandle[], { dropId?: string; truncated?: boolean }?]>('onDrop', caps().drop, (files, meta) => {
        const list = (Array.isArray(files) ? files : []).map(toHandle).filter((x): x is HostHandle => !!x)
        fn({ files: list, dropId: typeof meta?.dropId === 'string' ? meta.dropId : '', truncated: !!meta?.truncated })
      })
    },
    onDragState(fn) {
      return subscribe<[boolean]>('onDragState', caps().drop && typeof ft()?.onDragState === 'function', (a) => fn(!!a))
    },
    async pick() {
      if (!caps().pick) return null
      let r: any
      try {
        r = await ft()!.pick!({ multiple: true })
      } catch (e) {
        if (isCancel(e)) return null
        throw e
      }
      const files = Array.isArray(r) ? r : r?.files
      if (!Array.isArray(files) || files.length === 0) return null
      const list = files.map(toHandle).filter((x): x is HostHandle => !!x)
      return list.length ? list : null
    },
    async readBytes(handle, o) {
      if (handle.size > o.maxBytes) throw new ImageError('tooLarge')
      if (o.signal?.aborted) throw abortError()
      const read = ft()?.read
      if (typeof read !== 'function') throw new ImageError('readFailed')
      const declared = typeof handle.size === 'number' && handle.size > 0 ? handle.size : 0
      const cap = declared || o.maxBytes
      let buf = declared ? new Uint8Array(declared) : new Uint8Array(0)
      const parts: Uint8Array[] = []
      let off = 0
      for (;;) {
        if (o.signal?.aborted) throw abortError()
        const c = await read.call(ft(), handle.handleId, off, CHUNK)
        if (o.signal?.aborted) throw abortError()
        const bin = atob(c.dataBase64 ?? '')
        if (off + bin.length > cap || off + bin.length > o.maxBytes) throw new ImageError('tooLarge')
        if (declared) {
          for (let i = 0; i < bin.length; i++) buf[off + i] = bin.charCodeAt(i)
        } else {
          const part = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) part[i] = bin.charCodeAt(i)
          parts.push(part)
        }
        off += bin.length
        if (c.eof) break
        if (bin.length === 0) throw new ImageError('readFailed')
      }
      if (!declared) {
        buf = new Uint8Array(off)
        let p = 0
        for (const part of parts) { buf.set(part, p); p += part.length }
      }
      return off === buf.length ? buf : buf.subarray(0, off)
    },
    async release(handle) {
      if (released.has(handle.handleId)) return
      released.add(handle.handleId)
      if (released.size > MAX_RELEASED) released.delete(released.values().next().value as string)
      try { await ft()?.cancel?.(handle.handleId) } catch { /* ignore */ }
    },
  }
}
