// host.storage quota (DBX v0.6.47 pluginHostBridge.ts): value <= 256 KiB (UTF-8 JSON bytes), key <= 256 chars, whole store also capped by the native host (size not published); no storageDelete via bridge here, so we write null.
import type { HostBridge } from '../host/bridge'
import type { ChatMessage, ChatPart, ChatRecord } from './chatTypes'

export const CHAT_LIMITS = { maxMessages: 40, maxCharsPerBlock: 60_000, maxBlocks: 30, maxCharsTotal: 400_000 }

const MAX_BLOCK_BYTES = 200 * 1024
const INDEX_KEY = 'ai.chat.index.v1'
type Index = Record<string, { chars: number; updated: number }>

export function hashPath(path: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

export function chatKey(path: string, blockId: string): string {
  return 'ai.chat.v1.' + hashPath(path) + '.' + blockId
}

export interface ChatStore {
  load(path: string | null, blockId: string): Promise<ChatRecord>
  save(path: string | null, blockId: string, rec: ChatRecord): Promise<void>
  clear(path: string | null, blockId: string): Promise<void>
  remove(path: string | null, blockId: string): Promise<void>
}

const empty = (): ChatRecord => ({ v: 1, messages: [], updated: 0 })
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function normalize(raw: unknown): ChatRecord | null {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.messages)) return null
  const messages: ChatMessage[] = []
  for (const m of raw.messages) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.id !== 'string' || !Array.isArray(m.parts)) continue
    const parts: ChatPart[] = []
    for (const p of m.parts) {
      if (isObj(p) && (p.kind === 'text' || p.kind === 'data') && typeof p.text === 'string') parts.push({ kind: p.kind, text: p.text })
    }
    const out: ChatMessage = { id: m.id, role: m.role, parts, at: typeof m.at === 'number' ? m.at : 0 }
    if (typeof m.sqlAfter === 'string') out.sqlAfter = m.sqlAfter
    if (typeof m.markdownAfter === 'string') out.markdownAfter = m.markdownAfter
    if (typeof m.chartAfter === 'string') out.chartAfter = m.chartAfter
    if (typeof m.metricsAfter === 'string') out.metricsAfter = m.metricsAfter
    if (typeof m.metricsSampled === 'boolean') out.metricsSampled = m.metricsSampled
    if (m.metricsSchema === true) out.metricsSchema = true
    if (typeof m.resultSig === 'string') out.resultSig = m.resultSig
    if (isObj(m.catalog)) {
      const c: NonNullable<ChatMessage['catalog']> = {}
      if (m.catalog.list === true) c.list = true
      if (Array.isArray(m.catalog.tables)) {
        const tables = m.catalog.tables.filter((x: unknown): x is string => typeof x === 'string' && x.length <= 128).slice(0, 8)
        if (tables.length) c.tables = tables
      }
      if (c.list || c.tables) out.catalog = c
    }
    messages.push(out)
  }
  const rec: ChatRecord = { v: 1, messages, updated: typeof raw.updated === 'number' ? raw.updated : 0 }
  if (typeof raw.baseline === 'string') rec.baseline = raw.baseline
  return rec
}

const msgChars = (m: ChatMessage) => m.parts.reduce((n, p) => n + p.text.length, 0) + (m.sqlAfter?.length ?? 0) + (m.markdownAfter?.length ?? 0) + (m.chartAfter?.length ?? 0) + (m.metricsAfter?.length ?? 0)
const recChars = (r: ChatRecord) => r.messages.reduce((n, m) => n + msgChars(m), 0) + (r.baseline?.length ?? 0)

function cap(rec: ChatRecord, lim: typeof CHAT_LIMITS): ChatRecord {
  let messages = rec.messages.slice(-lim.maxMessages)
  const out: ChatRecord = { ...rec, messages }
  while (messages.length > 0 && recChars(out) > lim.maxCharsPerBlock) {
    messages = messages.slice(1)
    out.messages = messages
  }
  if (out.baseline !== undefined && recChars(out) > lim.maxCharsPerBlock) delete out.baseline
  const bytes = () => new TextEncoder().encode(JSON.stringify(out)).length
  while (out.messages.length > 0 && bytes() > MAX_BLOCK_BYTES) out.messages = out.messages.slice(1)
  if (out.baseline !== undefined && bytes() > MAX_BLOCK_BYTES) delete out.baseline
  return out
}

export function createChatStore(bridge: HostBridge, limits: Partial<typeof CHAT_LIMITS> = {}): ChatStore {
  const lim = { ...CHAT_LIMITS, ...limits }
  const mem = new Map<string, ChatRecord>()
  let memIndex: Index = {}
  let tick = 0
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(() => fn())
    chain = p.catch(() => {})
    return p
  }

  // Entries recorded while the stored index was unreadable; merged in once a read succeeds.
  let pending: Index = {}
  let indexOk = true
  async function readIndex(): Promise<Index> {
    try {
      const raw = await bridge.storageGet<unknown>(INDEX_KEY)
      if (raw === null || isObj(raw)) {
        const idx: Index = {}
        for (const [k, v] of Object.entries(raw ?? {})) {
          if (isObj(v) && typeof v.chars === 'number' && typeof v.updated === 'number') idx[k] = { chars: v.chars, updated: v.updated }
        }
        indexOk = true
        return { ...idx, ...pending }
      }
    } catch { /* fall through */ }
    indexOk = false
    return { ...memIndex, ...pending }
  }
  async function writeIndex(idx: Index): Promise<void> {
    memIndex = idx
    if (!indexOk) { pending = idx; return }
    try { await bridge.storageSet(INDEX_KEY, idx); pending = {} } catch { pending = idx }
  }
  async function nullKey(key: string): Promise<void> {
    mem.delete(key)
    try { await bridge.storageSet(key, null) } catch { /* ignore */ }
  }

  async function drop(path: string | null, blockId: string): Promise<void> {
    if (path === null) return
    const key = chatKey(path, blockId)
    await nullKey(key)
    const idx = await readIndex()
    delete idx[key]
    await writeIndex(idx)
  }

  return {
    load: (path, blockId) => serial(async () => {
      if (path === null) return empty()
      const key = chatKey(path, blockId)
      try {
        const raw = await bridge.storageGet<unknown>(key)
        const rec = normalize(raw)
        if (rec) return rec
      } catch { /* fall through to memory */ }
      return mem.get(key) ?? empty()
    }),
    save: (path, blockId, rec) => serial(async () => {
      if (path === null) return
      try {
        const key = chatKey(path, blockId)
        const capped = cap(rec, lim)
        const idx = await readIndex()
        tick = Math.max(tick + 1, Date.now())
        idx[key] = { chars: recChars(capped), updated: tick }
        try { await bridge.storageSet(key, capped); mem.delete(key) } catch { mem.set(key, capped) }
        const total = () => Object.values(idx).reduce((n, e) => n + e.chars, 0)
        while (Object.keys(idx).length > lim.maxBlocks || total() > lim.maxCharsTotal) {
          const victim = Object.entries(idx).filter(([k]) => k !== key).sort((a, b) => a[1].updated - b[1].updated)[0]
          if (!victim) break
          delete idx[victim[0]]
          await nullKey(victim[0])
        }
        await writeIndex(idx)
      } catch { /* never throws */ }
    }),
    clear: (path, blockId) => serial(() => drop(path, blockId).catch(() => {})),
    remove: (path, blockId) => serial(() => drop(path, blockId).catch(() => {})),
  }
}
