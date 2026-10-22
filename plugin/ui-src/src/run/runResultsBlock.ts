import type { Block } from '@sqlnb/format'
import type { HostBridge } from '../host/bridge'
import type { useNotebookStore, BlockRunState } from '../state/notebookStore'
import { hashSql } from '../state/hash'
import { t } from '../i18n'
import { DepError, resultNameOf, upstreamOf } from './deps'
import { EngineError, withReregister, type EngineClient } from './engineClient'
import { renderBlockParams } from './renderParams'
import { engineHintText } from './engineHints'

type Store = ReturnType<typeof useNotebookStore>
export interface ResultsDeps { bridge: HostBridge; store: Store; engine: EngineClient }

export async function runResultsBlock({ store, engine }: ResultsDeps, blockId: string): Promise<BlockRunState> {
  const block = store.nb.value.blocks.find((b) => b.id === blockId)!
  const sql = block.content ?? ''
  const ranSqlHash = hashSql(sql)
  const gen = store.generation.value
  const put = (s: BlockRunState) => {
    if (store.generation.value !== gen || !store.nb.value.blocks.some((b) => b.id === blockId)) return
    const finished = s.status === 'ok' || s.status === 'error'
    if (finished) s.executedAt = store.nowIso()
    store.runs.set(blockId, s)
    if (finished) store.noteRunFinished(blockId)
  }
  const fail = (message: string, extra: Partial<NonNullable<BlockRunState['error']>> = {}): BlockRunState => {
    const s: BlockRunState = { status: 'error', error: { code: 'UNKNOWN', message, ...extra }, ranSqlHash, ranSource: 'results' }
    put(s)
    return s
  }
  put({ status: 'running' })

  if (sql.trim() === '') return fail(t('run.emptySql'))
  let ups: Block[]
  try {
    ups = upstreamOf(block, store.nb.value.blocks)
  } catch (e) {
    if (!(e instanceof DepError)) throw e
    const key = e.code === 'SELF' ? 'run.depSelf' : e.code === 'FORWARD' ? 'run.depForward' : 'run.depDuplicate'
    return fail(t(key, { name: e.name }))
  }

  const rp = renderBlockParams(store, sql, 'sqlite')
  if (!rp.ok) return fail(rp.message, { kind: 'param', ...(rp.variable ? { variable: rp.variable } : {}), paramCode: rp.paramCode })

  const items: { name: string; block: Block; run: BlockRunState }[] = []
  for (const u of ups) {
    const name = resultNameOf(u)!
    const run = store.runs.get(u.id)
    if (!run || run.status !== 'ok' || !run.result) return fail(t('run.upstreamMissing', { name }))
    items.push({ name, block: u, run })
  }

  try {
    for (const i of items) await engine.ensureRegistered(i.name, i.block, i.run)
    const reregisterAll = async () => {
      engine.invalidate()
      for (const i of items) await engine.ensureRegistered(i.name, i.block, i.run)
    }
    const r = await withReregister(() => engine.query(rp.sql, store.effectiveMaxRows()), reregisterAll)
    const s: BlockRunState = {
      status: 'ok',
      result: { columns: r.columns.map((c) => ({ name: c.name, dataType: c.type })), rows: r.rows, truncated: r.truncated, elapsedMs: r.elapsedMs, dbType: 'sqlite' },
      ranSqlHash,
      ranSource: 'results',
      params: rp.used,
      upstream: Object.fromEntries(items.map((i) => [i.name, i.run.executedAt ?? ''])),
      partial: r.truncated || items.some((i) => i.run.result!.truncated || i.run.partial === true),
    }
    put(s)
    return s
  } catch (e) {
    if (!(e instanceof EngineError)) return fail(e instanceof Error ? e.message : String(e))
    if (e.code === -32020) return fail(t('run.engineTimeout'), { kind: 'engine' })
    if (e.code === -32021) return fail(t('run.engineFull'), { kind: 'engine' })
    let hint = engineHintText(e.hint)
    const missing = /no such table:?\s*"?([\w.$-]+)"?/i.exec(e.message)?.[1]
    if (!hint && missing) {
      const known = store.nb.value.blocks.some((b) => resultNameOf(b)?.toLowerCase() === missing.toLowerCase())
      if (!known) hint = t('run.noSuchResult', { name: missing })
    }
    return fail(e.message, { kind: 'engine', ...(hint ? { hint } : {}) })
  }
}
