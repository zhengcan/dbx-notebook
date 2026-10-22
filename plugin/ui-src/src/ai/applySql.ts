import type { HostBridge } from '../host/bridge'
import type { ConnectionsStore } from '../connections/hostConnections'
import type { EngineClient } from '../run/engineClient'
import type { AppliedOutcome, useNotebookStore } from '../state/notebookStore'
import { renderBlockParams } from '../run/renderParams'
import { resolveBlockConnection } from '../run/resolveConnection'
import { DepError, isResultsBlock, upstreamOf } from '../run/deps'
import { runSqlBlock } from '../run/runSqlBlock'
import { analyzeSql } from './sqlSafety'

type Store = ReturnType<typeof useNotebookStore>
export interface ApplyDeps { bridge: HostBridge; connections: ConnectionsStore; store: Store; engine?: EngineClient; /** true while a Run All is in progress or running is disallowed */ runBlocked?: () => boolean }
export type AutoRunOutcome = { ok: boolean; errorMessage?: string }

export type AutoRunDecision =
  | { run: true }
  | { run: false; reason: 'not-select' | 'multiple' | 'unsupported-syntax' | 'unresolved-params' | 'stale-upstream' | 'no-connection' | 'busy'; detail?: string }

/** Conservative gate for the one automatic run after Apply. `connections` is needed to check database blocks have a connection. */
export function decideAutoRun(store: Store, blockId: string, sql: string, connections?: ConnectionsStore, opts: { runBlocked?: boolean } = {}): AutoRunDecision {
  const a = analyzeSql(sql)
  if (a.statements > 1 || a.reason === 'multiple') return { run: false, reason: 'multiple' }
  if (a.reason === 'unsupported-syntax') return { run: false, reason: 'unsupported-syntax' }
  if (!a.readOnly || a.statements !== 1) return { run: false, reason: 'not-select' }
  const block = store.nb.value.blocks.find((b) => b.id === blockId)
  if (!block) return { run: false, reason: 'no-connection' }
  const local = isResultsBlock(block)
  let dbType = 'sqlite'
  if (!local) {
    const r = connections ? resolveBlockConnection(connections, store.nb.value, block).result : undefined
    if (!r || r.status !== 'ok') return { run: false, reason: 'no-connection' }
    dbType = r.conn.dialect
  }
  const p = renderBlockParams(store, sql, dbType)
  if (!p.ok) return { run: false, reason: 'unresolved-params', detail: p.variable ?? '' }
  // a never-run block (e.g. just inserted) has no stale reasons yet, so check the referenced results directly
  if (local) {
    try {
      const bad = upstreamOf(block, store.nb.value.blocks).some((u) => store.runs.get(u.id)?.status !== 'ok' || store.isStale(u.id))
      if (bad) return { run: false, reason: 'stale-upstream' }
    } catch (e) {
      if (e instanceof DepError) return { run: false, reason: 'stale-upstream' }
      throw e
    }
  }
  if (store.staleReasons(blockId).includes('upstream')) return { run: false, reason: 'stale-upstream' }
  if (opts.runBlocked || store.runs.get(blockId)?.status === 'running') return { run: false, reason: 'busy' }
  return { run: true }
}

const INHERIT = ['connection', 'database', 'schema', 'source'] as const

export async function applySqlSuggestion(
  deps: ApplyDeps,
  mode: 'replace' | 'insert-new',
  blockId: string,
  sql: string,
): Promise<{ applied: true; autoRun: AutoRunDecision; ran?: AutoRunOutcome; newBlockId?: string }> {
  const { store } = deps
  let newBlockId: string | undefined
  store.applyAiEdit({
    label: mode === 'replace' ? 'AI: replace SQL' : 'AI: insert SQL block',
    run: (tx) => {
      if (mode === 'replace') { tx.updateContent(blockId, sql); return }
      newBlockId = tx.insertAfter('sql', blockId, sql)
      const src = (store.nb.value.blocks.find((b) => b.id === blockId)?.metadata ?? {}) as Record<string, unknown>
      const meta: Record<string, unknown> = {}
      for (const k of INHERIT) if (src[k] !== undefined) meta[k] = src[k]
      if (Object.keys(meta).length) store.updateMeta(newBlockId, meta)
    },
  })
  const target = newBlockId ?? blockId
  const autoRun = decideAutoRun(store, target, sql, deps.connections, { runBlocked: deps.runBlocked?.() === true })
  let ran: AutoRunOutcome | undefined
  if (autoRun.run) {
    // a failed run keeps the edit and adds no history entry
    try {
      const r = await runSqlBlock(deps, target)
      ran = r.status === 'ok' ? { ok: true } : { ok: false, errorMessage: r.error?.message ?? '' }
    } catch (e) {
      ran = { ok: false, errorMessage: e instanceof Error ? e.message : String(e) }
    }
  }
  const outcome: AppliedOutcome | undefined = !autoRun.run
    ? { kind: 'skipped', reason: autoRun.reason, ...(autoRun.detail ? { detail: autoRun.detail } : {}) }
    : ran ? (ran.ok ? { kind: 'ran' } : { kind: 'failed', message: ran.errorMessage ?? '' }) : undefined
  const n = store.appliedNotice.value
  if (outcome && n && !n.conflict && n.blockId === target) store.appliedNotice.value = { ...n, outcome }
  return { applied: true, autoRun, ...(ran ? { ran } : {}), ...(newBlockId ? { newBlockId } : {}) }
}
