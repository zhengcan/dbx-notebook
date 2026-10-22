import { describe, it, expect } from 'vitest';
import { normalizeAnalysis, SUMMARIES, isSummary, isGrain, isAgg, isView, isChartType, validateNotebook, createEmptyNotebook, parseNotebook, serializeNotebook } from '../src/index';

const nbWith = (...blocks: any[]) => { const nb = createEmptyNotebook(); nb.blocks.push(...blocks); return nb; };
const chart = (md: any) => ({ id: 'b_c', type: 'chart', content: '', metadata: { data: 'r', spec: {}, ...md } });
const pv = (p: any) => normalizeAnalysis({ pivot: p });

describe('guards', () => {
  it('enums', () => {
    expect(isGrain('month')).toBe(true); expect(isGrain('month; DROP TABLE x')).toBe(false);
    expect(isAgg('median')).toBe(true); expect(isAgg('sum)')).toBe(false); expect(isAgg(1)).toBe(false);
    expect(isView('both')).toBe(true); expect(isView(3)).toBe(false);
    expect(isChartType('donut')).toBe(true); expect(isChartType('pie3d')).toBe(false);
  });
});

describe('summary', () => {
  it('guard and constant', () => {
    expect(SUMMARIES).toEqual(['sum', 'count', 'avg', 'min', 'max', 'median', 'none']);
    expect(isSummary('median')).toBe(true); expect(isSummary('countDistinct')).toBe(false); expect(isSummary(1)).toBe(false);
  });
  it('kept on values and round trips', () => {
    const r = pv({ values: [{ field: 'a', agg: 'sum', summary: 'avg' }, { field: 'a', agg: 'sum', summary: 'none' }, { field: 'a', agg: 'sum' }] });
    expect(r.pivot!.values.map((v) => v.summary)).toEqual(['avg', 'none', undefined]);
    expect(r.warnings).toEqual([]);
    expect(Object.keys(r.pivot!.values[2])).not.toContain('summary');
    const nb = nbWith(chart({ pivot: { values: [{ field: 'a', agg: 'sum', summary: 'max' }] } }));
    const again = parseNotebook(serializeNotebook(nb));
    expect(normalizeAnalysis(again.blocks[0].metadata).pivot!.values[0].summary).toBe('max');
  });
  it('invalid summary dropped with a warning, never throws', () => {
    for (const bad of ['median)', 3, null, {}, 'SUM']) {
      const r = pv({ values: [{ field: 'a', agg: 'sum', summary: bad }] });
      expect(r.pivot!.values).toEqual([{ field: 'a', agg: 'sum' }]);
      expect(Object.keys(r.pivot!.values[0])).not.toContain('summary');
      expect(r.warnings.some((x) => /summary/.test(x))).toBe(true);
    }
  });
  it('summary takes part in dedupe', () => {
    expect(pv({ values: [{ field: 'a', agg: 'sum', summary: 'avg' }, { field: 'a', agg: 'sum', summary: 'max' }] }).pivot!.values).toHaveLength(2);
    expect(pv({ values: [{ field: 'a', agg: 'sum', summary: 'avg' }, { field: 'a', agg: 'sum', summary: 'avg' }] }).pivot!.values).toHaveLength(1);
  });
  it('schema accepts weird summary values (repaired on load)', () => {
    const nb = nbWith(chart({ pivot: { values: [{ field: 'a', agg: 'sum', summary: 42 }] } }));
    expect(validateNotebook(nb).valid).toBe(true);
  });
});

describe('normalizeAnalysis', () => {
  it('never throws on junk', () => {
    for (const j of [undefined, null, 'x', 5, [], [1], { pivot: [] }, { pivot: { rows: 'x', values: { a: 1 } } }, { pivot: { rows: [null, 1, [], { field: {} }] }, chartOptions: 'x' }]) {
      const r = normalizeAnalysis(j);
      expect(r.view).toBe('both'); expect(r.chart.type).toBe('bar');
    }
    expect(normalizeAnalysis(undefined).pivot).toBeNull();
    expect(pv({}).pivot).toEqual({ rows: [], columns: [], values: [], totals: { row: false, column: false, grand: false }, sort: null });
  });
  it('proto safe', () => {
    const raw = JSON.parse('{"__proto__":{"x":1},"pivot":{"__proto__":{"y":1},"rows":[{"field":"a","__proto__":{"z":1}}]}}');
    const r = normalizeAnalysis(raw);
    expect(r.pivot!.rows).toEqual([{ field: 'a' }]);
    expect(({} as any).x).toBeUndefined();
    expect(Object.keys(r.pivot!)).not.toContain('__proto__');
  });
  it('keeps order', () => {
    const r = pv({ rows: [{ field: 'b' }, { field: 'a' }], columns: [{ field: 'c' }], values: [{ field: 'y', agg: 'avg' }, { field: 'x', agg: 'sum' }] }).pivot!;
    expect(r.rows.map((x) => x.field)).toEqual(['b', 'a']);
    expect(r.values.map((x) => x.field)).toEqual(['y', 'x']);
  });
  it('tampered grain dropped with warning', () => {
    const r = pv({ rows: [{ field: 'd', grain: 'month; DROP TABLE x' }] });
    expect(r.pivot!.rows).toEqual([{ field: 'd' }]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it('tampered agg drops value', () => {
    const r = pv({ values: [{ field: 'a', agg: 'sum)' }, { field: 'b', agg: 'sum' }] });
    expect(r.pivot!.values).toEqual([{ field: 'b', agg: 'sum' }]);
    expect(r.warnings.length).toBe(1);
  });
  it('decimals clamp', () => {
    const f = (d: any) => pv({ values: [{ field: 'a', agg: 'sum', format: { kind: 'percent', decimals: d } }] }).pivot!.values[0].format!;
    expect(f(99).decimals).toBe(6); expect(f(-3).decimals).toBe(0); expect(f(2.6).decimals).toBe(3);
    expect(f('x').decimals).toBeUndefined();
  });
  it('totals', () => {
    expect(pv({ totals: { row: true, grand: 'yes' } }).pivot!.totals).toEqual({ row: true, column: false, grand: false });
  });
  it('limits', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => ({ field: 'f' + i }));
    const r = pv({ rows: n(10), columns: n(5), values: n(12).map((x) => ({ ...x, agg: 'sum' })) });
    expect(r.pivot!.rows.length).toBe(6); expect(r.pivot!.columns.length).toBe(3); expect(r.pivot!.values.length).toBe(8);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });
  it('dedupe', () => {
    const r = pv({ rows: [{ field: 'a' }, { field: 'a' }, { field: 'a', grain: 'day' }] });
    expect(r.pivot!.rows).toEqual([{ field: 'a' }, { field: 'a', grain: 'day' }]);
  });
  it('NUL / long / empty names', () => {
    const r = pv({ rows: [{ field: 'a\0b' }, { field: 'x'.repeat(257) }, { field: '' }, { field: 'ok' }] });
    expect(r.pivot!.rows).toEqual([{ field: 'ok' }]);
    expect(r.warnings.length).toBe(3);
  });
  it('count with empty field', () => {
    expect(pv({ values: [{ field: '', agg: 'count' }, { field: '', agg: 'sum' }] }).pivot!.values).toEqual([{ field: '', agg: 'count' }]);
  });
  it('sort', () => {
    const values = [{ field: 'a', agg: 'sum' }, { field: 'b', agg: 'sum' }];
    expect(pv({ values, sort: { by: 'name', dir: 'asc' } }).pivot!.sort).toEqual({ by: 'name', dir: 'asc' });
    expect(pv({ values, sort: { by: 'value', valueIndex: 1, dir: 'desc' } }).pivot!.sort).toEqual({ by: 'value', valueIndex: 1, dir: 'desc' });
    expect(pv({ values, sort: { by: 'value', valueIndex: 2, dir: 'desc' } }).pivot!.sort).toEqual({ by: 'value', dir: 'desc' });
    expect(pv({ values, sort: { by: 'x', dir: 'desc' } }).pivot!.sort).toBeNull();
    expect(pv({ values, sort: 'x' }).pivot!.sort).toBeNull();
  });
  it('view and chart', () => {
    expect(normalizeAnalysis({ view: 'table' }).view).toBe('table');
    const bad = normalizeAnalysis({ view: 'x', chartOptions: { type: 'bar"; x' } });
    expect(bad.view).toBe('both'); expect(bad.chart).toEqual({ type: 'bar' }); expect(bad.warnings.length).toBe(2);
    expect(normalizeAnalysis({ chartOptions: { type: 'area', stacking: 'stacked', labels: true, title: 't'.repeat(300), bins: 1000 } }).chart)
      .toEqual({ type: 'area', stacking: 'stacked', labels: true, title: 't'.repeat(200), bins: 100 });
    expect(normalizeAnalysis({ chartOptions: { bins: 0 } }).chart.bins).toBe(2);
  });
  it('timeAxis whitelist', () => {
    expect(normalizeAnalysis({ chartOptions: { type: 'line', timeAxis: 'compact' } }).chart).toEqual({ type: 'line', timeAxis: 'compact' });
    expect(normalizeAnalysis({ chartOptions: { timeAxis: 'sparse' } }).chart.timeAxis).toBe('sparse');
    const bad = normalizeAnalysis({ chartOptions: { timeAxis: 'dense' } });
    expect(bad.chart.timeAxis).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes('timeAxis'))).toBe(true);
  });
});

describe('schema', () => {
  it('accepts new and old chart blocks', () => {
    expect(validateNotebook(nbWith(chart({ pivot: { rows: [], columns: [], values: [] }, view: 'both', chartOptions: { type: 'bar' } }))).valid).toBe(true);
    expect(validateNotebook(nbWith(chart({}))).valid).toBe(true);
  });
  it('accepts malformed optional analysis config (repaired on load by normalizeAnalysis)', () => {
    for (const md of [{ view: 3 }, { view: 'weird' }, { pivot: 'x' }, { pivot: 5 }, { pivot: [1] }, { chartOptions: 'x' }, { chartOptions: [] },
      { pivot: { rows: 'x', columns: 3, values: {}, totals: 1, sort: 'x' } }, { chartOptions: { type: 'nope', labels: 'y', title: 3, bins: 'a' } }])
      expect(validateNotebook(nbWith(chart(md))).valid).toBe(true);
    expect(normalizeAnalysis({ view: 3 }).warnings.length).toBeGreaterThan(0);
  });
  it('still requires data and spec', () => {
    expect(validateNotebook(nbWith({ id: 'b_c', type: 'chart', content: '', metadata: { spec: {} } })).valid).toBe(false);
  });
  it('round trips unknown metadata keys', () => {
    const nb = nbWith(chart({ pivot: { rows: [] }, futureKey: { a: [1, 2] } }));
    const again = parseNotebook(serializeNotebook(nb));
    expect(again.blocks[0].metadata).toEqual(nb.blocks[0].metadata);
  });
});

describe('bounded parsing', () => {
  it('100k junk entries fast with capped warnings', () => {
    const junk = Array.from({ length: 100000 }, () => ({ nope: 1 }));
    const t = Date.now();
    const r = normalizeAnalysis({ pivot: { rows: junk, columns: junk, values: junk } });
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.warnings.length).toBeLessThanOrEqual(21);
    expect(r.warnings.some((w) => /^… \d+ more$/.test(w))).toBe(true);
  });
  it('100k valid-but-over-limit entries stop early', () => {
    const many = Array.from({ length: 100000 }, (_, i) => ({ field: 'f' + i }));
    const t = Date.now();
    const r = normalizeAnalysis({ pivot: { rows: many, values: many.map((m) => ({ ...m, agg: 'sum' })) } });
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.pivot!.rows.length).toBe(6);
    expect(r.warnings.length).toBeLessThanOrEqual(21);
  });
});

import { STACKINGS as _ST, TIME_AXES as _TA } from '../src/index';
describe('exported chart option enums', () => {
  it('every stacking / timeAxis value round-trips through normalizeAnalysis', () => {
    expect(_ST.length).toBeGreaterThan(0);
    expect(_TA.length).toBeGreaterThan(0);
    for (const s of _ST) expect(normalizeAnalysis({ chartOptions: { type: 'bar', stacking: s } }).chart.stacking).toBe(s);
    for (const t of _TA) expect(normalizeAnalysis({ chartOptions: { type: 'line', timeAxis: t } }).chart.timeAxis).toBe(t);
  });
});

describe('label fields (0.5.11)', () => {
  const ref = (extra: any) => pv({ rows: [{ field: 'a', ...extra }], columns: [{ field: 'b', ...extra }], values: [] });
  const val = (format: any) => pv({ rows: [], columns: [], values: [{ field: 'x', agg: 'sum', format }] });
  it('keeps label/valueLabels/nullLabel on rows[0] and columns[0]', () => {
    const r = ref({ label: '地区', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' });
    for (const x of [r.pivot!.rows[0], r.pivot!.columns[0]]) {
      expect(x).toEqual({ field: x.field, label: '地区', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' });
    }
    expect(r.warnings).toEqual([]);
  });
  it('omits empty and whitespace-only labels', () => {
    const r = ref({ label: '  ', nullLabel: '', valueLabels: { a: '' } });
    expect(r.pivot!.rows[0]).toEqual({ field: 'a' });
    expect('label' in r.pivot!.rows[0]).toBe(false);
  });
  it('slices 300-char label to 200 without warning', () => {
    const r = ref({ label: 'x'.repeat(300) });
    expect(r.pivot!.rows[0].label).toHaveLength(200);
    expect(r.warnings).toEqual([]);
  });
  it('drops label with NUL or non-string, with warning', () => {
    for (const bad of ['a\0b', 5, {}, ['x'], null, true]) {
      const r = ref({ label: bad });
      expect(r.pivot!.rows[0].label).toBeUndefined();
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
  it('valueLabels: non-string value skipped, non-object dropped, 201 entries -> 200 + warning', () => {
    expect(ref({ valueLabels: { '5': 5, ok: 'y' } }).pivot!.rows[0].valueLabels).toEqual({ ok: 'y' });
    expect(ref({ valueLabels: ['a'] }).pivot!.rows[0].valueLabels).toBeUndefined();
    expect(ref({ valueLabels: 'x' }).pivot!.rows[0].valueLabels).toBeUndefined();
    const big: any = {}; for (let i = 0; i < 201; i++) big['k' + i] = 'v';
    const r = ref({ valueLabels: big });
    expect(Object.keys(r.pivot!.rows[0].valueLabels!)).toHaveLength(200);
    expect(r.warnings.length).toBeGreaterThan(0);
    const long = ref({ valueLabels: { ['k'.repeat(257)]: 'v', ['k'.repeat(256)]: 'w' } });
    expect(Object.keys(long.pivot!.rows[0].valueLabels!)).toEqual(['k'.repeat(256)]);
  });
  it('__proto__ key stays own, Object.prototype untouched', () => {
    const raw = JSON.parse('{"pivot":{"rows":[{"field":"a","valueLabels":{"__proto__":"P","constructor":"C"}}],"columns":[],"values":[]}}');
    const r = normalizeAnalysis(raw);
    const vl: any = r.pivot!.rows[0].valueLabels;
    expect(Object.keys(vl).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(vl, '__proto__')!.value).toBe('P');
    expect(Object.getPrototypeOf(vl)).toBe(Object.prototype);
    expect(({} as any).constructor).toBe(Object);
    expect(({} as any).P).toBeUndefined();
  });
  it('markup is kept as plain text', () => {
    expect(ref({ label: '<img src=x onerror=1>' }).pivot!.rows[0].label).toBe('<img src=x onerror=1>');
  });
  it('format.unit/scale', () => {
    expect(val({ kind: 'plain', unit: '万元', scale: 10000 }).pivot!.values[0].format).toEqual({ kind: 'plain', unit: '万元', scale: 10000 });
    for (const s of [0, -1, NaN, '10', 1e13, Infinity]) {
      const r = val({ kind: 'plain', scale: s });
      expect(r.pivot!.values[0].format).toEqual({ kind: 'plain' });
      expect(r.warnings.length).toBeGreaterThan(0);
    }
    expect(val({ kind: 'plain', scale: 1e12 }).pivot!.values[0].format!.scale).toBe(1e12);
    expect(val({ kind: 'percent', scale: 100 }).pivot!.values[0].format).toEqual({ kind: 'percent' });
    expect(val({ kind: 'plain', unit: 'u'.repeat(25) }).pivot!.values[0].format!.unit).toBe('u'.repeat(20));
    expect(val({ kind: 'plain', unit: '' }).pivot!.values[0].format).toEqual({ kind: 'plain' });
    expect(val({ kind: 'plain', unit: 5 }).warnings.length).toBeGreaterThan(0);
  });
  it('values[].label reads up to 256, new caps are 200 on other label kinds', () => {
    const r = pv({ rows: [], columns: [], values: [{ field: 'x', agg: 'sum', label: 'l'.repeat(256) }] });
    expect(r.pivot!.values[0].label).toHaveLength(256);
    const r2 = pv({ rows: [], columns: [], values: [{ field: 'x', agg: 'sum', label: 'l'.repeat(257) }] });
    expect(r2.pivot!.values[0].label).toBeUndefined();
  });
  it('summaryLabel and axisTitles', () => {
    expect(pv({ rows: [], columns: [], values: [], summaryLabel: '合计' }).pivot!.summaryLabel).toBe('合计');
    expect('summaryLabel' in pv({ rows: [], columns: [], values: [], summaryLabel: ' ' }).pivot!).toBe(false);
    const c = normalizeAnalysis({ chartOptions: { type: 'bar', axisTitles: { x: '渠道', y: '', legend: 'VIP', z: 'no' } } }).chart;
    expect(c.axisTitles).toEqual({ x: '渠道', legend: 'VIP' });
    expect('axisTitles' in normalizeAnalysis({ chartOptions: { axisTitles: { x: '' } } }).chart).toBe(false);
    expect(normalizeAnalysis({ chartOptions: { axisTitles: 'x' } }).warnings.length).toBeGreaterThan(0);
    expect(normalizeAnalysis({ chartOptions: { axisTitles: { x: 5 } } }).chart.axisTitles).toBeUndefined();
  });
  it('old fixture without label fields serializes byte-identically', () => {
    const old = serializeNotebook(nbWith(chart({
      pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum', label: 'L', format: { kind: 'thousands', decimals: 1 } }], totals: { row: false, column: false, grand: false }, sort: null },
      view: 'both', chartOptions: { type: 'bar' },
    })));
    expect(serializeNotebook(parseNotebook(old))).toBe(old);
    const m: any = (parseNotebook(old).blocks[0] as any).metadata;
    expect(JSON.stringify(normalizeAnalysis(m).pivot)).toBe(JSON.stringify(m.pivot));
  });
  it('fully labelled round trip is stable', () => {
    const raw = { pivot: { rows: [{ field: 'a', label: 'A', valueLabels: { x: 'X' }, nullLabel: 'N' }], columns: [], values: [{ field: 'v', agg: 'sum', format: { kind: 'plain', unit: '元', scale: 10 } }], summaryLabel: 'S' }, chartOptions: { type: 'bar', axisTitles: { x: 'X', y: 'Y', legend: 'L' } } };
    const a = normalizeAnalysis(raw);
    const b = normalizeAnalysis({ pivot: a.pivot, view: a.view, chartOptions: a.chart });
    expect(b).toEqual(a);
    expect(a.warnings).toEqual([]);
  });
  it('schema validates labelled example; malformed labels are repaired not rejected', () => {
    const ok = nbWith(chart({ pivot: { rows: [{ field: 'a', label: 5 }], columns: [], values: [{ field: 'v', agg: 'sum', format: { kind: 'plain', scale: 'x' } }] } }));
    expect(validateNotebook(ok).valid).toBe(true);
  });
});
