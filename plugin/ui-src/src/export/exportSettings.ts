import { ref, type Ref } from 'vue'
import type { HostBridge } from '../host/bridge'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type ExportOptions } from './options'

const NOTEBOOKS_KEY = 'export.notebooks.v1'
const FOLDER_KEY = 'export.lastFolder.v1'
const BROWSER_KEY = 'export.browserPath.v1'
export const MAX_NOTEBOOKS = 50
const MAX_KEY_PATH = 200

export interface NotebookMemory { key: string; options: ExportOptions; folder: string }
export interface RememberedExport { options: ExportOptions; folder: string }

export interface ExportSettings {
  options: Ref<ExportOptions>
  browserPath: Ref<string>
  folder: Ref<string>
  load(nbPath: string | null, blockIds?: string[]): Promise<void>
  save(nbPath: string | null, s: RememberedExport, blockIds?: string[]): Promise<void>
  setBrowserPath(p: string): Promise<void>
}

export function notebookKey(path: string): string {
  if (path.length <= MAX_KEY_PATH) return `p:${path}`
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  let h2 = 5381
  for (let i = path.length - 1; i >= 0; i--) h2 = (Math.imul(h2, 33) ^ path.charCodeAt(i)) >>> 0
  return `h:${path.length}:${h.toString(16)}${h2.toString(16)}`
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

export function normalizeMemory(raw: unknown): NotebookMemory[] {
  const items = isObj(raw) && Array.isArray(raw.items) ? raw.items : []
  const out: NotebookMemory[] = []
  for (const it of items) {
    if (!isObj(it) || typeof it.key !== 'string' || !it.key || out.some((e) => e.key === it.key)) continue
    out.push({
      key: it.key,
      options: normalizeExportOptions(it.options),
      folder: typeof it.folder === 'string' ? it.folder : '',
    })
    if (out.length >= MAX_NOTEBOOKS) break
  }
  return out
}

export function pruneOptions(o: ExportOptions, blockIds: string[] | undefined): ExportOptions {
  if (!blockIds) return o
  const keep = new Set(blockIds)
  const pick = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => keep.has(k)))
  return { ...o, columnBreaks: pick(o.columnBreaks), blocks: pick(o.blocks) }
}

export function createExportSettings(bridge: HostBridge, opts: { timeoutMs?: number } = {}): ExportSettings {
  const timeoutMs = opts.timeoutMs ?? 2500
  const options = ref<ExportOptions>(normalizeExportOptions(DEFAULT_EXPORT_OPTIONS))
  const browserPath = ref('')
  const folder = ref('')
  let writes = 0
  let cache: NotebookMemory[] = []

  async function bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    p.catch(() => {})
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('storage timeout')), timeoutMs) })])
    } finally { clearTimeout(timer) }
  }
  async function readMemory(): Promise<NotebookMemory[]> {
    try { cache = normalizeMemory(await bounded(bridge.storageGet<unknown>(NOTEBOOKS_KEY))) } catch { /* keep the cache */ }
    return cache
  }

  return {
    options,
    browserPath,
    folder,
    async load(nbPath, blockIds) {
      const seen = writes
      let lastFolder = ''
      try {
        const f = await bounded(bridge.storageGet<unknown>(FOLDER_KEY))
        if (typeof f === 'string') lastFolder = f
      } catch { /* defaults */ }
      let entry: NotebookMemory | undefined
      if (nbPath) {
        const key = notebookKey(nbPath)
        entry = (await readMemory()).find((e) => e.key === key)
      }
      try {
        const p = await bounded(bridge.storageGet<unknown>(BROWSER_KEY))
        if (seen === writes && typeof p === 'string') browserPath.value = p
      } catch { /* keep in-memory */ }
      if (seen !== writes) return
      options.value = entry ? pruneOptions(entry.options, blockIds) : normalizeExportOptions(DEFAULT_EXPORT_OPTIONS)
      folder.value = entry?.folder || lastFolder
    },
    async save(nbPath, s, blockIds) {
      writes++
      const o = pruneOptions(normalizeExportOptions(s.options), blockIds)
      options.value = o
      folder.value = s.folder
      if (s.folder) { try { await bounded(bridge.storageSet(FOLDER_KEY, s.folder)) } catch { /* keep in memory */ } }
      if (!nbPath) return
      const key = notebookKey(nbPath)
      const rest = (await readMemory()).filter((e) => e.key !== key)
      cache = [{ key, options: o, folder: s.folder }, ...rest].slice(0, MAX_NOTEBOOKS)
      try { await bounded(bridge.storageSet(NOTEBOOKS_KEY, { items: cache })) } catch { /* keep in memory */ }
    },
    async setBrowserPath(p) {
      const v = p.trim()
      writes++
      browserPath.value = v
      try { await bounded(bridge.storageSet(BROWSER_KEY, v)) } catch { /* keep in memory */ }
    },
  }
}
