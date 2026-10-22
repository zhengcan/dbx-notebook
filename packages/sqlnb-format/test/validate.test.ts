import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateNotebook, createEmptyNotebook, parseNotebook } from '../src/index';

const sql = (id: string, resultName?: string) => ({ id, type: 'sql', content: 'select 1', ...(resultName ? { metadata: { resultName } } : { metadata: {} }) });
const nbWith = (...blocks: any[]) => { const nb = createEmptyNotebook(); nb.blocks.push(...blocks); return nb; };

describe('validateNotebook', () => {
  it('empty valid', () => expect(validateNotebook(createEmptyNotebook())).toEqual({ valid: true, errors: [] }));
  it('missing id', () => {
    const r = validateNotebook(nbWith({ type: 'markdown' }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '/blocks/0/id')).toBe(true);
  });
  it('duplicate id', () => {
    const r = validateNotebook(nbWith(sql('b_a'), sql('b_a')));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '/blocks/1/id')).toBe(true);
  });
  it('bad resultName', () => expect(validateNotebook(nbWith(sql('b_a', '1abc'))).valid).toBe(false));
  it('duplicate resultName', () => {
    const r = validateNotebook(nbWith(sql('b_a', 'r'), sql('b_b', 'r')));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '/blocks/1/metadata/resultName')).toBe(true);
  });
  it('missing resultName ok, dupes only among present', () => expect(validateNotebook(nbWith(sql('b_a'), sql('b_b'))).valid).toBe(true));
  it('unknown type ok', () => expect(validateNotebook(nbWith({ id: 'b_a', type: 'python', content: 'x' })).valid).toBe(true));
  it('sql without metadata ok', () => expect(validateNotebook(nbWith({ id: 'b_a', type: 'sql', content: 'select 1' })).valid).toBe(true));
  it('source database ok', () => expect(validateNotebook(nbWith({ id: 'b_a', type: 'sql', content: 's', metadata: { source: 'database' } })).valid).toBe(true));
  it('source bogus rejected', () => expect(validateNotebook(nbWith({ id: 'b_a', type: 'sql', content: 's', metadata: { source: 'x' } })).valid).toBe(false));
  for (const f of ['full', 'minimal']) {
    it(`example ${f} valid`, () => {
      const nb = parseNotebook(readFileSync(new URL(`../../../spec/examples/${f}.sqlnb`, import.meta.url), 'utf8'));
      expect(validateNotebook(nb)).toEqual({ valid: true, errors: [] });
    });
  }

  describe('big-number additive keys', () => {
    const bn = (metrics?: any[]) => ({ id: 'b_bn0001', type: 'big-number', metadata: { data: 'r', value: { field: 'a', aggregate: 'sum' }, ...(metrics ? { metrics } : {}) } });
    it('big-number with metrics[].filter/compare/distinct validates', () => {
      const m = [{ field: 'a', aggregate: 'distinct', filter: [{ field: 'b', op: 'in', value: ['x', 'y'] }, { field: 'c', op: 'isNull' }], compare: { kind: 'yoy', dateField: 'd' } }];
      expect(validateNotebook(nbWith(sql('b_s', 'r'), bn(m)))).toEqual({ valid: true, errors: [] });
    });
    it('unknown op / compare.kind / aggregate "distinct2" still validates (schema unconstrained)', () => {
      const m = [{ field: 'a', aggregate: 'distinct2', filter: [{ field: 'b', op: 'regex', value: 'x' }], compare: { kind: 'qoq', dateField: 'd' } }];
      expect(validateNotebook(nbWith(sql('b_s', 'r'), bn(m)))).toEqual({ valid: true, errors: [] });
    });
    it('file without new keys unchanged', () => {
      expect(validateNotebook(nbWith(sql('b_s', 'r'), bn([{ field: 'a', aggregate: 'sum' }])))).toEqual({ valid: true, errors: [] });
      expect(validateNotebook(nbWith(sql('b_s', 'r'), bn()))).toEqual({ valid: true, errors: [] });
    });
  });
});
