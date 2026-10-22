import type { HostBridge } from '../host/bridge'
import { mapHostError } from '../host/bridge'
import type { ConnectionsStore } from '../connections/hostConnections'
import type { EngineClient } from '../run/engineClient'
import type { useNotebookStore } from '../state/notebookStore'
import { renderBlockParams } from '../run/renderParams'
import { resolveBlockConnection, effectiveCatalog } from '../run/resolveConnection'
import { DepError, isResultsBlock, resultNameOf, upstreamOf } from '../run/deps'
import { analyzeSql } from './sqlSafety'
import { t } from '../i18n'

type Store = ReturnType<typeof useNotebookStore>
export type TrialResult =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { ok: false; reason: 'not-read-only' | 'params' | 'no-connection' | 'busy' | 'error'; message?: string }

const active = new WeakSet<Store>()

/**
 * Drawer-local read-only trial: reuses the safe-SQL gate and the block's connection, but never writes
 * store.runs / outputs / history and is not an AI request. Results stay with the caller.
 */
export async function trialRun(
  deps: { bridge: HostBridge; connections: ConnectionsStore; store: Store; engine?: EngineClient },
  blockId: string,
  sql: string,
  opts: { maxRows?: number } = {},
): Promise<TrialResult> {
  const { bridge, connections, store, engine } = deps
  const maxRows = opts.maxRows ?? 50
  const a = analyzeSql(sql)
  if (!a.readOnly || a.statements !== 1) return { ok: false, reason: 'not-read-only', message: t(`drawer.trial.no.${a.reason ?? 'not-select'}`) }
  const block = store.nb.value.blocks.find((b) => b.id === blockId)
  if (!block) return { ok: false, reason: 'no-connection', message: t('drawer.trial.noBlock') }
  if (active.has(store)) return { ok: false, reason: 'busy', message: t('drawer.trial.busy') }
  const gen = store.generation.value
  const cap = (columns: string[], rows: unknown[][], truncated: boolean): TrialResult => ({
    ok: true, columns, rows: rows.slice(0, maxRows), truncated: truncated || rows.length > maxRows,
  })
  active.add(store)
  try {
    if (isResultsBlock(block)) {
      if (!engine) return { ok: false, reason: 'error', message: t('run.noEngine') }
      const rp = renderBlockParams(store, sql, 'sqlite')
      if (!rp.ok) return { ok: false, reason: 'params', message: rp.message }
      let ups
      try { ups = upstreamOf(block, store.nb.value.blocks) } catch (e) {
        if (e instanceof DepError) return { ok: false, reason: 'error', message: t('run.upstreamMissing', { name: e.name }) }
        throw e
      }
      if (ups.some((u) => store.isStale(u.id))) return { ok: false, reason: 'error', message: t('drawer.trial.staleUpstream') }
      const items = []
      for (const u of ups) {
        const run = store.runs.get(u.id)
        if (!run || run.status !== 'ok' || !run.result) return { ok: false, reason: 'error', message: t('run.upstreamMissing', { name: resultNameOf(u) ?? '' }) }
        items.push({ block: u, run })
      }
      try {
        for (const i of items) await engine.ensureRegistered(resultNameOf(i.block)!, i.block, i.run)
        const r = await engine.query(rp.sql, maxRows)
        if (store.generation.value !== gen) return { ok: false, reason: 'error', message: t('drawer.trial.changed') }
        return cap(r.columns.map((c) => c.name), r.rows, r.truncated)
      } catch (e) {
        return { ok: false, reason: 'error', message: (e instanceof Error ? e.message : String(e)) || t('drawer.trial.failed') }
      }
    }
    const rc = resolveBlockConnection(connections, store.nb.value, block)
    if (rc.result?.status !== 'ok') return { ok: false, reason: 'no-connection', message: t('run.noConnection') }
    const conn = rc.result.conn
    const rp = renderBlockParams(store, sql, conn.dialect)
    if (!rp.ok) return { ok: false, reason: 'params', message: rp.message }
    try {
      const r = await bridge.queryData({ connectionId: conn.id, ...effectiveCatalog(block, store.nb.value, conn), sql: rp.sql, maxRows })
      if (store.generation.value !== gen) return { ok: false, reason: 'error', message: t('drawer.trial.changed') }
      return cap(r.columns.map((c) => c.name), r.rows, r.truncated)
    } catch (e) {
      return { ok: false, reason: 'error', message: mapHostError(e).message || t('drawer.trial.failed') }
    }
  } finally {
    active.delete(store)
  }
}
