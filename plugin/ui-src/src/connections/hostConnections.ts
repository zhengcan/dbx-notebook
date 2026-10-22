import { reactive, ref } from 'vue'
import type { HostBridge, HostConnection } from '../host/bridge'

export type ResolveResult =
  | { status: 'ok'; conn: HostConnection }
  | { status: 'unmatched' }
  | { status: 'ambiguous'; candidates: HostConnection[] }

export type ConnectionsState = 'idle' | 'loading' | 'ready' | 'unavailable'

const BACKOFF_MS = 30_000
const MAP_KEY = 'connectionMappings.v1'
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)

export interface ConnectionsOpts { now?: () => number; minRefreshMs?: number; timeoutMs?: number }

export function createConnectionsStore(bridge: HostBridge, opts: ConnectionsOpts = {}) {
  const now = opts.now ?? (() => Date.now())
  const minRefreshMs = opts.minRefreshMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 2500
  const conns = reactive(new Map<string, HostConnection>())
  const seeded = reactive(new Map<string, HostConnection>())
  const mappings = reactive(new Map<string, string>())
  const state = ref<ConnectionsState>('idle')
  const loaded = ref(false)
  let lastRefresh = -Infinity
  let backoffUntil = -Infinity
  let inflight: Promise<boolean> | null = null
  let trailing = false
  let queue: Promise<void> = Promise.resolve()

  async function loadMappings(): Promise<Array<[string, string]>> {
    try {
      let t: ReturnType<typeof setTimeout> | undefined
      const m = await Promise.race([
        bridge.storageGet<unknown>(MAP_KEY),
        new Promise<undefined>(res => { t = setTimeout(() => res(undefined), timeoutMs) }),
      ]).finally(() => clearTimeout(t))
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        return Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string')
      }
    } catch { /* storage unavailable */ }
    return []
  }

  async function once(): Promise<boolean> {
    if (bridge.capabilities().connectionsApi !== true) {
      conns.clear(); loaded.value = false; state.value = 'unavailable'; backoffUntil = now() + BACKOFF_MS; return false
    }
    state.value = 'loading'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const call = bridge.getConnections()
      call.catch(() => {})
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs) })
      const [items, stored] = await Promise.race([Promise.all([call, loadMappings()]), timeout])
      for (const [k, v] of stored) if (!mappings.has(k)) mappings.set(k, v)
      conns.clear()
      for (const c of items) conns.set(c.id, c)
      const names = new Set(items.map(c => c.name))
      for (const [id, c] of [...seeded]) if (conns.has(id) || names.has(c.name)) seeded.delete(id)
      loaded.value = true; state.value = 'ready'; backoffUntil = -Infinity
      return true
    } catch {
      conns.clear(); loaded.value = false; state.value = 'unavailable'; backoffUntil = now() + BACKOFF_MS
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  function refresh(o: { force?: boolean } = {}): Promise<boolean> {
    if (inflight) {
      if (o.force) trailing = true
      return inflight
    }
    lastRefresh = now()
    const run = async () => {
      let ok = await once()
      while (trailing) { trailing = false; ok = await once() }
      return ok
    }
    const p = run().catch(() => false).finally(() => { inflight = null })
    inflight = p
    return p
  }

  function all(): HostConnection[] {
    const byId = new Map<string, HostConnection>()
    for (const c of seeded.values()) byId.set(c.id, c)
    for (const c of conns.values()) byId.set(c.id, c)
    return [...byId.values()]
  }

  function list(): HostConnection[] {
    return all().map(c => ({ ...c })).sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  return {
    state,
    loaded,
    list,
    refresh,
    async refreshIfStale(): Promise<void> {
      if (now() - lastRefresh < minRefreshMs || now() < backoffUntil) return
      try { await refresh() } catch { /* never surfaces */ }
    },
    seedFromContext(ctx: Record<string, unknown>): { name: string; dbType: string } | null {
      const id = str(ctx?.id) ?? str(ctx?.connectionId)
      const name = str(ctx?.name)
      if (!id || !name) return null
      const dbType = typeof ctx.dbType === 'string' ? ctx.dbType : ''
      const c: HostConnection = { id, name, dialect: dbType, connected: false, readOnly: false }
      if (typeof ctx.database === 'string' && ctx.database) c.database = ctx.database
      if (!conns.has(id)) seeded.set(id, c)
      return { name, dbType }
    },
    resolve(name: string): ResolveResult {
      const items = list()
      const target = mappings.get(name)
      const mapped = typeof target === 'string' ? items.find(c => c.id === target) : undefined
      if (mapped) return { status: 'ok', conn: mapped }
      const matches = items.filter(c => c.name === name)
      if (matches.length === 0) return { status: 'unmatched' }
      if (matches.length === 1) return { status: 'ok', conn: matches[0] }
      return { status: 'ambiguous', candidates: matches }
    },
    setMapping(name: string, id: string): Promise<void> {
      mappings.set(name, id)
      const run = async () => { try { await bridge.storageSet(MAP_KEY, Object.fromEntries(mappings)) } catch { /* in-memory only */ } }
      queue = queue.then(run)
      return queue
    },
  }
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>
