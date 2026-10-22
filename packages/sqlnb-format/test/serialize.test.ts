import { describe, it, expect } from 'vitest';
import { serializeNotebook, createEmptyNotebook } from '../src/index';

describe('serializeNotebook', () => {
  it('orders top-level keys', () => {
    const nb: any = { zzz: 1, blocks: [], connections: [], clients: { a: {} }, settings: { outputs: 'separate' }, metadata: {}, sqlnb: '1', foo: 2 };
    const keys = serializeNotebook(nb).split('\n').filter((l) => /^\w/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['sqlnb', 'metadata', 'settings', 'connections', 'blocks', 'clients', 'zzz', 'foo']);
  });
  it('orders block keys', () => {
    const nb = createEmptyNotebook();
    nb.blocks.push({ extra: 1, outputs: 'o', metadata: { a: 1 }, content: 'c', type: 'sql', id: 'b_aaaaaa' });
    const s = serializeNotebook(nb).split('blocks:')[1];
    const idx = ['id:', 'type:', 'content:', 'metadata:', 'outputs:', 'extra:'].map((k) => s.indexOf(k));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(idx.every((i) => i >= 0)).toBe(true);
  });
  it('uses block literals', () => {
    const nb = createEmptyNotebook();
    nb.blocks.push({ id: 'b_aaaaaa', type: 'sql', content: 'a\nb\n' });
    nb.blocks.push({ id: 'b_bbbbbb', type: 'sql', content: 'a\nb' });
    const s = serializeNotebook(nb);
    expect(s).toMatch(/content: \|\n/);
    expect(s).toMatch(/content: \|-\n/);
  });
  it('no anchors', () => {
    const shared = { a: 1 };
    const nb = createEmptyNotebook();
    (nb.metadata as any).note = 'R&D *team* &x';
    nb.x = shared; nb.y = shared; nb.z = ['&a', '*b', 'a & b'];
    const s = serializeNotebook(nb);
    expect(s).not.toMatch(/(^|[\s:-])&[A-Za-z0-9_]+\s*$/m);
    expect(s).not.toMatch(/:\s+\*[A-Za-z0-9_]+\s*$/m);
    expect(s).not.toMatch(/^\s*-\s+\*[A-Za-z0-9_]+\s*$/m);
    expect(s).toContain('"R&D *team* &x"');
  });
});
