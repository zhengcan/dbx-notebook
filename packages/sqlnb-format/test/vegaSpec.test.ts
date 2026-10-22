import { describe, it, expect } from 'vitest';
import { buildPortableSpec, buildRenderSpec, renderRowShape, vlField, uniqueName, LONG_FIELDS, ColumnInfo } from '../src/vegaSpec';
import type { PivotConfig, ChartOptions, Grain } from '../src/analysis';

const columns: ColumnInfo[] = [
  { name: 'day', kind: 'temporal' }, { name: 'region', kind: 'text' }, { name: 'tier', kind: 'text' },
  { name: 'amount', kind: 'number' }, { name: 'qty', kind: 'number' }, { name: 'flag', kind: 'boolean' },
  { name: 'weird.na[me]', kind: 'number' }, { name: 'x"]; alert(1)//', kind: 'text' },
];
const pv = (o: Partial<PivotConfig> = {}): PivotConfig => ({
  rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }], ...o,
});
const mk = (chart: Partial<ChartOptions> = {}, pivot: Partial<PivotConfig> = {}, extra: any = {}) =>
  ({ pivot: pv(pivot), chart: { type: 'bar', ...chart } as ChartOptions, columns, dataName: 'src', ...extra });
const P = (...a: Parameters<typeof mk>) => buildPortableSpec(mk(...a)) as any;
const R = (...a: Parameters<typeof mk>) => buildRenderSpec(mk(...a)) as any;

function exprs(o: any, out: string[] = []): string[] {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (k === 'calculate' && typeof v === 'string') out.push(v); else exprs(v, out);
  }
  return out;
}
const allowed = (e: string) => {
  const rest = e.replace(/"(?:[^"\\]|\\.)*"/g, 'S');
  return /^(?:\s*(?:S|toString\(datum\[S\]\)|\+)\s*)+$/.test(rest) && /toString|datum|S/.test(rest);
};

describe('vlField', () => {
  it('escapes . [ ] \\', () => {
    expect(vlField('a.b[c]\\d')).toBe('a\\.b\\[c\\]\\\\d');
    expect(vlField('plain name')).toBe('plain name');
  });
});

describe('structure per chart type', () => {
  it('constants', () => expect(LONG_FIELDS).toEqual({ x: 'x', series: 'series', value: 'value' }));
  it('line/area', () => {
    for (const t of ['line', 'area'] as const) {
      const r = P({ type: t });
      expect(r.spec.mark.type).toBe(t);
      expect(r.spec.encoding.x).toMatchObject({ field: 'region', type: 'nominal' });
      expect(r.spec.encoding.y).toMatchObject({ field: 'amount', aggregate: 'sum', type: 'quantitative' });
      expect(r.spec.$schema).toBe('https://vega.github.io/schema/vega-lite/v5.json');
      expect(r.spec.width).toBeUndefined();
    }
  });
  it('line with numeric x is quantitative, bar ordinal', () => {
    expect(P({ type: 'line' }, { rows: [{ field: 'qty' }] }).spec.encoding.x.type).toBe('quantitative');
    expect(P({ type: 'bar' }, { rows: [{ field: 'qty' }] }).spec.encoding.x.type).toBe('ordinal');
    expect(P({ type: 'bar' }, { rows: [{ field: 'flag' }] }).spec.encoding.x.type).toBe('nominal');
  });
  it('bar stacking/grouping', () => {
    const cols = { columns: [{ field: 'tier' }] };
    const s = P({ type: 'bar', stacking: 'stacked' }, cols).spec;
    expect(s.encoding.y.stack).toBe('zero');
    expect(s.encoding.color).toMatchObject({ field: 'tier', type: 'nominal' });
    const g = P({ type: 'bar', stacking: 'grouped' }, cols).spec;
    expect(g.encoding.xOffset).toMatchObject({ field: 'tier' });
    expect(g.encoding.y.stack).toBeUndefined();
    const n = P({ type: 'bar', stacking: 'none' }, cols).spec;
    expect(n.encoding.xOffset).toMatchObject({ field: 'tier' });
    expect(n.encoding.y.stack).toBeUndefined();
    expect(n.mark.opacity).toBeUndefined();
    const nh = P({ type: 'barHorizontal', stacking: 'none' }, cols).spec;
    expect(nh.encoding.yOffset).toMatchObject({ field: 'tier' });
    expect(R({ type: 'bar', stacking: 'none' }, cols).spec.encoding.xOffset).toMatchObject({ field: 'series' });
    const an = P({ type: 'area', stacking: 'none' }, cols).spec;
    expect(an.encoding.y.stack).toBe(false);
    expect(an.mark.opacity).toBe(0.7);
    const p = P({ type: 'bar', stacking: 'percent' }, cols).spec;
    expect(p.encoding.y.stack).toBe('normalize');
    expect(P({ type: 'bar' }, cols).spec.encoding.y.stack).toBeUndefined();
    expect(P({ type: 'bar', stacking: 'stacked' }, {}).spec.encoding.y.stack).toBeUndefined();
    expect(P({ type: 'area', stacking: 'percent' }, cols).spec.encoding.y.stack).toBe('normalize');
  });
  it('area treats grouped as stacked (portable and render)', () => {
    const cols = { columns: [{ field: 'tier' }] };
    for (const f of [P, R]) {
      const g = f({ type: 'area', stacking: 'grouped' }, cols).spec;
      const st = f({ type: 'area', stacking: 'stacked' }, cols).spec;
      expect(g).toEqual(st);
      expect(g.encoding.y.stack).toBe('zero');
      expect(g.mark.opacity).toBeUndefined();
    }
  });
  it('horizontal swaps axes', () => {
    const s = P({ type: 'barHorizontal', stacking: 'grouped' }, { columns: [{ field: 'tier' }] }).spec;
    expect(s.mark.type).toBe('bar');
    expect(s.encoding.y).toMatchObject({ field: 'region' });
    expect(s.encoding.x).toMatchObject({ field: 'amount', aggregate: 'sum' });
    expect(s.encoding.yOffset).toMatchObject({ field: 'tier' });
    expect(s.encoding.xOffset).toBeUndefined();
  });
  it('scatter', () => {
    const s = P({ type: 'scatter' }, { rows: [{ field: 'qty' }] }).spec;
    expect(s.mark.type).toBe('point');
    expect(s.encoding.x).toMatchObject({ field: 'qty', type: 'quantitative' });
    expect(s.encoding.y).toMatchObject({ field: 'amount', type: 'quantitative' });
  });
  it('pie and donut use first value + first row; notes for ignored', () => {
    const r = P({ type: 'pie' }, {
      rows: [{ field: 'region' }, { field: 'tier' }], columns: [{ field: 'flag' }],
      values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'avg' }],
    });
    expect(r.spec.mark.type).toBe('arc');
    expect(r.spec.encoding.theta).toMatchObject({ field: 'amount', aggregate: 'sum' });
    expect(r.spec.encoding.color).toMatchObject({ field: 'region' });
    expect(r.notes.length).toBe(3);
    expect(JSON.stringify(r.spec)).not.toContain('qty');
    const d = P({ type: 'donut' });
    expect(d.spec.mark.type).toBe('arc');
    expect(d.spec.mark.innerRadius).toBeGreaterThan(0);
    expect(d.notes).toEqual([]);
  });
  it('histogram uses raw rows with bin and no value aggregate', () => {
    const r = P({ type: 'histogram', bins: 7 }, { rows: [], values: [{ field: 'region', agg: 'count' }, { field: 'qty', agg: 'sum' }] });
    expect(r.usesRawRows).toBe(true);
    expect(r.spec.mark.type).toBe('bar');
    expect(r.spec.encoding.x).toMatchObject({ field: 'qty', bin: { maxbins: 7 }, type: 'quantitative' });
    expect(r.spec.encoding.x.aggregate).toBeUndefined();
    expect(r.spec.encoding.y).toMatchObject({ aggregate: 'count' });
    expect(P({ type: 'histogram' }).spec.encoding.x.bin.maxbins).toBe(20);
    const rr = R({ type: 'histogram', bins: 7 }, { rows: [], values: [{ field: 'qty', agg: 'sum' }] });
    expect(rr.usesRawRows).toBe(true);
    expect({ ...rr.spec, data: 0 }).toEqual({ ...P({ type: 'histogram', bins: 7 }, { rows: [], values: [{ field: 'qty', agg: 'sum' }] }).spec, data: 0 });
    expect(P({ type: 'bar' }).usesRawRows).toBe(false);
  });
  it('count agg omits field', () => {
    const e = P({}, { values: [{ field: '', agg: 'count' }] }).spec.encoding.y;
    expect(e.aggregate).toBe('count');
    expect('field' in e).toBe(false);
  });
  it('agg mapping', () => {
    const m: Record<string, string> = { sum: 'sum', countDistinct: 'distinct', avg: 'mean', min: 'min', max: 'max', median: 'median' };
    for (const [a, v] of Object.entries(m))
      expect(P({}, { values: [{ field: 'amount', agg: a as any }] }).spec.encoding.y.aggregate).toBe(v);
  });
  it('title, labels layer, tooltip', () => {
    const r = P({ type: 'bar', labels: true, title: 'T' });
    expect(r.spec.title).toBe('T');
    expect(r.spec.layer).toHaveLength(2);
    expect(r.spec.layer[0].mark.type).toBe('bar');
    expect(r.spec.layer[1].mark.type).toBe('text');
    expect(r.spec.layer[1].encoding.text).toMatchObject({ field: 'amount' });
    expect(buildPortableSpec({ ...mk(), title: 'Z' } as any)).toMatchObject({ spec: { title: 'Z' } });
    const plain = P({});
    expect(plain.spec.layer).toBeUndefined();
    expect(plain.spec.encoding.tooltip.length).toBeGreaterThanOrEqual(2);
  });
  it('number format on labels', () => {
    const r = P({ labels: true }, { values: [{ field: 'amount', agg: 'sum', format: { kind: 'percent', decimals: 1 } }] });
    expect(r.spec.layer[1].encoding.text.format).toBe('.1%');
  });
});

describe('x derivation', () => {
  it('grain mapping', () => {
    const m: Record<Grain, string> = { day: 'yearmonthdate', week: 'yearweek', month: 'yearmonth', quarter: 'yearquarter', year: 'year' };
    for (const [g, tu] of Object.entries(m)) {
      const s = P({ type: 'line' }, { rows: [{ field: 'day', grain: g as Grain }] }).spec;
      expect(s.encoding.x).toMatchObject({ field: 'day', type: 'temporal', timeUnit: tu });
    }
  });
  it('temporal vs text in both builders', () => {
    expect(R({ type: 'line' }, { rows: [{ field: 'day', grain: 'month' }] }).spec.encoding.x).toMatchObject({ field: 'x', type: 'temporal' });
    expect(R({ type: 'line' }).spec.encoding.x).toMatchObject({ field: 'x', type: 'nominal' });
    expect(R({ type: 'line' }).spec.data).toEqual({ name: 'table' });
  });
  it('multi-row combined label uses whitelisted expression', () => {
    const r = P({}, { rows: [{ field: 'region' }, { field: 'x"]; alert(1)//' }, { field: 'day' }] });
    const e = exprs(r.spec);
    expect(e.length).toBe(1);
    expect(allowed(e[0])).toBe(true);
    expect(e[0]).toContain('datum["region"]');
    expect(e[0]).toContain(' / ');
    expect(r.spec.encoding.x).toMatchObject({ field: '__sqlnb_x', type: 'nominal' });
    expect(R({}, { rows: [{ field: 'region' }, { field: 'tier' }] }).spec.encoding.x).toMatchObject({ field: 'x', type: 'nominal' });
  });
  it('injection-ish names stay inside strings', () => {
    const name = 'x"]; alert(1)//';
    const r = P({}, { rows: [{ field: name }, { field: 'region' }] });
    const e = exprs(r.spec)[0];
    expect(allowed(e)).toBe(true);
    expect(e).toContain(JSON.stringify(name));
    expect(JSON.parse(JSON.stringify(r.spec))).toEqual(r.spec);
  });
  it('field escaping in encoding', () => {
    const s = P({}, { rows: [{ field: 'weird.na[me]' }], values: [{ field: 'weird.na[me]', agg: 'sum' }] }).spec;
    expect(s.encoding.x.field).toBe('weird\\.na\\[me\\]');
    expect(s.encoding.y.field).toBe('weird\\.na\\[me\\]');
  });
});

describe('colour / series', () => {
  it('column field → colour', () => {
    expect(P({}, { columns: [{ field: 'tier' }] }).spec.encoding.color).toMatchObject({ field: 'tier' });
    expect(R({}, { columns: [{ field: 'tier' }] }).spec.encoding.color).toMatchObject({ field: 'series', type: 'nominal' });
    expect(R({}).spec.encoding.color).toBeUndefined();
  });
  it('multi value → one layer per value, colour by measure label (line)', () => {
    const s = P({ type: 'line' }, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'avg', label: 'Avg qty' }] }).spec;
    expect(s.layer).toHaveLength(2);
    expect(s.layer[0].encoding.y.aggregate).toBe('sum');
    expect(s.layer[1].encoding.y.aggregate).toBe('mean');
    expect(s.layer[1].encoding.color).toMatchObject({ datum: 'Avg qty', type: 'nominal' });
    expect(s.layer[0].mark.type).toBe('line');
  });
  it('multi value bar → aggregate + fold into one series dimension', () => {
    const s = P({}, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'avg', label: 'Avg qty' }] }).spec;
    expect(s.layer).toBeUndefined();
    expect(s.transform.find((t: any) => t.fold).fold).toEqual(['sum of amount', 'Avg qty']);
    expect(s.transform.find((t: any) => t.aggregate).aggregate.map((a: any) => a.op)).toEqual(['sum', 'mean']);
    expect(s.encoding.color).toMatchObject({ field: '__sqlnb_series', type: 'nominal' });
  });
  it('multi value + columns → "col · measure"', () => {
    const s = P({}, { columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum', label: 'A' }, { field: 'qty', agg: 'sum', label: 'Q' }] }).spec;
    const e = exprs(s);
    expect(e).toHaveLength(2);
    e.forEach((x) => expect(allowed(x)).toBe(true));
    expect(e[0]).toContain(' · ');
    expect(s.layer[0].encoding.color.field).toBe('__sqlnb_series');
    expect(s.layer[0].transform).toBeDefined();
  });
  it('multi value in render spec → series field', () => {
    const s = R({}, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'sum' }] }).spec;
    expect(s.encoding.color).toMatchObject({ field: 'series' });
    expect(s.encoding.y).toMatchObject({ field: 'value', type: 'quantitative' });
    expect(s.encoding.y.aggregate).toBeUndefined();
  });
  it('multi value with labels', () => {
    const s = P({ type: 'line', labels: true }, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'sum' }] }).spec;
    expect(s.layer).toHaveLength(4);
    expect(P({ labels: true }, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'sum' }] }).spec.layer).toHaveLength(2);
  });
});

describe('errors', () => {
  it('no_value', () => {
    for (const t of ['bar', 'line', 'pie', 'scatter', 'histogram'] as const)
      expect(buildPortableSpec(mk({ type: t }, { values: [] }) as any)).toEqual({ error: 'no_value' });
    expect(buildRenderSpec(mk({}, { values: [] }) as any)).toEqual({ error: 'no_value' });
  });
  it('no_x', () => {
    for (const t of ['bar', 'line', 'area', 'barHorizontal', 'scatter', 'pie', 'donut'] as const) {
      expect(buildPortableSpec(mk({ type: t }, { rows: [] }) as any)).toEqual({ error: 'no_x' });
      expect(buildRenderSpec(mk({ type: t }, { rows: [] }) as any)).toEqual({ error: 'no_x' });
    }
    expect('spec' in buildPortableSpec(mk({ type: 'histogram' }, { rows: [], values: [{ field: 'qty', agg: 'sum' }] }) as any)).toBe(true);
  });
  it('no_numeric_field', () => {
    expect(buildPortableSpec(mk({ type: 'scatter' }) as any)).toEqual({ error: 'no_numeric_field' });
    expect(buildRenderSpec(mk({ type: 'scatter' }) as any)).toEqual({ error: 'no_numeric_field' });
    expect(buildPortableSpec(mk({ type: 'histogram' }, { rows: [], values: [{ field: 'region', agg: 'count' }] }) as any)).toEqual({ error: 'no_numeric_field' });
  });
});

describe('invariants', () => {
  const cases: [string, Partial<ChartOptions>, Partial<PivotConfig>][] = [];
  for (const type of ['line', 'area', 'bar', 'barHorizontal', 'pie', 'donut'] as const)
    for (const r of ['region', 'day', 'qty'])
      cases.push([`${type}/${r}`, { type, labels: true }, { rows: [{ field: r }], columns: [{ field: 'tier' }] }]);
  cases.push(['scatter', { type: 'scatter' }, { rows: [{ field: 'qty' }] }]);
  const leaf = (o: any): any[] => (o.layer ? o.layer : [o]);
  it.each(cases)('builders agree on mark/types: %s', (_n, chart, pivot) => {
    const p = P(chart, pivot).spec, r = R(chart, pivot).spec;
    const pl = leaf(p), rl = leaf(r);
    expect(rl.map((l) => l.mark.type)).toEqual(pl.map((l) => l.mark.type));
    for (const k of ['x', 'y', 'theta', 'color', 'xOffset', 'yOffset']) {
      const a = pl[0].encoding[k], b = rl[0].encoding[k];
      expect(!!a).toBe(!!b);
      if (a) expect(b.type).toBe(a.type);
    }
  });
  it('JSON-serialisable, deterministic', () => {
    for (const [, chart, pivot] of cases) {
      for (const f of [P, R]) {
        const a = f(chart, pivot).spec;
        expect(JSON.parse(JSON.stringify(a))).toEqual(a);
        expect(JSON.stringify(f(chart, pivot).spec)).toBe(JSON.stringify(a));
      }
    }
  });
  it('portable has no data.values; named data', () => {
    const s = P({}).spec;
    expect(s.data).toEqual({ name: 'src' });
    expect('values' in s.data).toBe(false);
  });
});

describe('fix round 1', () => {
  it('no datum entries in tooltip (multi value, no columns)', () => {
    for (const t of ['line', 'area', 'bar', 'barHorizontal'] as const) {
      const s = P({ type: t, labels: true }, { values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'avg' }] }).spec;
      for (const l of s.layer) {
        expect(l.encoding.color).toMatchObject(t === 'line' ? { datum: expect.any(String) } : { field: '__sqlnb_series' });
        for (const tt of l.encoding.tooltip ?? []) expect('datum' in tt).toBe(false);
      }
    }
  });
  it('helper names are prefixed and collision-safe', () => {
    expect(uniqueName(new Set(['a']), 'a')).toBe('a_2');
    expect(uniqueName(new Set(['a', 'a_2']), 'a')).toBe('a_3');
    expect(uniqueName(new Set(), 'a')).toBe('a');
    const s = P({}, { rows: [{ field: 'region' }, { field: 'tier' }] }).spec;
    expect(s.encoding.x.field).toBe('__sqlnb_x');
    const names = ['__x', '__series', 'x', 'series', 'value', '__sqlnb_x', '__sqlnb_series'];
    const cols = names.map((n) => ({ name: n, kind: 'text' as const }));
    const r = buildPortableSpec({
      pivot: pv({ rows: [{ field: '__x' }, { field: '__sqlnb_x' }], columns: [{ field: 'series' }, { field: 'value' }] }),
      chart: { type: 'bar' }, columns: cols, dataName: 'src',
    }) as any;
    expect(r.spec.encoding.x.field).toBe('__sqlnb_x_2');
    expect(r.spec.transform.map((t: any) => t.as)).toEqual(['__sqlnb_x_2', '__sqlnb_series_2']);
    expect(r.spec.encoding.color.field).toBe('__sqlnb_series_2');
  });
});

describe('renderRowShape', () => {
  const two = { rows: [{ field: 'region' }, { field: 'tier' }] };
  it('matches the render spec for each chart type', () => {
    for (const type of ['bar', 'line', 'area', 'barHorizontal', 'scatter', 'pie', 'donut'] as const) {
      const rows = type === 'scatter' ? [{ field: 'amount' }, { field: 'qty' }] : two.rows;
      const cfg = mk({ type }, { rows, values: [{ field: 'amount', agg: 'sum' }, { field: 'qty', agg: 'sum' }] });
      const shape = renderRowShape(cfg);
      const spec = (buildRenderSpec(cfg) as any).spec;
      const enc = spec.encoding ?? spec.layer[0].encoding;
      const x = type === 'barHorizontal' ? enc.y : type === 'pie' || type === 'donut' ? enc.color : enc.x;
      expect(shape.combineX).toBe(type === 'bar' || type === 'line' || type === 'area' || type === 'barHorizontal');
      expect(shape.firstMeasureOnly).toBe(type === 'scatter' || type === 'pie' || type === 'donut');
      if (shape.combineX) expect(x.type).toBe('nominal'); else expect(x.type).toBe(shape.xType);
    }
  });
  it('xType follows the first row column', () => {
    expect(renderRowShape(mk({ type: 'line' }, { rows: [{ field: 'day' }] })).xType).toBe('temporal');
    expect(renderRowShape(mk({ type: 'line' }, { rows: [{ field: 'amount' }] })).xType).toBe('quantitative');
    expect(renderRowShape(mk({ type: 'bar' }, { rows: [{ field: 'amount' }] })).xType).toBe('ordinal');
    expect(renderRowShape(mk({ type: 'bar' }, { rows: [{ field: 'region' }] })).xType).toBe('nominal');
  });
  it('pie ignores columns, scatter keeps them', () => {
    expect(renderRowShape(mk({ type: 'pie' }, { columns: [{ field: 'tier' }] })).useColumns).toBe(false);
    expect(renderRowShape(mk({ type: 'scatter' }, { rows: [{ field: 'amount' }], columns: [{ field: 'tier' }] })).useColumns).toBe(true);
  });
});

describe('timeAxis compact', () => {
  const T = (type: any, timeAxis: any, grain: Grain = 'month', extra: Partial<PivotConfig> = {}) => ({ type, timeAxis, rows: [{ field: 'day', grain }], ...extra });
  const enc = (spec: any, type: string) => (spec.encoding ?? spec.layer[0].encoding)[type === 'barHorizontal' ? 'y' : 'x'];
  for (const type of ['line', 'area', 'bar', 'barHorizontal'] as const) {
    it(type + ': portable is ordinal + timeUnit + ascending; render uses xLabel sorted by x', () => {
      const t = T(type, 'compact', 'quarter');
      const p = P({ type, timeAxis: 'compact' }, { rows: t.rows });
      expect(enc(p.spec, type)).toMatchObject({ field: 'day', type: 'ordinal', timeUnit: 'yearquarter', sort: 'ascending' });
      const r = R({ type, timeAxis: 'compact' }, { rows: t.rows });
      expect(enc(r.spec, type)).toMatchObject({ field: 'xLabel', type: 'ordinal', sort: { field: 'x', op: 'min' } });
      expect(renderRowShape(mk({ type, timeAxis: 'compact' }, { rows: t.rows })).compact).toBe(true);
    });
    it(type + ': sparse/absent keeps the temporal axis', () => {
      for (const ta of [undefined, 'sparse'] as const) {
        const rows = [{ field: 'day', grain: 'month' as Grain }];
        expect(enc(P({ type, timeAxis: ta }, { rows }).spec, type)).toMatchObject({ type: 'temporal', timeUnit: 'yearmonth' });
        expect(enc(R({ type, timeAxis: ta }, { rows }).spec, type)).toMatchObject({ field: 'x', type: 'temporal' });
        expect(renderRowShape(mk({ type, timeAxis: ta }, { rows })).compact).toBe(false);
      }
    });
  }
  it('tooltip x definition carries no sort (not allowed in tooltip channel defs)', () => {
    const rows = [{ field: 'day', grain: 'month' as Grain }];
    for (const r of [P({ type: 'bar', timeAxis: 'compact' }, { rows }), R({ type: 'bar', timeAxis: 'compact' }, { rows })]) {
      expect(r.spec.encoding.tooltip[0]).not.toHaveProperty('sort');
      expect(r.spec.encoding.tooltip[0].type).toBe('ordinal');
    }
  });
  it('ignored for non-temporal x, combined x and other chart types', () => {
    expect(enc(R({ type: 'bar', timeAxis: 'compact' }).spec, 'bar')).toMatchObject({ field: 'x', type: 'nominal' });
    expect(enc(P({ type: 'bar', timeAxis: 'compact' }).spec, 'bar')).toMatchObject({ field: 'region', type: 'nominal' });
    expect(R({ type: 'bar', timeAxis: 'compact' }, { rows: [{ field: 'day', grain: 'month' }, { field: 'region' }] }).spec.encoding.x.type).toBe('nominal');
    for (const type of ['scatter', 'pie', 'donut', 'histogram'] as const) {
      const r = R({ type, timeAxis: 'compact' }, { rows: [{ field: 'day', grain: 'month' }] });
      expect(JSON.stringify(r.spec ?? {})).not.toContain('xLabel');
      expect(renderRowShape(mk({ type, timeAxis: 'compact' }, { rows: [{ field: 'day', grain: 'month' }] })).compact).toBe(false);
    }
  });
});

describe('custom labels in titles (Plan 13 T9)', () => {
  const lab = (o: any = {}) => mk(o.chart ?? {}, { rows: [{ field: 'region', label: '渠道' }], values: [{ field: 'amount', agg: 'sum', label: '销售额' }], ...(o.pivot ?? {}) });
  const tx = (m: any) => m.pivot.rows[0] && R(m.chart, m.pivot);
  it('x title = row label else field; axisTitles.x overrides; y = measure label', () => {
    const r = buildRenderSpec(lab()) as any;
    expect(r.spec.encoding.x.title).toBe('渠道');
    expect(r.spec.encoding.y.title).toBe('销售额');
    const o = buildRenderSpec(lab({ chart: { axisTitles: { x: '区域', y: '金额' } } })) as any;
    expect(o.spec.encoding.x.title).toBe('区域');
    expect(o.spec.encoding.y.title).toBe('金额');
    expect(((buildPortableSpec(lab({ chart: { axisTitles: { y: '金额' } } })) as any)).spec.encoding.y.title).toBe('金额');
    expect(((buildPortableSpec(lab()) as any)).spec.encoding.x.title).toBe('渠道');
  });
  it('legend title from columns[0].label, axisTitles.legend overrides', () => {
    const m = lab({ pivot: { columns: [{ field: 'tier', label: '等级' }] } });
    expect((buildRenderSpec(m) as any).spec.encoding.color.title).toBe('等级');
    expect((buildPortableSpec(m) as any).spec.encoding.color.title).toBe('等级');
    const o = lab({ pivot: { columns: [{ field: 'tier', label: '等级' }] }, chart: { axisTitles: { legend: '图例' } } });
    expect((buildRenderSpec(o) as any).spec.encoding.color.title).toBe('图例');
  });
  it('multi-measure y title stays value unless axisTitles.y', () => {
    const two = { values: [{ field: 'amount', agg: 'sum' as const, label: 'A' }, { field: 'qty', agg: 'sum' as const }] };
    expect((buildRenderSpec(lab({ pivot: two })) as any).spec.encoding.y.title).toBe('value');
    expect((buildRenderSpec(lab({ pivot: two, chart: { axisTitles: { y: '数值' } } })) as any).spec.encoding.y.title).toBe('数值');
    expect(JSON.stringify((buildPortableSpec(lab({ pivot: two, chart: { axisTitles: { y: '数值' } } })) as any).spec)).not.toContain('"title":"value"');
  });
  it('render y title appends （unit） for a single measure; portable does not; axisTitles.y wins', () => {
    const u = { values: [{ field: 'amount', agg: 'sum' as const, label: '销售额', format: { kind: 'thousands' as const, unit: '万元', scale: 10000 } }] };
    expect((buildRenderSpec(lab({ pivot: u })) as any).spec.encoding.y.title).toBe('销售额（万元）');
    expect((buildPortableSpec(lab({ pivot: u })) as any).spec.encoding.y.title).toBe('销售额');
    expect((buildRenderSpec(lab({ pivot: u, chart: { axisTitles: { y: '金额' } } })) as any).spec.encoding.y.title).toBe('金额');
  });
  it('portable spec carries no scale/unit/mapping, only titles', () => {
    const u = { rows: [{ field: 'region', valueLabels: { a: 'A' } }], values: [{ field: 'amount', agg: 'sum' as const, format: { kind: 'thousands' as const, unit: '万元', scale: 10000 } }] };
    const s = JSON.stringify((buildPortableSpec(lab({ pivot: u })) as any).spec);
    expect(s).not.toContain('万元'); expect(s).not.toContain('10000'); expect(s).not.toContain('valueText');
  });
  it('render tooltip/text use valueText only when unit or scale is set', () => {
    const base = (buildRenderSpec(lab({ chart: { labels: true } })) as any).spec;
    expect(JSON.stringify(base)).not.toContain('valueText');
    const u = { values: [{ field: 'amount', agg: 'sum' as const, format: { kind: 'thousands' as const, unit: '万元' } }] };
    const s = (buildRenderSpec(lab({ pivot: u, chart: { labels: true } })) as any).spec;
    expect(JSON.stringify(s.layer[0].encoding.tooltip)).toContain('valueText');
    expect(s.layer[1].encoding.text.field).toBe('valueText');
  });
  it('mapped x sorts by raw key; unmapped spec has no sort', () => {
    const m = lab({ pivot: { rows: [{ field: 'region', valueLabels: { 0: '否', 1: '是' } }] } });
    expect((buildRenderSpec(m) as any).spec.encoding.x.sort).toEqual({ field: 'xRaw', op: 'min' });
    expect((buildRenderSpec(lab()) as any).spec.encoding.x.sort).toBeUndefined();
  });
  it('histogram title from label, no change without', () => {
    const h = (pivot: any) => (buildRenderSpec({ pivot: { rows: [], columns: [], values: [{ field: 'amount', agg: 'sum', ...pivot }] }, chart: { type: 'histogram' } as any, columns }) as any).spec;
    expect(h({}).encoding.x.title).toBe('amount');
    expect(h({ label: '销售额' }).encoding.x.title).toBe('销售额');
  });
  it('no label fields: spec deep-equals the baseline construction', () => {
    const a = buildRenderSpec(mk({ type: 'bar', title: 'T' })) as any;
    expect(a.spec.encoding.x.title).toBe('region');
    expect(a.spec.encoding.y.title).toBe('sum of amount');
    expect(a.spec.title).toBe('T');
    expect(a.spec.encoding.x.sort).toBeUndefined();
    expect(Object.keys(a.spec.encoding.y)).toEqual(['field', 'type', 'title']);
  });
});
