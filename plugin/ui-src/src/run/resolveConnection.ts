import type { Block, Notebook } from '@sqlnb/format'
import { dialectHasSchemas } from './catalog'
import type { ConnectionsStore, ResolveResult } from '../connections/hostConnections'

export function resolveBlockConnection(
  connections: ConnectionsStore,
  nb: Notebook,
  block: Block | undefined,
): { name?: string; result?: ResolveResult } {
  const c = block?.metadata?.connection
  const name = (typeof c === 'string' && c !== '' ? c : undefined) ?? nb.settings.defaultConnection
  if (!name) return {}
  return { name, result: connections.resolve(name) }
}

const clean = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

export function effectiveCatalog(
  block: Block | undefined,
  nb: Notebook,
  conn: { database?: string; dialect?: string } | undefined,
): { database?: string; schema?: string } {
  const m = (block?.metadata ?? {}) as Record<string, unknown>
  const s = (nb.settings ?? {}) as Record<string, unknown>
  return {
    database: clean(m.database) ?? clean(s.defaultDatabase) ?? clean(conn?.database),
    schema: conn?.dialect !== undefined && dialectHasSchemas(conn.dialect) === false ? undefined : clean(m.schema) ?? clean(s.defaultSchema),
  }
}
