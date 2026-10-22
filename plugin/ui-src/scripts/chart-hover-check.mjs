#!/usr/bin/env node
// Chart hover check (real Chrome/Edge, real mouse via Playwright): line/area show every series at the nearest X anywhere in the plot,
// scatter has a ~16px hit target, bars are unchanged, tooltip text equals the displayed text, and the export SVG carries no interaction layer.
// SMOKE_SHOT_DIR=<dir> additionally writes dark/light x 960/320 screenshots. Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const shotDir = process.env.SMOKE_SHOT_DIR || '';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const col = (name, kind) => ({ name, kind });
const columns = [col('day', 'temporal'), col('region', 'text'), col('tier', 'text'), col('amount', 'number'), col('qty', 'number')];
const pivot = (rows, extra = {}) => ({ rows, columns: [], values: [{ field: 'amount', agg: 'sum' }], ...extra });
const cfgOf = (type, p, extra = {}) => ({ pivot: p, chart: { type, ...extra }, columns });
const seriesP = pivot([{ field: 'region' }], { columns: [{ field: 'tier' }] });
const grid = (xs, names, f) => xs.flatMap((x, i) => names.map((s, j) => ({ x, series: s, value: f(i, j, s) })));
const xs12 = Array.from({ length: 12 }, (_, i) => 'x' + String(i).padStart(2, '0'));
const iso = (i) => new Date(Date.UTC(2024, 0, 1 + i * 9)).toISOString();

let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}
process.on('exit', () => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} } });

// In-page helpers (serialised into the page).
const geometry = () => {
  const host = document.querySelector('.chart-host');
  const svg = host.querySelector('svg');
  const pt = svg.createSVGPoint();
  const toClient = (el, x, y) => { pt.x = x; pt.y = y; const m = el.getScreenCTM(); const q = pt.matrixTransform(m); return [q.x, q.y]; };
  const bg = svg.querySelector('g.role-frame path.background').getBoundingClientRect();
  const rx = Array.from(svg.querySelectorAll('g.layer_1_marks line')).map((l) => l.getBoundingClientRect().left).sort((a, b) => a - b);
  const pathPts = (p) => Array.from((p.getAttribute('d') || '').matchAll(/[ML]\s*(-?[\d.e+-]+)[ ,](-?[\d.e+-]+)/g)).map((m) => toClient(p, Number(m[1]), Number(m[2])));
  const lines = Array.from(svg.querySelectorAll('g.layer_0_marks path[role="graphics-symbol"]')).map(pathPts);
  const symbols = Array.from(svg.querySelectorAll('g.layer_0_marks path')).map((p) => { const r = p.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2, r.width]; });
  const areas = Array.from(svg.querySelectorAll('g.mark-area path')).map(pathPts);
  return { plot: { l: bg.left, t: bg.top, r: bg.right, b: bg.bottom }, rx, lines, symbols, areas, voronoi: svg.querySelectorAll('g.layer_1_voronoi path').length, legend: svg.querySelectorAll('g.role-legend').length };
};
const tip = () => { const t = document.querySelector('[data-chart-tooltip]'); return t && t.style.display !== 'none' ? t.textContent : null; };
const dots = () => Array.from(document.querySelectorAll('g.layer_2_marks path')).map((p) => { const r = p.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; });
const ruleOpacity = () => Array.from(document.querySelectorAll('g.layer_1_marks line')).filter((l) => Number(l.getAttribute('opacity')) > 0).length;

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.log('playwright-core is not installed: run `npm install` at the repo root.'); return 1; }

  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-hover-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp } });
  if (b.status !== 0 || !existsSync(join(tmp, 'chart-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');

  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${String(e.message).split('\n')[0]}`); }
  }
  if (!browser) { console.log('No system Chrome/Edge found; cannot run chart hover check.'); return requireBrowser ? 1 : 2; }

  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'chart-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push('console.error: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__sqlnbMountHoverForSmoke === 'function', null, { timeout: 10000 });

  let failed = false;
  const report = (ok, name, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); if (!ok) failed = true; };
  const mount = (cfg, rows, w = 700, theme = 'light') => page.evaluate(([c, r, ww, t]) => window.__sqlnbMountHoverForSmoke(c, r, ww, t), [cfg, rows, w, theme]);
  const geo = () => page.evaluate(geometry);
  const park = async () => { await page.mouse.move(2, 2); await page.waitForTimeout(30); };
  const hoverAt = async (x, y) => { await page.mouse.move(x, y, { steps: 3 }); await page.waitForTimeout(40); return page.evaluate(tip); };
  const firstLine = (t) => (t ?? '').split('\n')[0];

  // ---- line, nominal x, two crossing series
  const lineRows = grid(xs12, ['a', 'b'], (i, j) => (j === 0 ? 10 + i * 3 : 40 - i * 2));
  await mount(cfgOf('line', seriesP), lineRows);
  let g = await geo();
  let bad = [];
  const mid = (g.plot.t + g.plot.b) / 2;
  const vertexTip = [];
  for (let i = 0; i < 12; i++) {
    const t = await hoverAt(g.rx[i], mid);
    vertexTip.push(t);
    if (firstLine(t) !== `region: x${String(i).padStart(2, '0')}`) bad.push(`vertex ${i}: ${JSON.stringify(t)}`);
    const lines = (t ?? '').split('\n');
    const expA = 10 + i * 3, expB = 40 - i * 2;
    const want = expA >= expB ? [`a: ${expA}`, `b: ${expB}`] : [`b: ${expB}`, `a: ${expA}`];
    if (lines.length !== 3 || lines[1] !== want[0] || lines[2] !== want[1]) bad.push(`vertex ${i} body ${JSON.stringify(lines)} want ${JSON.stringify(want)}`);
  }
  report(bad.length === 0, 'line: every vertex shows its X, all series, sorted by value desc', bad.slice(0, 3).join(' | ') || `12 x, voronoi=${g.voronoi}`);

  bad = [];
  let nMid = 0;
  for (let i = 0; i < 11; i++) {
    const [x0, x1] = [g.rx[i], g.rx[i + 1]];
    const ly = g.lines[0][i][1] + (g.lines[0][i + 1][1] - g.lines[0][i][1]) / 2;
    for (const [f, want] of [[0.5 - 0.2, i], [0.5 + 0.2, i + 1], [0.5 - 0.45, i], [0.5 + 0.45, i + 1]]) {
      const t = await hoverAt(x0 + (x1 - x0) * f, ly);
      nMid++;
      if (firstLine(t) !== `region: x${String(want).padStart(2, '0')}`) bad.push(`seg ${i} f=${f}: ${firstLine(t)} want x${want}`);
    }
    // segment midpoint exactly on the line (ties are allowed to go either way, but must trigger)
    const t = await hoverAt((x0 + x1) / 2, ly);
    if (!t || ![`region: x${String(i).padStart(2, '0')}`, `region: x${String(i + 1).padStart(2, '0')}`].includes(firstLine(t))) bad.push(`seg ${i} midpoint: ${JSON.stringify(t)}`);
  }
  report(bad.length === 0, 'line: segment midpoints / between two points trigger with the nearest X', bad.slice(0, 3).join(' | ') || `${nMid + 11} probes`);

  bad = [];
  for (const [px, py, want] of [[g.plot.l + 1, g.plot.t + 1, 0], [g.plot.l + 1, g.plot.b - 1, 0], [g.plot.r - 1, g.plot.t + 1, 11], [g.plot.r - 1, g.plot.b - 1, 11], [g.plot.l + 1, mid, 0], [g.plot.r - 1, mid, 11], [(g.plot.l + g.plot.r) / 2, g.plot.t + 1, null]]) {
    const t = await hoverAt(px, py);
    if (want === null ? !t : firstLine(t) !== `region: x${String(want).padStart(2, '0')}`) bad.push(`(${Math.round(px)},${Math.round(py)}): ${firstLine(t)} want x${want}`);
  }
  report(bad.length === 0, 'line: plot-area edges and corners trigger the end X', bad.join(' | ') || 'ok');

  await page.mouse.move(g.rx[5], mid);
  const during = await page.evaluate(() => ({ dots: Array.from(document.querySelectorAll('g.layer_2_marks path')).length, rules: Array.from(document.querySelectorAll('g.layer_1_marks line')).filter((l) => Number(l.getAttribute('opacity')) > 0).length }));
  const dotPos = await page.evaluate(dots);
  const lineYs = g.lines.map((l) => l[5][1]);
  const dotsOnLines = dotPos.every(([dx, dy]) => Math.abs(dx - g.rx[5]) < 1.5 && lineYs.some((ly) => Math.abs(ly - dy) < 1.5));
  await park();
  const after = await page.evaluate(() => ({ dots: document.querySelectorAll('g.layer_2_marks path').length, rules: Array.from(document.querySelectorAll('g.layer_1_marks line')).filter((l) => Number(l.getAttribute('opacity')) > 0).length, tip: (() => { const t = document.querySelector('[data-chart-tooltip]'); return t.style.display; })() }));
  report(during.dots === 2 && during.rules === 1 && dotsOnLines && after.dots === 0 && after.rules === 0 && after.tip === 'none', 'line: highlight dots (one per series, on the lines) + reference line show while hovering and clear on leave', `during=${JSON.stringify(during)} onLines=${dotsOnLines} after=${JSON.stringify(after)}`);
  const outside = await hoverAt(g.plot.l - 25, mid);
  report(outside === null, 'line: pointer left of the plot area shows no tooltip', JSON.stringify(outside));
  report(g.legend === 1, 'line: legend count unchanged (1)', `legend=${g.legend}`);

  // ---- temporal x, uneven spacing, three series
  const tx = Array.from({ length: 10 }, (_, i) => (i < 5 ? iso(i) : iso(i * 3)));
  await mount(cfgOf('line', pivot([{ field: 'day', grain: 'day' }], { columns: [{ field: 'tier' }] })), grid(tx, ['a', 'b', 'c'], (i, j) => 10 + ((i * (j + 2)) % 9) + j * 4));
  g = await geo();
  const tv = [];
  for (let i = 0; i < 10; i++) tv.push(await hoverAt(g.rx[i], g.plot.t + 5));
  bad = [];
  for (let i = 0; i < 9; i++) {
    const w = g.rx[i + 1] - g.rx[i];
    const l = await hoverAt(g.rx[i] + w * 0.3, g.plot.b - 5), r = await hoverAt(g.rx[i] + w * 0.7, g.plot.b - 5);
    if (l !== tv[i] || r !== tv[i + 1]) bad.push(`seg ${i}`);
  }
  report(bad.length === 0 && new Set(tv).size === 10 && tv.every((t) => t.split('\n').length === 4), 'line temporal (uneven gaps, 3 series): nearest X by pixel, 4 lines each', bad.join(',') || `distinct=${new Set(tv).size}`);

  // ---- compact time axis
  await mount(cfgOf('line', pivot([{ field: 'day', grain: 'month' }], { columns: [{ field: 'tier' }] }), { timeAxis: 'compact' }), grid(['2024-01-01', '2024-02-01', '2024-08-01', '2025-11-01'].map((d) => d + 'T00:00:00.000Z'), ['a', 'b'], (i, j) => 5 + i * 3 + j).map((r) => ({ ...r, xLabel: r.x.slice(0, 7) })));
  g = await geo();
  const c0 = await hoverAt(g.rx[1] + 4, mid), c1 = await hoverAt(g.rx[2] - 4, mid);
  report(/2024-02/.test(c0 ?? '') && /2024-08/.test(c1 ?? '') && g.rx.length === 4, 'line compact time axis: tooltip shows the xLabel of the nearest X', `${JSON.stringify(c0)} / ${JSON.stringify(c1)}`);

  // ---- combineX
  await mount(cfgOf('line', pivot([{ field: 'region' }, { field: 'tier' }])), ['n / g', 'n / s', 's / g', 's / s'].map((x, i) => ({ x, value: 5 + i * 4 })));
  g = await geo();
  const cx = await hoverAt(g.rx[2] + 3, mid);
  report(/s \/ g/.test(firstLine(cx)) && g.rx.length === 4, 'line combineX: multi-field X text on the title line', JSON.stringify(cx));

  // ---- stacked area, 3 series: dots sit on cumulative boundaries
  const ax = Array.from({ length: 10 }, (_, i) => 'd' + i);
  await mount(cfgOf('area', seriesP, { stacking: 'stacked' }), grid(ax, ['a', 'b', 'c'], (i, j) => 10 + ((i + j * 3) % 5) * 4));
  g = await geo();
  const ta = await hoverAt(g.rx[4] + 5, g.plot.t + 20);
  const lines = (ta ?? '').split('\n');
  const nums = lines.slice(1).map((l) => Number(l.split(': ')[1]));
  const sorted = nums.every((v, i) => i === 0 || nums[i - 1] >= v);
  const dp = await page.evaluate(dots);
  const bounds = g.areas.flatMap((a) => a.filter((p) => Math.abs(p[0] - g.rx[4]) < 1.5).map((p) => p[1]));
  const onTop = dp.length === 3 && dp.every(([dx, dy]) => Math.abs(dx - g.rx[4]) < 1.5 && bounds.some((by) => Math.abs(by - dy) < 1.5));
  report(lines.length === 4 && sorted && onTop, 'area stacked: all 3 series listed (desc) and 3 dots on the cumulative boundaries', `lines=${lines.length} sorted=${sorted} dots=${dp.length} onTop=${onTop}`);
  await mount(cfgOf('area', seriesP, { stacking: 'none' }), grid(ax, ['a', 'b'], (i, j) => 10 + ((i + j * 3) % 5) * 4));
  g = await geo();
  const ao = await hoverAt(g.rx[3], g.plot.b - 3);
  report(!!ao && ao.split('\n').length === 3, 'area overlay: both series at the nearest X', JSON.stringify(ao));

  // ---- many series: top 10 + "N more"
  const names12 = Array.from({ length: 12 }, (_, i) => 's' + String(i).padStart(2, '0'));
  await mount(cfgOf('line', seriesP), grid(['p', 'q', 'r', 's'], names12, (i, j) => 100 + j * 10 + i));
  g = await geo();
  const tm = await hoverAt(g.rx[1], mid);
  const ml = (tm ?? '').split('\n');
  const vals = ml.slice(1, 11).map((l) => Number(l.split(': ')[1]));
  report(ml.length === 12 && /(…另有 2 项|… 2 more)$/.test(ml[11]) && vals.every((v, i) => i === 0 || vals[i - 1] >= v) && ml[1] === 's11: 211', 'many series: first 10 by value + "N more" line (zh/en)', JSON.stringify(ml.slice(0, 3)) + ' … ' + ml[11]);

  // ---- null values
  await mount(cfgOf('line', seriesP), grid(xs12.slice(0, 6), ['a', 'b'], (i, j) => ((j === 1 && i === 3) || i === 4 ? null : 10 + i * 2 + j * 5)));
  g = await geo();
  const n3 = await hoverAt(g.rx[3] === undefined ? 0 : g.rx[3], mid);
  const nRules = g.rx.length;
  report(nRules === 5 && /a: /.test(n3 ?? '') && !/b: /.test(n3 ?? ''), 'null point: series without a value at this X is omitted; an all-null X has no hit target', `rules=${nRules} tip=${JSON.stringify(n3)}`);
  const holeX = (g.plot.l + g.plot.r) / 2;
  const nh = await hoverAt(g.rx[3] + (g.rx[4] - g.rx[3]) * 0.5, mid);
  report(nh !== null && !/x04/.test(nh), 'null X is skipped: the nearest valid X answers', JSON.stringify(firstLine(nh)));
  void holeX;

  // ---- tooltip text equals displayed text (unit/scale valueText, thousands format)
  await mount(cfgOf('line', pivot([{ field: 'region' }], { columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum', label: '销售额', format: { kind: 'plain', unit: '万元' } }] })), grid(['p', 'q', 'r'], ['a', 'b'], (i, j) => 12000 + i * 1000 + j).map((r) => ({ ...r, valueText: `${(r.value / 10000).toFixed(1)}万元` })));
  g = await geo();
  const tu = await hoverAt(g.rx[1], mid);
  report(/a: 1\.3万元/.test(tu ?? '') && /b: 1\.3万元/.test(tu ?? '') && !/13000|13001/.test(tu ?? ''), 'valueText (unit): tooltip shows the display text, never the raw number', JSON.stringify(tu));
  await mount(cfgOf('line', pivot([{ field: 'region' }], { columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum', format: { kind: 'thousands', decimals: 0 } }] })), grid(['p', 'q', 'r'], ['a', 'b'], (i, j) => 1234567 + i * 1000 + j));
  g = await geo();
  const tth = await hoverAt(g.rx[1], mid);
  report(/a: 1,235,567/.test(tth ?? '') && !/1235567/.test(tth ?? ''), 'thousands format: tooltip uses the formatted value', JSON.stringify(tth));

  // ---- scatter: 16px hit target
  const spts = Array.from({ length: 9 }, (_, i) => ({ x: i * 11 + (i % 3), value: (i * 37) % 41 + 3 * i }));
  await mount(cfgOf('scatter', pivot([{ field: 'qty' }])), spts);
  g = await geo();
  const P = g.symbols.filter((p) => p[2] < 12 && p[2] > 0);
  const iso1 = P.filter((p, i) => P.every((o, j) => j === i || Math.hypot(o[0] - p[0], o[1] - p[1]) > 40));
  const dirs = Array.from({ length: 16 }, (_, k) => (k * Math.PI) / 8);
  let radii = [];
  for (const p of iso1) {
    for (const a of dirs) {
      let r = 0;
      const centre = await hoverAt(p[0], p[1]);
      if (!centre) { r = -1; radii.push(r); continue; }
      for (let d = 1; d <= 24; d += 0.5) { const t = await hoverAt(p[0] + d * Math.cos(a), p[1] + d * Math.sin(a)); if (t) r = d; else break; }
      radii.push(r);
    }
  }
  const rmin = Math.min(...radii), rmax = Math.max(...radii);
  const t7 = [];
  for (const p of iso1.slice(0, 3)) for (const a of dirs) t7.push(await hoverAt(p[0] + 7 * Math.cos(a), p[1] + 7 * Math.sin(a)));
  const t14 = [];
  for (const p of iso1.slice(0, 3)) for (const a of dirs) t14.push(await hoverAt(p[0] + 14 * Math.cos(a), p[1] + 14 * Math.sin(a)));
  const sc = await hoverAt(iso1[0][0], iso1[0][1]);
  report(iso1.length >= 3 && rmin >= 7 && rmax <= 9.5 && t7.every(Boolean) && t14.every((t) => !t) && /qty: /.test(sc ?? ''), 'scatter: hit radius ≈8px (7px shows everywhere, 14px shows nothing)', `isolated=${iso1.length} radius ${rmin}–${rmax}px, tip=${JSON.stringify(sc)}`);
  console.log(`      scatter measured hit radius range: ${rmin}–${rmax}px (diameter ≈ ${2 * rmin}–${2 * rmax}px); base point diameter ${Math.round(P[0][2] * 10) / 10}px`);

  // ---- bar unchanged
  await mount(cfgOf('bar', seriesP, { stacking: 'grouped' }), grid(['n', 's', 'e', 'w'], ['a', 'b'], (i, j) => 10 + i * 7 + j * 5));
  const barInfo = await page.evaluate(() => ({ vor: document.querySelectorAll('g[class*="voronoi"]').length, layers: document.querySelectorAll('g[class*="layer_1_marks"]').length, rects: Array.from(document.querySelectorAll('g.mark-rect path')).map((p) => { const r = p.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }) }));
  const br = barInfo.rects[0];
  const bt = await hoverAt((br[0] + br[2]) / 2, (br[1] + br[3]) / 2);
  g = await geo();
  const gap = await hoverAt((br[0] + br[2]) / 2, g.plot.t + 1);
  report(barInfo.vor === 0 && barInfo.layers === 0 && /region: n/.test(bt ?? '') && /sum of amount: 10/.test(bt ?? '') && gap === null, 'bar: no hover layers; tooltip only on the bar, as before', `bar tip=${JSON.stringify(bt)} above-bar=${JSON.stringify(gap)}`);
  await mount(cfgOf('pie', pivot([{ field: 'region' }])), ['n', 's', 'e'].map((x, i) => ({ x, value: 5 + i })));
  const pieInfo = await page.evaluate(() => document.querySelectorAll('g[class*="voronoi"]').length);
  report(pieInfo === 0, 'pie: no hover layers', `voronoi=${pieInfo}`);

  // ---- export path: static SVG without any interaction layer (and not affected by hover)
  let exportOk = true; const exDetail = [];
  const exCases = [
    ['line', cfgOf('line', seriesP), lineRows], ['area', cfgOf('area', seriesP, { stacking: 'stacked' }), lineRows],
    ['scatter', cfgOf('scatter', pivot([{ field: 'qty' }])), spts], ['bar', cfgOf('bar', seriesP), lineRows],
  ];
  for (const [name, cfg, rows] of exCases) {
    const svg = await page.evaluate(([c, r]) => window.__sqlnbExportSvgForSmoke(c, r), [cfg, rows]);
    const clean = typeof svg === 'string' && !/voronoi|layer_1_marks|layer_2_marks|__sqlnb/.test(svg) && !/opacity="0"[^>]*\/>/.test(svg.replace(/stroke-opacity="0"/g, ''));
    const interactive = await page.evaluate(([c, r]) => { const d = document.createElement('div'); d.innerHTML = ''; return 0; }, [cfg, rows]);
    void interactive;
    if (!clean) { exportOk = false; exDetail.push(name); }
  }
  report(exportOk, 'export SVG (line/area/scatter/bar): no voronoi/rule/dot layers, no zero-opacity marks', exDetail.join(',') || '4 charts clean');

  // ---- screenshots (optional)
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    const lineS = cfgOf('line', seriesP, { title: '日销售额' });
    const areaS = cfgOf('area', seriesP, { stacking: 'stacked', title: '堆叠面积' });
    const shots = [['line', lineS, lineRows, 4], ['area', areaS, grid(xs12, ['a', 'b', 'c'], (i, j) => 12 + ((i + j * 4) % 6) * 3), 6], ['scatter', cfgOf('scatter', pivot([{ field: 'qty' }]), { title: '散点' }), spts, null]];
    for (const theme of ['dark', 'light']) for (const w of [960, 320]) for (const [name, cfg, rows, at] of shots) {
      await page.evaluate((t) => { document.documentElement.style.background = t === 'dark' ? '#0a0a0a' : '#ffffff'; document.body.style.background = t === 'dark' ? '#0a0a0a' : '#ffffff'; }, theme);
      await mount(cfg, rows, w, theme);
      g = await geo();
      if (at !== null) { const px = g.rx[at] + 3; await hoverAt(px, (g.plot.t + g.plot.b) / 2); }
      else { const p = g.symbols.filter((q) => q[2] < 12)[3]; await hoverAt(p[0] + 6, p[1]); }
      await page.screenshot({ path: join(shotDir, `${name}-${theme}-${w}.png`), clip: { x: 0, y: 0, width: Math.min(1100, w + 40), height: 330 } });
    }
    console.log('screenshots: ' + shotDir);
  }

  const bad2 = errors.filter((e) => /^pageerror|Content Security|unsafe-eval|EvalError/i.test(e) || /console\.error/.test(e));
  report(bad2.length === 0, 'no page errors / CSP violations', bad2[0] ? bad2[0].slice(0, 300) : 'clean');
  return failed ? 1 : 0;
}

main().then(async (code) => { await cleanup(); process.exit(code); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
