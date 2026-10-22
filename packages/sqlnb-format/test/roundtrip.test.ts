import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseNotebook, serializeNotebook, createEmptyNotebook, validateNotebook } from '../src/index';

const lookalikes = ['no', 'on', '1.0', '0123', '2026-10-17', '~', 'null'];
const mk = (note: string, content: string) => {
  const nb = createEmptyNotebook();
  (nb.metadata as any).note = note;
  nb.blocks.push({ id: 'b_aaaaaa', type: 'markdown', content });
  return nb;
};

describe('roundtrip', () => {
  for (const v of lookalikes) {
    it(`string ${v}`, () => {
      const nb = mk(v, v);
      expect(parseNotebook(serializeNotebook(nb))).toEqual(nb);
    });
  }
  const contents = ['  SELECT 1\t\n-- x  \n---\n# h\n', '  a\nb', 'a\nb\n\n\n', 'a\nb\n', '\n\nx', ' \n x\n', '', 'one line', 'x\n  \n'];
  for (const c of contents) {
    it(`content ${JSON.stringify(c)}`, () => {
      const nb = mk('t', c);
      const out = parseNotebook(serializeNotebook(nb));
      expect(out.blocks[0].content).toBe(c);
    });
  }
  const adversarial = [' \n', '  \n', '\n  ', '\t\n', ' ', '\n', '\n\n\n', '\tx\t\n\t', 'a\r\nb\r\n', 'a\u2028b\nc', '\u2028\n', ' \n \n', '\n x', 'x\n '];
  for (const c of adversarial) {
    it(`adversarial ${JSON.stringify(c)}`, () => {
      const nb = mk(c, c);
      const out = parseNotebook(serializeNotebook(nb));
      expect(out.blocks[0].content).toBe(c);
      expect((out.metadata as any).note).toBe(c);
      expect(serializeNotebook(out)).toBe(serializeNotebook(nb));
    });
  }
  it('in-memory CRLF content survives', () => {
    const nb = mk('t', 'a\r\nb\r\n');
    expect(parseNotebook(serializeNotebook(nb)).blocks[0].content).toBe('a\r\nb\r\n');
  });
  it('CRLF normalizes', () => {
    const text = serializeNotebook(mk('t', 'a\nb\n')).replace(/\n/g, '\r\n');
    expect(parseNotebook(text).blocks[0].content).toBe('a\nb\n');
  });
  it('preserves unknowns', () => {
    const nb = mk('t', 'x');
    nb.foo = { a: 1 };
    nb.blocks.push({ id: 'b_bbbbbb', type: 'python', content: 'print(1)', weird: [1, 'x', { k: null }] });
    expect(parseNotebook(serializeNotebook(nb))).toEqual(nb);
  });
  it('idempotent', () => {
    const nb = mk('no', 'a\nb');
    nb.foo = { a: 1 };
    const s1 = serializeNotebook(parseNotebook(serializeNotebook(nb)));
    expect(s1).toBe(serializeNotebook(nb));
  });
});

describe('prototype-ish keys', () => {
  it('round-trips __proto__/constructor unknown keys without pollution', () => {
    const src = 'sqlnb: "1"\n__proto__:\n  a: 1\nconstructor: 2\nblocks:\n  - id: b_aaaaaa\n    type: markdown\n    __proto__:\n      z: 1\n    prototype: 3\n';
    const a = parseNotebook(src) as any;
    expect(Object.prototype.hasOwnProperty.call(a, '__proto__')).toBe(true);
    const text = serializeNotebook(a);
    expect(text).toContain('__proto__');
    const b = parseNotebook(text) as any;
    expect(b).toEqual(a);
    expect(Object.getOwnPropertyDescriptor(b.blocks[0], '__proto__')?.value).toEqual({ z: 1 });
    expect(Object.getOwnPropertyDescriptor(b, '__proto__')?.value).toEqual({ a: 1 });
    expect(({} as any).a).toBeUndefined();
    expect(({} as any).z).toBeUndefined();
  });
});

describe('settings catalog defaults', () => {
  it('validate and round-trip', () => {
    const nb = createEmptyNotebook();
    nb.settings.defaultDatabase = 'biz';
    nb.settings.defaultSchema = 'public';
    expect(validateNotebook(nb).valid).toBe(true);
    const out = parseNotebook(serializeNotebook(nb));
    expect(out.settings.defaultDatabase).toBe('biz');
    expect(out.settings.defaultSchema).toBe('public');
    expect(out).toEqual(nb);
  });
  it('rejects non-string', () => {
    const nb = createEmptyNotebook();
    (nb.settings as any).defaultDatabase = 5;
    expect(validateNotebook(nb).valid).toBe(false);
  });

  describe('legacy metadata.title is an unknown key: loads, validates, no special handling', () => {
    const titles: unknown[] = ['旧标题', '', 'no', '<b>x</b> 🎉 "q" \\ : #', '0123', '~', 'a\u2028b', ' lead and trail ', 42, true, null, ['a'], { k: 1 }];
    for (const title of titles) {
      it(`${JSON.stringify(title)} loads and validates`, () => {
        const text = `sqlnb: "1"\nmetadata:\n  title: ${JSON.stringify(title)}\nblocks:\n  - id: b_aaaaaa\n    type: markdown\n    content: x\n`;
        const nb = parseNotebook(text);
        expect(nb.blocks[0].content).toBe('x');
        expect(validateNotebook(nb)).toEqual({ valid: true, errors: [] });
        expect((nb.metadata as any).title).toEqual(title);
        const again = parseNotebook(serializeNotebook(nb));
        expect((again.metadata as any).title).toEqual(title);
        expect(serializeNotebook(again)).toBe(serializeNotebook(nb));
      });
    }
    it('the schema and types no longer name title in metadata', () => {
      const schema = JSON.parse(readFileSync(new URL('../../../spec/sqlnb-v1.schema.json', import.meta.url), 'utf8'));
      expect(Object.keys(schema.properties.metadata.properties)).not.toContain('title');
      expect(schema.properties.metadata.additionalProperties).not.toBe(false);
    });
    it('new notebooks have no title key and createEmptyNotebook takes no title', () => {
      const nb = createEmptyNotebook();
      expect('title' in nb.metadata).toBe(false);
      expect(createEmptyNotebook.length).toBe(0);
      expect(serializeNotebook(nb)).not.toMatch(/title/);
    });
    it('unknown metadata keys (general rule) are preserved in any order', () => {
      const text = 'blocks:\n  - id: b_aaaaaa\n    type: markdown\n    content: x\nmetadata:\n  modifiedAt: "2026-01-02T00:00:00.000Z"\n  extra: {k: [1, 2]}\n  createdAt: "2026-01-01T00:00:00.000Z"\nsqlnb: "1"\n';
      const out = parseNotebook(serializeNotebook(parseNotebook(text)));
      expect(out.metadata).toEqual({ modifiedAt: '2026-01-02T00:00:00.000Z', extra: { k: [1, 2] }, createdAt: '2026-01-01T00:00:00.000Z' });
      expect(validateNotebook(out).valid).toBe(true);
    });
  });
});

describe('big-number additive keys roundtrip', () => {
  const head = 'sqlnb: "1"\nmetadata:\n  title: "t"\nblocks:\n  - id: "b_sal1"\n    type: "sql"\n    content: "select 1"\n    metadata:\n      resultName: "r"\n  - id: "b_kpi1"\n    type: "big-number"\n    metadata:\n';
  it('parse→serialize keeps filter/compare/unknown extra keys on a metric entry byte-for-byte', () => {
    const nb1 = parseNotebook(head + '      data: "r"\n      value: { field: "a", aggregate: "sum" }\n      metrics:\n        - field: "a"\n          aggregate: "sum"\n          filter:\n            - { field: "b", op: "=", value: "EU" }\n          compare: { kind: "mom", dateField: "d" }\n          futureKey: { x: 1 }\n');
    const once = serializeNotebook(nb1);
    expect(serializeNotebook(parseNotebook(once))).toBe(once);
    const m: any = (nb1.blocks[1] as any).metadata.metrics[0];
    expect(m.filter).toEqual([{ field: 'b', op: '=', value: 'EU' }]);
    expect(m.compare).toEqual({ kind: 'mom', dateField: 'd' });
    expect(m.futureKey).toEqual({ x: 1 });
    expect(once).toContain('futureKey');
    expect(once).toContain('dateField');
  });
  it('an old 0.5.8 big-number file round-trips byte-identical', () => {
    const nb = parseNotebook(head + '      data: "r"\n      value: { field: "a", aggregate: "sum" }\n      label: "L"\n');
    const once = serializeNotebook(nb);
    expect(serializeNotebook(parseNotebook(once))).toBe(once);
    expect(parseNotebook(once)).toEqual(nb);
  });
});
