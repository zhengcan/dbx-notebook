import type { HostBridge } from '../host/bridge'
import { mapHostError } from '../host/bridge'

export type ImageErrorCode = 'invalidPath' | 'notFound' | 'unsupported' | 'tooLarge' | 'readFailed' | 'needsSave'
export interface LoadedImage { mime: string; dataUri: string; size: number; mtimeMs: number; width: number; height: number }
export type ReadImageFn = (notebookPath: string, relPath: string, signal?: AbortSignal) => Promise<LoadedImage>

const CODES: readonly string[] = ['invalidPath', 'notFound', 'unsupported', 'tooLarge', 'readFailed', 'needsSave']
const MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export class ImageError extends Error {
  code: ImageErrorCode
  constructor(code: ImageErrorCode) {
    super(code)
    this.name = 'ImageError'
    this.code = code
  }
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError'

function toImageError(e: unknown): ImageError {
  if (e instanceof ImageError) return e
  const m = /^\[(\w+)\]/.exec(mapHostError(e).message)
  return new ImageError(m && CODES.includes(m[1]) ? (m[1] as ImageErrorCode) : 'readFailed')
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export type SaveImageFn = (notebookPath: string, image: { mime: string; base64: string }) => Promise<{ relPath: string; size: number }>

export function createImageClient(bridge: Pick<HostBridge, 'invoke'>): { readImage: ReadImageFn; saveImage: SaveImageFn } {
  return {
    async saveImage(notebookPath, image) {
      try {
        const r = await bridge.invoke<Record<string, unknown>>('notebook/saveImage', { notebookPath, mime: image.mime, base64: image.base64 }, { timeoutMs: 60_000 })
        if (!r || typeof r.relPath !== 'string' || r.relPath === '') throw new ImageError('readFailed')
        return { relPath: r.relPath, size: num(r.size) }
      } catch (e) {
        throw toImageError(e)
      }
    },
    async readImage(notebookPath, relPath, signal) {
      if (signal?.aborted) throw abortError()
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_, rej) => {
        onAbort = () => rej(abortError())
        signal?.addEventListener('abort', onAbort)
      })
      try {
        const call = bridge.invoke<Record<string, unknown>>('notebook/readImage', { notebookPath, relPath }, { timeoutMs: 30_000 })
        const r = await (signal ? Promise.race([call, aborted]) : call)
        if (!r || typeof r.mime !== 'string' || !MIMES.has(r.mime) || typeof r.base64 !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(r.base64)) throw new ImageError('readFailed')
        return { mime: r.mime, dataUri: `data:${r.mime};base64,${r.base64}`, size: num(r.size), mtimeMs: num(r.mtimeMs), width: num(r.width), height: num(r.height) }
      } catch (e) {
        if (isAbort(e)) throw e
        throw toImageError(e)
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        aborted.catch(() => {})
      }
    },
  }
}
