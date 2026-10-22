// Pure helpers for pasting/dropping images into a Markdown block. The client only filters and bounds;
// the sidecar re-validates magic bytes, size and pixels.
import { ImageError } from '../files/imageClient'
import { dropSignature } from './dropGate'
import { createFileTransferClient, type FileTransferClient, type HostHandle } from '../files/fileTransferClient'

export const MAX_IMAGES = 10
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const UNSUPPORTED_EXT = new Set(['svg', 'svgz', 'avif', 'jxl', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'ico', 'apng'])

export interface Inspected {
  files: File[]
  /** Image-like files that are not PNG/JPEG/GIF/WebP. */
  unsupported: number
  /** Allowed images beyond the per-action limit. */
  truncated: number
  /** True when the transfer carries any image-like file (the default action must be prevented). */
  claimed: boolean
  /** Name/size signature of every file in the transfer, shared with the host-drop dedupe gate. */
  signature: string
}

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')

export interface ImageSource { name: string; size: number; type: string; read(signal?: AbortSignal): Promise<{ mime: string; base64: string }> }
export interface DropSummary { unsupported: number; ignored: number; truncated: number; hostTruncated: boolean }

export function classifyName(name: string, rawType: string): 'ok' | 'unsupported' | 'ignore' {
  const type = (rawType || '').toLowerCase()
  if (ALLOWED.has(type)) return 'ok'
  const ext = extOf(name)
  if (type.startsWith('image/')) return 'unsupported'
  if (type === '') return ext in BY_EXT ? 'ok' : UNSUPPORTED_EXT.has(ext) ? 'unsupported' : 'ignore'
  return 'ignore'
}

function filesOf(dt: DataTransfer): File[] {
  const out: File[] = []
  const list = dt.files
  if (list && list.length > 0) for (let i = 0; i < list.length; i++) { const f = list[i] ?? list.item?.(i); if (f) out.push(f) }
  else if (dt.items) for (const it of Array.from(dt.items)) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f) } }
  return out
}

export function inspectTransfer(dt: DataTransfer | null | undefined, kind: 'paste' | 'drop'): Inspected {
  const none: Inspected = { files: [], unsupported: 0, truncated: 0, claimed: false, signature: '' }
  if (!dt) return none
  if (kind === 'paste' && (dt.getData('text/plain') ?? '').length > 0) return none
  return inspectFiles(filesOf(dt))
}

export function inspectFiles(all: File[]): Inspected {
  const ok: File[] = []
  let unsupported = 0
  for (const f of all) {
    const c = classifyName(f.name, f.type)
    if (c === 'ok') ok.push(f)
    else if (c === 'unsupported') unsupported++
  }
  return { files: ok.slice(0, MAX_IMAGES), unsupported, truncated: Math.max(0, ok.length - MAX_IMAGES), claimed: ok.length + unsupported > 0, signature: dropSignature(all) }
}

export function extractImageFiles(dt: DataTransfer | null | undefined, kind: 'paste' | 'drop' = 'paste'): File[] {
  return inspectTransfer(dt, kind).files
}

function mimeOfBytes(b: Uint8Array): string | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif'
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  return null
}

function readBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as ArrayBuffer)
    r.onerror = () => rej(new ImageError('readFailed'))
    r.readAsArrayBuffer(blob)
  })
}

export async function sniffMime(f: Blob): Promise<string | null> {
  return mimeOfBytes(new Uint8Array(await readBuffer(f.slice(0, 16))))
}

export function assertSize(f: File): void {
  if (f.size > MAX_IMAGE_BYTES) throw new ImageError('tooLarge')
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function fileToBase64(f: File): Promise<{ mime: string; base64: string }> {
  assertSize(f)
  const mime = await sniffMime(f)
  if (!mime) throw new ImageError('unsupported')
  return { mime, base64: toBase64(await readBuffer(f)) }
}

/** All sizes are checked before any file is read. */
export async function filesToBase64(files: File[]): Promise<{ mime: string; base64: string }[]> {
  files.forEach(assertSize)
  const out: { mime: string; base64: string }[] = []
  for (const f of files) out.push(await fileToBase64(f))
  return out
}

export function fileSource(f: File): ImageSource {
  return { name: f.name, size: f.size, type: f.type, read: () => fileToBase64(f) }
}

function toBase64Bytes(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Reads through the host client; releasing the handle is the caller's job. */
export function handleSource(client: FileTransferClient, h: HostHandle): ImageSource {
  return {
    name: h.name,
    size: h.size,
    type: h.contentType,
    async read(signal) {
      const bytes = await client.readBytes(h, { signal, maxBytes: MAX_IMAGE_BYTES })
      const mime = BY_EXT[extOf(h.name)] ?? mimeOfBytes(bytes) ?? (ALLOWED.has((h.contentType || '').toLowerCase()) ? h.contentType.toLowerCase() : null)
      if (!mime) throw new ImageError('unsupported')
      return { mime, base64: toBase64Bytes(bytes) }
    },
  }
}

/** Sizes above the limit stay in `sources` so the per-file notice comes from the failed read. */
export function inspectHandles(files: HostHandle[], hostTruncated: boolean, client: FileTransferClient = createFileTransferClient()): { sources: ImageSource[]; summary: DropSummary } {
  const ok: HostHandle[] = []
  let unsupported = 0
  let ignored = 0
  for (const h of files) {
    const c = classifyName(h.name, h.contentType)
    if (c === 'ok') ok.push(h)
    else if (c === 'unsupported') unsupported++
    else ignored++
  }
  return {
    sources: ok.slice(0, MAX_IMAGES).map((h) => handleSource(client, h)),
    summary: { unsupported, ignored, truncated: Math.max(0, ok.length - MAX_IMAGES), hostTruncated },
  }
}

export function summaryOf(ins: Inspected): DropSummary {
  return { unsupported: ins.unsupported, ignored: 0, truncated: ins.truncated, hostTruncated: false }
}
