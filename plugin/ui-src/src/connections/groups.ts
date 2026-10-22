import type { HostConnection } from '../host/bridge'

const byName = (a: HostConnection, b: HostConnection) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function groupConnections(list: HostConnection[]): { connected: HostConnection[]; disconnected: HostConnection[] } {
  const sorted = [...list].sort(byName)
  return { connected: sorted.filter((c) => c.connected), disconnected: sorted.filter((c) => !c.connected) }
}

export function groupNames(list: HostConnection[]): { connected: string[]; disconnected: string[] } {
  const on = new Set(list.filter((c) => c.connected).map((c) => c.name))
  const all = [...new Set(list.map((c) => c.name))].sort((a, b) => a.localeCompare(b))
  return { connected: all.filter((n) => on.has(n)), disconnected: all.filter((n) => !on.has(n)) }
}
