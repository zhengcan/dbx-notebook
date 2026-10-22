import type { Notebook } from '@sqlnb/format'
import type { ConnectionsStore } from './hostConnections'
import { resolveBlockConnection } from '../run/resolveConnection'

export function missingConnections(connections: ConnectionsStore, nb: Notebook): { names: string[]; blocks: Record<string, string> } {
  const out = { names: [] as string[], blocks: {} as Record<string, string> }
  const st = connections.state.value
  if (!(st === 'ready' || (st === 'loading' && connections.loaded.value))) return out
  const names = new Set<string>()
  const def = nb.settings.defaultConnection
  if (def && connections.resolve(def).status === 'unmatched') names.add(def)
  for (const b of nb.blocks) {
    if (b.type !== 'sql' || (b.metadata as Record<string, unknown> | undefined)?.source === 'results') continue
    const rc = resolveBlockConnection(connections, nb, b)
    if (rc.name && rc.result?.status === 'unmatched') {
      names.add(rc.name)
      out.blocks[b.id] = rc.name
    }
  }
  out.names = [...names]
  return out
}
