import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNotebook, SqlnbParseError } from '../src/index';

const full = readFileSync(new URL('../../../spec/examples/full.sqlnb', import.meta.url), 'utf8');
const base = 'sqlnb: "1"\nmetadata: {}\nsettings: {outputs: "separate"}\nconnections: []\nblocks: []\n';

describe('parseNotebook', () => {
  it('parses full example', () => {
    const nb = parseNotebook(full);
    expect(nb.blocks.map((b) => b.type)).toEqual(['markdown', 'input', 'input', 'input', 'input', 'input', 'sql', 'sql', 'sql', 'sql', 'chart', 'big-number', 'big-number', 'sql', 'chart', 'big-number']);
  });
  it('rejects unsupported version', () => {
    expect(() => parseNotebook(base.replace('"1"', '"2"'))).toThrow(/unsupported version/);
    expect(() => parseNotebook(base.replace('"1"', '"2"'))).toThrow(SqlnbParseError);
  });
  it('reports line on bad yaml', () => {
    try { parseNotebook('sqlnb: "1"\nfoo: [1,\nbar: }\n'); throw new Error('no'); }
    catch (e) { expect(e).toBeInstanceOf(SqlnbParseError); expect((e as SqlnbParseError).line).toBeGreaterThan(0); expect((e as SqlnbParseError).column).toBeGreaterThan(0); }
  });
  it('rejects anchors, aliases, tags', () => {
    for (const [extra, msg] of [['x: &a 1\n', /anchors and tags/], ['x: &a 1\ny: *a\n', /not allowed/], ['x: !!str 1\n', /anchors and tags/]] as const) {
      try { parseNotebook(base + extra); throw new Error('no throw'); }
      catch (e) {
        expect(e).toBeInstanceOf(SqlnbParseError);
        expect((e as Error).message).toMatch(msg);
        expect((e as SqlnbParseError).line).toBeGreaterThan(0);
      }
    }
  });
});
