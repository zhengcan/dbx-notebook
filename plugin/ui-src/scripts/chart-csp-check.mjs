#!/usr/bin/env node
// Chart runtime CSP check: serves a smoke-only build with the DBX sandbox CSP (no unsafe-eval) and renders charts.
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const col = (name, kind) => ({ name, kind });
const columns = [col('day', 'temporal'), col('region', 'text'), col('tier', 'text'), col('amount', 'number'), col('qty', 'number')];
const regions = ['north', 'south', 'east', 'west'];
const tiers = ['gold', 'silver'];
// long rows as produced by the analysis runner: x / series / value
const long = [];
for (const [i, r] of regions.entries()) for (const [j, t] of tiers.entries()) long.push({ x: r, series: t, value: 10 + i * 7 + j * 5 });
const longNoSeries = regions.map((r, i) => ({ x: r, value: 5 + i * 3 }));
const longTime = [];
for (let d = 0; d < 12; d++) for (const t of tiers) longTime.push({ x: new Date(Date.UTC(2024, 0, 1 + d * 9)).toISOString(), series: t, value: 20 + ((d * 7) % 11) + (t === 'gold' ? 5 : 0) });
const longNum = Array.from({ length: 12 }, (_, i) => ({ x: i * 3 + 1, value: (i * 29) % 37 }));
const raw = Array.from({ length: 80 }, (_, i) => ({ amount: (i * 37) % 101, qty: (i * 13) % 17 }));
const pivot = (rows, extra = {}) => ({ rows, columns: [], values: [{ field: 'amount', agg: 'sum' }], ...extra });
const C = (type, extra = {}, p = pivot([{ field: 'region' }])) => ({ pivot: p, chart: { type, ...extra }, columns });
const timeP = pivot([{ field: 'day', grain: 'day' }], { columns: [{ field: 'tier' }] });
const sery = pivot([{ field: 'region' }], { columns: [{ field: 'tier' }] });

const charts = [
  { name: 'bar stacked (series)', cfg: C('bar', { stacking: 'stacked' }, sery), rows: long, expect: 'rect>=8,xs<=4' },
  { name: 'bar grouped (series): distinct bar x positions', cfg: C('bar', { stacking: 'grouped' }, sery), rows: long, expect: 'rect>=8,xs>=8' },
  { name: 'bar none (= grouped, side by side)', cfg: C('bar', { stacking: 'none' }, sery), rows: long, expect: 'rect>=8,xs>=8' },
  { name: 'barHorizontal none (= grouped)', cfg: C('barHorizontal', { stacking: 'none' }, sery), rows: long, expect: 'rect>=8' },
  { name: 'area none (overlay)', cfg: C('area', { stacking: 'none' }, timeP), rows: longTime, expect: 'area>=2' },
  { name: 'bar percent (100% stacked)', cfg: C('bar', { stacking: 'percent' }, sery), rows: long, expect: 'rect>=8,xs<=4' },
  { name: 'area percent', cfg: C('area', { stacking: 'percent' }, timeP), rows: longTime, expect: 'area>=2' },
  { name: 'fit: bar + legend + title', cfg: { ...C('bar', { title: 'A fairly long chart title for the fit check' }, sery), smokeWidth: 400 }, rows: long, expect: 'rect>=8' },
  { name: 'fit: long category labels', cfg: C('bar', {}, sery), rows: long.map((r) => ({ ...r, x: r.x + ' – a very long category label' })), expect: 'rect>=8' },
  { name: 'fit: horizontal bar + legend, narrow 300', cfg: { ...C('barHorizontal', {}, sery), smokeWidth: 300 }, rows: long, expect: 'rect>=8' },
  { name: 'fit: pie + legend', cfg: C('pie', { title: 'Pie title' }), rows: longNoSeries, expect: 'arc>=4' },
  { name: 'fit: donut narrow 320', cfg: { ...C('donut'), smokeWidth: 320 }, rows: longNoSeries, expect: 'arc>=4' },
  { name: 'fit: line temporal + legend narrow 300', cfg: { ...C('line', {}, timeP), smokeWidth: 300 }, rows: longTime, expect: 'line>=2' },
  { name: 'bar horizontal', cfg: C('barHorizontal'), rows: longNoSeries, expect: 'rect>=4' },
  { name: 'line temporal x', cfg: C('line', {}, timeP), rows: longTime, expect: 'line>=2' },
  { name: 'area temporal x (stack)', cfg: C('area', {}, timeP), rows: longTime, expect: 'area>=2' },
  { name: 'scatter', cfg: C('scatter', {}, pivot([{ field: 'qty' }])), rows: longNum, expect: 'symbol>=4' },
  { name: 'pie', cfg: C('pie'), rows: longNoSeries, expect: 'arc>=4' },
  { name: 'donut', cfg: C('donut'), rows: longNoSeries, expect: 'arc>=4' },
  { name: 'histogram (bin+aggregate)', cfg: C('histogram', { bins: 10 }, pivot([{ field: 'region' }], { values: [{ field: 'amount', agg: 'sum' }] })), rows: raw, expect: 'rect>=3' },
  { name: 'histogram + labels', cfg: C('histogram', { bins: 10, labels: true }), rows: raw, expect: 'rect>=3,text>=26' },
  { name: 'bar stacked + labels layer', cfg: C('bar', { stacking: 'stacked', labels: true }, sery), rows: long, expect: 'rect>=8,text>=24' },
  { name: 'pie + labels layer', cfg: C('pie', { labels: true }), rows: longNoSeries, expect: 'arc>=4,text>=9' },
];

// Sparse monthly data: 4 data months out of 24 (uneven true time positions)
const sparseMonths = ['2024-01-01', '2024-02-01', '2024-08-01', '2025-11-01'];
const longSparse = sparseMonths.map((d, i) => ({ x: d + 'T00:00:00.000Z', xLabel: d.slice(0, 7), value: 10 + i * 5 }));
const monthP = pivot([{ field: 'day', grain: 'month' }]);
charts.push(
  { name: 'time axis sparse bar: uneven gaps', cfg: C('bar', { timeAxis: 'sparse' }, monthP), rows: longSparse, expect: 'rect>=4,nx>=4,gapSpread>=10' },
  { name: 'time axis compact bar: 4 evenly spaced marks, 4 labelled ticks', cfg: C('bar', { timeAxis: 'compact' }, monthP), rows: longSparse, expect: 'rect>=4,nx>=4,gapSpread<=1,xlabels>=4,xlabels<=4' },
  { name: 'time axis compact line: evenly spaced vertices', cfg: C('line', { timeAxis: 'compact' }, monthP), rows: longSparse, expect: 'line>=1,nx>=4,gapSpread<=1,xlabels>=4,xlabels<=4' },
  { name: 'time axis compact area', cfg: C('area', { timeAxis: 'compact' }, monthP), rows: longSparse, expect: 'area>=1,xlabels<=4' },
  { name: 'time axis compact barHorizontal', cfg: C('barHorizontal', { timeAxis: 'compact' }, monthP), rows: longSparse, expect: 'rect>=4' },
  { name: 'portable: time axis compact bar (timeUnit ordinal)', cfg: { ...C('bar', { timeAxis: 'compact' }, monthP), portable: true }, rows: sparseMonths.map((d, i) => ({ day: d + 'T00:00:00.000Z', amount: 10 + i })), expect: 'rect>=4,gapSpread<=1,xlabels>=4,xlabels<=4' },
  { name: 'portable: time axis compact line', cfg: { ...C('line', { timeAxis: 'compact' }, monthP), portable: true }, rows: sparseMonths.map((d, i) => ({ day: d + 'T00:00:00.000Z', amount: 10 + i })), expect: 'line>=1' },
);

const P = (name, cfg, rows, expect) => ({ name: 'portable: ' + name, cfg: { ...cfg, portable: true }, rows, expect });
const pcols = [...columns, col('city', 'text'), col('id', 'number')];
const src = [];
for (let i = 0; i < 40; i++) src.push({
  day: new Date(Date.UTC(2023, 0, 1 + i * 23)).toISOString(), region: regions[i % 4], tier: tiers[Math.floor(i / 4) % 2], city: ['a', 'b', 'c'][i % 3],
  amount: 10 + ((i * 37) % 53), qty: (i * 13) % 17, id: i,
});
const PC = (type, p, extra = {}) => ({ pivot: p, chart: { type, ...extra }, columns: pcols });
const val = (agg, field = 'amount') => ({ field, agg });
const portable = [
  P('combined x label (2 row fields)', PC('bar', pivot([{ field: 'region' }, { field: 'tier' }])), src, 'rect>=8'),
  P('combined x + series + stacked', PC('bar', pivot([{ field: 'region' }, { field: 'tier' }], { columns: [{ field: 'city' }] }), { stacking: 'stacked' }), src, 'rect>=8'),
  ...['day', 'week', 'month', 'quarter', 'year'].map((g) => P('line temporal grain=' + g, PC('line', pivot([{ field: 'day', grain: g }], { columns: [{ field: 'tier' }] })), src, 'line>=2')),
  P('area temporal month', PC('area', pivot([{ field: 'day', grain: 'month' }])), src, 'area>=1'),
  P('bar temporal year', PC('bar', pivot([{ field: 'day', grain: 'year' }])), src, 'rect>=2'),
  P('histogram bin', PC('histogram', pivot([{ field: 'region' }]), { bins: 8 }), src, 'rect>=3'),
  P('histogram bin + labels', PC('histogram', pivot([{ field: 'region' }]), { bins: 8, labels: true }), src, 'rect>=3,text>=20'),
  P('multi-value layered (colour datum)', PC('line', pivot([{ field: 'region' }], { values: [val('sum'), val('avg', 'qty')] })), src, 'line>=2'),
  P('multi-value bar + labels', PC('bar', pivot([{ field: 'region' }], { values: [val('sum'), val('max', 'qty')] }), { labels: true }), src, 'rect>=4,text>=10'),
  P('multi-value + column field (layer transform)', PC('line', pivot([{ field: 'region' }], { columns: [{ field: 'tier' }], values: [val('sum'), val('min', 'qty')] })), src, 'line>=2'),
  P('count with empty field', PC('bar', pivot([{ field: 'region' }], { values: [{ field: '', agg: 'count' }] })), src, 'rect>=4'),
  P('median aggregate', PC('bar', pivot([{ field: 'region' }], { values: [val('median')] })), src, 'rect>=4'),
  P('countDistinct aggregate', PC('barHorizontal', pivot([{ field: 'region' }], { values: [val('countDistinct', 'city')] })), src, 'rect>=4'),
  P('pie sum', PC('pie', pivot([{ field: 'region' }])), src, 'arc>=4'),
  P('scatter', PC('scatter', pivot([{ field: 'qty' }])), src, 'symbol>=4'),
];
charts.push(...portable);

const nm = (i) => ['north', 'south', 'east', 'west', 'central', 'islands', 'overseas territories', 'frontier'][i % 8] + (i >= 8 ? ' ' + i : '');
const longCat = (n, w = '') => Array.from({ length: n }, (_, i) => nm(i) + w);
const grid = (cats, sers, f = (i, j) => 10 + i * 7 + j * 5) => cats.flatMap((x, i) => sers.map((series, j) => ({ x, series, value: f(i, j) })));
const segP = (type, extra = {}, rowsP = [{ field: 'region' }]) => ({ pivot: { rows: rowsP, columns: [{ field: 'customer_tier_segment_name' }], values: [{ field: 'amount', agg: 'sum' }] }, chart: { type, ...extra }, columns: [...columns, col('customer_tier_segment_name', 'text')] });
const prodCols = [{ name: 'tier', kind: 'text' }];
const LS = ['gold tier customers (long legend label)', 'silver tier customers (long legend label)', 'bronze'];
const prod = [];
for (const [pname, pw] of [['wide 700', 700], ['both-pane 360', 360], ['narrow 300', 300]]) {
  const add = (name, cfg, rows) => prod.push({ name: `prod ${pname}: ${name}`, cfg, rows, pw, shortTitle: (cfg.chart?.title ?? '').length > 0 && cfg.chart.title.length <= 30 });
  add('bar + legend (long) + title + legend title', segP('bar', { title: 'Revenue by region and customer tier (a long chart title)' }), grid(longCat(4), LS));
  add('bar labels at max (top edge)', segP('bar', { labels: true, stacking: 'grouped' }), grid(longCat(4), LS.slice(0, 2), (i, j) => 100 - i * 3 + j));
  add('bar stacked labels', segP('bar', { labels: true, stacking: 'stacked' }), grid(longCat(4), LS.slice(0, 2), (i, j) => 100 - i * 3 + j));
  add('line peak labels', segP('line', { labels: true }, [{ field: 'day', grain: 'month' }]), Array.from({ length: 10 }, (_, i) => ({ x: new Date(Date.UTC(2024, i, 1)).toISOString(), series: 'gold', value: i === 4 ? 100 : 20 + i })));
  add('horizontal bar long category labels', segP('barHorizontal', {}), grid(longCat(6, ' – an extremely long category label'), LS.slice(0, 2)));
  add('many categories (40) rotated labels', segP('bar', {}), grid(Array.from({ length: 40 }, (_, i) => 'category ' + i + ' name'), ['a']));
  add('pie + legend + title', C('pie', { title: 'Share of revenue by region' }), longCat(5, ' long label').map((x, i) => ({ x, value: 5 + i * 3 })));
  add('donut labels', C('donut', { labels: true }), longCat(5).map((x, i) => ({ x, value: 5 + i * 3 })));
  add('area + title', segP('area', { title: 'Area title' }, [{ field: 'day', grain: 'month' }]), Array.from({ length: 10 }, (_, i) => ({ x: new Date(Date.UTC(2024, i, 1)).toISOString(), series: 'gold', value: 20 + i })));
}

const isCspMsg = (t) => /Content Security Policy|unsafe-eval|EvalError|Refused to evaluate/i.test(t);
const trunc = (s) => (s.length > 400 ? s.slice(0, 400) + '…' : s);
let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}
process.on('exit', () => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} } });

function check(res, expect) {
  return expect.split(',').every((c) => {
    const m = /^(\w+)(>=|<=)(\d+)$/.exec(c);
    return m && (m[2] === '>=' ? res[m[1]] >= Number(m[3]) : res[m[1]] <= Number(m[3]));
  });
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.log('playwright-core is not installed: run `npm install` at the repo root.'); return 1; }

  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-chart-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp } });
  if (b.status !== 0 || !existsSync(join(tmp, 'chart-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');

  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${trunc(String(e.message).split('\n')[0])}`); }
  }
  if (!browser) { console.log('No system Chrome/Edge found; cannot run chart CSP check.'); return requireBrowser ? 1 : 2; }

  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'chart-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && (isCspMsg(m.text()) || !/favicon|Failed to load resource/i.test(m.text()))) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__sqlnbRenderChartForSmoke === 'function', null, { timeout: 10000 });

  let failed = false;
  const attributed = new Set();
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
  const isBad = (t) => /^pageerror/.test(t) || isCspMsg(t);
  for (const c of charts) {
    const before = errors.length;
    let detail, ok = false;
    try {
      const res = await page.evaluate(([cfg, rows]) => window.__sqlnbRenderChartForSmoke(cfg, rows), [c.cfg, c.rows]);
      await settle();
      const newErr = errors.slice(before).filter(isBad);
      newErr.forEach((t) => attributed.add(t));
      ok = res.fit === 1 && res.svgType === 'string' && res.svgLen > 0 && check(res, c.expect) && newErr.length === 0;
      detail = `expect ${c.expect}; got gapSpread=${res.gapSpread} nx=${res.nx} xlabels=${res.xlabels} fit=${res.fit} svg=${res.svgW}x${res.svgH} bbox=${res.bbox} xs=${res.xs} rect=${res.rect} line=${res.line} area=${res.area} symbol=${res.symbol} arc=${res.arc} text=${res.text} svg=${res.svgType}/${res.svgLen}` + (newErr.length ? '; ' + trunc(newErr[0]) : '');
    } catch (e) {
      await settle();
      errors.slice(before).filter(isBad).forEach((t) => attributed.add(t));
      detail = trunc(String(e.message).split('\n')[0]);
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} — ${detail}`);
    if (!ok) failed = true;
  }
  for (const c of prod) {
    const before = errors.length;
    let ok = false, detail;
    try {
      const r = await page.evaluate(([cfg, rows, pw]) => window.__sqlnbMountChartForSmoke(cfg, rows, pw), [c.cfg, c.rows, c.pw]);
      const newErr = errors.slice(before).filter(isBad);
      newErr.forEach((t) => attributed.add(t));
      const centered = c.shortTitle ? r.titleOff !== null && Math.abs(r.titleOff) <= 2 : true;
      ok = centered && r.clipped.length === 0 && !r.scrollOver && r.sizeOk && newErr.length === 0;
      detail = `titleOff=${r.titleOff} wrapper=${r.wrap} svg=${r.svg} scrollOver=${r.scrollOver}` + (r.clipped.length ? ` CLIPPED(${r.clipped.length}): ` + r.clipped.slice(0, 4).join(' | ') : '') + (newErr.length ? '; ' + trunc(newErr[0]) : '');
    } catch (e) { detail = trunc(String(e.message).split('\n')[0]); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} — ${detail}`);
    if (!ok) failed = true;
  }
  for (const [kind, cw] of [['uuid', 400], ['stacked', 400]]) {
    const before = errors.length;
    let ok = false, detail;
    try {
      const r = await page.evaluate(([k, w]) => window.__sqlnbRenderBoardForSmoke(k, w), [kind, cw]);
      const newErr = errors.slice(before).filter(isBad);
      newErr.forEach((t) => attributed.add(t));
      ok = r.bboxFits && r.ellipsis === 0 && (!r.hasTitle || r.titleTop >= 0) && (kind !== 'uuid' || r.labelsFull === 40) && (kind !== 'stacked' || r.hasTitle) && newErr.length === 0;
      detail = `svg=${r.svgW}x${r.svgH} bbox=${r.bbox} bboxFits=${r.bboxFits} titleTop=${r.titleTop} ellipsis=${r.ellipsis} labelsFull=${r.labelsFull} scroll=${r.scrollW}/${r.clientW} (overflow:auto container)` + (newErr.length ? '; ' + trunc(newErr[0]) : '');
    } catch (e) { detail = trunc(String(e.message).split('\n')[0]); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  board large: ${kind} — ${detail}`);
    if (!ok) failed = true;
  }
  // Left-pane widths derived from AiDrawer.vue: .dr = 80% of the window, .dr-body grid 3fr/2fr, .dr-left padding 12px 14px + 1px border.
  const leftOf = (win) => Math.round(win * 0.8 * 0.6);
  const kinds = ['uuid', 'stacked', 'pie', 'line'];
  const boardCases = [];
  for (const win of [640, 800, 1000, 1280, 1440, 1920]) for (const k of kinds) boardCases.push({ k, pw: leftOf(win), tag: `win ${win} (left ${leftOf(win)})`, o: {} });
  for (const pw of [280, 320, 360, 400, 450]) for (const k of kinds) boardCases.push({ k, pw, tag: `narrow ${pw}`, o: {} });
  for (const pw of [280, 360]) for (const k of ['stacked', 'line', 'pie']) boardCases.push({ k, pw, tag: `narrow ${pw} long title`, o: { longTitle: true }, longTitle: true });
  const CJK_TITLE = '各维度每日新增空间数量趋势对比分析及同比环比变化情况的详细说明与总结报告及趋势预测';
  for (const pw of [280, 360, 450]) for (const k of ['stacked', 'line', 'pie']) boardCases.push({ k, pw, tag: `narrow ${pw} CJK title`, o: { cjkTitle: CJK_TITLE }, cjk: CJK_TITLE });
  for (const pw of [280, 360, 450, 586]) {
    boardCases.push({ k: 'stacked', pw, tag: `centered ${pw} single-line title`, o: { shortTitle: 'Revenue' }, center: true });
    boardCases.push({ k: 'stacked', pw, tag: `centered ${pw} wrapped English title`, o: { longTitle: true }, longTitle: true, center: true });
    boardCases.push({ k: 'line', pw, tag: `centered ${pw} wrapped CJK title`, o: { cjkTitle: CJK_TITLE }, cjk: CJK_TITLE, center: true });
  }
  for (const pw of [360, 450, 586, 1000]) { boardCases.push({ k: 'uuid', pw, tag: `classic scrollbar ${pw}`, o: { classic: true } }); boardCases.push({ k: 'uuid', pw, tag: `classic + gutter:auto ${pw}`, o: { classic: true, gutterAuto: true } }); }
  for (const pw of [360, 586]) boardCases.push({ k: 'stacked', pw, tag: `classic ${pw}`, o: { classic: true } });
  boardCases.push({ k: 'stacked', pw: 1000, tag: 'resize 1000->560', o: { resizeTo: 560 }, rz: 560 }, { k: 'uuid', pw: 560, tag: 'resize 560->900', o: { resizeTo: 900 }, rz: 900 }, { k: 'line', pw: 700, tag: 'resize 700->320', o: { resizeTo: 320 }, rz: 320 }, { k: 'uuid', pw: 700, tag: 'classic gutter:auto resize 700->360', o: { classic: true, gutterAuto: true, resizeTo: 360 }, rz: 360 });
  for (const bc of boardCases) {
    const { k: kind, pw, tag, o, rz, longTitle, cjk, center } = bc;
    const before = errors.length;
    let ok = false, detail;
    try {
      const r = await page.evaluate(([k, w, oo]) => window.__sqlnbMountBoardForSmoke(k, w, oo), [kind, pw, o]);
      const newErr = errors.slice(before).filter(isBad);
      newErr.forEach((t) => attributed.add(t));
      const content = (rz ?? pw) - 29;
      const titleOk = !r.hasTitle || (r.titleTop >= 0 && r.titleLeft >= -1 && r.titleRight <= r.largeClient + 1 && !r.titleLines.some((x) => x.endsWith('…')));
      ok = (!rz || r.largeClient > 0) && !r.overflowX && !r.paneOverflowX && r.svgFits && r.clipped.length === 0 && titleOk
        && (kind !== 'uuid' || r.ellipsis === 0 || r.svgW < 360) && (kind === 'uuid' || r.ellipsis === 0)
        && (kind !== 'uuid' || r.labelsFull + r.ellipsis === 40)
        && (kind === 'uuid' || (r.hasTitle && r.nLegend >= 1)) && (!longTitle || r.titleH >= 28) && (!cjk || (r.titleJoined === cjk && r.titleH >= 28 && !r.titleJoined.includes('…'))) && (!center || (r.titleOffs.length > 0 && r.titleOffs.every((x) => Math.abs(x) <= 2) && r.titleAnchors.every((a) => a === 'middle'))) && newErr.length === 0;
      detail = `content~${content} large=${r.largeClient}/${r.largeScroll} svg=${r.svgW}x${r.svgH} overflowX=${r.overflowX} paneOverflowX=${r.paneOverflowX} titleLines=${r.titleLines.length} titleX=${r.titleLeft}..${r.titleRight} offs=${r.titleOffs}/${r.titleAnchors} ellipsis=${r.ellipsis} labelsFull=${r.labelsFull} yLabel=${r.yLabel} titleH=${r.titleH}` + (r.clipped.length ? ` CLIPPED(${r.clipped.length}): ` + r.clipped.slice(0, 3).join(' | ') : '') + (newErr.length ? '; ' + trunc(newErr[0]) : '');
    } catch (e) { detail = trunc(String(e.message).split('\n')[0]); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  board real ${kind} @ ${tag} — ${detail}`);
    if (!ok) failed = true;
  }
  await settle();
  const unattributed = errors.filter((t) => isBad(t) && !attributed.has(t));
  const bad = errors.filter(isBad);
  console.log(`${unattributed.length === 0 ? 'PASS' : 'FAIL'}  final sweep: no unattributed pageerror / CSP / EvalError messages${unattributed.length ? ' — ' + unattributed.length + ' found' : ''}`);
  if (unattributed.length || bad.length || failed) { for (const t of errors) console.log('  - ' + trunc(t)); return 1; }
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(trunc(String(e.stack || e))); code = 1; } finally { await cleanup(); }
console.log(code === 0 ? '\nCHART CSP CHECK PASSED' : code === 2 ? '\nCHART CSP CHECK SKIPPED' : '\nCHART CSP CHECK FAILED');
process.exit(code);
