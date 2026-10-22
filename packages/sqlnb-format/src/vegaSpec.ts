import type { Agg, ChartOptions, Grain, NumberFormat, PivotConfig, ValueSpec } from './analysis';

export interface ColumnInfo { name: string; kind: 'number' | 'temporal' | 'text' | 'boolean' | 'unknown' }
export const LONG_FIELDS = { x: 'x', series: 'series', value: 'value' } as const;

export const X_LABEL_FIELD = 'xLabel';
export const X_RAW_FIELD = 'xRaw';
export const VALUE_TEXT_FIELD = 'valueText';

const txt = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
// Plugin-only display text (unit and/or scale): render rows then carry a pre-formatted `valueText` for tooltips and data labels.
export const hasDisplayText = (v: ValueSpec): boolean => !!v.format && (txt(v.format.unit) !== undefined || (v.format.kind !== 'percent' && v.format.scale !== undefined));

export type SpecError = 'no_value' | 'no_x' | 'no_numeric_field' | 'unsupported';
// usesRawRows: true for histogram — the spec bins the RAW source rows (even the render spec),
// so the caller must bind the un-pivoted rows to its data instead of the long table.
export type SpecResult = { spec: object; notes: string[]; usesRawRows: boolean } | { error: SpecError };

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json';
// NOTE: Vega-Lite `yearweek` starts weeks on SUNDAY, while this plugin's own rendering buckets
// weeks on MONDAY, so week buckets may differ between the portable spec and the plugin view.
const TIME_UNITS: Record<Grain, string> = {
  day: 'yearmonthdate', week: 'yearweek', month: 'yearmonth', quarter: 'yearquarter', year: 'year',
};
const AGG_MAP: Record<Agg, string> = {
  sum: 'sum', count: 'count', countDistinct: 'distinct', avg: 'mean', min: 'min', max: 'max', median: 'median',
};

export function uniqueName(existing: ReadonlySet<string>, base: string): string {
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) if (!existing.has(`${base}_${i}`)) return `${base}_${i}`;
}

export const vlField = (name: string): string => name.replace(/[.\[\]\\]/g, '\\$&');

type Def = Record<string, unknown>;
interface Parts { x: Def; series: Def | null; measure: Def }

// Size (width/height) is intentionally left unset: the client sizes the view.
// Expressions use only datum["…"], toString(), + and JSON-escaped string literals (safe for vega-interpreter).
const datum = (f: string) => `datum[${JSON.stringify(f)}]`;
const str = (f: string) => `toString(${datum(f)})`;
const joinExpr = (fields: string[], sep: string) => fields.map(str).join(` + ${JSON.stringify(sep)} + `);

const measureLabel = (v: ValueSpec) => txt(v.label) ?? (v.field ? `${v.agg} of ${v.field}` : 'count');

function d3Format(f?: NumberFormat): string | undefined {
  if (!f) return undefined;
  const d = f.decimals ?? (f.kind === 'plain' ? undefined : 0);
  if (f.kind === 'thousands') return `,.${d}f`;
  if (f.kind === 'percent') return `.${d}%`;
  return d === undefined ? undefined : `.${d}f`;
}

function xType(kind: ColumnInfo['kind'], chart: ChartOptions['type']): string {
  if (kind === 'temporal') return 'temporal';
  if (kind === 'number') return chart === 'line' || chart === 'area' || chart === 'scatter' ? 'quantitative' : 'ordinal';
  return 'nominal';
}

function effectiveStacking(chart: ChartOptions): ChartOptions['stacking'] {
  if (chart.type === 'area' && chart.stacking === 'grouped') return 'stacked';
  if ((chart.type === 'bar' || chart.type === 'barHorizontal') && chart.stacking === 'none') return 'grouped';
  return chart.stacking;
}

function encoding(chart: ChartOptions, p: Parts, value: ValueSpec, forText: boolean, valueText = false): Def {
  const t = chart.type;
  const tip = (d: Def): Def => {
    if (!('sort' in d)) return d;
    const { sort: _sort, ...rest } = d;
    return rest;
  };
  const tooltip = [p.x, p.series, p.measure].filter((d): d is Def => !!d && !('datum' in d)).map(tip);
  const fmt = d3Format(value.format);
  const measure: Def = { ...p.measure };
  if (p.series && (t === 'bar' || t === 'barHorizontal' || t === 'area')) {
    const st = effectiveStacking(chart);
    if (st === 'stacked') measure.stack = 'zero';
    else if (st === 'percent') measure.stack = 'normalize';
    else if (st === 'none') measure.stack = false;
  }
  const enc: Def = {};
  if (t === 'pie' || t === 'donut') {
    enc.theta = measure;
    enc.color = { ...p.x };
  } else {
    const horiz = t === 'barHorizontal';
    enc[horiz ? 'y' : 'x'] = p.x;
    enc[horiz ? 'x' : 'y'] = measure;
    if (p.series) {
      enc.color = p.series;
      if ((t === 'bar' || horiz) && effectiveStacking(chart) === 'grouped') enc[horiz ? 'yOffset' : 'xOffset'] = p.series;
    }
  }
  if (forText) {
    const { stack: _s, ...m } = measure as any;
    enc.text = valueText ? { field: VALUE_TEXT_FIELD, type: 'nominal' } : fmt ? { ...m, format: fmt } : m;
    if (enc.theta) enc.theta = measure;
    return enc;
  }
  const vt: Def = { field: VALUE_TEXT_FIELD, type: 'nominal', title: p.measure.title };
  enc.tooltip = valueText ? tooltip.map((d) => (d === p.measure ? vt : d)) : fmt ? tooltip.map((d) => (d === p.measure ? { ...d, format: fmt } : d)) : tooltip;
  return enc;
}

function markFor(chart: ChartOptions, hasSeries = false): Def {
  const overlay = hasSeries && effectiveStacking(chart) === 'none' ? { opacity: 0.7 } : {};
  switch (chart.type) {
    case 'line': return { type: 'line' };
    case 'area': return { type: 'area', ...overlay };
    case 'scatter': return { type: 'point' };
    case 'pie': return { type: 'arc' };
    case 'donut': return { type: 'arc', innerRadius: 50 };
    default: return { type: 'bar', ...overlay };
  }
}

function textMark(chart: ChartOptions): Def {
  if (chart.type === 'barHorizontal') return { type: 'text', align: 'left', dx: 4 };
  if (chart.type === 'pie' || chart.type === 'donut') return { type: 'text', radius: 70 };
  return { type: 'text', dy: -6 };
}

const rowName = (r: { field: string; label?: string }) => txt(r.label) ?? r.field;
interface Cfg { pivot: PivotConfig; chart: ChartOptions; columns: ColumnInfo[]; title?: string }
const kindOf = (cols: ColumnInfo[], name: string) => cols.find((c) => c.name === name)?.kind ?? 'unknown';

export interface RenderRowShape {
  single: boolean;
  combineX: boolean;
  firstMeasureOnly: boolean;
  useColumns: boolean;
  xType: 'temporal' | 'quantitative' | 'ordinal' | 'nominal';
  // Compact time axis: ordinal x over only the dates present (render rows carry an `xLabel` field).
  compact: boolean;
}
// Single source of truth for how the pivot's long table maps onto the render spec's x/series/value.
export function renderRowShape(cfg: Cfg): RenderRowShape {
  const t = cfg.chart.type;
  const single = t === 'pie' || t === 'donut' || t === 'scatter';
  const combineX = !single && cfg.pivot.rows.length > 1;
  const first = cfg.pivot.rows[0];
  const xt = first ? xType(kindOf(cfg.columns, first.field), t) : 'nominal';
  const compact = cfg.chart.timeAxis === 'compact' && !combineX && xt === 'temporal'
    && (t === 'line' || t === 'area' || t === 'bar' || t === 'barHorizontal');
  return {
    compact,
    single, combineX, firstMeasureOnly: single, useColumns: !(single && t !== 'scatter'),
    xType: combineX ? 'nominal' : compact ? 'ordinal' : (xt as RenderRowShape['xType']),
  };
}

// Render rows replace category text with valueLabels/nullLabel; x then sorts by the raw key (xRaw) to keep raw order.
export function mapsX(cfg: Cfg): boolean {
  const sh = renderRowShape(cfg);
  if (sh.compact || sh.xType === 'temporal' || sh.xType === 'quantitative' || cfg.chart.type === 'scatter') return false;
  const rs = sh.combineX ? cfg.pivot.rows : cfg.pivot.rows.slice(0, 1);
  return rs.some((r) => (r.valueLabels && Object.keys(r.valueLabels).length > 0) || txt(r.nullLabel) !== undefined);
}

function build(mode: 'portable' | 'render', cfg: Cfg, dataName: string): SpecResult {
  const { pivot, chart, columns } = cfg;
  const t = chart.type;
  const values = pivot.values;
  const title = cfg.title ?? chart.title;
  const head = (): Def => ({ $schema: SCHEMA, ...(title !== undefined ? { title } : {}) });
  if (values.length === 0) return { error: 'no_value' };

  if (t === 'histogram') {
    const v = values.find((s) => s.field && kindOf(columns, s.field) === 'number');
    if (!v) return { error: 'no_numeric_field' };
    const hu = mode === 'render' && txt(v.format?.unit) !== undefined ? `（${v.format!.unit}）` : '';
    const x = { bin: { maxbins: chart.bins ?? 20 }, field: vlField(v.field), type: 'quantitative', title: txt(chart.axisTitles?.x) ?? (txt(v.label) ?? v.field) + hu };
    const y = { aggregate: 'count', type: 'quantitative', ...(txt(chart.axisTitles?.y) ? { title: chart.axisTitles!.y } : {}) };
    const layers: Def[] = [{ mark: { type: 'bar' }, encoding: { x, y, tooltip: [x, y] } }];
    if (chart.labels) layers.push({ mark: { type: 'text', dy: -6 }, encoding: { x, y, text: y } });
    const spec = { ...head(), data: { name: dataName }, ...(layers.length === 1 ? layers[0] : { layer: layers }) };
    return { spec: JSON.parse(JSON.stringify(spec)), notes: [], usesRawRows: true };
  }

  const rows = pivot.rows;
  if (rows.length === 0) return { error: 'no_x' };
  const first = rows[0];
  const firstKind = kindOf(columns, first.field);
  if (t === 'scatter' && firstKind !== 'number') return { error: 'no_numeric_field' };

  const shape = renderRowShape(cfg);
  const single = shape.single;
  const notes: string[] = [];
  if (t === 'pie' || t === 'donut') {
    if (rows.length > 1) notes.push('pie: extra row fields ignored');
    if (pivot.columns.length > 0) notes.push('pie: column fields ignored');
    if (values.length > 1) notes.push('pie: extra values ignored');
  } else if (t === 'scatter') {
    if (rows.length > 1) notes.push('scatter: extra row fields ignored');
    if (values.length > 1) notes.push('scatter: extra values ignored');
  }
  const usedValues = single ? values.slice(0, 1) : values;
  const combine = shape.combineX;
  const cols = !shape.useColumns ? [] : pivot.columns.map((c) => c.field);
  const multi = usedValues.length > 1;
  const transform: Def[] = [];
  const taken = new Set<string>([...columns.map((c) => c.name), ...rows.map((r) => r.field), ...pivot.columns.map((c) => c.field), ...values.map((v) => v.field)]);
  const xName = uniqueName(taken, '__sqlnb_x');
  const seriesName = uniqueName(taken, '__sqlnb_series');
  const spec: Def = { ...head(), data: { name: dataName } };
  const layers: Def[] = [];

  let x: Def;
  const xTitle = txt(chart.axisTitles?.x) ?? (combine ? rows.map(rowName).join(' / ') : rowName(first));
  const yOverride = txt(chart.axisTitles?.y);
  const legendOverride = txt(chart.axisTitles?.legend);
  const colTitle = legendOverride ?? pivot.columns.map(rowName).join(' / ');
  const dispText = mode === 'render' && usedValues.some(hasDisplayText);
  const sortRaw = mode === 'render' && mapsX(cfg);
  if (mode === 'portable') {
    if (combine) {
      transform.push({ calculate: joinExpr(rows.map((r) => r.field), ' / '), as: xName });
      x = { field: xName, type: 'nominal', title: xTitle };
    } else {
      const type = shape.compact ? 'ordinal' : xType(firstKind, t);
      x = { field: vlField(first.field), type, title: xTitle };
      if (type === 'temporal' || shape.compact) x.timeUnit = TIME_UNITS[first.grain ?? 'day'];
      if (shape.compact) x.sort = 'ascending';
    }
  } else {
    x = shape.compact
      ? { field: X_LABEL_FIELD, type: 'ordinal', title: xTitle, sort: { field: LONG_FIELDS.x, op: 'min' } }
      : { field: LONG_FIELDS.x, type: combine ? 'nominal' : xType(firstKind, t), title: xTitle };
    if (sortRaw) x.sort = { field: X_RAW_FIELD, op: 'min' };
    // xOffset (grouped bars) is ignored on a plain temporal axis; a time unit makes it a banded axis.
    if (x.type === 'temporal' && (t === 'bar' || t === 'barHorizontal') && effectiveStacking(chart) === 'grouped' && (pivot.columns.length > 0 || usedValues.length > 1)) x.timeUnit = 'utcyearmonthdate';
  }

  const folded = mode === 'portable' && multi && cols.length === 0 && (t === 'bar' || t === 'barHorizontal' || t === 'area');
  if (folded) {
    // Several measures, no column field: fold the per-x aggregates into one shared series dimension so stacking applies.
    const names: string[] = [];
    const used = new Set<string>([...taken, xName, seriesName]);
    const valueName = uniqueName(used, '__sqlnb_value');
    used.add(valueName);
    let groupX = first.field;
    if (combine) groupX = xName;
    else if (x.timeUnit) {
      transform.push({ timeUnit: x.timeUnit, field: vlField(first.field), as: xName });
      groupX = xName;
      x = { ...x, field: xName };
    }
    const ops = usedValues.map((v) => {
      const nm = uniqueName(used, measureLabel(v));
      used.add(nm);
      names.push(nm);
      return { op: AGG_MAP[v.agg], ...(v.field ? { field: vlField(v.field) } : {}), as: nm };
    });
    transform.push({ aggregate: ops, groupby: [groupX] }, { fold: names, as: [seriesName, valueName] });
    const measure: Def = { field: valueName, type: 'quantitative', title: yOverride ?? 'value' };
    const parts: Parts = { x, series: { field: seriesName, type: 'nominal', title: legendOverride ?? 'measure' }, measure };
    layers.push({ mark: markFor(chart, true), encoding: encoding(chart, parts, usedValues[0], false) });
    if (chart.labels) layers.push({ mark: textMark(chart), encoding: encoding(chart, parts, usedValues[0], true) });
  }
  if (!folded) usedValues.forEach((v, i) => {
    const label = measureLabel(v);
    let series: Def | null = null;
    const layerTransform: Def[] = [];
    let measure: Def;
    if (mode === 'portable') {
      measure = { type: 'quantitative', title: yOverride ?? label, aggregate: AGG_MAP[v.agg] };
      if (v.field) measure = { field: vlField(v.field), ...measure };
      if (multi && cols.length) {
        layerTransform.push({ calculate: `${joinExpr(cols, ' / ')} + ${JSON.stringify(' · ')} + ${JSON.stringify(label)}`, as: seriesName });
        series = { field: seriesName, type: 'nominal', title: legendOverride ?? `${colTitle} · measure` };
      } else if (multi) {
        series = { datum: label, type: 'nominal' };
      } else if (cols.length === 1) {
        series = { field: vlField(cols[0]), type: 'nominal', title: colTitle };
      } else if (cols.length > 1) {
        transform.push({ calculate: joinExpr(cols, ' / '), as: seriesName });
        series = { field: seriesName, type: 'nominal', title: colTitle };
      }
    } else {
      const unit = !multi && txt(v.format?.unit) !== undefined ? `（${v.format!.unit}）` : '';
      measure = { field: LONG_FIELDS.value, type: 'quantitative', title: yOverride ?? (multi ? 'value' : label + unit) };
      if (cols.length || multi) series = { field: LONG_FIELDS.series, type: 'nominal', title: legendOverride ?? (multi ? 'measure' : colTitle) };
    }
    if (mode === 'render' && i > 0) return;
    const parts: Parts = { x, series, measure };
    const base = layerTransform.length ? { transform: layerTransform } : {};
    layers.push({ ...base, mark: markFor(chart, !!series), encoding: encoding(chart, parts, v, false, dispText) });
    if (chart.labels) layers.push({ ...base, mark: textMark(chart), encoding: encoding(chart, parts, v, true, dispText) });
  });

  if (mode === 'render' && shape.compact) transform.unshift({ filter: `isValid(${datum(X_LABEL_FIELD)})` });
  if (transform.length) spec.transform = transform;
  Object.assign(spec, layers.length === 1 ? layers[0] : { layer: layers });
  return { spec: JSON.parse(JSON.stringify(spec)), notes, usesRawRows: false };
}

export function buildPortableSpec(cfg: Cfg & { dataName: string }): SpecResult {
  return build('portable', cfg, cfg.dataName);
}
export function buildRenderSpec(cfg: Cfg): SpecResult {
  return build('render', cfg, 'table');
}
