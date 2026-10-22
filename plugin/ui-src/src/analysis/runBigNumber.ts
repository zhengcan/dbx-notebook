import type { useNotebookStore } from '../state/notebookStore'
import { t } from '../i18n'
import { EngineError, withReregister, type EngineClient } from '../run/engineClient'
import { resolveSource, type ResolvedSource } from './source'
import { buildBigNumberSql, buildCompareSql } from './sql'
import { createFlights } from './flights'
import { normalizeBigNumber, isKnownAggregate, type Metric } from './bigNumberConfig'
import type { BigNumberResult, BigNumberItem, BigNumberErrorCode, BigNumberCompare } from './analysisState'

type Store = ReturnType<typeof useNotebookStore>
const shiftMonth = (ym: string, kind: 'mom' | 'yoy'): string => {
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7))
  if (kind === 'yoy') return `${String(y - 1).padStart(4, '0')}-${ym.slice(5, 7)}`
  return m === 1 ? `${String(y - 1).padStart(4, '0')}-12` : `${String(y).padStart(4, '0')}-${String(m - 1).padStart(2, '0')}`
}
const delta = (cur: unknown, prev: unknown): number | null => {
  if (typeof cur !== 'number' || typeof prev !== 'number' || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null
  const d = (cur - prev) / Math.abs(prev)
  return Number.isFinite(d) ? d : null
}

export async function computeMetric(deps: { engine: EngineClient }, src: ResolvedSource, m: Metric): Promise<BigNumberItem> {
  const { engine } = deps
  const reregister = async () => {
    engine.invalidate()
    await engine.ensureRegistered(src.name, src.block, src.run)
  }
  {
    const { field, aggregate } = m
    const err = (code: BigNumberErrorCode, message: string): BigNumberItem => ({ value: null, error: { code, message } })
    if (aggregate !== undefined && !isKnownAggregate(aggregate)) return err('BAD_AGG', t('bn.err.BAD_AGG', { aggregate }))
    const isCount = aggregate === undefined ? field === '' : aggregate === 'count' && field === ''
    if (field === '' && !isCount) return err('NO_FIELD', t('bn.err.NO_FIELD'))
    if (field !== '' && !src.columns.some((c) => c.name === field)) return err('BAD_FIELD', t('bn.err.BAD_FIELD', { field }))
    const q = buildBigNumberSql(src.name, { field, aggregate, filter: m.filter }, src.columns)
    const sqlErr = (e: { code: string; message: string }): BigNumberItem => {
      const code: BigNumberErrorCode = e.code === 'TYPE' ? 'TYPE' : e.code === 'BAD_FIELD' ? 'BAD_FIELD'
        : e.code === 'FILTER' ? 'FILTER' : e.code === 'COMPARE' ? 'COMPARE' : 'SQL'
      return err(code, t(`bn.err.${code}`, { field, aggregate: aggregate ?? '', message: e.message }))
    }
    if ('error' in q) return sqlErr(q.error)
    const cmp = m.compare === undefined ? undefined : buildCompareSql(src.name, { field, aggregate, filter: m.filter, compare: m.compare }, src.columns)
    if (cmp && 'error' in cmp) return sqlErr(cmp.error)
    const scalar = async (sql: string) => (await withReregister(() => engine.query(sql, 1), reregister)).rows[0]?.[0] ?? null
    try {
      const value = await scalar(q.sql)
      if (!cmp) return { value }
      const cur = await scalar(cmp.periodSql)
      if (typeof cur !== 'string' || !/^\d{4}-\d{2}$/.test(cur))
        return { value, info: { code: 'COMPARE_NO_DATES' } }
      const kind = m.compare!.kind as 'mom' | 'yoy'
      const prev = shiftMonth(cur, kind)
      const [currentValue, previousValue] = await Promise.all([scalar(cmp.valueSql(cur)), scalar(cmp.valueSql(prev))])
      const compare: BigNumberCompare = { kind, current: cur, previous: prev, currentValue, previousValue, deltaPct: delta(currentValue, previousValue) }
      return { value, compare }
    } catch (e) {
      const msg = e instanceof EngineError ? e.message : e instanceof Error ? e.message : String(e)
      return err('ENGINE', t('bn.err.ENGINE', { message: msg }))
    }
  }
}

const flights = createFlights<BigNumberResult>()

function fingerprint(store: Store, blockId: string): string {
  const b = store.nb.value.blocks.find((x) => x.id === blockId)
  const c = normalizeBigNumber(b?.metadata)
  return JSON.stringify([c.data, c.metrics.map((x) => [x.field, x.aggregate, x.filter ?? null, x.compare ?? null])])
}

export function runBigNumber(deps: { store: Store; engine: EngineClient }, blockId: string): Promise<BigNumberResult> {
  return flights.run(deps.store, blockId, fingerprint(deps.store, blockId), (isLatest) => doRun(deps, blockId, isLatest))
}

async function doRun({ store, engine }: { store: Store; engine: EngineClient }, blockId: string, isLatest: () => boolean): Promise<BigNumberResult> {
  const gen = store.generation.value
  const ranAt = store.nowIso()
  const base = { value: null, items: [] as BigNumberItem[], partial: false, ranAt }
  const put = (r: BigNumberResult) => {
    if (isLatest() && store.generation.value === gen && store.nb.value.blocks.some((b) => b.id === blockId)) store.bigNumbers.set(blockId, r)
    return r
  }
  const fail = (code: BigNumberErrorCode, message: string, extra: Partial<BigNumberResult> = {}) =>
    put({ ...base, status: 'error', error: { code, message }, ...extra })

  const block = store.nb.value.blocks.find((b) => b.id === blockId)
  if (!block) return { ...base, status: 'error', error: { code: 'NO_SOURCE', message: t('bn.err.NO_SOURCE') } }
  const cfg = normalizeBigNumber(block.metadata)
  const src = resolveSource(store, cfg.data)
  if ('error' in src) return fail(src.error.code, t(`bn.err.${src.error.code}`))
  const common = { sourceExecutedAt: src.executedAt, partial: src.partial }

  try { await engine.ensureRegistered(src.name, src.block, src.run) } catch (e) {
    return fail('ENGINE', t('bn.err.ENGINE', { message: e instanceof Error ? e.message : String(e) }), common)
  }

  const items = await Promise.all(cfg.metrics.map((m) => computeMetric({ engine }, src, m)))
  const allFailed = items.every((i) => i.error)
  return put({
    ...base, ...common, items, value: items[0]?.value ?? null,
    status: allFailed ? 'error' : 'ok',
    ...(allFailed && items[0]?.error ? { error: items[0].error } : {}),
  })
}
