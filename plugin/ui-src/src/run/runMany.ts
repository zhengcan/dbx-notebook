import type { HostBridge, HostErrorCode } from '../host/bridge'
import type { ConnectionsStore } from '../connections/hostConnections'
import type { useNotebookStore } from '../state/notebookStore'
import type { EngineClient } from './engineClient'
import { runSqlBlock } from './runSqlBlock'
import { findSourceBlock } from '../analysis/source'

type Store = ReturnType<typeof useNotebookStore>
export interface RunManyDeps { bridge: HostBridge; connections: ConnectionsStore; store: Store; engine?: EngineClient; signal?: AbortSignal }
export type RunMode = { kind: 'all' } | { kind: 'from'; blockId: string }
export interface RunManyResult { ran: string[]; stoppedAt?: { blockId: string; code: HostErrorCode } }

export async function runAll(deps: RunManyDeps, mode: RunMode): Promise<RunManyResult> {
  deps.store.sealHistory()
  const ids = deps.store.nb.value.blocks.map((b) => b.id)
  const start = mode.kind === 'from' ? ids.indexOf(mode.blockId) : 0
  const ran: string[] = []
  const gen = deps.store.generation.value
  if (start < 0) return { ran }
  const cancelled = () => !!deps.signal?.aborted || deps.store.generation.value !== gen
  let stoppedAt: RunManyResult['stoppedAt']
  for (const id of ids.slice(start)) {
    if (cancelled()) break
    const block = deps.store.nb.value.blocks.find((b) => b.id === id)
    if (!block || block.type !== 'sql') continue
    const s = await runSqlBlock(deps, id)
    ran.push(id)
    if (deps.store.generation.value !== gen) break
    if (s.status === 'error') { stoppedAt = { blockId: id, code: s.error!.code }; break }
  }
  if (!cancelled()) await refreshDependents(deps, ran)
  return stoppedAt ? { ran, stoppedAt } : { ran }
}

// Bulk runs are explicit "refresh everything": refresh charts/big-numbers whose source ran OK in this batch.
async function refreshDependents(deps: RunManyDeps, ran: string[]) {
  const { store } = deps
  const okSources = new Set(ran.filter((id) => store.runs.get(id)?.status === 'ok'))
  for (const b of [...store.nb.value.blocks]) {
    if (b.type !== 'chart' && b.type !== 'big-number') continue
    const data = typeof b.metadata?.data === 'string' ? b.metadata.data : ''
    const src = findSourceBlock(store, data)
    if (!src || !okSources.has(src.id)) continue
    try { await (b.type === 'chart' ? store.refreshAnalysis(b.id) : store.refreshBigNumber(b.id)) } catch { /* per-block failure must not abort the batch */ }
    if (deps.signal?.aborted) return
  }
}
