import { Document, isScalar, visit, parse } from 'yaml';
import type { Notebook } from './types';

const TOP = ['sqlnb', 'metadata', 'settings', 'connections', 'blocks', 'clients'];
const BLOCK = ['id', 'type', 'content', 'metadata', 'outputs'];

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function put(o: Record<string, unknown>, k: string, v: unknown) {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

function order(obj: Record<string, unknown>, first: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of first) if (has(obj, k)) put(out, k, obj[k]);
  for (const k of Object.keys(obj)) if (!has(out, k)) put(out, k, obj[k]);
  return out;
}

export function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) put(o, k, clone(x));
    return o;
  }
  return v;
}

function literalRoundTrips(s: string): boolean {
  try {
    const d = new Document({ k: s });
    visit(d, { Scalar(key, n) { if (key !== 'key') n.type = 'BLOCK_LITERAL'; } });
    const back = parse(d.toString({ lineWidth: 0, indent: 2 }), { schema: 'core' }) as { k?: unknown };
    return back.k === s;
  } catch {
    return false;
  }
}

export function serializeNotebook(nb: Notebook): string {
  const top = order(clone(nb) as Record<string, unknown>, TOP);
  if (Array.isArray(top.blocks)) {
    top.blocks = top.blocks.map((b) => (b && typeof b === 'object' ? order(b as Record<string, unknown>, BLOCK) : b));
  }
  const doc = new Document(top, { aliasDuplicateObjects: false });
  visit(doc, {
    Scalar(key, node) {
      if (key === 'key') return;
      if (typeof node.value === 'string') {
        const s = node.value;
        node.type = s.includes('\n') && !s.includes('\r') && literalRoundTrips(s) ? 'BLOCK_LITERAL' : 'QUOTE_DOUBLE';
      }
    },
    Pair(_k, pair) {
      if (isScalar(pair.key) && typeof pair.key.value === 'string') pair.key.type = 'PLAIN';
    },
  });
  return doc.toString({ lineWidth: 0, indent: 2, doubleQuotedAsJSON: true, blockQuote: 'literal' });
}
