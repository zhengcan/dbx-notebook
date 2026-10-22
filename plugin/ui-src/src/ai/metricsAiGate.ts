import type { Block } from '@sqlnb/format'
import type { Capabilities } from '../host/bridge'
import type { AiSendOptions } from './aiSettings'
import type { useNotebookStore, BlockRunState } from '../state/notebookStore'
import type { LocalTable, MetricCandidate } from './parseMetrics'
import { candidateToMetric } from './parseMetrics'
import { resultNameOf } from '../run/deps'
import { columnKind } from '../analysis/sql'
import { resolveSource } from '../analysis/source'
import { computeMetric } from '../analysis/runBigNumber'
import { compareText } from '../analysis/compareText'
import { formatValue } from '../analysis/pivotModel'
import { t, type MessageKey } from '../i18n'
import type { EngineClient } from '../run/engineClient'

type Store = ReturnType<typeof useNotebookStore>

export type MetricsGate = { enabled: true } | { enabled: false; reason: 'no-schema-setting' | 'no-tables' | 'ai-busy' | 'unsupported' }

export function metricsAiGate(input: { caps: Capabilities; send: AiSendOptions; tables: number; busy: boolean }): MetricsGate {
  if (input.caps.aiCompletion !== true) return { enabled: false, reason: 'unsupported' }
  if (!input.send.schema) return { enabled: false, reason: 'no-schema-setting' }
  if (input.tables <= 0) return { enabled: false, reason: 'no-tables' }
  if (input.busy) return { enabled: false, reason: 'ai-busy' }
  return { enabled: true }
}

export interface LocalTableData extends LocalTable { block: Block; run: BlockRunState; executedAt?: string; partial: boolean }

export function listLocalTables(store: Pick<Store, 'nb' | 'runs' | 'isPartial'>): LocalTableData[] {
  const seen = new Set<string>()
  const out: LocalTableData[] = []
  for (const block of store.nb.value.blocks) {
    if (block.type !== 'sql') continue
    const name = resultNameOf(block)
    if (!name || seen.has(name.toLowerCase())) continue
    const run = store.runs.get(block.id)
    if (!run || run.status !== 'ok' || !run.result) continue
    seen.add(name.toLowerCase())
    const rows = run.result.rows
    const columns = run.result.columns.map((c, i) => ({
      name: c.name,
      kind: columnKind(c.dataType, rows.find((r) => r[i] !== null && r[i] !== undefined)?.[i]),
    }))
    out.push({ name, columns, block, run, executedAt: run.executedAt, partial: run.result.truncated === true || store.isPartial(block.id) })
  }
  return out
}

export const tableSignature = (tables: LocalTable[]): string =>
  JSON.stringify(tables.map((x) => [x.name, x.columns.map((c) => [c.name, c.kind])]))

export interface Preview { text: string | null; compare?: string; error?: string }

export async function previewCandidate(deps: { store: Store; engine: EngineClient }, c: MetricCandidate, isAlive: () => boolean): Promise<Preview> {
  try {
    const gen = deps.store.generation.value
    const src = resolveSource(deps.store, c.data)
    if ('error' in src) return { text: null, error: t(`bn.err.${src.error.code}` as MessageKey) }
    try { await deps.engine.ensureRegistered(src.name, src.block, src.run) } catch (e) {
      return { text: null, error: t('bn.err.ENGINE', { message: e instanceof Error ? e.message : String(e) }) }
    }
    if (!isAlive() || deps.store.generation.value !== gen) return { text: null }
    const m = candidateToMetric(c)
    const it = await computeMetric(deps, src, m)
    if (!isAlive() || deps.store.generation.value !== gen) return { text: null }
    if (it.error) return { text: null, error: it.error.message }
    const v = it.value
    const text = v === null || v === undefined ? '—' : typeof v === 'number' ? formatValue(v, m.format ?? { kind: 'plain' }) || String(v) : String(v)
    const info = it.info ? t(('bn.info.' + it.info.code) as MessageKey) : undefined
    const compare = it.compare ? compareText(it.compare, t as (k: string, p?: Record<string, unknown>) => string) : info
    return { text, ...(compare !== undefined ? { compare } : {}) }
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : String(e) }
  }
}
