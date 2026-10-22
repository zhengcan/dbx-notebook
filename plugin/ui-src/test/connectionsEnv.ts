import { createFakeBridge } from '../src/host/fakeBridge'
import { createConnectionsStore } from '../src/connections/hostConnections'
import type { HostConnection } from '../src/host/bridge'

export async function makeConnections(
  conns: Partial<HostConnection>[],
  bridgeOpts: Parameters<typeof createFakeBridge>[0] = {},
) {
  const items = conns.map((c, i) => ({ id: `c${i + 1}`, name: `conn${i + 1}`, dialect: 'postgres', connected: true, readOnly: false, ...c }))
  const bridge = createFakeBridge({ ...bridgeOpts, connections: items })
  const connections = createConnectionsStore(bridge)
  await connections.refresh()
  return { bridge, connections }
}
