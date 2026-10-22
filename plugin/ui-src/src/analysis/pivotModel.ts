import type { Agg, NumberFormat, PivotConfig, Summary } from '@sqlnb/format'
import { escapeTsvCell } from '../blocks/grid/copy'
import { t } from '../i18n'
import type { AnalysisResult } from './analysisState'
import type { ResolvedLabels } from './labelResolve'

export const EMPTY_LABEL = '（空）'
export const MAX_PIVOT_ROWS = 5000
export const MAX_PIVOT_COLUMNS = 500

export interface PivotLabels { empty: string; summary: string }
export interface PivotModel {
  rowHeaders: string[]
  columnHeaders: string[][]
  cells: (number | null)[][]
  rowLabels: string[][]
  rowTotals?: (number | null)[][]
  columnTotals?: (number | null)[]
  grandTotal?: (number | null)[]
  measures: { label: string; format: NumberFormat; summary?: Summary }[]
  truncated: { rows: boolean; columns: boolean }
  // Only with opts.resolved: raw keys behind the (possibly mapped) labels, and the summary text.
  rowKeys?: unknown[][]
  columnKeys?: unknown[][]
  summaryLabel?: string
}

const defaultLabels = (): PivotLabels => ({ empty: t('pivot.empty'), summary: t('pivot.summary') })

const rank = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? 0 : typeof v === 'string' ? 1 : 2)
function cmpKey(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 0) {
    const x = a as number | bigint, y = b as number | bigint
    if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = String(a), y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}
function cmpTuple(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) { const c = cmpKey(a[i], b[i]); if (c) return c }
  return 0
}
const tkey = (k: unknown[]) => JSON.stringify(k, (_, v) => (typeof v === 'bigint' ? `\u0000bigint:${v}` : v))
const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? null : n
}

function measureOf(cfg: PivotConfig) {
  return cfg.values.map((v) => ({
    label: v.label || (v.field ? `${v.agg}(${v.field})` : v.agg),
    format: v.format ?? { kind: 'thousands' as const },
    summary: v.summary ?? DEFAULT_SUMMARY[v.agg],
  }))
}

export const DEFAULT_SUMMARY: Record<Agg, Summary> = { sum: 'sum', count: 'sum', countDistinct: 'sum', avg: 'avg', min: 'min', max: 'max', median: 'median' }

export function summarize(vals: (number | null)[], how: Summary | undefined): number | null {
  if (how === 'none' || how === undefined) return null
  const xs = vals.filter((v): v is number => v != null)
  if (how === 'count') return xs.length
  if (!xs.length) return null
  switch (how) {
    case 'sum': return xs.reduce((a, b) => a + b, 0)
    case 'avg': return xs.reduce((a, b) => a + b, 0) / xs.length
    case 'min': return Math.min(...xs)
    case 'max': return Math.max(...xs)
    default: {
      const o = [...xs].sort((a, b) => a - b), h = o.length >> 1
      return o.length % 2 ? o[h] : (o[h - 1] + o[h]) / 2
    }
  }
}

export function buildPivotModel(res: AnalysisResult, cfg: PivotConfig, opts?: { labels?: Partial<PivotLabels>; resolved?: ResolvedLabels }): PivotModel {
  const rv = opts?.resolved
  const labels = { ...defaultLabels(), ...opts?.labels }
  const nr = cfg.rows.length, nc = cfg.columns.length, nm = cfg.values.length
  const measures = measureOf(cfg)
  if (rv) measures.forEach((m, i) => { m.label = rv.measureNames[i] ?? m.label; m.format = rv.format(i) })
  const model: PivotModel = {
    rowHeaders: rv ? [...rv.rowNames] : cfg.rows.map((r) => r.field), columnHeaders: [], cells: [], rowLabels: [], measures,
    truncated: { rows: false, columns: false },
  }
  if (res.status !== 'ok' || !res.long || !res.long.rows.length) return model
  const lab = (v: unknown) => (v == null ? labels.empty : String(v))
  const labAt = (axis: 'row' | 'column') => (v: unknown, i: number) => (rv ? rv.category(axis, i, v) : lab(v))

  const rowKeys = new Map<string, unknown[]>(), colKeys = new Map<string, unknown[]>()
  const data = new Map<string, (number | null)[]>()
  for (const row of res.long.rows) {
    const rk = row.slice(0, nr), ck = row.slice(nr, nr + nc)
    rowKeys.set(tkey(rk), rk); colKeys.set(tkey(ck), ck)
    data.set(tkey(rk) + '|' + tkey(ck), row.slice(nr + nc, nr + nc + nm).map(num))
  }
  let rows = [...rowKeys.values()].sort(cmpTuple)
  const sort = cfg.sort
  if (sort && nr > 0) {
    const dir = sort.dir === 'desc' ? -1 : 1
    const groups = new Map<string, unknown[][]>()
    for (const r of rows) {
      const g = tkey([r[0]])
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(r)
    }
    let order = [...groups.values()]
    if (sort.by === 'name') {
      order.sort((a, b) => (a[0][0] == null || b[0][0] == null ? cmpKey(a[0][0], b[0][0]) : dir * cmpKey(a[0][0], b[0][0])))
    } else {
      const vi = sort.valueIndex ?? 0
      const how = measures[vi]?.summary === 'none' || !measures[vi]?.summary ? DEFAULT_SUMMARY[cfg.values[vi]?.agg ?? 'sum'] : measures[vi].summary
      const score = (g: unknown[][]): number | null => {
        const vals: (number | null)[] = []
        for (const r of g) for (const ck of colKeys.keys()) vals.push(data.get(tkey(r) + '|' + ck)?.[vi] ?? null)
        if (vals.length === 1) return vals[0]
        return summarize(vals, how === 'count' ? 'sum' : how)
      }
      const sc = new Map(order.map((g) => [g, score(g)]))
      order.sort((a, b) => {
        const x = sc.get(a), y = sc.get(b)
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
        return x === y ? 0 : x < y ? -dir : dir
      })
    }
    rows = order.flat()
  }
  if (rows.length > MAX_PIVOT_ROWS) { rows = rows.slice(0, MAX_PIVOT_ROWS); model.truncated.rows = true }
  let cols = [...colKeys.values()].sort(cmpTuple)
  if (cols.length > MAX_PIVOT_COLUMNS) { cols = cols.slice(0, MAX_PIVOT_COLUMNS); model.truncated.columns = true }

  model.rowLabels = rows.map((r) => r.map(labAt('row')))
  model.columnHeaders = cols.flatMap((c) => measures.map((m) => [...c.map(labAt('column')), m.label]))
  if (rv) {
    model.rowKeys = rows
    model.columnKeys = cols.flatMap((c) => measures.map(() => c))
    model.summaryLabel = rv.summary
  }
  model.cells = rows.map((r) => cols.flatMap((c) => {
    const v = data.get(tkey(r) + '|' + tkey(c))
    return measures.map((_, i) => v?.[i] ?? null)
  }))
  const tot = cfg.totals
  const sm = (vals: (number | null)[], i: number) => summarize(vals, measures[i].summary)
  const inCol = (cells: (number | null)[], i: number) => cells.filter((_, k) => k % nm === i)
  if (tot?.row && nc > 0) model.rowTotals = model.cells.map((cs) => measures.map((_, i) => sm(inCol(cs, i), i)))
  if (tot?.column && nr > 0) model.columnTotals = model.columnHeaders.map((_, k) => sm(model.cells.map((cs) => cs[k]), k % nm))
  if (tot?.grand && nr > 0 && nc > 0) model.grandTotal = measures.map((_, i) => sm(model.cells.flatMap((cs) => inCol(cs, i)), i))
  return model
}

function roundAbs(x: number, d: number): number {
  const s = String(x)
  if (s.includes('e')) return Number(x.toFixed(d))
  return Number(Math.round(Number(s + 'e' + d)) + 'e-' + d)
}

export function formatValue(v: number | null, f: NumberFormat): string {
  if (v == null || !Number.isFinite(v)) return ''
  const pct = f.kind === 'percent'
  const sc = !pct && typeof f.scale === 'number' && Number.isFinite(f.scale) && f.scale > 0 ? f.scale : 1
  const unit = typeof f.unit === 'string' ? f.unit : ''
  let x = pct ? v * 100 : v / sc
  const suffix = (pct ? '%' : '') + unit
  if (Math.abs(x) >= 1e21) return String(x) + suffix
  const explicit = f.decimals != null
  const d = Math.min(6, Math.max(0, Math.trunc(f.decimals ?? (pct ? 1 : 2))))
  const neg = x < 0
  const r = roundAbs(Math.abs(x), d)
  let s = r.toFixed(d)
  if (!explicit && !pct && s.includes('.')) s = s.replace(/\.?0+$/, '')
  let [int, frac] = s.split('.')
  if (f.kind === 'thousands') int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = frac ? `${int}.${frac}` : int
  return (neg && r !== 0 ? '-' : '') + body + suffix
}

export function toTsv(model: PivotModel, opts?: { withHeader?: boolean; withFormat?: boolean; labels?: Partial<PivotLabels> }): string {
  if (!model.rowLabels.length) return ''
  const labels = { ...defaultLabels(), ...(model.summaryLabel ? { summary: model.summaryLabel } : {}), ...opts?.labels }
  const nm = model.measures.length
  const cell = (v: number | null, m: number) => (v == null ? '' : opts?.withFormat ? formatValue(v, model.measures[m].format) : String(v))
  const lines: string[] = []
  const join = (cells: string[]) => cells.map(escapeTsvCell).join('\t')
  const rh = model.rowHeaders.length || 1
  if (opts?.withHeader !== false) {
    const levels = model.columnHeaders[0]?.length ?? 1
    for (let l = 0; l < levels; l++) {
      const head = Array.from({ length: rh }, (_, i) => (l === levels - 1 ? model.rowHeaders[i] ?? '' : ''))
      const body = model.columnHeaders.map((h) => h[l] ?? '')
      const tail = model.rowTotals || model.grandTotal ? model.measures.map((m) => (l === levels - 1 ? `${labels.summary} ${m.label}` : l === 0 ? labels.summary : '')) : []
      lines.push(join([...head, ...body, ...tail]))
    }
  }
  model.cells.forEach((row, i) => {
    const lab = model.rowLabels[i]
    const cells = [...Array.from({ length: rh }, (_, k) => lab[k] ?? ''), ...row.map((v, k) => cell(v, k % nm))]
    if (model.rowTotals) cells.push(...model.rowTotals[i].map((v, k) => cell(v, k)))
    else if (model.grandTotal) cells.push(...model.measures.map(() => ''))
    lines.push(join(cells))
  })
  if (model.columnTotals || model.grandTotal) {
    const cells = [labels.summary, ...Array.from({ length: rh - 1 }, () => '')]
    if (model.columnTotals) cells.push(...model.columnTotals.map((v, k) => cell(v, k % nm)))
    else cells.push(...model.cells[0].map(() => ''))
    if (model.rowTotals || model.grandTotal) cells.push(...(model.grandTotal ?? model.measures.map(() => null)).map((v, k) => cell(v, k)))
    lines.push(join(cells))
  }
  return lines.join('\n')
}
