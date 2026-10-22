export type InputType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface InputVar {
  name: string;
  inputType: InputType;
  value: unknown;
  multiple?: boolean;
}

export type ParamErrorCode = 'UNRESOLVED' | 'UNSET' | 'INVALID' | 'FORBIDDEN_POSITION' | 'DUPLICATE';

export class ParamError extends Error {
  code: ParamErrorCode;
  variable?: string;
  offset?: number;
  constructor(code: ParamErrorCode, message: string, opts: { variable?: string; offset?: number } = {}) {
    super(message);
    this.name = 'ParamError';
    this.code = code;
    this.variable = opts.variable;
    this.offset = opts.offset;
  }
}

type Family = 'postgres' | 'mysql' | 'clickhouse' | 'sqlserver' | 'sqlite' | 'oracle' | 'duckdb' | 'unknown';

function family(dbType: string): Family {
  switch (String(dbType).toLowerCase()) {
    case 'postgres': case 'postgresql': case 'cockroach': case 'redshift': case 'greenplum': return 'postgres';
    case 'mysql': case 'mariadb': case 'tidb': case 'doris': case 'starrocks': return 'mysql';
    case 'clickhouse': return 'clickhouse';
    case 'sqlserver': case 'mssql': return 'sqlserver';
    case 'sqlite': return 'sqlite';
    case 'oracle': return 'oracle';
    case 'duckdb': return 'duckdb';
    default: return 'unknown';
  }
}

const invalid = (v: InputVar, rule: string) =>
  new ParamError('INVALID', `Variable "${v.name}" is invalid: ${rule}`, { variable: v.name });

const isUnset = (x: unknown) => x === undefined || x === null || x === '';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function text(v: InputVar, x: unknown, f: Family): string {
  if (typeof x !== 'string') throw invalid(v, 'expected a string');
  if (CONTROL.test(x)) throw invalid(v, 'contains NUL or control characters');
  if (LONE_SURROGATE.test(x)) throw invalid(v, 'contains invalid Unicode');
  let s = x;
  if (f === 'mysql' || f === 'clickhouse') s = s.replace(/\\/g, '\\\\');
  else if (f === 'unknown' && s.includes('\\')) throw invalid(v, 'backslash not allowed for this database type');
  let e = '';
  if (f === 'postgres' && s.includes('\\')) { s = s.replace(/\\/g, '\\\\'); e = 'E'; }
  s = s.replace(/'/g, "''");
  const n = f === 'sqlserver' && /[^\u0000-\u007f]/.test(s) ? 'N' : e;
  return `${n}'${s}'`;
}

const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function number(v: InputVar, x: unknown): string {
  let s: string;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw invalid(v, 'number must be finite');
    s = String(x);
  } else if (typeof x === 'string') s = x;
  else throw invalid(v, 'expected a number');
  if (!NUM_RE.test(s)) throw invalid(v, 'does not match numeric format');
  if (!Number.isFinite(Number(s))) throw invalid(v, 'number must be finite');
  const neg = s.startsWith('-');
  const body = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, '');
  return neg ? `(-${body})` : body;
}

function date(v: InputVar, x: unknown, f: Family): string {
  if (typeof x !== 'string') throw invalid(v, 'expected a date string');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  if (!m) throw invalid(v, 'date must be YYYY-MM-DD');
  const y = +m[1], mo = +m[2], d = +m[3];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (mo < 1 || mo > 12 || d < 1 || d > dim) throw invalid(v, 'not a real calendar date');
  return f === 'oracle' ? `DATE '${x}'` : `'${x}'`;
}

function bool(v: InputVar, x: unknown, f: Family): string {
  if (typeof x !== 'boolean') throw invalid(v, 'expected a boolean');
  if (f === 'sqlserver' || f === 'sqlite' || f === 'oracle') return x ? '1' : '0';
  return x ? 'TRUE' : 'FALSE';
}

function element(v: InputVar, x: unknown, f: Family): string {
  if (typeof x === 'string') return text(v, x, f);
  if (typeof x === 'number') return number(v, x);
  if (typeof x === 'boolean') return bool(v, x, f);
  throw invalid(v, 'unsupported option value type');
}

export function renderLiteral(v: InputVar, dbType: string): string {
  const f = family(dbType);
  const x = v.value;
  if (isUnset(x) || (Array.isArray(x) && x.length === 0 && v.inputType === 'select' && v.multiple)) {
    throw new ParamError('UNSET', `Variable "${v.name}" has no value`, { variable: v.name });
  }
  switch (v.inputType) {
    case 'text': return text(v, x, f);
    case 'number': return number(v, x);
    case 'date': return date(v, x, f);
    case 'boolean': return bool(v, x, f);
    case 'select':
      if (v.multiple) {
        if (!Array.isArray(x)) throw invalid(v, 'expected an array for multiple selection');
        return `(${x.map((e) => element(v, e, f)).join(', ')})`;
      }
      if (Array.isArray(x)) throw invalid(v, 'expected a single value');
      return element(v, x, f);
    default: throw invalid(v, 'unknown input type');
  }
}

/**
 * Lexical scanner for SQL used to decide whether a `{{ }}` reference sits in code.
 *
 * Residual risks that are NOT mitigated: MySQL NO_BACKSLASH_ESCAPES (doubling `\`
 * only alters the data; it cannot break out of the literal) and multibyte client
 * charsets (GBK/Big5/SJIS) where a trailing byte can swallow an escape.
 */

/** @internal */
export type SqlTokenKind = 'code' | 'string' | 'dquote' | 'backtick' | 'line' | 'block' | 'dollar' | 'bracket';
/** @internal */
export interface SqlToken { kind: SqlTokenKind; start: number; end: number }

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const CLOSERS: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

/** @internal */
export function scanSql(sql: string, dbType: string): SqlToken[] {
  const f = family(dbType);
  const backslash = f === 'mysql' || f === 'clickhouse';
  const hashComment = backslash;
  const dollar = f === 'postgres' || f === 'duckdb';
  const nested = f === 'postgres' || f === 'duckdb' || f === 'sqlserver';
  const toks: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  let codeStart = 0;
  const push = (kind: SqlTokenKind, start: number, end: number) => {
    if (codeStart < start) toks.push({ kind: 'code', start: codeStart, end: start });
    toks.push({ kind, start, end });
    codeStart = end;
    i = end;
  };
  const quoted = (q: string, esc: boolean, kind: SqlTokenKind, start = i, from = i + 1) => {
    let j = from;
    while (j < n) {
      const c = sql[j];
      if (esc && c === '\\') { j += 2; continue; }
      if (c === q) {
        if (sql[j + 1] === q) { j += 2; continue; }
        j++;
        push(kind, start, Math.min(j, n));
        return;
      }
      j++;
    }
    push(kind, start, n);
  };
  const lineEnd = () => {
    let j = i;
    while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
    push('line', i, j);
  };
  const prevIdent = () => i > 0 && IDENT_CHAR.test(sql[i - 1]);
  while (i < n) {
    const c = sql[i];
    if (c === "'") quoted("'", backslash, 'string');
    else if (c === '"') quoted('"', backslash, 'dquote');
    else if (c === '`') quoted('`', false, 'backtick');
    else if (c === '[' && f === 'sqlserver') quoted(']', false, 'bracket');
    else if (c === '-' && sql[i + 1] === '-') lineEnd();
    else if (c === '#' && hashComment) lineEnd();
    else if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else if (nested && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else j++;
      }
      push('block', start, Math.min(j, n));
    } else if (f === 'postgres' && (c === 'e' || c === 'E') && sql[i + 1] === "'" && !prevIdent()) {
      quoted("'", true, 'string', i, i + 2);
    } else if (f === 'oracle' && (c === 'q' || c === 'Q') && sql[i + 1] === "'" && !prevIdent()
      && i + 2 < n && !/\s/.test(sql[i + 2])) {
      const d = sql[i + 2];
      const close = (CLOSERS[d] ?? d) + "'";
      const e = sql.indexOf(close, i + 3);
      push('string', i, e < 0 ? n : e + 2);
    } else if (dollar && c === '$' && !prevIdent()) {
      const m = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i, i + 200));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        push('dollar', i, e < 0 ? n : e + m[0].length);
      } else i++;
    } else i++;
  }
  if (codeStart < n) toks.push({ kind: 'code', start: codeStart, end: n });
  return toks;
}

const REF_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,62})\s*\}\}/g;

export function findParamRefs(sql: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  for (const m of sql.matchAll(REF_RE)) out.push({ name: m[1], start: m.index!, end: m.index! + m[0].length });
  return out;
}

export function renderSql(sql: string, vars: InputVar[], dbType: string): { sql: string; used: Record<string, unknown> } {
  const byName = new Map<string, InputVar>();
  for (const v of vars) {
    if (byName.has(v.name)) throw new ParamError('DUPLICATE', `Duplicate variable "${v.name}"`, { variable: v.name });
    byName.set(v.name, v);
  }
  const refs = findParamRefs(sql);
  const used: Record<string, unknown> = {};
  if (refs.length === 0) return { sql, used };
  const toks = scanSql(sql, dbType);
  let t = 0;
  let out = '';
  let pos = 0;
  const refEnds = new Set<number>();
  for (const r of refs) {
    while (toks[t].end <= r.start) t++;
    if (toks[t].kind !== 'code') {
      throw new ParamError('FORBIDDEN_POSITION', `Variable "${r.name}" is not allowed inside strings, identifiers or comments`, { variable: r.name, offset: r.start });
    }
    const v = byName.get(r.name);
    if (!v) throw new ParamError('UNRESOLVED', `Variable "${r.name}" is not defined`, { variable: r.name, offset: r.start });
    out += sql.slice(pos, r.start) + (pos === r.start && pos > 0 && out.length > 0 && refEnds.has(pos) ? ' ' : '') + renderLiteral(v, dbType);
    refEnds.add(r.end);
    used[r.name] = v.value;
    pos = r.end;
  }
  return { sql: out + sql.slice(pos), used };
}
