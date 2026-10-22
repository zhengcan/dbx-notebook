export interface OutputEntry {
  columns: { name: string; type?: string }[];
  rows: unknown[][];
  executedAt: string;
  elapsedMs: number;
  truncated: boolean;
  error?: string | null;
  sqlHash?: string;
  params?: Record<string, unknown>;
  upstream?: Record<string, string>;
  [unknown: string]: unknown;
}

const KNOWN = ['columns', 'rows', 'executedAt', 'elapsedMs', 'truncated', 'error', 'sqlHash', 'params', 'upstream'];

function setOwn(o: object, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export const DEFAULT_MAX_ROWS = 5000;

export function clampMaxRows(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_ROWS;
  return Math.min(DEFAULT_MAX_ROWS, Math.max(1, Math.floor(v)));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string');

export function isValidEntry(v: unknown): v is OutputEntry {
  if (!isObj(v)) return false;
  if (!Array.isArray(v.columns) || !v.columns.every((c) => isObj(c) && typeof c.name === 'string')) return false;
  if (!Array.isArray(v.rows)) return false;
  const n = v.columns.length;
  if (!v.rows.every((r) => Array.isArray(r) && r.length === n)) return false;
  if (typeof v.executedAt !== 'string') return false;
  if (v.elapsedMs !== undefined && (typeof v.elapsedMs !== 'number' || !Number.isFinite(v.elapsedMs) || v.elapsedMs < 0)) return false;
  if (v.truncated !== undefined && typeof v.truncated !== 'boolean') return false;
  if (v.sqlHash !== undefined && typeof v.sqlHash !== 'string') return false;
  if (v.error != null && typeof v.error !== 'string') return false;
  if (v.params !== undefined && !isObj(v.params)) return false;
  if (v.upstream !== undefined && !isStrMap(v.upstream)) return false;
  return true;
}

function clean(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(clean);
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) setOwn(o, k, clean(v[k]));
    return o;
  }
  return v;
}

function cleanEntry(e: OutputEntry): Record<string, unknown> {
  const o: Record<string, unknown> = {
    columns: e.columns.map((c) => (c.type === undefined ? { name: c.name } : { name: c.name, type: c.type })),
    rows: e.rows.map((r) => r.map(clean)),
    executedAt: e.executedAt,
    elapsedMs: clean(e.elapsedMs),
    truncated: e.truncated,
  };
  if (e.error !== undefined) o.error = e.error;
  if (e.sqlHash !== undefined) o.sqlHash = e.sqlHash;
  if (e.params !== undefined) o.params = clean(e.params);
  if (e.upstream !== undefined) o.upstream = clean(e.upstream);
  for (const k of Object.keys(e).sort()) {
    if (!KNOWN.includes(k) && e[k] !== undefined) setOwn(o, k, clean(e[k]));
  }
  return o;
}

export function serializeOutFile(entries: Record<string, OutputEntry>, extra: Record<string, unknown> = {}): string {
  const outputs: Record<string, unknown> = {};
  for (const id of Object.keys(entries).sort()) setOwn(outputs, id, cleanEntry(entries[id]));
  const doc: Record<string, unknown> = {};
  for (const k of Object.keys(extra).sort()) if (k !== 'sqlnbOut' && k !== 'outputs') setOwn(doc, k, clean(extra[k]));
  setOwn(doc, 'sqlnbOut', '1');
  setOwn(doc, 'outputs', outputs);
  return JSON.stringify(doc, null, 2) + '\n';
}

export function parseOutFile(text: string): { entries: Record<string, OutputEntry>; warnings: string[]; extra: Record<string, unknown> } {
  const entries: Record<string, OutputEntry> = {};
  const warnings: string[] = [];
  const extra: Record<string, unknown> = {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { entries, warnings: ['result file is not valid JSON'], extra };
  }
  if (!isObj(doc)) return { entries, warnings: ['result file is not a JSON object'], extra };
  if (doc.sqlnbOut !== '1') return { entries, warnings: [`unsupported result file version: ${JSON.stringify(doc.sqlnbOut)}`], extra };
  if (!isObj(doc.outputs)) return { entries, warnings: ['result file has no "outputs" map'], extra };
  for (const k of Object.keys(doc)) if (k !== 'sqlnbOut' && k !== 'outputs') setOwn(extra, k, doc[k]);
  const accept = (id: string, raw: Record<string, unknown>) => {
    const e: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) setOwn(e, k, raw[k]);
    if (e.elapsedMs === undefined) e.elapsedMs = 0;
    if (e.truncated === undefined) e.truncated = false;
    setOwn(entries, id, e);
  };
  for (const id of Object.keys(doc.outputs)) {
    const raw = doc.outputs[id];
    if (isObj(raw) && raw.upstream !== undefined && !isStrMap(raw.upstream)) {
      warnings.push(`entry "${id}": malformed upstream dropped`);
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(raw)) if (k !== 'upstream') setOwn(rest, k, raw[k]);
      if (isValidEntry(rest)) { accept(id, rest); continue; }
    }
    if (isValidEntry(raw)) accept(id, raw);
    else warnings.push(`entry "${id}" is malformed and was dropped`);
  }
  return { entries, warnings, extra };
}
