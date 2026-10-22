import type { Block } from '@sqlnb/format'
import { mapHostError, type HostBridge } from '../host/bridge'
import type { BlockRunState } from '../state/notebookStore'
import { columnKind } from '../analysis/sql'

export interface EngineQueryResult { columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean; elapsedMs: number }

const HINT_RE = /\n?hint:(cast_operator|ilike|distinct_on|filter_clause|within_group|regex_operator)\s*$/
const TIMEOUT_MS = 60_000

export class EngineError extends Error {
  code: number
  hint?: string
  sqlMessage: string
  needsReregister?: boolean
  constructor(code: number, message: string, hint?: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.hint = hint
    this.sqlMessage = message
  }
}

export interface EngineClient {
  readonly sessionId: string
  ensureRegistered(name: string, block: Block, run: BlockRunState): Promise<void>
  query(sql: string, maxRows: number): Promise<EngineQueryResult>
  invalidate(name?: string): void
  close(): Promise<void>
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function defaultRandomId(): string {
  const bytes = new Uint8Array(20)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let s = 'ses_'
  for (const b of bytes) s += ALPHA[b % ALPHA.length]
  return s
}

function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e
  const h = mapHostError(e)
  let msg = h.message
  let hint: string | undefined
  const m = HINT_RE.exec(msg)
  if (m) { hint = m[1]; msg = msg.slice(0, m.index) }
  return new EngineError(h.rpcCode ?? -32603, msg, hint)
}

export function createEngineClient(bridge: HostBridge, opts: { sessionId?: string; randomId?: () => string } = {}): EngineClient {
  const sessionId = opts.sessionId ?? (opts.randomId ?? defaultRandomId)()
  const registered = new Map<string, string>()
  const chains = new Map<string, Promise<void>>()

  async function call<T>(method: string, params: unknown): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineError(-32020, 'engine request timed out')), TIMEOUT_MS)
    })
    try {
      return await Promise.race([bridge.invoke<T>(method, params), timeout])
    } catch (e) {
      throw toEngineError(e)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function register(name: string, block: Block, run: BlockRunState): Promise<void> {
    const result = run.result
    if (run.status !== 'ok' || !result) throw new EngineError(-32602, 'block result not available')
    const key = `${block.id}|${run.executedAt ?? ''}|${result.rows.length}|${result.columns.length}`
    if (registered.get(name) === key) return
    const columns = result.columns.map((c, i) => {
      if (columnKind(c.dataType) !== 'number') {
        const sample = result.rows.find((r) => r[i] !== null && r[i] !== undefined)?.[i]
        if (typeof sample === 'string' && columnKind(c.dataType, sample) === 'number') return { name: c.name, type: 'decimal' }
      }
      return c.dataType === undefined ? { name: c.name } : { name: c.name, type: c.dataType }
    })
    await call('engine/register', { sessionId, name, columns, rows: result.rows })
    registered.set(name, key)
  }

  return {
    sessionId,
    ensureRegistered(name, block, run) {
      if (run.status !== 'ok' || !run.result) return Promise.reject(new EngineError(-32602, 'block result not available'))
      const prev = chains.get(name) ?? Promise.resolve()
      const next = prev.catch(() => {}).then(() => register(name, block, run))
      chains.set(name, next)
      const clean = () => { if (chains.get(name) === next) chains.delete(name) }
      next.then(clean, clean)
      return next
    },
    async query(sql, maxRows) {
      const n = Number.isFinite(maxRows) ? Math.floor(maxRows) : 1
      const clamped = Math.min(5000, Math.max(1, n))
      try {
        return await call<EngineQueryResult>('engine/query', { sessionId, sql, maxRows: clamped })
      } catch (e) {
        const err = e as EngineError
        if (/no such table/i.test(err.message)) {
          const t = /no such table:?\s*"?([\w.$-]+)"?/i.exec(err.message)?.[1]
          if (t ? registered.has(t) : registered.size > 0) err.needsReregister = true
        }
        throw err
      }
    },
    invalidate(name) {
      if (name === undefined) registered.clear()
      else registered.delete(name)
    },
    async close() {
      registered.clear()
      try { await call('engine/close', { sessionId }) } catch { /* best effort */ }
    },
  }
}

export async function withReregister<T>(fn: () => Promise<T>, reregisterAll: () => Promise<void>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!(e instanceof EngineError) || !e.needsReregister) throw e
    await reregisterAll()
    return await fn()
  }
}
