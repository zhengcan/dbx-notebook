import { normalizeAnalysis, buildRenderSpec, type Block, type ColumnInfo } from '@sqlnb/format'
import type { useNotebookStore } from '../state/notebookStore'
import { buildPivotModel, formatValue } from '../analysis/pivotModel'
import type { BigNumberCompare } from '../analysis/analysisState'
import { normalizeBigNumber } from '../analysis/bigNumberConfig'
import { resolveSource } from '../analysis/source'
import { toChartRows, toHistogramRows } from '../analysis/chartRows'
import { resolveLabels } from '../analysis/labelResolve'
import { t } from '../i18n'
import { cellText } from '../blocks/grid/format'
import type { ExportOptions } from './options'
import { autoColumnBreaks, effectiveRepeat } from './autoBreaks'

type Store = ReturnType<typeof useNotebookStore>

export interface ColumnGroup { cols: number[] }
export interface TableSection {
  kind: 'table'; blockId: string; title?: string; sql?: string
  columns: string[]; rows: string[][]; nullMask: boolean[][]
  totalRows: number; shownRows: number
  limitedNote: 'first-n' | 'truncated-at-run' | null
  groups: ColumnGroup[]; numeric: boolean[]
  // Transposed view: `columns` are #1…#N, `rows` hold one entry per original column, labelled by `rowNames`.
  transposed?: boolean; rowNames?: string[]
  // Where the automatic width-based pagination breaks; used unless the block has manual breaks.
  autoBreaks?: number[]
  // Leading columns repeated on every column page (auto mode may reduce the requested number).
  repeat?: number
}
export interface PivotModelText {
  rowHeaders: string[]
  columnHeaders: string[][]
  rowLabels: string[][]
  cells: string[][]
  rowTotals?: string[][]
  columnTotals?: string[]
  grandTotal?: string[]
  measures: string[]
  summaryLabel?: string
}
export interface PivotSection { kind: 'pivot'; blockId: string; title?: string; model: PivotModelText }
export interface ChartSection { kind: 'chart'; blockId: string; title?: string; spec: object; rows: unknown[]; usesRawRows: boolean }
export interface BigNumberSection { kind: 'big-number'; blockId: string; items: { label: string; text: string; compare?: string }[] }
/** `html` is the pre-rendered markup with images embedded (set by runExport); absent = render `source` without images. */
export interface MarkdownSection { kind: 'markdown'; blockId: string; source: string; html?: string }
export interface InputSection { kind: 'input'; blockId: string; name: string; text: string }
export type Section = InputSection | MarkdownSection | TableSection | PivotSection | ChartSection | BigNumberSection
export interface SkippedBlock { blockId: string; label: string; reason: 'no-result' | 'error' | 'chart-failed' }
export interface CatalogEntry { blockId: string; type: Block['type']; label: string; included: boolean; table?: TableSection }
export interface ExportModel {
  documentTitle: string
  exportedAt: string
  runTimes: { blockId: string; index: number; name: string; at: string }[]
  dataSources: string[]
  note: string
  exporter: string | null
  sections: Section[]
  catalog: CatalogEntry[]
  skipped: SkippedBlock[]
  staleBlockIds: string[]
  estimate: { totalRows: number; bigTables: { blockId: string; rows: number }[] }
  exportable: boolean
}

const BIG_TABLE_ROWS = 5000

export function suggestColumnBreaks(columnCount: number, parts: number): number[] {
  const p = Math.min(Math.max(1, Math.trunc(parts) || 1), Math.max(1, columnCount))
  const out: number[] = []
  for (let i = 1; i < p; i++) {
    const b = Math.ceil((columnCount * i) / p) - 1
    if (b >= 0 && b < columnCount - 1 && (out.length === 0 || b > out[out.length - 1])) out.push(b)
  }
  return out
}

function groupsOf(columnCount: number, breaks: number[] | undefined): ColumnGroup[] {
  const cuts = [...new Set((breaks ?? []).filter((b) => Number.isInteger(b) && b >= 0 && b < columnCount - 1))].sort((a, b) => a - b)
  const groups: ColumnGroup[] = []
  let start = 0
  for (const c of [...cuts, columnCount - 1]) {
    if (c >= start) groups.push({ cols: Array.from({ length: c - start + 1 }, (_, i) => start + i) })
    start = c + 1
  }
  return groups.length ? groups : [{ cols: [] }]
}

export const TRANSPOSE_MAX_ROWS = 20

const cellStr = (v: unknown) => (typeof v === 'bigint' ? v.toString() : cellText(v))
const label = (b: Block) => {
  const m = b.metadata as Record<string, unknown> | undefined
  const n = typeof m?.resultName === 'string' && m.resultName ? m.resultName : typeof m?.title === 'string' && m.title ? m.title : ''
  return n || b.id
}
const inputText = (v: unknown): string => (Array.isArray(v) ? v.map(cellStr).join(', ') : v === undefined || v === null || v === '' ? '' : cellStr(v))
const fmtNum = (v: number | null, f: Parameters<typeof formatValue>[1]) => formatValue(v, f)

export function buildExportModel(input: {
  store: Pick<Store, 'nb' | 'runs' | 'analysis' | 'bigNumbers' | 'isStale' | 'isPartial' | 'transposed'>
  options: ExportOptions
  now: Date
  documentTitle?: string
  exporter?: string | null
  dataSourceName: (block: Block) => string | undefined
  labels?: { empty: string; summary: string; compare?: (c: BigNumberCompare) => string }
}): ExportModel {
  const { store, options, now } = input
  const nb = store.nb.value
  const built: Section[] = []
  const isInc = (id: string) => options.blocks?.[id]?.include !== false
  let cur = ''
  const skipped: SkippedBlock[] = []
  const staleIds: string[] = []
  const sources: string[] = []
  const bigTables: { blockId: string; rows: number }[] = []
  let totalRows = 0
  const runTimes: ExportModel['runTimes'] = []
  const indexOf = new Map(nb.blocks.map((x, i) => [x.id, i + 1]))
  const noteRun = (src: Block, iso: string | undefined) => {
    if (!isInc(cur) || !iso || runTimes.some((r) => r.blockId === src.id)) return
    runTimes.push({ blockId: src.id, index: indexOf.get(src.id) ?? 0, name: label(src), at: iso })
  }
  const skip = (b: Block, reason: SkippedBlock['reason']) => isInc(b.id) && skipped.push({ blockId: b.id, label: label(b), reason })
  const noteSource = (b: Block) => {
    if (!options.header.dataSource || !isInc(cur)) return
    const n = input.dataSourceName(b)
    if (n && !sources.includes(n)) sources.push(n)
  }
  const markStale = (id: string) => { if (isInc(id) && store.isStale(id)) staleIds.push(id) }

  for (const b of nb.blocks) {
    cur = b.id
    const meta = (b.metadata ?? {}) as Record<string, unknown>
    if (b.type === 'input') {
      if (options.filtersLine && typeof meta.variable === 'string' && meta.variable) built.push({ kind: 'input', blockId: b.id, name: meta.variable, text: inputText(meta.value) })
    } else if (b.type === 'markdown') {
      built.push({ kind: 'markdown', blockId: b.id, source: b.content ?? '' })
    } else if (b.type === 'sql') {
      const run = store.runs.get(b.id)
      if (!run || run.status === 'idle' || run.status === 'running') { skip(b, 'no-result'); continue }
      if (run.status === 'error' || !run.result) { skip(b, 'error'); continue }
      const r = run.result
      const limit = options.rowLimit
      const all = r.rows
      const shown = limit === 'all' ? all : all.slice(0, limit)
      const limitedNote: TableSection['limitedNote'] = shown.length < all.length ? 'first-n' : r.truncated ? 'truncated-at-run' : null
      const origCols = r.columns.map((c) => c.name)
      const mode = options.blocks?.[b.id]?.transpose ?? 'follow'
      const eligible = origCols.length >= 1 && shown.length >= 1 && shown.length <= TRANSPOSE_MAX_ROWS
      const transposed = eligible && (mode === 'on' || (mode === 'follow' && store.transposed.get(b.id) === true))
      const isNull = (v: unknown) => v === null || v === undefined
      let columns: string[], rows: string[][], nullMask: boolean[][], numeric: boolean[]
      let rowNames: string[] | undefined
      if (transposed) {
        columns = shown.map((_, i) => `#${i + 1}`)
        rows = origCols.map((_, c) => shown.map((row) => cellStr(row[c])))
        nullMask = origCols.map((_, c) => shown.map((row) => isNull(row[c])))
        numeric = columns.map(() => false)
        rowNames = origCols
      } else {
        columns = origCols
        rows = shown.map((row) => columns.map((_, i) => cellStr(row[i])))
        nullMask = shown.map((row) => columns.map((_, i) => isNull(row[i])))
        numeric = columns.map((_, i) => {
          let any = false
          for (const row of shown) {
            const v = row[i]
            if (isNull(v)) continue
            if (typeof v !== 'number' && typeof v !== 'bigint') return false
            any = true
          }
          return any
        })
      }
      const autoInput = {
        columns, rows, orientation: options.orientation, repeatCols: options.repeatCols,
        leading: rowNames ? { kind: 'name' as const, names: rowNames } : { kind: 'serial' as const, rowCount: rows.length },
      }
      const autoBreaks = autoColumnBreaks(autoInput)
      const manual = options.columnBreaks[b.id]
      const sec: TableSection = {
        kind: 'table', blockId: b.id, columns, rows, nullMask,
        totalRows: all.length, shownRows: shown.length, limitedNote,
        groups: groupsOf(columns.length, manual ?? autoBreaks), numeric, autoBreaks,
        repeat: manual ? options.repeatCols : effectiveRepeat(autoInput),
      }
      if (transposed) { sec.transposed = true; sec.rowNames = rowNames }
      const title = typeof meta.resultName === 'string' && meta.resultName ? meta.resultName : undefined
      if (title) sec.title = title
      if (options.includeSql) sec.sql = b.content ?? ''
      built.push(sec)
      if (isInc(b.id)) totalRows += shown.length
      if (isInc(b.id) && shown.length > BIG_TABLE_ROWS) bigTables.push({ blockId: b.id, rows: shown.length })
      noteRun(b, run.executedAt)
      noteSource(b)
      markStale(b.id)
    } else if (b.type === 'chart') {
      const cfg = normalizeAnalysis(meta)
      const data = typeof meta.data === 'string' ? meta.data : ''
      const src = resolveSource(store, data)
      const legacy = cfg.pivot === null && typeof meta.spec === 'object' && meta.spec !== null
      if ('error' in src) { skip(b, 'no-result'); continue }
      if (legacy) {
        const rr = src.run.result!
        const rows = rr.rows.map((row) => Object.fromEntries(rr.columns.map((c, i) => [c.name, row[i]])))
        built.push({ kind: 'chart', blockId: b.id, spec: meta.spec as object, rows, usesRawRows: true })
        noteRun(src.block, src.executedAt); noteSource(src.block); markStale(b.id)
        continue
      }
      const res = store.analysis.get(b.id)
      if (!cfg.pivot || !res) { skip(b, 'no-result'); continue }
      if (res.status === 'error') { skip(b, 'error'); continue }
      if (res.status !== 'ok') { skip(b, 'no-result'); continue }
      const labelCtx = { empty: input.labels?.empty ?? t('pivot.empty'), summary: input.labels?.summary ?? t('pivot.summary') }
      const resolved = resolveLabels({ pivot: cfg.pivot, chart: cfg.chart }, labelCtx)
      const pm = buildPivotModel(res, cfg.pivot, { labels: labelCtx, resolved })
      const wantTable = cfg.view !== 'chart'
      const wantChart = cfg.view !== 'table'
      if (wantTable) {
        const fm = (cells: (number | null)[], off: number) => cells.map((v, k) => fmtNum(v, pm.measures[(k + off) % pm.measures.length].format))
        const text: PivotModelText = {
          rowHeaders: pm.rowHeaders, columnHeaders: pm.columnHeaders, rowLabels: pm.rowLabels,
          cells: pm.cells.map((cs) => fm(cs, 0)),
          measures: pm.measures.map((m) => m.label),
        }
        if (pm.rowTotals) text.rowTotals = pm.rowTotals.map((cs) => fm(cs, 0))
        if (pm.columnTotals) text.columnTotals = fm(pm.columnTotals, 0)
        if (pm.grandTotal) text.grandTotal = fm(pm.grandTotal, 0)
        if (pm.summaryLabel !== undefined) text.summaryLabel = pm.summaryLabel
        const ps: PivotSection = { kind: 'pivot', blockId: b.id, model: text }
        if (cfg.chart.title) ps.title = cfg.chart.title
        built.push(ps)
      }
      if (wantChart) {
        const columns = src.columns as ColumnInfo[]
        const spec = buildRenderSpec({ pivot: cfg.pivot, chart: cfg.chart, columns })
        if ('error' in spec) { skip(b, 'chart-failed'); if (!wantTable) continue }
        else {
          const rr = src.run.result!
          const rows = spec.usesRawRows
            ? toHistogramRows(rr.rows.map((row) => Object.fromEntries(rr.columns.map((c, i) => [c.name, row[i]]))), cfg.pivot, cfg.chart, columns)
            : res.long ? toChartRows(res.long, cfg.pivot, cfg.chart, columns, resolved) : []
          const cs: ChartSection = { kind: 'chart', blockId: b.id, spec: spec.spec, rows, usesRawRows: spec.usesRawRows }
          if (cfg.chart.title) cs.title = cfg.chart.title
          built.push(cs)
        }
      }
      noteRun(src.block, src.executedAt); noteSource(src.block); markStale(b.id)
    } else if (b.type === 'big-number') {
      const cfg = normalizeBigNumber(meta)
      const res = store.bigNumbers.get(b.id)
      if (!res) { skip(b, 'no-result'); continue }
      if (res.status === 'error') { skip(b, 'error'); continue }
      const items = cfg.metrics.map((m, i) => {
        const v = res.items[i]?.value
        const lab = m.label || m.field || ''
        const text = typeof v === 'number' ? formatValue(v, m.format ?? { kind: 'plain' }) || String(v) : cellStr(v)
        const cmp = res.items[i]?.compare
        const item: { label: string; text: string; compare?: string } = { label: lab, text }
        if (cmp && input.labels?.compare) item.compare = input.labels.compare(cmp)
        return item
      })
      built.push({ kind: 'big-number', blockId: b.id, items })
      const src = resolveSource(store, cfg.data)
      if (!('error' in src)) { noteRun(src.block, src.executedAt); noteSource(src.block) }
      markStale(b.id)
    }
  }

  const byId = new Map(nb.blocks.map((b) => [b.id, b]))
  const catalog: CatalogEntry[] = []
  for (const s of built) {
    if (catalog.some((c) => c.blockId === s.blockId)) continue
    const b = byId.get(s.blockId)!
    const lab = b.type === 'input' ? String((b.metadata as Record<string, unknown>)?.variable ?? b.id) : b.type === 'markdown' ? ((b.content ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? b.id).slice(0, 60) : label(b)
    const entry: CatalogEntry = { blockId: b.id, type: b.type, label: lab, included: isInc(b.id) }
    if (s.kind === 'table') entry.table = s
    catalog.push(entry)
  }
  const sections = built.filter((s) => isInc(s.blockId))

  return {
    documentTitle: input.documentTitle ?? '',
    exportedAt: now.toISOString(),
    runTimes: runTimes.sort((a, b) => a.index - b.index),
    dataSources: sources,
    note: options.note,
    exporter: options.header.exporter && input.exporter?.trim() ? input.exporter.trim() : null,
    sections,
    catalog,
    skipped,
    staleBlockIds: staleIds,
    estimate: { totalRows, bigTables },
    exportable: sections.some((s) => s.kind !== 'input'),
  }
}
