import { parseDocument, isAlias, isScalar, isMap, isSeq, visit } from 'yaml';
import type { Notebook } from './types';

export class SqlnbParseError extends Error {
  line?: number;
  column?: number;
  constructor(message: string, line?: number, column?: number) {
    super(message);
    this.name = 'SqlnbParseError';
    this.line = line;
    this.column = column;
  }
}

export function parseNotebook(text: string): Notebook {
  const src = text.replace(/\r\n?/g, '\n');
  const doc = parseDocument(src, { schema: 'core', uniqueKeys: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const pos = e.linePos?.[0];
    throw new SqlnbParseError(e.message, pos?.line, pos?.col);
  }
  const lc = (range?: [number, number, number] | null) => {
    const off = range ? range[0] : 0;
    const before = src.slice(0, off).split('\n');
    return [before.length, before[before.length - 1].length + 1] as const;
  };
  visit(doc, (_k, node) => {
    if (isAlias(node)) {
      const [l, c] = lc(node.range);
      throw new SqlnbParseError('aliases are not allowed', l, c);
    }
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor || node.tag) {
        const [l, c] = lc(node.range);
        throw new SqlnbParseError('anchors and tags are not allowed', l, c);
      }
    }
  });
  const value = doc.toJS() as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SqlnbParseError('notebook must be a YAML mapping', 1, 1);
  }
  const v = (value as Record<string, unknown>).sqlnb;
  if (v !== '1') {
    throw new SqlnbParseError(`unsupported version: ${JSON.stringify(v)}`, 1, 1);
  }
  return value as Notebook;
}
