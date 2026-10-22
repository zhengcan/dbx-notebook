// Screen-only hover enhancement. Applied to the render spec right before compiling, only when the caller asks for it (ChartView);
// the export / PDF / AI-preview paths never call it, so their output stays static and the portable spec is never touched.
export const HOVER_RANK = '__sqlnb_rank'
const HOVER_KEY = '__sqlnb_hk'
const SERIES_PREFIX = '__sqlnb_s'
const PARAM = '__sqlnb_hover'
export const HOVER_MAX_SERIES = 10
export interface HoverTheme { rule: string; stroke: string }

type Def = Record<string, any>
const markType = (m: any): string | undefined => (typeof m === 'string' ? m : m?.type)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const validNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// Scatter: an invisible 16px-diameter point layer carries the tooltip (symbol size is the area of the bounding square).
function enhanceScatter(spec: Def, layers: Def[] | null): Def {
  const out = clone(spec)
  const ls: Def[] = layers ? out.layer : [{ mark: out.mark, encoding: out.encoding }]
  const base = ls[0]
  const tip = base.encoding?.tooltip
  if (!tip) return spec
  const { tooltip: _t, ...enc } = base.encoding
  base.encoding = enc
  ls.push({ mark: { type: 'point', filled: true, opacity: 0, size: 256, aria: false }, encoding: { ...enc, tooltip: tip } })
  if (layers) return out
  const { mark: _m, encoding: _e, ...rest } = out
  return { ...rest, layer: ls }
}

function enhanceSeries(spec: Def, data: unknown[], theme: HoverTheme, layers: Def[] | null): { spec: Def; data: unknown[] } {
  const out = clone(spec)
  const ls: Def[] = layers ? out.layer : [{ mark: out.mark, encoding: out.encoding }]
  const base = ls[0]
  const enc = base.encoding ?? {}
  const x: Def | undefined = enc.x
  const y: Def | undefined = enc.y
  const tips: Def[] | undefined = Array.isArray(enc.tooltip) ? enc.tooltip : undefined
  if (!x?.field || !y?.field || !tips) return { spec, data }
  const xField: string = x.field
  const valueField: string = y.field
  const seriesField: string | undefined = enc.color?.field

  const ruleTransform: Def[] = [{ filter: `isValid(datum[${JSON.stringify(valueField)}])` }]
  let tooltip: Def[] = tips
  let outData = data
  if (seriesField) {
    const names: string[] = []
    const index = new Map<string, number>()
    for (const r of data as Def[]) {
      const n = String(r?.[seriesField])
      if (!index.has(n)) { index.set(n, names.length); names.push(n) }
    }
    const byX = new Map<string, { name: string; v: number; i: number }[]>()
    let seq = 0
    for (const r of data as Def[]) {
      if (!validNum(r?.[valueField])) continue
      const k = String(r[xField])
      let a = byX.get(k)
      if (!a) byX.set(k, (a = []))
      a.push({ name: String(r[seriesField]), v: r[valueField], i: seq++ })
    }
    const rank = new Map<string, string>()
    for (const [k, a] of byX) rank.set(k, JSON.stringify([...a].sort((p, q) => q.v - p.v || p.i - q.i).map((e) => e.name)))
    outData = (data as Def[]).map((r) => (validNum(r?.[valueField])
      ? { ...r, [HOVER_KEY]: `${SERIES_PREFIX}${index.get(String(r[seriesField]))}`, [HOVER_RANK]: rank.get(String(r[xField])) }
      : r))
    const xTip = tips.find((d) => d.field === xField) ?? { field: xField, type: x.type, title: x.title }
    const mTip = tips.find((d) => d.field !== xField && d.field !== seriesField)
    if (!mTip) return { spec, data }
    const groupby = [xField, HOVER_RANK]
    const sortField = x.sort?.field
    if (typeof sortField === 'string' && !groupby.includes(sortField)) groupby.push(sortField)
    ruleTransform.push({ pivot: HOVER_KEY, value: mTip.field, groupby, op: 'max' })
    tooltip = [
      xTip,
      ...names.map((n, i) => ({ ...mTip, field: `${SERIES_PREFIX}${i}`, title: n })),
      { field: HOVER_RANK, type: 'nominal', title: HOVER_RANK },
    ]
  }

  const { tooltip: _t, ...encNoTip } = enc
  base.encoding = encNoTip
  // `fill` (not `color`) with legend:null: a null legend on the shared `color` channel would drop the chart's own legend, and a second legend would appear otherwise.
  const dotColor = enc.color ? { fill: { ...enc.color, legend: null } } : {}
  ls.push(
    {
      transform: ruleTransform,
      mark: { type: 'rule', color: theme.rule, strokeWidth: 1, aria: false },
      params: [{ name: PARAM, select: { type: 'point', fields: [xField], nearest: true, on: 'mousemove', clear: 'mouseout' } }],
      encoding: { x: clone(x), opacity: { condition: { param: PARAM, empty: false, value: 0.6 }, value: 0 }, tooltip },
    },
    {
      transform: [{ filter: { param: PARAM, empty: false } }],
      mark: { type: 'point', filled: true, size: 70, opacity: 1, stroke: theme.stroke, strokeWidth: 1.5, aria: false },
      encoding: { x: clone(x), y: clone(y), ...dotColor },
    },
  )
  if (layers) return { spec: out, data: outData }
  const { mark: _m, encoding: _e, ...rest } = out
  return { spec: { ...rest, layer: ls }, data: outData }
}

export function enhanceHover(spec: any, data: unknown[], theme: HoverTheme): { spec: any; data: unknown[] } {
  if (!spec || typeof spec !== 'object') return { spec, data }
  const layers: Def[] | null = Array.isArray(spec.layer) ? spec.layer : null
  const base: Def | undefined = layers ? layers[0] : spec
  const mt = markType(base?.mark)
  if (mt === 'point') return { spec: enhanceScatter(spec, layers), data }
  if (mt === 'line' || mt === 'area') return enhanceSeries(spec, data, theme, layers)
  return { spec, data }
}

// Tooltip text lines for a Vega tooltip value. A value carrying the rank entry is a multi-series hover: x line first, then the
// series in rank order (value descending), at most HOVER_MAX_SERIES of them, then a "N more" line.
export function hoverLines(value: Record<string, unknown>, more: (n: number) => string): string[] {
  const rankRaw = value[HOVER_RANK]
  const keys = Object.keys(value).filter((k) => k !== HOVER_RANK)
  const plain = () => keys.map((k) => `${k}: ${value[k]}`)
  if (typeof rankRaw !== 'string') return plain()
  let names: unknown
  try { names = JSON.parse(rankRaw) } catch { return plain() }
  if (!Array.isArray(names) || !keys.length) return plain()
  const lines = [`${keys[0]}: ${value[keys[0]]}`]
  const shown = names.map(String).filter((n) => value[n] != null)
  for (const n of shown.slice(0, HOVER_MAX_SERIES)) lines.push(`${n}: ${value[n]}`)
  if (shown.length > HOVER_MAX_SERIES) lines.push(more(shown.length - HOVER_MAX_SERIES))
  return lines
}
