import { renderRowShape, mapsX, hasDisplayText, X_RAW_FIELD, VALUE_TEXT_FIELD, type ChartOptions, type Grain, type PivotConfig, type ValueSpec, type ColumnInfo } from '@sqlnb/format'
import { t } from '../i18n'
import type { Rows } from './analysisState'
import type { ResolvedLabels } from './labelResolve'
import { formatValue } from './pivotModel'

export interface ChartLabels { empty: string; measure: (v: ValueSpec) => string }

export function chartMeasureLabel(v: ValueSpec): string {
  if (v.label) return v.label
  return v.field ? t('ab.measure', { agg: t(`fp.agg.${v.agg}`), field: v.field }) : t('ab.measureCount')
}
const defaultLabels = (): ChartLabels => ({ empty: t('pivot.empty'), measure: chartMeasureLabel })

// Labels are read straight off the ISO bucket string the engine's date_trunc returns (it keeps the input's
// shape and does no timezone conversion); a Date is rendered via toISOString and a non-ISO string passes through unchanged.
// Known limitation: if the engine returns the same day in two shapes ('2026-03-07 10:00:00' vs '2026-03-07T00:00:00')
// as separate groups, compact shows two ticks with the same label. They are deliberately NOT merged here because
// merging pre-aggregated rows would double count non-additive aggregates (avg, median, countDistinct).
export function compactTimeLabel(x: unknown, grain: Grain | undefined): string | null {
  if (x == null) return null
  const iso = x instanceof Date ? x.toISOString() : String(x)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  switch (grain ?? 'day') {
    case 'year': return m[1]
    case 'quarter': return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`
    case 'month': return `${m[1]}-${m[2]}`
    default: return `${m[1]}-${m[2]}-${m[3]}`
  }
}

const validScale = (v: ValueSpec): number | undefined => {
  const f = v.format
  return f && f.kind !== 'percent' && typeof f.scale === 'number' && Number.isFinite(f.scale) && f.scale > 0 ? f.scale : undefined
}

// Display-only: scale/unit/valueLabels change plotted numbers and category text, never sorting or aggregation (those ran on raw values).
// Two distinct raw keys whose display text collides are disambiguated with their raw key so they never merge into one band/slice.
function categoryMapper(rows: unknown[][], idx: number, resolved: ResolvedLabels, axis: 'row' | 'column', pos: number) {
  const NULL = '\u0000null'
  const keyOf = (raw: unknown) => (raw == null ? NULL : String(raw))
  const byDisplay = new Map<string, Set<string>>()
  for (const r of rows) {
    const raw = r[idx]
    const d = resolved.category(axis, pos, raw)
    const set = byDisplay.get(d) ?? new Set<string>()
    set.add(keyOf(raw))
    byDisplay.set(d, set)
  }
  return (raw: unknown): string => {
    const d = resolved.category(axis, pos, raw)
    return (byDisplay.get(d)?.size ?? 0) > 1 ? `${d} (${raw == null ? 'null' : String(raw)})` : d
  }
}

export function toHistogramRows(raw: Record<string, unknown>[], pivot: PivotConfig, chart: ChartOptions, columns: ColumnInfo[]): Record<string, unknown>[] {
  void chart
  const v = pivot.values.find((s) => s.field && columns.find((c) => c.name === s.field)?.kind === 'number')
  const sc = v ? validScale(v) : undefined
  if (!v || sc === undefined) return raw
  return raw.map((r) => {
    const n = r[v.field]
    const num = n == null ? null : Number(n)
    return { ...r, [v.field]: num !== null && Number.isFinite(num) ? num / sc : null }
  })
}

export function toChartRows(long: Rows, pivot: PivotConfig, chart: ChartOptions, columns: ColumnInfo[], labelsArg: ChartLabels | ResolvedLabels = defaultLabels()): Record<string, unknown>[] {
  const resolved = 'category' in labelsArg ? labelsArg : undefined
  const labels: ChartLabels = resolved
    ? { empty: resolved.category('row', 0, null), measure: (v) => resolved.measureNames[pivot.values.indexOf(v)] ?? chartMeasureLabel(v) }
    : (labelsArg as ChartLabels)
  const shape = renderRowShape({ pivot, chart, columns })
  const nr = pivot.rows.length
  const nc = pivot.columns.length
  const used = shape.firstMeasureOnly ? pivot.values.slice(0, 1) : pivot.values
  const multi = used.length > 1
  const catX = !!resolved && !shape.compact && (shape.xType === 'nominal' || shape.xType === 'ordinal')
  const sortRaw = !!resolved && mapsX({ pivot, chart, columns })
  const rowMap = resolved ? pivot.rows.map((_, i) => categoryMapper(long.rows, i, resolved, 'row', i)) : []
  const colMap = resolved ? pivot.columns.map((_, i) => categoryMapper(long.rows, nr + i, resolved, 'column', i)) : []
  const lbl = (v: unknown) => (v == null ? labels.empty : String(v))
  const out: Record<string, unknown>[] = []
  for (const row of long.rows) {
    let x: unknown
    if (shape.combineX) x = row.slice(0, nr).map((v, i) => (resolved ? rowMap[i](v) : lbl(v))).join(' / ')
    else if (row[0] == null) x = shape.xType === 'temporal' || shape.compact || shape.xType === 'quantitative' ? null : resolved ? rowMap[0](null) : labels.empty
    else x = catX ? rowMap[0](row[0]) : row[0]
    const cols = shape.useColumns ? row.slice(nr, nr + nc).map((v, i) => (resolved ? colMap[i](v) : lbl(v))) : []
    used.forEach((v, i) => {
      const val = row[nr + nc + i]
      const parts = multi ? [...cols, labels.measure(v)] : cols
      const sc = validScale(v)
      let value: number | null = val == null ? null : Number(val)
      if (sc !== undefined) value = value !== null && Number.isFinite(value) ? value / sc : null
      const o: Record<string, unknown> = { x, value }
      if (sortRaw) o[X_RAW_FIELD] = shape.combineX ? row.slice(0, nr).map((r) => (r == null ? '' : String(r))).join(' / ') : row[0] ?? undefined
      if (hasDisplayText(v)) o[VALUE_TEXT_FIELD] = val == null ? '' : formatValue(Number(val), v.format ?? { kind: 'thousands' })
      if (shape.compact) {
        const xl = compactTimeLabel(x, pivot.rows[0].grain)
        if (xl === null) return
        o.xLabel = xl
      }
      if (parts.length) o.series = parts.join(' · ')
      out.push(o)
    })
  }
  return out
}
