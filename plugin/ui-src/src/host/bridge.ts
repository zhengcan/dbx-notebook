export interface Capabilities {
  dataApi: boolean
  schemaMetadataApi: boolean
  storage: boolean
  aiCompletion: boolean
  aiCompletionStream?: boolean
  aiModelDiscovery?: boolean
  workbenchTitle?: boolean
  connectionsApi?: boolean
}

export interface QueryResult {
  columns: { name: string; dataType?: string }[]
  rows: unknown[][]
  truncated: boolean
  elapsedMs: number
  dbType: string
}

export type HostErrorCode = 'NOT_OPEN' | 'NOT_GRANTED' | 'NOT_READONLY' | 'UNSUPPORTED' | 'UNKNOWN'
  | 'AI_CONSENT_DECLINED' | 'AI_BUSY' | 'AI_CANCELLED' | 'AI_TIMEOUT'

export class HostError extends Error {
  code: HostErrorCode
  rpcCode?: number
  rawMessage?: string
  constructor(code: HostErrorCode, message: string, rpcCode?: number) {
    super(message)
    this.rpcCode = rpcCode
    this.name = 'HostError'
    this.code = code
  }
}

export interface QueryRequest { connectionId: string; database?: string; schema?: string; sql: string; maxRows?: number }
export interface TableMetadataRequest { connectionId: string; database?: string; schema?: string; table: string }
export interface TableMetadata { columns: { name: string; dataType: string; nullable: boolean }[] }

export interface ThemeInfo {
  appearance: 'light' | 'dark'
  editor?: { fontFamily?: string; fontSize?: number; theme?: string }
}

export interface HostConnection {
  id: string
  name: string
  dialect: string
  connected: boolean
  readOnly: boolean
  database?: string
  schema?: string
}

// Capped; duplicate ids keep the first entry.
const MAX_CONNECTIONS = 2000

export function parseConnections(raw: unknown): HostConnection[] {
  if (!Array.isArray(raw)) return []
  const out: HostConnection[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    if (out.length >= MAX_CONNECTIONS) break
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (typeof r.id === 'string' && seen.has(r.id)) continue
    if (typeof r.id !== 'string' || r.id === '' || typeof r.name !== 'string' || r.name === '') continue
    const dialect = typeof r.dbType === 'string' ? r.dbType : typeof r.dialect === 'string' ? r.dialect : ''
    const c: HostConnection = {
      id: r.id, name: r.name, dialect,
      connected: r.connected === true || r.isConnected === true,
      readOnly: r.readOnly === true,
    }
    if (typeof r.database === 'string' && r.database) c.database = r.database
    if (typeof r.schema === 'string' && r.schema) c.schema = r.schema
    seen.add(c.id)
    out.push(c)
  }
  return out
}

export interface HostBridge {
  ready(): Promise<void>
  capabilities(): Capabilities
  locale(): string
  context(): Record<string, unknown>
  onContext(fn: (ctx: Record<string, unknown>) => void): () => void
  theme(): ThemeInfo
  onEnv(fn: () => void): () => void
  queryData(req: QueryRequest): Promise<QueryResult>
  getTableMetadata(req: TableMetadataRequest): Promise<TableMetadata>
  storageGet<T>(key: string): Promise<T | null>
  storageSet(key: string, value: unknown): Promise<void>
  invoke<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
  setTitle(title: string | null): Promise<void>
  getTitle(): Promise<string>
  getConnections(): Promise<HostConnection[]>
  onEvent(name: string, fn: (payload: unknown) => void): () => void
}

const RPC_PREFIX = /^\[(-?\d{5})\]\s*/

export function mapHostError(e: unknown): HostError {
  if (e instanceof HostError) return e
  const inner = (e as any)?.error && typeof (e as any).error === 'object' ? (e as any).error : undefined
  const raw = e instanceof Error ? e.message
    : typeof e === 'string' ? e
    : typeof (e as any)?.message === 'string' ? (e as any).message
    : typeof inner?.message === 'string' ? inner.message
    : e === undefined || e === null ? 'Unknown error'
    : typeof e === 'object' ? safeJson(e) : String(e)
  const m = RPC_PREFIX.exec(raw)
  const code = (e as any)?.code ?? inner?.code
  const numeric = typeof code === 'number' ? code : undefined
  const rpc = m ? Number(m[1]) : numeric
  const msg = m ? raw.slice(m[0].length) : raw
  const h = classify(msg)
  h.rpcCode = rpc
  h.rawMessage = raw
  return h
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function classify(msg: string): HostError {
  if (msg.includes('Connection is not open')) return new HostError('NOT_OPEN', msg)
  if (msg.startsWith('PLUGIN_DATA_ACCESS_NOT_GRANTED')) return new HostError('NOT_GRANTED', msg)
  if (/read-only/i.test(msg)) return new HostError('NOT_READONLY', msg)
  // DBX reports a declined consent dialog as the same text as a cancelled stream.
  if (/^AI generation cancelled/i.test(msg)) return new HostError('AI_CONSENT_DECLINED', msg)
  if (/^AI is already generating/i.test(msg)) return new HostError('AI_BUSY', msg)
  return new HostError('UNKNOWN', msg)
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { throw mapHostError(e) }
}

export function createHostBridge(): HostBridge {
  const host = () => (window as any).dbxPlugin
  const caps = (): Capabilities => {
    const c = host()?.capabilities ?? {}
    return {
      dataApi: c.dataApi === true,
      schemaMetadataApi: c.schemaMetadataApi === true,
      storage: c.storage === true,
      aiCompletion: c.aiCompletion === true,
      aiCompletionStream: c.aiCompletionStream === true,
      aiModelDiscovery: c.aiModelDiscovery === true,
      workbenchTitle: c.workbenchTitle === true,
      connectionsApi: c.connectionsApi === true,
    }
  }
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new HostError('UNSUPPORTED', `${what} is not supported by this host`)
  }
  const request = <T>(method: string, params?: unknown, opts?: { timeoutMs?: number }) =>
    wrap<T>(() => (opts ? host().request(method, params, opts) : host().request(method, params)))
  return {
    async ready() { await host()?.ready },
    capabilities: caps,
    locale: () => host()?.locale ?? 'en',
    context: () => host()?.context ?? {},
    onContext(fn) {
      const off = host()?.onContext?.(fn)
      return typeof off === 'function' ? off : () => {}
    },
    theme() {
      const th = host()?.theme
      const out: ThemeInfo = { appearance: th?.appearance === 'dark' ? 'dark' : 'light' }
      if (th?.editor && typeof th.editor === 'object') out.editor = th.editor
      return out
    },
    onEnv(fn) {
      window.addEventListener('dbx-plugin-env', fn)
      return () => window.removeEventListener('dbx-plugin-env', fn)
    },
    onEvent(name, fn) {
      const deliver = (m: any) => { if (m && m.type === 'event' && m.method === name) fn(m.params) }
      const off = host()?.onEvent?.(deliver)
      if (typeof off === 'function') return off
      const dom = (e: Event) => deliver((e as CustomEvent).detail)
      document.addEventListener('dbx-plugin-event', dom)
      return () => document.removeEventListener('dbx-plugin-event', dom)
    },
    async queryData(req) {
      need(caps().dataApi, 'dataApi')
      return wrap(() => host().queryData(req))
    },
    async getTableMetadata(req) {
      need(caps().schemaMetadataApi, 'schemaMetadataApi')
      return wrap(() => host().getTableMetadata(req))
    },
    async storageGet<T>(key: string) {
      need(caps().storage, 'storage')
      const v = await wrap(() => host().storage.get(key))
      return (v ?? null) as T | null
    },
    async storageSet(key, value) {
      need(caps().storage, 'storage')
      await wrap(() => host().storage.set(key, value))
    },
    request,
    async setTitle(title) {
      need(caps().workbenchTitle === true, 'workbenchTitle')
      await request<void>('host.setTitle', { title })
    },
    async getTitle() {
      need(caps().workbenchTitle === true, 'workbenchTitle')
      const t = await request<unknown>('host.getTitle')
      return typeof t === 'string' ? t : ''
    },
    async getConnections() {
      need(caps().connectionsApi === true, 'connectionsApi')
      return parseConnections(await request<unknown>('host.getConnections', {}))
    },
    invoke: <T>(method: string, params: unknown, opts?: { timeoutMs?: number }) =>
      wrap<T>(() => (opts ? host().invoke(method, params, opts) : host().invoke(method, params))),
  }
}
