import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseNotebook, serializeNotebook, validateNotebook, buildPortableSpec } from '../src/index';

const dir = new URL('../../../spec/examples/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sqlnb'));

describe('spec/examples', () => {
  for (const f of files) {
    it(`${f} validates and parse→serialize is stable`, () => {
      const nb = parseNotebook(readFileSync(new URL(f, dir), 'utf8'));
      expect(validateNotebook(nb)).toEqual({ valid: true, errors: [] });
      const once = serializeNotebook(nb);
      expect(serializeNotebook(parseNotebook(once))).toBe(once);
      expect(parseNotebook(once)).toEqual(nb);
    });
  }

  it('full.sqlnb pivot chart carries the generated portable spec', () => {
    const nb = parseNotebook(readFileSync(new URL('full.sqlnb', dir), 'utf8'));
    const b: any = nb.blocks.find((x) => x.id === 'b_ch02');
    const r: any = buildPortableSpec({
      dataName: b.metadata.data, title: b.metadata.chartOptions.title, pivot: b.metadata.pivot, chart: b.metadata.chartOptions,
      columns: [{ name: 'order_date', kind: 'temporal' }, { name: 'region', kind: 'text' }, { name: 'amount', kind: 'number' }],
    });
    expect(b.metadata.spec).toEqual(r.spec);
    expect(JSON.stringify(b.metadata.spec)).not.toContain('"values":[');
  });

  it('chart and big-number blocks in examples have no outputs', () => {
    const nb = parseNotebook(readFileSync(new URL('full.sqlnb', dir), 'utf8'));
    for (const b of nb.blocks) if (b.type === 'chart' || b.type === 'big-number') expect((b as any).outputs).toBeUndefined();
  });
});

describe('big-number examples', () => {
  it('full.sqlnb has a multi-metric big-number whose value mirrors metrics[0]', () => {
    const nb = parseNotebook(readFileSync(new URL('full.sqlnb', dir), 'utf8'));
    const b: any = nb.blocks.find((x: any) => x.type === 'big-number' && Array.isArray(x.metadata.metrics));
    expect(b).toBeDefined();
    expect(b.metadata.metrics.length).toBeGreaterThan(1);
    expect(b.metadata.value).toEqual({ field: b.metadata.metrics[0].field, aggregate: b.metadata.metrics[0].aggregate });
  });

  it('big-number-compare.sqlnb carries filter, compare and distinct on metrics', () => {
    const nb = parseNotebook(readFileSync(new URL('big-number-compare.sqlnb', dir), 'utf8'));
    const b: any = nb.blocks.find((x: any) => x.type === 'big-number');
    expect(b.metadata.metrics[0].filter).toHaveLength(1);
    expect(b.metadata.metrics[0].compare.kind).toBe('mom');
    expect(b.metadata.metrics[1].aggregate).toBe('distinct');
  });
});
