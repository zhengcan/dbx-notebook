import type { ChartOptions, PivotConfig } from '@sqlnb/format'
import { resolveLabels, type LabelCtx, type LabelTarget } from './labelResolve'
import { formatValue } from './pivotModel'
import { labelTargetId, parseLabelTargetId } from './labelTargetId'

// Pure, query-free sketch model. Every text comes from resolveLabels/formatValue (the same code the real
// table/chart use); sample categories are only the keys the block already holds. All texts are plain text.
// The sketch shows up to MAX_ROW_FIELDS row and MAX_COL_FIELDS column fields in the table; the chart sketch
// (ticks, series) uses row field 0 / the column tuples. Not sketched: tooltip and export (see labelAffects).
type Cfg = { pivot: PivotConfig; chart: ChartOptions }
export interface Item { text: string; active: boolean; ns?: number[] }
export interface SampleCategories { rows?: unknown[][]; columns?: unknown[][] }
export interface PreviewModel {
  header: { cells: (Item & { role: 'rowName' | 'columnName' | 'measureName'; index: number })[]; summary: Item }
  table: {
    groups: { keys: unknown[]; parts: Item[] }[]
    rows: { keys: unknown[]; heads: Item[]; cells: Item[] }[]
    totals: { label: Item; cells: Item[] }
  }
  chart: { title: Item; axisX: Item; axisY: Item; legend: Item; ticks: Item[]; yTicks: Item[]; series: Item[] }
}

const CAP = 3
const MAX_ROW_FIELDS = 2
const MAX_COL_FIELDS = 2
const MAX_GROUPS = 2
const MAX_GROUPS_MULTI = 3
export const Y_TICK_FRACTIONS = [1, 0.5]
const PLACEHOLDER: unknown[] = ['A', 'B', 'C']
const SAMPLE = [1234567, 765432, 98765]
const PCT = [0.4321, 0.2468, 0.1357]
export const sampleValue = (kind: string, row: number): number => (kind === 'percent' ? PCT : SAMPLE)[row % 3]

// Keys the dialog numbered for one ref, lowest number first (only used when the map has category entries).
function numberedKeys(numbers: ReadonlyMap<string, number> | undefined, axis: 'row' | 'column', index: number): string[] | null {
  if (!numbers) return null
  let any = false
  const found: [number, string][] = []
  for (const [id, n] of numbers) {
    if (!id.startsWith('category:')) continue
    any = true
    const t = parseLabelTargetId(id)
    if (t?.kind === 'category' && t.axis === axis && t.index === index) found.push([n, t.key])
  }
  return any ? found.sort((a, b) => a[0] - b[0]).map((f) => f[1]) : null
}

function sampleKeys(src: unknown[] | undefined, cfgNull: boolean, active: LabelTarget | null, axis: 'row' | 'column', index: number, numbered: string[] | null = null): unknown[] {
  const keys: unknown[] = []
  const seen = new Set<string>()
  const pool: unknown[] = numbered ? numbered : src && src.length ? src : PLACEHOLDER
  for (const k of pool) {
    if (k === null || k === undefined) continue
    const s = String(k)
    if (seen.has(s)) continue
    seen.add(s); keys.push(k)
    if (keys.length >= CAP) break
  }
  const mine = (active?.kind === 'category' || active?.kind === 'nullLabel') && active.axis === axis && active.index === index
  if (mine && active!.kind === 'category' && !seen.has(active!.key)) keys[keys.length >= CAP ? CAP - 1 : keys.length] = active!.key
  if (cfgNull || (mine && active!.kind === 'nullLabel') || (src && src.some((k) => k === null || k === undefined))) keys.push(null)
  return keys
}

export function buildPreviewModel(cfg: Cfg, ctx: LabelCtx, active: LabelTarget | null, categories: SampleCategories = {}, numbers?: ReadonlyMap<string, number>): PreviewModel {
  const r = resolveLabels(cfg, ctx)
  const rows = (cfg.pivot.rows ?? []).slice(0, MAX_ROW_FIELDS), cols = (cfg.pivot.columns ?? []).slice(0, MAX_COL_FIELDS), values = cfg.pivot.values ?? []
  const a = active
  const is = (k: LabelTarget['kind']) => a?.kind === k
  const idx = (k: LabelTarget['kind'], i: number) => a?.kind === k && (a as { index: number }).index === i
  const axisIs = (x: 'x' | 'y' | 'legend') => a?.kind === 'axis' && a.axis === x
  const catActive = (axis: 'row' | 'column', index: number, raw: unknown) => {
    if (!a || (a.kind !== 'category' && a.kind !== 'nullLabel') || a.axis !== axis || a.index !== index) return false
    return raw === null || raw === undefined ? a.kind === 'nullLabel' : a.kind === 'category' && a.key === String(raw)
  }
  const nulled = (f: { nullLabel?: string } | undefined) => typeof f?.nullLabel === 'string' && f.nullLabel.trim() !== ''

  const numOf = (...ts: LabelTarget[]): { ns?: number[] } => {
    const ns = ts.map((t) => numbers?.get(labelTargetId(t))).filter((n): n is number => typeof n === 'number').sort((x, y) => x - y)
    return ns.length ? { ns } : {}
  }
  const tag = <T extends Item>(item: T, ...ts: LabelTarget[]): T => Object.assign(item, numOf(...ts))

  // badge on the FIRST place a category/null key shows (heads repeat when the other field has more keys)
  const catTargets = (axis: 'row' | 'column', index: number, raw: unknown): LabelTarget =>
    raw === null || raw === undefined ? { kind: 'nullLabel', axis, index } : { kind: 'category', axis, index, key: String(raw) }
  const placed = new Set<string>()
  const catNs = (axis: 'row' | 'column', index: number, raw: unknown): { ns?: number[] } => {
    const t = catTargets(axis, index, raw), id = labelTargetId(t)
    if (placed.has(id)) return {}
    const o = numOf(t)
    if (o.ns) placed.add(id)
    return o
  }
  const header: PreviewModel['header']['cells'] = [
    ...r.rowNames.map((text, i) => ({ text, active: idx('rowName', i), role: 'rowName' as const, index: i, ...numOf({ kind: 'rowName', index: i }) })),
    ...r.columnNames.map((text, i) => ({ text, active: idx('columnName', i), role: 'columnName' as const, index: i, ...numOf({ kind: 'columnName', index: i }) })),
    ...r.measureNames.map((text, i) => ({ text, active: idx('measureName', i), role: 'measureName' as const, index: i, ...numOf({ kind: 'measureName', index: i }) })),
  ]

  const rowSamples = rows.map((f, i) => sampleKeys(categories.rows?.[i], nulled(f), a, 'row', i, numberedKeys(numbers, 'row', i)))
  const colSamples = cols.map((f, i) => sampleKeys(categories.columns?.[i], nulled(f), a, 'column', i, numberedKeys(numbers, 'column', i)))
  const rowN = Math.max(0, ...rowSamples.map((ks) => ks.length))
  const rowTuples = Array.from({ length: rowN }, (_, ri) => rowSamples.map((ks) => ks[ri % ks.length]))
  const groupCap = colSamples.length > 1 ? MAX_GROUPS_MULTI : MAX_GROUPS
  // the null key (always last) must stay visible so the null label can be shown/highlighted
  const fit = (ks: unknown[]) => (ks.length > groupCap ? [...ks.slice(0, groupCap - 1), ks[ks.length - 1]] : ks)
  const colFit = colSamples.map(fit)
  const groupN = colFit.length ? Math.max(...colFit.map((ks) => ks.length)) : 1
  const groupTuples: unknown[][] = Array.from({ length: groupN }, (_, gi) => colFit.map((ks) => ks[gi % ks.length]))
  const groups = cols.length
    ? groupTuples.map((keys) => ({ keys, parts: keys.map((k, f) => ({ text: r.category('column', f, k), active: catActive('column', f, k), ...catNs('column', f, k) })) }))
    : []

  const kindOf = (m: number) => r.format(m).kind
  const unitScale = (m: number) => idx('unit', m) || idx('scale', m)
  const cell = (m: number, v: number, extra = false): Item => ({ text: formatValue(v, r.format(m)), active: unitScale(m) || extra })
  const seenUnit = new Set<number>()
  const tableRows = rowTuples.map((keys, ri) => ({
    keys,
    heads: keys.map((k, f) => ({ text: r.category('row', f, k), active: catActive('row', f, k), ...catNs('row', f, k) })),
    cells: groupTuples.flatMap(() => values.map((_v, m) => (ri === 0 && !seenUnit.has(m) ? (seenUnit.add(m), tag(cell(m, sampleValue(kindOf(m), ri)), { kind: 'unit', index: m }, { kind: 'scale', index: m })) : cell(m, sampleValue(kindOf(m), ri))))),
  }))
  const sum = (m: number): number => rowTuples.reduce<number>((s, _k, ri) => s + sampleValue(kindOf(m), ri), 0)
  const totalCells = groupTuples.flatMap(() => values.map((_v, m) => cell(m, sum(m), idx('measureName', m))))

  const series: Item[] = cols.length
    ? groups.map((g) => ({ text: g.parts.map((p) => p.text).join(' / '), active: g.parts.some((p) => p.active) }))
    : r.measureNames.map((text, i) => ({ text, active: idx('measureName', i) }))
  const tickKeys = rowSamples.length ? rowSamples[0] : []
  const topTick = values.length ? sampleValue(kindOf(0), 0) : 0

  return {
    header: { cells: header, summary: { text: r.summary, active: is('summary') } },
    table: { groups, rows: tableRows, totals: { label: tag({ text: r.summary, active: is('summary') }, { kind: 'summary' }), cells: totalCells } },
    chart: {
      title: tag({ text: r.title, active: is('title') }, { kind: 'title' }),
      axisX: tag({ text: r.axis.x, active: axisIs('x') || idx('rowName', 0) }, { kind: 'axis', axis: 'x' }),
      axisY: tag({ text: r.axis.y, active: axisIs('y') || is('measureName') || (r.measureNames.length === 1 && idx('unit', 0)) }, { kind: 'axis', axis: 'y' }),
      legend: tag({ text: r.axis.legend, active: axisIs('legend') || idx('columnName', 0) }, { kind: 'axis', axis: 'legend' }),
      ticks: tickKeys.map((k) => ({ text: r.category('row', 0, k), active: catActive('row', 0, k) })),
      yTicks: values.length ? Y_TICK_FRACTIONS.map((f) => ({ text: formatValue(topTick * f, r.format(0)), active: idx('scale', 0) })) : [],
      series,
    },
  }
}
