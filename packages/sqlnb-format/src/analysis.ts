export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type Agg = 'sum' | 'count' | 'countDistinct' | 'avg' | 'min' | 'max' | 'median';
export type Summary = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'median' | 'none';
export type View = 'table' | 'chart' | 'both';
export type ChartType = 'line' | 'area' | 'bar' | 'barHorizontal' | 'scatter' | 'pie' | 'donut' | 'histogram';
export type TimeAxis = 'sparse' | 'compact';
export type Stacking = 'none' | 'stacked' | 'grouped' | 'percent';

export interface FieldRef { field: string; grain?: Grain; label?: string; valueLabels?: Record<string, string>; nullLabel?: string }
export interface NumberFormat { kind: 'plain' | 'thousands' | 'percent'; decimals?: number; unit?: string; scale?: number }
export interface ValueSpec { field: string; agg: Agg; label?: string; format?: NumberFormat; summary?: Summary }
export interface PivotConfig {
  rows: FieldRef[];
  columns: FieldRef[];
  values: ValueSpec[];
  totals?: { row?: boolean; column?: boolean; grand?: boolean };
  sort?: { by: 'name' | 'value'; valueIndex?: number; dir: 'asc' | 'desc' } | null;
  summaryLabel?: string;
}
export interface ChartOptions { type: ChartType; stacking?: Stacking; labels?: boolean; title?: string; bins?: number; timeAxis?: TimeAxis; axisTitles?: { x?: string; y?: string; legend?: string } }

export const GRAINS: readonly Grain[] = ['day', 'week', 'month', 'quarter', 'year'];
export const AGGS: readonly Agg[] = ['sum', 'count', 'countDistinct', 'avg', 'min', 'max', 'median'];
export const SUMMARIES: readonly Summary[] = ['sum', 'count', 'avg', 'min', 'max', 'median', 'none'];
export const CHART_TYPES: readonly ChartType[] = ['line', 'area', 'bar', 'barHorizontal', 'scatter', 'pie', 'donut', 'histogram'];
export const VIEWS: readonly View[] = ['table', 'chart', 'both'];
export const TIME_AXES: readonly TimeAxis[] = ['sparse', 'compact'];
export const STACKINGS: readonly Stacking[] = ['none', 'stacked', 'grouped', 'percent'];
const FORMAT_KINDS = ['plain', 'thousands', 'percent'];

export const isGrain = (v: unknown): v is Grain => typeof v === 'string' && (GRAINS as readonly string[]).includes(v);
export const isAgg = (v: unknown): v is Agg => typeof v === 'string' && (AGGS as readonly string[]).includes(v);
export const isSummary = (v: unknown): v is Summary => typeof v === 'string' && (SUMMARIES as readonly string[]).includes(v);
export const isView = (v: unknown): v is View => typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
export const isChartType = (v: unknown): v is ChartType => typeof v === 'string' && (CHART_TYPES as readonly string[]).includes(v);

const MAX_ROWS = 6, MAX_COLS = 3, MAX_VALUES = 8, MAX_NAME = 256, MAX_TITLE = 200;
// New label fields are written/capped at 200 chars; legacy values[].label is still read up to MAX_NAME (256).
export const MAX_LABEL = 200, MAX_UNIT = 20, MAX_VALUE_LABELS = 200, MAX_SCALE = 1e12;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
const set = (o: any, k: string, v: unknown) =>
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

function validName(v: unknown, allowEmpty = false): v is string {
  return typeof v === 'string' && (allowEmpty || v.length > 0) && v.length <= MAX_NAME && !v.includes('\0');
}

function labelStr(raw: unknown, w: string[], what: string, max = MAX_LABEL): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') { w.push(`${what}: not a string, dropped`); return undefined; }
  if (raw.includes('\0')) { w.push(`${what}: invalid characters, dropped`); return undefined; }
  if (raw.trim() === '') return undefined;
  return raw.slice(0, max);
}

function valueLabelMap(raw: unknown, w: string[], what: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { w.push(`${what}: not an object, dropped`); return undefined; }
  const out: Record<string, string> = {};
  let n = 0, over = false;
  for (const k of Object.keys(raw)) {
    const v = own(raw, k);
    if (k.length > MAX_NAME || typeof v !== 'string' || v.includes('\0') || v.trim() === '') continue;
    if (n >= MAX_VALUE_LABELS) { over = true; break; }
    set(out, k, v.slice(0, MAX_LABEL));
    n++;
  }
  if (over) w.push(`${what}: limit ${MAX_VALUE_LABELS} exceeded, extra dropped`);
  return n ? out : undefined;
}

function fieldRefs(raw: unknown, label: string, max: number, w: string[]): FieldRef[] {
  const out: FieldRef[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) { w.push(`${label}: not an array`); return out; }
  const seen = new Set<string>();
  for (const it of raw) {
    if (!isObj(it) || !validName(own(it, 'field'))) { w.push(`${label}: invalid field dropped`); continue; }
    const field = own(it, 'field') as string;
    const g = own(it, 'grain');
    const ref: FieldRef = { field };
    if (g !== undefined) {
      if (isGrain(g)) ref.grain = g; else w.push(`${label}: invalid grain dropped`);
    }
    if (out.length >= max) { w.push(`${label}: limit ${max} exceeded, extra dropped`); break; }
    const lb = labelStr(own(it, 'label'), w, `${label}: label`);
    if (lb !== undefined) ref.label = lb;
    const vl = valueLabelMap(own(it, 'valueLabels'), w, `${label}: valueLabels`);
    if (vl) ref.valueLabels = vl;
    const nl = labelStr(own(it, 'nullLabel'), w, `${label}: nullLabel`);
    if (nl !== undefined) ref.nullLabel = nl;
    const key = JSON.stringify([ref.field, ref.grain ?? null]);
    if (seen.has(key)) { w.push(`${label}: duplicate dropped`); continue; }
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function valueSpecs(raw: unknown, w: string[]): ValueSpec[] {
  const out: ValueSpec[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) { w.push('values: not an array'); return out; }
  const seen = new Set<string>();
  for (const it of raw) {
    if (!isObj(it)) { w.push('values: invalid item dropped'); continue; }
    const agg = own(it, 'agg');
    if (!isAgg(agg)) { w.push('values: invalid agg, value dropped'); continue; }
    const field = own(it, 'field');
    if (!validName(field, agg === 'count')) { w.push('values: invalid field dropped'); continue; }
    const spec: ValueSpec = { field, agg };
    const label = own(it, 'label');
    if (typeof label === 'string' && label.length <= MAX_NAME && !label.includes('\0')) spec.label = label;
    const f = own(it, 'format');
    if (isObj(f)) {
      const kind = own(f, 'kind');
      if (typeof kind === 'string' && FORMAT_KINDS.includes(kind)) {
        const nf: NumberFormat = { kind: kind as NumberFormat['kind'] };
        const d = own(f, 'decimals');
        if (typeof d === 'number' && Number.isFinite(d)) nf.decimals = Math.min(6, Math.max(0, Math.round(d)));
        const sc = own(f, 'scale');
        if (sc !== undefined) {
          if (kind === 'percent') { /* scale ignored for percent */ }
          else if (typeof sc === 'number' && Number.isFinite(sc) && sc > 0 && sc <= MAX_SCALE) nf.scale = sc;
          else w.push('values: invalid scale dropped');
        }
        const un = labelStr(own(f, 'unit'), w, 'values: unit', MAX_UNIT);
        if (un !== undefined) nf.unit = un;
        spec.format = nf;
      } else w.push('values: invalid format dropped');
    }
    const sm = own(it, 'summary');
    if (sm !== undefined) {
      if (isSummary(sm)) spec.summary = sm; else w.push('values: invalid summary dropped');
    }
    if (out.length >= MAX_VALUES) { w.push(`values: limit ${MAX_VALUES} exceeded, extra dropped`); break; }
    const key = JSON.stringify([spec.field, spec.agg, spec.label ?? null, spec.format ?? null, spec.summary ?? null]);
    if (seen.has(key)) { w.push('values: duplicate dropped'); continue; }
    seen.add(key);
    out.push(spec);
  }
  return out;
}

function normPivot(p: Record<string, unknown>, w: string[]): PivotConfig {
  const values = valueSpecs(own(p, 'values'), w);
  const t = own(p, 'totals');
  const totals: { row: boolean; column: boolean; grand: boolean } = { row: false, column: false, grand: false };
  if (isObj(t)) {
    totals.row = own(t, 'row') === true;
    totals.column = own(t, 'column') === true;
    totals.grand = own(t, 'grand') === true;
  }
  let sort: PivotConfig['sort'] = null;
  const s = own(p, 'sort');
  if (s !== undefined && s !== null) {
    const by = own(s as any, 'by'), dir = own(s as any, 'dir');
    if (isObj(s) && (by === 'name' || by === 'value') && (dir === 'asc' || dir === 'desc')) {
      const ns: any = { by, dir };
      const vi = own(s, 'valueIndex');
      if (by === 'value' && typeof vi === 'number' && Number.isInteger(vi) && vi >= 0 && vi < values.length) ns.valueIndex = vi;
      sort = ns;
    } else w.push('sort: invalid, dropped');
  }
  const out: PivotConfig = {
    rows: fieldRefs(own(p, 'rows'), 'rows', MAX_ROWS, w),
    columns: fieldRefs(own(p, 'columns'), 'columns', MAX_COLS, w),
    values,
    totals,
    sort,
  };
  const sl = labelStr(own(p, 'summaryLabel'), w, 'summaryLabel');
  if (sl !== undefined) out.summaryLabel = sl;
  return out;
}

function normChart(raw: unknown, w: string[]): ChartOptions {
  const c: ChartOptions = { type: 'bar' };
  if (raw === undefined) return c;
  if (!isObj(raw)) { w.push('chartOptions: not an object'); return c; }
  const type = own(raw, 'type');
  if (type !== undefined) {
    if (isChartType(type)) c.type = type; else w.push('chartOptions: invalid type, using bar');
  }
  const st = own(raw, 'stacking');
  if (st !== undefined) {
    if (typeof st === 'string' && (STACKINGS as readonly string[]).includes(st)) c.stacking = st as Stacking;
    else w.push('chartOptions: invalid stacking dropped');
  }
  const ta = own(raw, 'timeAxis');
  if (ta !== undefined) {
    if (typeof ta === 'string' && (TIME_AXES as readonly string[]).includes(ta)) c.timeAxis = ta as TimeAxis;
    else w.push('chartOptions: invalid timeAxis dropped');
  }
  const lb = own(raw, 'labels');
  if (typeof lb === 'boolean') c.labels = lb; else if (lb !== undefined) w.push('chartOptions: invalid labels dropped');
  const ti = own(raw, 'title');
  if (typeof ti === 'string') c.title = ti.slice(0, MAX_TITLE); else if (ti !== undefined) w.push('chartOptions: invalid title dropped');
  const bins = own(raw, 'bins');
  if (typeof bins === 'number' && Number.isFinite(bins)) c.bins = Math.min(100, Math.max(2, Math.round(bins)));
  else if (bins !== undefined) w.push('chartOptions: invalid bins dropped');
  const at = own(raw, 'axisTitles');
  if (at !== undefined) {
    if (!isObj(at)) w.push('chartOptions: axisTitles not an object, dropped');
    else {
      const t: { x?: string; y?: string; legend?: string } = {};
      for (const k of ['x', 'y', 'legend'] as const) {
        const v = labelStr(own(at, k), w, `chartOptions: axisTitles.${k}`);
        if (v !== undefined) t[k] = v;
      }
      if (Object.keys(t).length) c.axisTitles = t;
    }
  }
  return c;
}

const MAX_WARNINGS = 20;
function capWarnings(w: string[]): string[] {
  return w.length <= MAX_WARNINGS ? w : [...w.slice(0, MAX_WARNINGS), `… ${w.length - MAX_WARNINGS} more`];
}

export function normalizeAnalysis(raw: unknown): { pivot: PivotConfig | null; view: View; chart: ChartOptions; warnings: string[] } {
  const warnings: string[] = [];
  try {
    return capAll(normalizeInner(raw, warnings));
  } catch {
    return { pivot: null, view: 'both', chart: { type: 'bar' }, warnings: capWarnings([...warnings, 'unexpected error']) };
  }
}

function capAll<T extends { warnings: string[] }>(r: T): T { return { ...r, warnings: capWarnings(r.warnings) }; }

function normalizeInner(raw: unknown, warnings: string[]): { pivot: PivotConfig | null; view: View; chart: ChartOptions; warnings: string[] } {
  {
    if (!isObj(raw)) return { pivot: null, view: 'both', chart: { type: 'bar' }, warnings };
    const p = own(raw, 'pivot');
    const pivot = isObj(p) ? normPivot(p, warnings) : null;
    let view: View = 'both';
    const v = own(raw, 'view');
    if (v !== undefined) {
      if (isView(v)) view = v; else warnings.push('view: invalid, using both');
    }
    return { pivot, view, chart: normChart(own(raw, 'chartOptions'), warnings), warnings };
  }
}
