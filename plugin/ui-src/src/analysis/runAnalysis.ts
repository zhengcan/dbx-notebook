import { normalizeAnalysis } from '@sqlnb/format'
import type { useNotebookStore } from '../state/notebookStore'
import { t } from '../i18n'
import { EngineError, withReregister, type EngineClient } from '../run/engineClient'
import { resolveSource } from './source'
import { createFlights } from './flights'
import { buildAggregateSql, buildExcludedCountSql, type AggregateQuery, type SqlError } from './sql'
import type { AnalysisResult, AnalysisErrorCode, Rows } from './analysisState'

export type { AnalysisResult, Rows } from './analysisState'
type Store = ReturnType<typeof useNotebookStore>

const MAX_POINTS = 5000
const isErr = (x: unknown): x is SqlError => typeof x === 'object' && x !== null && 'error' in x

// sql.ts codes -> result: BAD_FIELD stays BAD_FIELD; BAD_AGG/BAD_GRAIN/TYPE are config
// errors the user fixes in the panel and surface as 'SQL'; EMPTY (no values) is status 'empty'.
const flights = createFlights<AnalysisResult>()

function fingerprint(store: Store, blockId: string): string {
  const b = store.nb.value.blocks.find((x) => x.id === blockId)
  const data = typeof b?.metadata?.data === 'string' ? b.metadata.data : ''
  return JSON.stringify([data, b ? normalizeAnalysis(b.metadata) : null])
}

export function runAnalysis(deps: { store: Store; engine: EngineClient }, blockId: string): Promise<AnalysisResult> {
  return flights.run(deps.store, blockId, fingerprint(deps.store, blockId), (isLatest) => doRun(deps, blockId, isLatest))
}

async function doRun({ store, engine }: { store: Store; engine: EngineClient }, blockId: string, isLatest: () => boolean): Promise<AnalysisResult> {
  const gen = store.generation.value
  const ranAt = store.nowIso()
  const base = { excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt }
  const put = (r: AnalysisResult) => {
    if (isLatest() && store.generation.value === gen && store.nb.value.blocks.some((b) => b.id === blockId)) store.analysis.set(blockId, r)
    return r
  }
  const fail = (code: AnalysisErrorCode, message: string, extra: Partial<AnalysisResult> = {}) =>
    put({ ...base, status: 'error', error: { code, message }, ...extra })

  const block = store.nb.value.blocks.find((b) => b.id === blockId)
  if (!block) return { ...base, status: 'error', error: { code: 'NO_SOURCE', message: t('analysis.err.NO_SOURCE') } }
  const cfg = normalizeAnalysis(block.metadata)
  const dataName = typeof block.metadata?.data === 'string' ? block.metadata.data : ''
  const src = resolveSource(store, dataName)
  if ('error' in src) return fail(src.error.code, t(`analysis.err.${src.error.code}`))
  const common = { sourceExecutedAt: src.executedAt, partial: src.partial }

  if (!cfg.pivot) return put({ ...base, ...common, status: 'ok' })
  const pivot = cfg.pivot

  const have = new Set(src.columns.map((c) => c.name))
  const wanted = [...pivot.rows.map((r) => r.field), ...pivot.columns.map((c) => c.field), ...pivot.values.filter((v) => v.field !== '').map((v) => v.field)]
  const missing = [...new Set(wanted.filter((f) => !have.has(f)))]
  if (missing.length) return fail('BAD_FIELD', t('analysis.err.BAD_FIELD', { fields: missing.join(', ') }), common)

  const agg = buildAggregateSql(src.name, pivot, src.columns)
  if (isErr(agg)) {
    if (agg.error.code === 'EMPTY') return put({ ...base, ...common, status: 'empty' })
    const code: AnalysisErrorCode = agg.error.code === 'BAD_FIELD' ? 'BAD_FIELD' : 'SQL'
    return fail(code, t(`analysis.err.${code}`, { fields: agg.error.field ?? '', message: agg.error.message }), common)
  }

  const exc = buildExcludedCountSql(src.name, pivot, src.columns)
  if (exc !== null && isErr(exc)) return fail('SQL', t('analysis.err.SQL', { message: exc.error.message, fields: '' }), common)

  try {
    const reregister = async () => {
      engine.invalidate()
      await engine.ensureRegistered(src.name, src.block, src.run)
    }
    await engine.ensureRegistered(src.name, src.block, src.run)
    const q = <T>(sql: string) => withReregister(() => engine.query(sql, MAX_POINTS), reregister) as Promise<T>
    const main = await q<Awaited<ReturnType<EngineClient['query']>>>(agg.sql)
    const toRows = (qq: AggregateQuery, rows: unknown[][]): Rows => ({ dims: qq.dims, measures: qq.measures, rows })
    let excludedDateRows = 0
    if (exc) {
      const r = await q<Awaited<ReturnType<EngineClient['query']>>>(exc.sql)
      const n = Number(r.rows[0]?.[0])
      excludedDateRows = Number.isFinite(n) ? n : 0
    }
    const tooManyPoints = main.truncated || main.rows.length > MAX_POINTS
    return put({
      ...base, ...common, status: 'ok', excludedDateRows, tooManyPoints,
      ...(tooManyPoints ? {} : { long: toRows(agg, main.rows) }),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail('ENGINE', t('analysis.err.ENGINE', { message: e instanceof EngineError ? e.message : msg, fields: '' }), common)
  }
}
