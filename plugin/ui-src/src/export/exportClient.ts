import type { HostBridge } from '../host/bridge'
import type { Orientation } from './options'

export interface BrowserStatus {
  found: boolean
  path?: string
  source: 'manual' | 'env' | 'auto' | 'none'
  reason?: string
  code?: 'notFound' | 'notExecutable'
}

/** RPC code of `export/saveHtml` / `export/pdfStart`, and job failure code of `export/pdfStatus`, for an existing target. */
export const TARGET_EXISTS_RPC = -32030
export const TARGET_EXISTS = 'TARGET_EXISTS'

export type ExportExt = 'pdf' | 'html'

export interface PdfArgs {
  html: string
  path: string
  orientation: Orientation
  manual?: string
  overwrite?: boolean
  onProgress?: (state: string) => void
  signal?: AbortSignal
  pollMs?: number
}

export interface ExportClient {
  browserStatus(manual?: string): Promise<BrowserStatus>
  pickSave(name: string, ext: ExportExt): Promise<{ path: string } | { cancelled: true }>
  pickFolder(defaultPath?: string): Promise<{ path: string } | { cancelled: true }>
  /** Native picker for the PDF browser: `file` = executable, `dir` = folder / .app bundle (resolved by the sidecar). */
  pickBrowser?(kind: 'file' | 'dir'): Promise<{ path: string } | { cancelled: true }>
  saveHtml(path: string, html: string, overwrite?: boolean): Promise<{ bytes: number }>
  pdf(args: PdfArgs): Promise<{ bytes: number }>
  /** Opens a file this plugin just exported with the system default program; the sidecar refuses anything else. */
  openFile?(path: string): Promise<void>
  /** OS user name from the sidecar; null on any failure (never throws). */
  exporterName(): Promise<string | null>
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

export class ExportError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ExportError'
    this.code = code
  }
}

/** Which field of the error recognised the "target exists" refusal, or null. */
export function targetExistsBranch(e: unknown): string | null {
  const o = (e ?? {}) as Record<string, any>
  const hit = (c: unknown) => c === TARGET_EXISTS_RPC || c === TARGET_EXISTS
  if (hit(o.rpcCode)) return 'rpcCode'
  if (hit(o.code)) return 'code'
  if (hit(o.error?.code)) return 'error.code'
  if (hit(o.data?.code)) return 'data.code'
  const re = /-32030|TARGET_EXISTS|Target already exists/
  if (typeof e === 'string' && re.test(e)) return 'text'
  if (typeof o.message === 'string' && re.test(o.message)) return 'message'
  if (typeof o.rawMessage === 'string' && re.test(o.rawMessage)) return 'rawMessage'
  if (typeof o.error?.message === 'string' && re.test(o.error.message)) return 'error.message'
  return null
}

/** True for every way the host may surface the sidecar's "target exists" refusal (RPC code, job code, or its text). */
export function isTargetExists(e: unknown): boolean {
  return targetExistsBranch(e) !== null
}

/** JSON for logging any thrown value; never throws (circular refs, bigint, functions, throwing getters). */
export function safeStringify(e: unknown): string {
  try {
    const seen = new WeakSet<object>()
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === 'bigint') return `${v}n`
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
      if (typeof v === 'symbol') return String(v)
      if (v === undefined) return '[undefined]'
      if (v === null || typeof v !== 'object') return v
      if (seen.has(v)) return '[Circular]'
      if (depth > 6) return '[Depth]'
      seen.add(v)
      if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1))
      const out: Record<string, unknown> = {}
      if (v instanceof Error) { out.name = v.name; out.message = v.message }
      let keys: string[] = []
      try { keys = Object.keys(v) } catch { /* ignore */ }
      for (const k of keys) {
        try { out[k] = walk((v as any)[k], depth + 1) } catch { out[k] = '[Unreadable]' }
      }
      return out
    }
    const top = walk(e, 0)
    return e === undefined ? 'undefined' : JSON.stringify(top) ?? String(e)
  } catch {
    try { return String(e) } catch { return '[Unserialisable error]' }
  }
}

/** `[<rpcCode|code>] <raw message>` for visible diagnostics. */
export function rawDetail(e: unknown): string {
  const o = (e ?? {}) as Record<string, any>
  const code = [o.rpcCode, o.code, o.error?.code, o.data?.code].find((c) => c !== undefined && c !== null)
  return `[${code ?? 'n/a'}] ${errorText(e)}`
}

/** A human-readable message for anything that can be thrown. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e || 'Unknown error'
  const o = e as Record<string, any> | null | undefined
  if (typeof o?.message === 'string' && o.message) return o.message
  if (typeof o?.error?.message === 'string' && o.error.message) return o.error.message
  if (e === undefined || e === null) return 'Unknown error'
  try { return JSON.stringify(e) ?? String(e) } catch { return String(e) }
}

const RPC_TIMEOUT_MS = 30_000
const SAVE_TIMEOUT_MS = 120_000
const PICK_TIMEOUT_MS = 10 * 60_000

type Status = { state: 'running' | 'done' | 'failed' | 'cancelled'; path?: string; bytes?: number; code?: string; message?: string }

export function createExportClient(bridge: Pick<HostBridge, 'invoke'>): ExportClient {
  return {
    browserStatus: (manual) =>
      bridge.invoke<BrowserStatus>('export/browserStatus', manual ? { manualPath: manual } : {}, { timeoutMs: RPC_TIMEOUT_MS }),
    pickSave: (name, ext) =>
      bridge.invoke('export/pickSave', { suggestedName: name, ext }, { timeoutMs: PICK_TIMEOUT_MS }),
    pickFolder: (defaultPath) => bridge.invoke('export/pickFolder', defaultPath ? { defaultPath } : {}, { timeoutMs: PICK_TIMEOUT_MS }),
    pickBrowser: (kind) => bridge.invoke('export/pickBrowser', { kind }, { timeoutMs: PICK_TIMEOUT_MS }),
    async openFile(path) {
      await bridge.invoke('export/openFile', { path }, { timeoutMs: RPC_TIMEOUT_MS })
    },
    async exporterName() {
      try {
        const r = await bridge.invoke<{ name?: unknown }>('system/user', {}, { timeoutMs: RPC_TIMEOUT_MS })
        const n = typeof r?.name === 'string' ? r.name.trim().slice(0, 128) : ''
        return n || null
      } catch { return null }
    },
    async saveHtml(path, html, overwrite) {
      const params: Record<string, unknown> = { path, html }
      if (overwrite) params.overwrite = true
      const r = await bridge.invoke<{ path: string; bytes: number }>('export/saveHtml', params, { timeoutMs: SAVE_TIMEOUT_MS })
      return { bytes: r.bytes }
    },
    async pdf({ html, path, orientation, manual, overwrite, onProgress, signal, pollMs = 500 }) {
      if (signal?.aborted) throw new ExportCancelled()
      const params: Record<string, unknown> = { html, path, orientation }
      if (manual) params.manualBrowserPath = manual
      if (overwrite) params.overwrite = true
      const { jobId } = await bridge.invoke<{ jobId: string }>('export/pdfStart', params, { timeoutMs: SAVE_TIMEOUT_MS })
      let aborted = signal?.aborted ?? false
      let wake: (() => void) | undefined
      const onAbort = () => {
        aborted = true
        wake?.()
      }
      signal?.addEventListener('abort', onAbort)
      try {
        for (;;) {
          if (aborted) {
            await bridge.invoke('export/pdfCancel', { jobId }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => {})
            throw new ExportCancelled()
          }
          const s = await bridge.invoke<Status>('export/pdfStatus', { jobId }, { timeoutMs: RPC_TIMEOUT_MS })
          onProgress?.(s.state)
          if (s.state === 'done') return { bytes: s.bytes ?? 0 }
          if (s.state === 'failed') throw new ExportError(s.code ?? 'EXPORT_FAILED', s.message ?? 'PDF export failed')
          if (s.state === 'cancelled') throw new ExportCancelled()
          await new Promise<void>((resolve) => {
            wake = resolve
            setTimeout(resolve, pollMs)
          })
          wake = undefined
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}
