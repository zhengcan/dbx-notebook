import { HostError, mapHostError, type HostBridge } from '../host/bridge'
import type { ConnectionsStore } from '../connections/hostConnections'
import { useNotebookStore, type BlockRunState } from '../state/notebookStore'
import { hashSql } from '../state/hash'
import { resolveBlockConnection, effectiveCatalog } from './resolveConnection'
import type { EngineClient } from './engineClient'
import { runResultsBlock } from './runResultsBlock'
import { t } from '../i18n'
import { renderBlockParams } from './renderParams'

type Store = ReturnType<typeof useNotebookStore>
interface Deps { bridge: HostBridge; connections: ConnectionsStore; store: Store; engine?: EngineClient }

const inflight = new WeakMap<Store, Map<string, Promise<BlockRunState>>>()

export function runSqlBlock(deps: Deps, blockId: string): Promise<BlockRunState> {
  const { store } = deps
  store.sealHistory()
  if (!store.nb.value.blocks.some((b) => b.id === blockId)) {
    return Promise.reject(new Error(`unknown block ${blockId}`))
  }
  let m = inflight.get(store)
  if (!m) inflight.set(store, (m = new Map()))
  const key = `${store.generation.value}:${blockId}`
  const existing = m.get(key)
  if (existing) return existing
  const p = safeRun(deps, blockId).finally(() => m!.delete(key))
  m.set(key, p)
  return p
}

async function safeRun(deps: Deps, blockId: string): Promise<BlockRunState> {
  const block = deps.store.nb.value.blocks.find((b) => b.id === blockId)
  const ranSqlHash = hashSql(block?.content ?? '')
  const gen = deps.store.generation.value
  try {
    return await doRun(deps, blockId)
  } catch (e) {
    const s: BlockRunState = { status: 'error', error: { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) }, ranSqlHash, ranSource: 'database' }
    if (deps.store.generation.value === gen && deps.store.nb.value.blocks.some((b) => b.id === blockId)) {
      s.executedAt = deps.store.nowIso()
      deps.store.runs.set(blockId, s)
      deps.store.noteRunFinished(blockId)
    }
    return s
  }
}

async function doRun({ bridge, connections, store, engine }: Deps, blockId: string): Promise<BlockRunState> {
  const block = store.nb.value.blocks.find((b) => b.id === blockId)!
  const sql = block.content ?? ''
  const ranSqlHash = hashSql(sql)
  const gen = store.generation.value
  // a notebook load while the query is in flight must not receive its result
  const put = (s: BlockRunState) => {
    if (store.generation.value !== gen || !store.nb.value.blocks.some((b) => b.id === blockId)) return
    const finished = s.status === 'ok' || s.status === 'error'
    if (finished) s.executedAt = store.nowIso()
    store.runs.set(blockId, s)
    if (finished) store.noteRunFinished(blockId)
  }
  let params: Record<string, unknown> | undefined
  const fail = (code: HostError['code'], message: string, kind?: 'param', variable?: string, paramCode?: NonNullable<BlockRunState['error']>['paramCode']): BlockRunState => {
    const s: BlockRunState = { status: 'error', error: kind ? { code, message, kind, ...(variable ? { variable } : {}), ...(paramCode ? { paramCode } : {}) } : { code, message }, ranSqlHash, ranSource: 'database' }
    if (params) s.params = params
    put(s)
    return s
  }
  put({ status: 'running' })

  const meta = (block.metadata ?? {}) as Record<string, unknown>
  if (meta.source === 'results') {
    if (!engine) return fail('UNKNOWN', t('run.noEngine'))
    return runResultsBlock({ bridge, store, engine }, blockId)
  }
  if (sql.trim() === '') return fail('UNKNOWN', t('run.emptySql'))

  const rc = resolveBlockConnection(connections, store.nb.value, block)
  if (!rc.name) return fail('UNKNOWN', t('run.noConnection'))
  const name = rc.name
  const r = rc.result!
  if (r.status === 'unmatched') return fail('UNKNOWN', t('run.unmatched', { name }))
  if (r.status === 'ambiguous') return fail('UNKNOWN', t('run.ambiguous', { name }))
  const conn = r.conn

  const rp = renderBlockParams(store, sql, conn.dialect)
  if (!rp.ok) return fail('UNKNOWN', rp.message, 'param', rp.variable, rp.paramCode)
  const execSql = rp.sql
  params = rp.used

  try {
    const result = await bridge.queryData({
      connectionId: conn.id,
      ...effectiveCatalog(block, store.nb.value, conn),
      sql: execSql,
      maxRows: store.effectiveMaxRows(),
    })
    const s: BlockRunState = { status: 'ok', result, ranSqlHash, ranSource: 'database', params }
    put(s)
    return s
  } catch (e) {
    const he = mapHostError(e)
    const msg =
      he.code === 'NOT_OPEN' ? t('run.notOpen', { name })
      : he.code === 'NOT_GRANTED' ? t('run.notGranted')
      : he.code === 'NOT_READONLY' ? t('run.notReadonly')
      : he.message
    return fail(he.code, msg)
  }
}
