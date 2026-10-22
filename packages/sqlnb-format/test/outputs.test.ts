import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseNotebook, serializeOutFile, parseOutFile, isValidEntry, clampMaxRows, DEFAULT_MAX_ROWS, validateNotebook, createEmptyNotebook, type OutputEntry } from '../src/index';

const entry = (o: Partial<OutputEntry> = {}): OutputEntry => ({
  columns: [{ name: 'a', type: 'int' }, { name: 'b' }], rows: [[1, null], ['x', { k: [1, true] }]],
  executedAt: '2026-10-17T14:31:00Z', elapsedMs: 5, truncated: false, sqlHash: 'fnv1a32:0a1b2c3d', ...o,
});

describe('outputs', () => {
  it('round trips', () => {
    const m = { b1: entry({ truncated: true, error: 'boom', params: { s: '2026' }, upstream: { r: 'fnv1a32:00000000' } }), b0: entry() };
    const r = parseOutFile(serializeOutFile(m));
    expect(r.warnings).toEqual([]);
    expect(r.entries).toEqual(m);
  });
  it('stable key order, 2 spaces, trailing newline, no undefined', () => {
    const a = serializeOutFile({ z: entry(), a: entry({ params: undefined }) });
    const b = serializeOutFile({ a: entry(), z: entry() });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"z"'));
    expect(a).toContain('\n  "outputs"');
    expect(a).not.toContain('undefined');
  });
  it('non-finite numbers become null', () => {
    const r = parseOutFile(serializeOutFile({ a: entry({ rows: [[NaN, Infinity], [-Infinity, { n: NaN }]] }) }));
    expect(r.entries.a.rows).toEqual([[null, null], [null, { n: null }]]);
  });
  it.each(['', '[]', '{bad', '{"sqlnbOut":"2","outputs":{}}', '{"sqlnbOut":"1"}', 'null', '{"sqlnbOut":"1","outputs":[]}'])('bad file %j', (t) => {
    const r = parseOutFile(t);
    expect(r.entries).toEqual({});
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it('salvages entries', () => {
    const text = JSON.stringify({ sqlnbOut: '1', outputs: {
      ok: entry(), noExec: { ...entry(), executedAt: undefined }, badRow: entry({ rows: [[1]] }),
      badCols: { ...entry(), columns: 'x' }, badRows: { ...entry(), rows: 3 }, badParams: { ...entry(), params: [1] }, nul: null,
      badUp: { ...entry(), upstream: { a: 1 } },
    } });
    const r = parseOutFile(text);
    expect(Object.keys(r.entries).sort()).toEqual(['badUp', 'ok']);
    expect(r.entries.badUp.upstream).toBeUndefined();
    expect(r.warnings.length).toBe(7);
    expect(r.warnings).toContain('entry "noExec" is malformed and was dropped');
    expect(r.warnings).toContain('entry "nul" is malformed and was dropped');
    expect(r.warnings).toContain('entry "badUp": malformed upstream dropped');
  });
  it('isValidEntry', () => {
    expect(isValidEntry(entry())).toBe(true);
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry({ ...entry(), elapsedMs: 'x' })).toBe(false);
  });
  it('clampMaxRows', () => {
    expect(DEFAULT_MAX_ROWS).toBe(5000);
    expect([0, -1, 1e9, 'x', undefined, 2500.5, 100].map(clampMaxRows)).toEqual([1, 1, 5000, 5000, 5000, 2500, 100]);
    expect(clampMaxRows(2500.5)).toBe(2500);
    expect([clampMaxRows('5000'), clampMaxRows(true), clampMaxRows(null), clampMaxRows(NaN)]).toEqual([5000, 5000, 5000, 5000]);
    expect([clampMaxRows(-0), clampMaxRows(0)]).toEqual([1, 1]);
  });
  it('large input is fast', () => {
    const row = Array.from({ length: 50 }, (_, i) => (i % 2 ? 'str' + i : i));
    const e = entry({ columns: row.map((_, i) => ({ name: 'c' + i })), rows: Array.from({ length: 5000 }, () => row) });
    const t = Date.now();
    const r = parseOutFile(serializeOutFile({ a: e }));
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.entries.a.rows.length).toBe(5000);
  });
  it('validateNotebook maxRows', () => {
    const v = (x: unknown) => { const nb = createEmptyNotebook(); (nb.settings as any).maxRows = x; return validateNotebook(nb).valid; };
    expect([v(1), v(5000), v(0), v(5001), v('5000'), v(1.5)]).toEqual([true, true, false, false, false, false]);
  });

  it('preserves unknown entry and top-level fields, deterministic order', () => {
    const text = JSON.stringify({ sqlnbOut: '1', 'x-client': { k: 1 }, outputs: { a: { ...entry(), zz: 1, extra: { a: 1 } } } });
    const p = parseOutFile(text);
    const out = serializeOutFile(p.entries, p.extra);
    const q = parseOutFile(out);
    expect((q.entries.a as any).extra).toEqual({ a: 1 });
    expect((q.entries.a as any).zz).toBe(1);
    expect(q.extra).toEqual({ 'x-client': { k: 1 } });
    expect(out.indexOf('"sqlHash"')).toBeLessThan(out.indexOf('"extra"'));
    expect(out.indexOf('"extra"')).toBeLessThan(out.indexOf('"zz"'));
  });
  it('__proto__ keys are own properties, no pollution', () => {
    const text = '{"sqlnbOut":"1","outputs":{"__proto__":' + JSON.stringify(entry({ params: undefined })).slice(0, -1) +
      ',"params":{"__proto__":{"polluted":1},"constructor":2},"upstream":{"__proto__":"h","prototype":"p"}},"constructor":' +
      JSON.stringify(entry()) + '}}';
    const p = parseOutFile(text);
    expect(Object.keys(p.entries).sort()).toEqual(['__proto__', 'constructor']);
    const e = p.entries['__proto__'];
    expect(Object.keys(e.params!)).toEqual(['__proto__', 'constructor']);
    expect(Object.keys(e.upstream!)).toEqual(['__proto__', 'prototype']);
    expect(({} as any).polluted).toBeUndefined();
    const q = parseOutFile(serializeOutFile(p.entries));
    expect(Object.keys(q.entries).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.keys(q.entries['__proto__'].params!)).toEqual(['__proto__', 'constructor']);
    expect(Object.keys(q.entries['__proto__'].upstream!)).toEqual(['__proto__', 'prototype']);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(q.entries)).toBe(Object.prototype);
  });
  it('relaxed validity: elapsedMs/truncated/sqlHash optional', () => {
    const { elapsedMs, truncated, sqlHash, ...min } = entry();
    expect(isValidEntry(min)).toBe(true);
    const p = parseOutFile(JSON.stringify({ sqlnbOut: '1', outputs: { a: min } }));
    expect(p.warnings).toEqual([]);
    expect(p.entries.a.elapsedMs).toBe(0);
    expect(p.entries.a.truncated).toBe(false);
    expect(p.entries.a.sqlHash).toBeUndefined();
    expect(serializeOutFile(p.entries)).not.toContain('sqlHash');
  });
  it.each([['elapsedMs', 'x'], ['elapsedMs', -1], ['elapsedMs', null], ['truncated', 'yes'], ['truncated', null], ['sqlHash', 5]])('bad %s=%j dropped', (k, v) => {
    const p = parseOutFile(JSON.stringify({ sqlnbOut: '1', outputs: { a: { ...entry(), [k]: v } } }));
    expect(p.entries).toEqual({});
    expect(p.warnings.length).toBe(1);
  });
});

describe('spec/examples/with-outputs', () => {
  const dir = new URL('../../../spec/examples/', import.meta.url);
  const nbText = readFileSync(new URL('with-outputs.sqlnb', dir), 'utf8');
  const outText = readFileSync(new URL('with-outputs.sqlnb.out', dir), 'utf8');
  it('notebook validates cleanly', () => {
    const nb = parseNotebook(nbText);
    expect(validateNotebook(nb)).toEqual({ valid: true, errors: [] });
    expect(nb.settings.outputs).toBe('separate');
  });
  it('.out parses with no warnings and ids exist in the notebook', () => {
    const nb = parseNotebook(nbText);
    const r = parseOutFile(outText);
    expect(r.warnings).toEqual([]);
    const ids = new Set(nb.blocks.map((b) => b.id));
    expect(Object.keys(r.entries).length).toBe(2);
    for (const id of Object.keys(r.entries)) expect(ids.has(id)).toBe(true);
    expect(r.entries.b_q001.rows).toHaveLength(3);
    expect(r.entries.b_q002.error).toBeTruthy();
    expect(serializeOutFile(r.entries)).toBe(outText);
  });
});
