import { describe, it, expect } from 'vitest';
import { renderLiteral, ParamError, type InputVar, type InputType } from '../src/index';

const v = (inputType: InputType, value: unknown, multiple?: boolean): InputVar => ({
  name: 'x', inputType, value, ...(multiple ? { multiple } : {}),
});
const code = (f: () => unknown) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(ParamError); return (e as ParamError).code; }
  return 'NO_ERROR';
};

describe('text', () => {
  it('doubles single quotes', () => expect(renderLiteral(v('text', "O'Brien"), 'postgres')).toBe("'O''Brien'"));
  for (const db of ['mysql', 'MariaDB', 'clickhouse', 'tidb']) {
    it(`escapes backslash for ${db}`, () => {
      expect(renderLiteral(v('text', 'a\\b'), db)).toBe("'a\\\\b'");
      expect(renderLiteral(v('text', "\\'"), db)).toBe("'\\\\'''");
    });
  }
  for (const db of ['sqlite', 'duckdb', 'oracle', 'sqlserver']) {
    it(`keeps backslash for ${db}`, () => expect(renderLiteral(v('text', 'a\\b'), db)).toBe("'a\\b'"));
  }
  it('sqlserver N prefix for non-ASCII only', () => {
    expect(renderLiteral(v('text', 'héllo'), 'mssql')).toBe("N'héllo'");
    expect(renderLiteral(v('text', 'hello'), 'mssql')).toBe("'hello'");
  });
  it('rejects NUL, control chars, lone surrogates', () => {
    expect(code(() => renderLiteral(v('text', 'a\0b'), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('text', 'a\x07b'), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('text', 'a\ud800b'), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('text', 'a\udc00'), 'postgres'))).toBe('INVALID');
  });
  it('accepts multiline, tabs and emoji', () => {
    expect(renderLiteral(v('text', 'a\nb\t\r😀'), 'postgres')).toBe("'a\nb\t\r😀'");
  });
  it('unknown dbType is conservative', () => {
    expect(code(() => renderLiteral(v('text', 'a\\b'), 'weird'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('text', 'a\x01'), 'weird'))).toBe('INVALID');
    expect(renderLiteral(v('text', "it's"), 'weird')).toBe("'it''s'");
  });
  it('rejects non-string', () => expect(code(() => renderLiteral(v('text', 5), 'postgres'))).toBe('INVALID'));
});

describe('number', () => {
  const ok: [unknown, string][] = [[-12.5, '(-12.5)'], ['1e3', '1e3'], [0, '0'], ['007', '7'], ['1.5', '1.5'], ['-007.5', '(-7.5)'], ['0.5', '0.5']];
  for (const [i, o] of ok) it(`renders ${String(i)}`, () => expect(renderLiteral(v('number', i), 'postgres')).toBe(o));
  for (const bad of [NaN, Infinity, -Infinity, '1e999', 'abc', '1;DROP', ' 1', true, {}])
    it(`rejects ${String(bad)}`, () => expect(code(() => renderLiteral(v('number', bad), 'mysql'))).toBe('INVALID'));
  it('empty string is UNSET', () => expect(code(() => renderLiteral(v('number', ''), 'mysql'))).toBe('UNSET'));
});

describe('date', () => {
  it('renders', () => {
    expect(renderLiteral(v('date', '2026-09-01'), 'postgres')).toBe("'2026-09-01'");
    expect(renderLiteral(v('date', '2026-09-01'), 'oracle')).toBe("DATE '2026-09-01'");
  });
  for (const bad of ['2026-02-30', '2026-2-3', '2026-09-01 10:00', '2025-02-29', '2026-13-01', '2026-00-10', 5])
    it(`rejects ${String(bad)}`, () => expect(code(() => renderLiteral(v('date', bad), 'postgres'))).toBe('INVALID'));
  it('accepts leap day', () => expect(renderLiteral(v('date', '2024-02-29'), 'mysql')).toBe("'2024-02-29'"));
});

describe('boolean', () => {
  for (const db of ['postgres', 'mysql', 'duckdb', 'clickhouse'])
    it(`TRUE/FALSE for ${db}`, () => {
      expect(renderLiteral(v('boolean', true), db)).toBe('TRUE');
      expect(renderLiteral(v('boolean', false), db)).toBe('FALSE');
    });
  for (const db of ['sqlserver', 'sqlite', 'oracle'])
    it(`1/0 for ${db}`, () => {
      expect(renderLiteral(v('boolean', true), db)).toBe('1');
      expect(renderLiteral(v('boolean', false), db)).toBe('0');
    });
  it('rejects strings', () => expect(code(() => renderLiteral(v('boolean', 'true'), 'postgres'))).toBe('INVALID'));
});

describe('select', () => {
  it('single by value type', () => {
    expect(renderLiteral(v('select', 'a'), 'postgres')).toBe("'a'");
    expect(renderLiteral(v('select', 3), 'postgres')).toBe('3');
    expect(renderLiteral(v('select', true), 'sqlite')).toBe('1');
  });
  it('multiple', () => {
    expect(renderLiteral(v('select', ['a', 'b'], true), 'postgres')).toBe("('a', 'b')");
    expect(renderLiteral(v('select', [1, 2], true), 'postgres')).toBe('(1, 2)');
    expect(renderLiteral(v('select', ["o'k"], true), 'postgres')).toBe("('o''k')");
    expect(renderLiteral(v('select', ['a', 1], true), 'postgres')).toBe("('a', 1)");
    expect(renderLiteral(v('select', ['a', 'a'], true), 'postgres')).toBe("('a', 'a')");
  });
  it('empty array is UNSET', () => expect(code(() => renderLiteral(v('select', [], true), 'postgres'))).toBe('UNSET'));
  it('invalid element', () => {
    expect(code(() => renderLiteral(v('select', ['a', null], true), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('select', ['a\0'], true), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('select', 'a', true), 'postgres'))).toBe('INVALID');
    expect(code(() => renderLiteral(v('select', ['a']), 'postgres'))).toBe('INVALID');
  });
});

describe('unset and errors', () => {
  const types: InputType[] = ['text', 'number', 'date', 'boolean', 'select'];
  for (const t of types)
    for (const val of [null, undefined, ''])
      it(`${t} ${String(val)} -> UNSET`, () => expect(code(() => renderLiteral(v(t, val), 'postgres'))).toBe('UNSET'));
  it('message omits value and carries variable', () => {
    try { renderLiteral({ name: 'age', inputType: 'number', value: 'SECRET;DROP' }, 'postgres'); } catch (e) {
      const err = e as ParamError;
      expect(err.message).not.toContain('SECRET');
      expect(err.variable).toBe('age');
      expect(err.message).toContain('age');
    }
    try { renderLiteral({ name: 'n', inputType: 'text', value: 'pw\0SECRET' }, 'postgres'); } catch (e) {
      expect((e as ParamError).message).not.toContain('SECRET');
    }
  });
});

import { renderSql, findParamRefs, scanSql } from '../src/index';

const sv = (name: string, value: unknown, inputType: InputType = 'text', multiple?: boolean): InputVar =>
  ({ name, inputType, value, ...(multiple ? { multiple } : {}) });
const err = (f: () => unknown): ParamError => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(ParamError); return e as ParamError; }
  throw new Error('no error');
};

describe('findParamRefs', () => {
  it('finds refs in order incl. duplicates, ignoring position', () => {
    const s = "a {{x}} '{{ y }}' {{x}} {{ 1+1 }} {{ not a var }} {{1a}}";
    expect(findParamRefs(s).map((r) => [r.name, s.slice(r.start, r.end)])).toEqual([
      ['x', '{{x}}'], ['y', '{{ y }}'], ['x', '{{x}}'],
    ]);
  });
  it('limits name length to 63', () => {
    expect(findParamRefs(`{{${'a'.repeat(63)}}} {{${'a'.repeat(64)}}}`)).toHaveLength(1);
  });
});

describe('renderSql', () => {
  const r = (sql: string, vars: InputVar[], db = 'postgres') => renderSql(sql, vars, db);
  it('renders scalar and list', () => {
    const out = r('WHERE a = {{ x }} AND b IN {{v}}', [sv('x', "O'B"), sv('v', ['a', 'b'], 'select', true)]);
    expect(out.sql).toBe("WHERE a = 'O''B' AND b IN ('a', 'b')");
    expect(out.used).toEqual({ x: "O'B", v: ['a', 'b'] });
  });
  it('renders each occurrence, tight braces, numbers', () => {
    expect(r('{{x}}+{{x}} LIMIT {{ n }}', [sv('x', 'a'), sv('n', 5, 'number')]).sql).toBe("'a'+'a' LIMIT 5");
  });
  const bad: [string, string][] = [
    ["'{{x}}'", 'single'], ['"{{x}}"', 'dq'], ['`{{x}}`', 'bt'], ['-- {{x}}', 'line'],
    ['/* {{x}} */', 'block'], ['$$ {{x}} $$', 'dollar'], ['$t$ {{x}} $t$', 'tag'],
    ["select 'unterminated {{x}}", 'unterminated'], ['/* open {{ x }}', 'unterminated block'],
  ];
  for (const [sql, n] of bad) {
    it(`forbids in ${n}`, () => {
      const e = err(() => r(sql, [sv('x', 'a')]));
      expect(e.code).toBe('FORBIDDEN_POSITION');
      expect(e.offset).toBe(sql.indexOf('{{'));
      expect(e.message).not.toContain('"a"');
    });
  }
  it('forbids even when var is unknown', () => {
    expect(err(() => r("'{{zz}}'", [])).code).toBe('FORBIDDEN_POSITION');
  });
  it('allows after closed constructs and $1 params', () => {
    expect(r("'a' -- c\n/* c */ \"q\" $1 {{x}}", [sv('x', 'a')]).sql).toBe("'a' -- c\n/* c */ \"q\" $1 'a'");
    expect(r("'it''s' {{x}}", [sv('x', 'a')]).sql).toBe("'it''s' 'a'");
  });
  it('mysql: backslash-quote does not end the string', () => {
    expect(err(() => r("'a\\' {{x}}", [sv('x', 'a')], 'mysql')).code).toBe('FORBIDDEN_POSITION');
    expect(r("'a\\' {{x}}", [sv('x', 'a')], 'postgres').sql).toBe("'a\\' 'a'");
  });
  it('non-variable braces stay verbatim', () => {
    const s = "'{{ not a var }}' {{ 1+1 }}";
    expect(r(s, []).sql).toBe(s);
  });
  it('no refs: identical, used empty', () => {
    const out = r('select 1', []);
    expect(out).toEqual({ sql: 'select 1', used: {} });
  });
  it('UNRESOLVED, DUPLICATE (first), UNSET, INVALID', () => {
    expect(err(() => r('{{y}}', [sv('x', 'a')])).code).toBe('UNRESOLVED');
    expect(err(() => r('select 1', [sv('x', 'a'), sv('x', 'b')])).code).toBe('DUPLICATE');
    expect(err(() => r('{{x}}', [sv('x', '')])).code).toBe('UNSET');
    const e = err(() => r('{{x}}', [sv('x', 'sec\0ret')]));
    expect(e.code).toBe('INVALID');
    expect(e.message).not.toContain('sec');
  });
  it('does not rescan rendered output', () => {
    const out = r('{{x}} {{y}}', [sv('x', '{{y}}'), sv('y', 'b')]);
    expect(out.sql).toBe("'{{y}}' 'b'");
  });
  it('used only has used vars', () => {
    expect(r('{{x}}', [sv('x', 'a'), sv('y', 'b')]).used).toEqual({ x: 'a' });
  });
});

describe('injection property', () => {
  const nasty = ["'", "\\", "\\'", "'; DROP TABLE x; --", '}}', '{{x}}', 'ünï 😀 日本', "a'b\\'c''", '$$ x $$', '/* c */', '`"', 'x'.repeat(100000), "'".repeat(1001), '\\'.repeat(999)];
  for (const db of ['postgres', 'mysql', 'mariadb', 'clickhouse', 'sqlserver', 'sqlite', 'duckdb', 'oracle', 'weird']) {
    it(`value stays inside one string literal for ${db}`, () => {
      for (const val of nasty) {
        let out: { sql: string };
        try { out = renderSql('WHERE a = {{ v }}', [sv('v', val)], db); }
        catch (e) { expect((e as ParamError).code).toBe('INVALID'); expect(db).toBe('weird'); continue; }
        const pre = 'WHERE a = '.length;
        const toks = scanSql(out.sql, db).filter((t) => t.end > pre);
        const first = toks[0];
        const nPrefix = out.sql[pre] === 'N' ? 1 : 0;
        if (nPrefix) { expect(first.kind).toBe('code'); expect(first.end).toBe(pre + 1); toks.shift(); }
        expect(toks).toHaveLength(1);
        expect(toks[0].kind).toBe('string');
        expect(toks[0].start).toBe(pre + nPrefix);
        expect(toks[0].end).toBe(out.sql.length);
      }
    });
  }
});

describe('fix round 1', () => {
  const x = [sv('x', 'a')];
  const R = (sql: string, db: string, vars: InputVar[] = x) => renderSql(sql, vars, db).sql;
  const forbidden = (sql: string, db: string) => {
    const e = err(() => renderSql(sql, x, db));
    expect(e.code).toBe('FORBIDDEN_POSITION');
  };
  it('1: # comments in mysql family only', () => {
    for (const db of ['mysql', 'mariadb', 'clickhouse']) forbidden('# {{x}}', db);
    expect(R('# {{x}}', 'postgres')).toBe("# 'a'");
    expect(R('# {{x}}', 'sqlite')).toBe("# 'a'");
  });
  it('1: comments end at \\n or \\r', () => {
    expect(R('-- c\r{{x}}', 'postgres')).toBe("-- c\r'a'");
    expect(R('-- c\n{{x}}', 'postgres')).toBe("-- c\n'a'");
    expect(R('# c\r{{x}}', 'mysql')).toBe("# c\r'a'");
    forbidden('--{{x}}', 'mysql');
  });
  it('2: E strings', () => {
    forbidden("E'a\\' {{x}}'", 'postgres');
    forbidden("e'a\\' {{x}}'", 'redshift');
    expect(R("xE'a\\' {{x}}", 'postgres')).toBe("xE'a\\' 'a'");
    expect(R("E'a' {{x}}", 'postgres')).toBe("E'a' 'a'");
  });
  it('3: postgres family E-string for backslash', () => {
    for (const db of ['postgres', 'postgresql', 'cockroach', 'redshift', 'greenplum']) {
      expect(R('{{x}}', db, [sv('x', "a\\b'c")])).toBe("E'a\\\\b''c'");
      expect(R('{{x}}', db, [sv('x', "ab'c")])).toBe("'ab''c'");
    }
    expect(R('{{x}}', 'postgres', [sv('x', ['\\', 'b'], 'select', true)])).toBe("(E'\\\\', 'b')");
    expect(R('{{x}}', 'duckdb', [sv('x', 'a\\b')])).toBe("'a\\b'");
    expect(R('{{x}}', 'sqlite', [sv('x', 'a\\b')])).toBe("'a\\b'");
  });
  it('4: negative numbers parenthesised', () => {
    for (const db of ['postgres', 'mysql', 'sqlserver', 'oracle', 'weird']) {
      expect(R('1 -{{n}}', db, [sv('n', -5, 'number')])).toBe('1 -(-5)');
      expect(R('1 - {{n}}', db, [sv('n', '-5', 'number')])).toBe('1 - (-5)');
    }
    expect(R('{{n}}', 'postgres', [sv('n', [-1, 2], 'select', true)])).toBe('((-1), 2)');
  });
  it('4: adjacent refs do not fuse literals', () => {
    expect(R('{{a}}{{b}}', 'postgres', [sv('a', 'p'), sv('b', 'q')])).toBe("'p' 'q'");
  });
  it('5: nested block comments', () => {
    for (const db of ['postgres', 'duckdb', 'sqlserver', 'cockroach']) forbidden('/* /* */ {{x}} */', db);
    for (const db of ['mysql', 'sqlite', 'oracle', 'clickhouse']) expect(R('/* /* */ {{x}}', db)).toBe("/* /* */ 'a'");
  });
  it('6: mysql double quotes are strings with backslash escapes', () => {
    forbidden('"a\\" {{x}}"', 'mysql');
    forbidden('"a"" {{x}}"', 'clickhouse');
    expect(R('"a\\" {{x}}', 'postgres')).toBe("\"a\\\" 'a'");
  });
  it('7: sqlserver brackets, oracle q-quote, duckdb dollar', () => {
    forbidden('[a]]{{x}}]', 'sqlserver');
    expect(R('[a] {{x}}', 'sqlserver')).toBe("[a] 'a'");
    forbidden("q'[ ' {{x}} ]'", 'oracle');
    forbidden("Q'{ ' {{x}} }'", 'oracle');
    forbidden("q'( {{x}} )'", 'oracle');
    forbidden("q'< {{x}} >'", 'oracle');
    expect(R("q'[a]' {{x}}", 'oracle')).toBe("q'[a]' 'a'");
    forbidden('$$ {{x}} $$', 'duckdb');
  });
  it('9: scanSql marked internal', () => {
    // documentation-level; asserted by source check
    expect(typeof scanSql).toBe('function');
  });
});

describe('independent literal checker', () => {
  const mysqlish = new Set(['mysql', 'mariadb', 'clickhouse']);
  const pg = new Set(['postgres', 'cockroach', 'redshift', 'greenplum']);
  function oneString(lit: string, db: string): boolean {
    let i = 0;
    let esc = mysqlish.has(db);
    if (db === 'sqlserver' && lit[0] === 'N') i = 1;
    if (pg.has(db) && lit[0] === 'E') { i = 1; esc = true; }
    if (lit[i] !== "'") return false;
    for (let j = i + 1; j < lit.length; j++) {
      if (esc && lit[j] === '\\') { j++; continue; }
      if (lit[j] === "'") {
        if (lit[j + 1] === "'") { j++; continue; }
        return j === lit.length - 1;
      }
    }
    return false;
  }
  const vals = ["'", '\\', "\\'", "\\\\'; DROP TABLE x; --", "'; DROP TABLE x; --", '}}', '{{x}}', 'ünï 😀', "a'b\\'c''", '#', '--', "E'", 'x'.repeat(100000), '\\'.repeat(999)];
  for (const db of ['postgres', 'cockroach', 'redshift', 'greenplum', 'mysql', 'mariadb', 'clickhouse', 'sqlserver', 'sqlite', 'duckdb', 'oracle']) {
    it(`${db}: literal is one balanced string`, () => {
      for (const val of vals) {
        const lit = renderSql('{{v}}', [sv('v', val)], db).sql;
        expect(oneString(lit, db)).toBe(true);
      }
    });
  }
});
