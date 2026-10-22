import type { ChartOptions, ColumnInfo, Grain, PivotConfig, ValueSpec } from '@sqlnb/format'
import { buildRenderSpec, normalizeAnalysis } from '@sqlnb/format'
import type { Capabilities } from '../host/bridge'
import type { AiSendOptions } from './aiSettings'
import type { ChartCandidate, ChartConfig } from './parse'
import { loadVega, type VegaRuntime } from '../analysis/vegaRuntime'
import { toChartRows } from '../analysis/chartRows'
import { columnKind } from '../analysis/sql'
import { vegaConfig, type ThemeTokens } from '../analysis/theme'
import type { Rows } from '../analysis/analysisState'
import { t } from '../i18n'

export type ChartAiGate = { enabled: true } | { enabled: false; reason: 'no-data-setting' | 'no-source' | 'empty-source' | 'ai-busy' | 'unsupported' }

export function chartAiGate(input: { caps: Capabilities; send: AiSendOptions; source: { columns: string[]; rows: unknown[][] } | null; busy: boolean }): ChartAiGate {
  if (input.caps.aiCompletion !== true) return { enabled: false, reason: 'unsupported' }
  if (!input.source) return { enabled: false, reason: 'no-source' }
  if (input.source.rows.length === 0) return { enabled: false, reason: 'empty-source' }
  if (!input.send.data) return { enabled: false, reason: 'no-data-setting' }
  if (input.busy) return { enabled: false, reason: 'ai-busy' }
  return { enabled: true }
}

type SourceCol = string | { name: string; dataType?: string }
const MAX_PREVIEW_GROUPS = 2000

function truncateDate(v: unknown, grain: Grain | undefined): unknown {
  if (!grain || v == null) return v
  const s = v instanceof Date ? v.toISOString() : String(v)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const [, y, mo, d] = m
  if (grain === 'year') return `${y}-01-01`
  if (grain === 'quarter') return `${y}-${String(Math.floor((Number(mo) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`
  if (grain === 'month') return `${y}-${mo}-01`
  if (grain === 'week') {
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
    return dt.toISOString().slice(0, 10)
  }
  return `${y}-${mo}-${d}`
}

function aggregate(vals: unknown[], v: ValueSpec, rowCount: number): number | null {
  if (v.field === '' && v.agg === 'count') return rowCount
  const present = vals.filter((x) => x !== null && x !== undefined)
  if (v.agg === 'count') return present.length
  if (v.agg === 'countDistinct') return new Set(present.map((x) => String(x))).size
  const nums = present.map(Number).filter((n) => Number.isFinite(n))
  if (!nums.length) return null
  if (v.agg === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (v.agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
  if (v.agg === 'min') return Math.min(...nums)
  if (v.agg === 'max') return Math.max(...nums)
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const cmp = (a: unknown, b: unknown): number => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

// Pure in-memory aggregation of the block's existing result rows (no engine/model call); preview only.
export function localAggregate(source: { columns: ColumnInfo[]; rows: unknown[][] }, pivot: PivotConfig): Rows {
  const idx = new Map(source.columns.map((c, i) => [c.name, i]))
  const dimRefs = [...pivot.rows, ...pivot.columns]
  const groups = new Map<string, { key: unknown[]; rows: unknown[][] }>()
  for (const row of source.rows) {
    const key = dimRefs.map((r) => {
      const v = row[idx.get(r.field) ?? -1]
      const kind = source.columns.find((c) => c.name === r.field)?.kind
      return kind === 'temporal' ? truncateDate(v, r.grain) : v
    })
    const k = JSON.stringify(key)
    let g = groups.get(k)
    if (!g) {
      if (groups.size >= MAX_PREVIEW_GROUPS) continue
      groups.set(k, (g = { key, rows: [] }))
    }
    g.rows.push(row)
  }
  const out = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) { const c = cmp(a.key[i], b.key[i]); if (c) return c }
    return 0
  }).map((g) => [...g.key, ...pivot.values.map((v) => aggregate(g.rows.map((r) => r[idx.get(v.field) ?? -1]), v, g.rows.length))])
  return { dims: dimRefs.map((_, i) => `d${i}`), measures: pivot.values.map((_, i) => `__sqlnb_v${i}`), rows: out }
}

import { LABEL_FRACTION, labelFontSize, wrapTitle } from './chartSizing'
export interface PreviewOpts { vega?: () => Promise<VegaRuntime>; tokens?: ThemeTokens; dark?: boolean; width?: number; height?: number; large?: boolean }
const FALLBACK_TOKENS: ThemeTokens = { background: '#ffffff', foreground: '#1a1a1a', mutedForeground: '#555', border: '#d0d0d0' }

export async function renderCandidatePreview(source: { columns: SourceCol[]; rows: unknown[][] }, c: ChartCandidate, opts: PreviewOpts = {}): Promise<{ svg: string | null; error?: string }> {
  let chart: Awaited<ReturnType<VegaRuntime['render']>> | null = null
  try {
    const cols: ColumnInfo[] = source.columns.map((col, i) => {
      const name = typeof col === 'string' ? col : col.name
      const sample = source.rows.find((r) => r[i] != null)?.[i]
      return { name, kind: columnKind(typeof col === 'string' ? undefined : col.dataType, sample) }
    })
    const { pivot, chartOptions } = c.config
    const built = buildRenderSpec({ pivot, chart: chartOptions as ChartOptions, columns: cols })
    if ('error' in built) return { svg: null, error: String(built.error) }
    const rows = built.usesRawRows
      ? source.rows.map((r) => Object.fromEntries(cols.map((col, i) => [col.name, r[i]])))
      : toChartRows(localAggregate({ columns: cols, rows: source.rows }, pivot), pivot, chartOptions as ChartOptions, cols)
    const rt = await (opts.vega ?? loadVega)()
    const width = opts.width ?? 320
    const el = document.createElement('div')
    const spec = JSON.parse(JSON.stringify(built.spec))
    const config: any = vegaConfig(opts.tokens ?? FALLBACK_TOKENS, opts.dark ? 'dark' : 'light', width)
    if (opts.large) {
      spec.autosize = { type: 'fit', contains: 'padding' }
      config.axis = { ...config.axis, labelLimit: 0 }
      if (c.config.chartOptions.type === 'barHorizontal') {
        const cap = Math.floor(width * LABEL_FRACTION)
        const ci = cols.findIndex((x) => x.name === pivot.rows[0]?.field)
        const longest = ci < 0 ? 0 : source.rows.reduce((m, r) => Math.max(m, String(r[ci] ?? '').length), 0)
        config.axisY = { ...config.axisY, labelOverlap: false, labelLimit: cap, labelFontSize: labelFontSize(cap, longest) }
      }
      config.title = { ...config.title, limit: width - 8, anchor: 'middle', align: 'center', frame: 'bounds' }
      if (typeof spec.title === 'string') spec.title = wrapTitle(spec.title, width - 8)
      config.legend = { ...config.legend, labelLimit: 0 }
    }
    chart = await rt.render(el, spec, rows, { width, height: opts.height ?? 180, config })
    return { svg: await chart.svg() }
  } catch (e) {
    return { svg: null, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try { chart?.destroy() } catch { /* ignore */ }
  }
}

const refs = (f: { field: string; grain?: string }[]) => f.map((x) => (x.grain ? `${x.field} (${x.grain})` : x.field)).join(', ')
const vals = (v: ValueSpec[]) => v.map((x) => (x.field ? `${x.agg}(${x.field})` : 'count(*)') + (x.label ? ` as "${x.label}"` : '')).join(', ')

export interface ChartSummaryRow { key: 'type' | 'rows' | 'columns' | 'values' | 'stacking' | 'timeAxis' | 'title' | 'totals'; text: string }

export function describeChart(cfg: { pivot: PivotConfig | null; chartOptions: ChartOptions }): ChartSummaryRow[] {
  const p = cfg.pivot ?? { rows: [], columns: [], values: [] }
  const o = cfg.chartOptions
  return [
    { key: 'type', text: o.type },
    { key: 'rows', text: refs(p.rows) },
    { key: 'columns', text: refs(p.columns) },
    { key: 'values', text: vals(p.values) },
    { key: 'stacking', text: o.stacking ?? '' },
    { key: 'timeAxis', text: o.timeAxis ?? '' },
    { key: 'title', text: o.title ?? '' },
    { key: 'totals', text: (['row', 'column', 'grand'] as const).filter((k) => p.totals?.[k] === true).join(', ') },
  ]
}

export function fallbackSummary(c: ChartConfig): string {
  const d = describeChart({ pivot: c.pivot, chartOptions: c.chartOptions })
  const of = (k: ChartSummaryRow['key']) => d.find((r) => r.key === k)?.text || '—'
  return t('ai.chart.autoSummary', { type: of('type'), rows: of('rows'), columns: of('columns'), values: of('values') })
}

export type { ChartConfig }

// The single final config: what the preview renders and exactly what Apply writes. Chart-related keys the AI
// did not propose are explicitly cleared (undefined is dropped by normalizeAnalysis); data/view/other metadata are untouched.
export function chartApplyPatch(cfg: ChartConfig): { pivot: Partial<PivotConfig>; chartOptions: Partial<ChartOptions> } {
  return {
    pivot: { ...cfg.pivot, sort: cfg.pivot.sort ?? null, totals: cfg.pivot.totals ?? { row: false, column: false, grand: false } },
    chartOptions: { stacking: undefined, timeAxis: undefined, title: undefined, labels: undefined, bins: undefined, ...cfg.chartOptions },
  }
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

type ChartCfgLike = { pivot: PivotConfig | null; chartOptions: ChartOptions }
export function chartConfigEqual(a: ChartCfgLike, b: ChartCfgLike): boolean {
  if (a.pivot === null || b.pivot === null) return a.pivot === b.pivot
  const na = normalizeAnalysis({ pivot: a.pivot, chartOptions: a.chartOptions })
  const nb = normalizeAnalysis({ pivot: b.pivot, chartOptions: b.chartOptions })
  return canon({ p: na.pivot, c: na.chart }) === canon({ p: nb.pivot, c: nb.chart })
}
