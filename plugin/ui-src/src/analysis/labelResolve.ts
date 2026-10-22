import type { ChartOptions, FieldRef, NumberFormat, PivotConfig } from '@sqlnb/format'

// Pure display-label resolution (no Vue/DOM). Everything returned is PLAIN TEXT: render it as text
// (never v-html) and escape it in exports. This layer only produces display text/format
// descriptors; sorting, totals, summaries and TSV raw copy must keep using RAW values and never
// consume anything returned from category()/format() as data.
export interface LabelCtx { empty: string; summary: string }
export interface ResolvedLabels {
  rowNames: string[]; columnNames: string[]; measureNames: string[]
  summary: string; title: string
  axis: { x: string; y: string; legend: string }
  category(axis: 'row' | 'column', index: number, raw: unknown): string
  format(measureIndex: number): NumberFormat
}
type Cfg = { pivot: PivotConfig; chart: ChartOptions }

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const own = (o: object | undefined, k: string): string | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? text((o as Record<string, unknown>)[k]) : undefined

function build(cfg: Cfg, ctx: LabelCtx, useOverrides: boolean): ResolvedLabels {
  const ov = <T>(v: T | undefined): T | undefined => (useOverrides ? v : undefined)
  const { pivot, chart } = cfg
  const rows = pivot.rows ?? [], cols = pivot.columns ?? [], values = pivot.values ?? []
  const rowNames = rows.map((r) => text(ov(r.label)) ?? r.field)
  const columnNames = cols.map((r) => text(ov(r.label)) ?? r.field)
  const measureNames = values.map((v) => text(ov(v.label)) ?? (v.field ? `${v.agg}(${v.field})` : v.agg))
  const formats: NumberFormat[] = values.map((v) => {
    const f: NumberFormat = { ...(v.format ?? { kind: 'thousands' }) }
    if (!useOverrides) { delete f.unit; delete f.scale }
    if (f.kind === 'percent') delete f.scale
    if (text(f.unit) === undefined) delete f.unit
    return f
  })
  const at = ov(chart.axisTitles)
  const unit0 = formats.length === 1 ? formats[0].unit : undefined
  const yAuto = measureNames.length === 0 ? '' : measureNames.length === 1 ? measureNames[0] + (unit0 ? `（${unit0}）` : '') : 'value'  // multi-measure: same 'value' title vegaSpec uses today (buildSpec long form)
  const refOf = (axis: 'row' | 'column', i: number): FieldRef | undefined => (axis === 'row' ? rows : cols)[i]
  return {
    rowNames, columnNames, measureNames,
    summary: text(ov(pivot.summaryLabel)) ?? ctx.summary,
    title: text(ov(chart.title)) ?? '',
    axis: {
      x: text(at?.x) ?? rowNames[0] ?? '',
      y: text(at?.y) ?? yAuto,
      legend: text(at?.legend) ?? columnNames[0] ?? '',
    },
    // Value-mapping key is String(raw): number 1 and string "1" intentionally collide.
    category(axis, index, raw) {
      const ref = useOverrides ? refOf(axis, index) : undefined
      if (raw === null || raw === undefined) return text(ref?.nullLabel) ?? ctx.empty
      const s = String(raw)
      return own(ref?.valueLabels, s) ?? s
    },
    format(i) { return formats[i] ? { ...formats[i] } : { kind: 'thousands' } },
  }
}

export const resolveLabels = (cfg: Cfg, ctx: LabelCtx): ResolvedLabels => build(cfg, ctx, true)
export const autoLabels = (cfg: Cfg, ctx: LabelCtx): ResolvedLabels => build(cfg, ctx, false)

export type LabelTarget =
  | { kind: 'rowName' | 'columnName'; index: number }
  | { kind: 'measureName'; index: number }
  | { kind: 'summary' } | { kind: 'title' }
  | { kind: 'axis'; axis: 'x' | 'y' | 'legend' }
  | { kind: 'unit' | 'scale'; index: number }
  | { kind: 'category'; axis: 'row' | 'column'; index: number; key: string }
  | { kind: 'nullLabel'; axis: 'row' | 'column'; index: number }

export function isOverridden(cfg: Cfg, target: LabelTarget): boolean {
  const { pivot, chart } = cfg
  switch (target.kind) {
    case 'rowName': return text(pivot.rows?.[target.index]?.label) !== undefined
    case 'columnName': return text(pivot.columns?.[target.index]?.label) !== undefined
    case 'measureName': return text(pivot.values?.[target.index]?.label) !== undefined
    case 'summary': return text(pivot.summaryLabel) !== undefined
    case 'title': return text(chart.title) !== undefined
    case 'axis': return text(chart.axisTitles?.[target.axis]) !== undefined
    case 'unit': return text(pivot.values?.[target.index]?.format?.unit) !== undefined
    case 'scale': {
      const f = pivot.values?.[target.index]?.format
      return !!f && f.kind !== 'percent' && f.scale !== undefined
    }
    case 'category': return own((target.axis === 'row' ? pivot.rows : pivot.columns)?.[target.index]?.valueLabels, target.key) !== undefined
    case 'nullLabel': return text((target.axis === 'row' ? pivot.rows : pivot.columns)?.[target.index]?.nullLabel) !== undefined
  }
}
