#!/usr/bin/env node
// Real-Chrome check of export syntax highlighting: tok-* spans in HTML, textContent == source, WCAG contrast of the token colours,
// no scripts/requests, and coloured pixels in the rasterised PDF code region (colours survive printing).
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge or pdftoppm; 1 if SMOKE_REQUIRE_BROWSER=1).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };
const skip = (m) => { console.log(`SKIP  ${m}`); return requireBrowser ? 1 : 2; };

let browser;
async function main() {
  if (!has('pdftoppm')) return skip('pdftoppm not found (poppler)');
  const dir = mkdtempSync(join(tmpdir(), 'export-highlight-'));
  execFileSync('npx', ['vite-node', 'scripts/export-highlight-fixture.ts', dir], { cwd: resolve(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
  const src = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'));
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) return skip('No system Chrome/Edge found');
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, javaScriptEnabled: true });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.emulateMedia({ media: 'print' });
  await page.goto(pathToFileURL(join(dir, 'highlight.html')).href);
  await page.waitForLoadState('load');
  const r = await page.evaluate(({ sql, fences }) => {
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const bg = rgb(getComputedStyle(document.querySelector('pre.sql')).backgroundColor);
    const toks = [...document.querySelectorAll('[class^="tok-"]')];
    const kinds = {};
    let minRatio = 99;
    for (const t of toks) { const c = rgb(getComputedStyle(t).color); kinds[t.className] = (kinds[t.className] || 0) + 1; minRatio = Math.min(minRatio, ratio(c, bg)); }
    const sqlPre = document.querySelector('pre.sql');
    const codes = [...document.querySelectorAll('.md pre code')];
    const byLang = Object.fromEntries(codes.map((c) => [c.className.replace('language-', '') || '(none)', c]));
    return {
      sqlText: sqlPre.textContent, sqlToks: sqlPre.querySelectorAll('[class^="tok-"]').length, sqlWs: getComputedStyle(sqlPre).whiteSpace,
      fences: Object.fromEntries(Object.keys(fences).map((l) => [l, { text: byLang[l]?.textContent, toks: byLang[l]?.querySelectorAll('[class^="tok-"]').length ?? -1 }])),
      cobol: { n: byLang['(none)']?.querySelectorAll('span').length, text: byLang['(none)']?.textContent },
      kinds, minRatio, scripts: document.querySelectorAll('script').length, pwned: window.__pwned, adjust: getComputedStyle(sqlPre).getPropertyValue('print-color-adjust') || getComputedStyle(sqlPre).webkitPrintColorAdjust,
    };
  }, src);
  report(r.sqlToks >= 8 && r.sqlText === src.sql, `SQL block: ${r.sqlToks} tok spans, textContent equals the source`);
  report(r.sqlWs === 'pre-wrap', `SQL block keeps white-space: pre-wrap (${r.sqlWs})`);
  for (const [l, f] of Object.entries(r.fences)) report(f.toks > 0 && f.text === src.fences[l] + '\n', `fence ${l}: ${f.toks} tok spans, text round-trips`);
  report(r.cobol.n === 0 && r.cobol.text === 'MOVE 1 TO X\n', 'unknown language fence (cobol) renders plain');
  report(Object.keys(r.kinds).length >= 6, `token kinds present: ${JSON.stringify(r.kinds)}`);
  report(r.minRatio >= 4.5, `computed token colours >= 4.5:1 on the code background (min ${r.minRatio.toFixed(2)})`);
  report(r.scripts === 0 && r.pwned === undefined && requests.length === 1, `no <script>, payload inert, no extra requests (${requests.length})`);
  report(r.adjust === 'exact', `print-color-adjust: exact on code blocks (${r.adjust})`);

  const colouredPixels = async (name) => {
    const pdf = join(dir, `${name}.pdf`);
    await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
    execFileSync('pdftoppm', ['-r', '110', '-png', '-f', '1', '-l', '1', pdf, join(dir, name)]);
    const ppm = execFileSync('pdftoppm', ['-r', '110', '-f', '1', '-l', '1', pdf], { maxBuffer: 1 << 28 });
    let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(ppm[p]))) p++; let s = ''; while (!/\s/.test(String.fromCharCode(ppm[p]))) s += String.fromCharCode(ppm[p++]); return s; };
    tok(); const w = +tok(), h = +tok(); tok(); p++;
    let n = 0;
    for (let i = 0; i < w * h; i++) { const a = ppm[p + 3 * i], b = ppm[p + 3 * i + 1], c = ppm[p + 3 * i + 2]; if (Math.max(a, b, c) - Math.min(a, b, c) > 60) n++; }
    return n;
  };
  const withColour = await colouredPixels('hl');
  await page.addStyleTag({ content: '[class^="tok-"]{color:#24292f !important}' });
  const baseline = await colouredPixels('plain');
  report(withColour > baseline + 500, `PDF page 1: coloured (non-gray) pixels ${withColour} vs ${baseline} without token colours (borders/links excluded)`);
  console.log(`NOTE  PNGs in ${dir}`);
  await browser.close();
  return failed ? 1 : 0;
}

main().then((c) => process.exit(c), async (e) => { console.error(e); try { await browser?.close(); } catch { /* ignore */ } process.exit(1); });
