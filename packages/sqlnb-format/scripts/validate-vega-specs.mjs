// OPT-IN check (not part of `npm test`): `npm run validate:vega -w packages/sqlnb-format`.
// Builds a fixture matrix with the real buildPortableSpec/buildRenderSpec and validates every spec
// against the official Vega-Lite v5 JSON schema (ajv, installed into a temp dir outside the repo).
// Needs network. Exit: 0 all valid, 1 failures, 2 offline / schema or ajv unavailable.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPortableSpec, buildRenderSpec } from '../src/vegaSpec';

const SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.json';
let schema, Ajv;
try {
  const res = await fetch(SCHEMA_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  schema = await res.json();
  const dir = mkdtempSync(join(tmpdir(), 'vlcheck-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"vlcheck","private":true}');
  execSync('npm i ajv --no-audit --no-fund --silent', { cwd: dir, stdio: 'inherit' });
  const req = createRequire(join(dir, 'package.json'));
  const m = req('ajv');
  Ajv = m.default ?? m;
} catch (e) {
  console.error(`cannot fetch schema / install ajv (offline?): ${e?.message ?? e}`);
  process.exit(2);
}
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const validate = ajv.compile(schema);

const columns = [
  { name: 'day', kind: 'temporal' }, { name: 'region', kind: 'text' }, { name: 'tier', kind: 'text' },
  { name: 'amount', kind: 'number' }, { name: 'qty', kind: 'number' }, { name: 'a.b[c]', kind: 'number' },
  { name: 'd.x', kind: 'text' },
];
const chartTypes = ['line', 'area', 'bar', 'barHorizontal', 'scatter', 'pie', 'donut', 'histogram'];
const stackings = ['none', 'stacked', 'grouped', 'percent'];
const rowSets = [
  ...['day', 'week', 'month', 'quarter', 'year'].map((g) => [{ field: 'day', grain: g }]),
  [{ field: 'qty' }], [{ field: 'region' }], [{ field: 'd.x' }, { field: 'a.b[c]' }],
];
const colSets = [[], [{ field: 'tier' }], [{ field: 'tier' }, { field: 'd.x' }]];
const S = (field, agg, extra = {}) => ({ field, agg, ...extra });
const valueSets = [
  [S('amount', 'sum')],
  [S('amount', 'sum'), S('qty', 'sum')],
  [S('amount', 'sum'), S('qty', 'avg'), S('amount', 'max')],
  [S('', 'count')],
  [S('amount', 'sum', { format: { kind: 'percent', decimals: 1 } })],
  [S('amount', 'countDistinct'), S('qty', 'median', { label: 'Med', format: { kind: 'thousands' } })],
];

let total = 0, built = 0;
const failures = [];
for (const type of chartTypes) for (const stacking of [undefined, ...stackings]) for (const labels of [false, true]) for (const timeAxis of [undefined, 'compact'])
  for (const rows of rowSets) for (const cols of colSets) for (const values of valueSets) {
    const cfg = { pivot: { rows, columns: cols, values }, chart: { type, stacking, labels, bins: 12, timeAxis }, columns, title: 't' };
    for (const [name, r] of [['portable', buildPortableSpec({ ...cfg, dataName: 'src' })], ['render', buildRenderSpec(cfg)]]) {
      if ('error' in r) continue;
      built++;
      if (!validate(r.spec)) {
        failures.push({ name, type, stacking, labels, timeAxis, grain: rows[0].grain, path: validate.errors[0].instancePath, message: validate.errors[0].message });
      }
    }
    total++;
  }
console.log(`configs: ${total}, specs built+validated: ${built}, failures: ${failures.length}`);
for (const f of failures.slice(0, 5)) console.log(JSON.stringify(f));
const groups = new Map();
for (const f of failures) { const k = [f.timeAxis, f.name, f.type, f.path, f.message].join(' | '); groups.set(k, (groups.get(k) ?? 0) + 1); }
for (const [k, n] of [...groups].slice(0, 12)) console.log(n, k);
process.exit(failures.length ? 1 : 0);
