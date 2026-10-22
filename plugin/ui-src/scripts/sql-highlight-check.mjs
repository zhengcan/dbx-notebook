#!/usr/bin/env node
// SQL highlight check: real-Chrome computed colours of editor + read-only spans in light and dark under the DBX sandbox CSP.
// SMOKE_REQUIRE_BROWSER=1 makes a missing browser a failure (the release task sets it); otherwise exit 2 = loudly SKIPPED.
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const rgb = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const trunc = (s) => (s.length > 300 ? s.slice(0, 300) + '…' : s);

let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.log('playwright-core is not installed: run `npm install` at the repo root.'); return 1; }
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-sql-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp, SMOKE_INPUT: 'sql-smoke.html' } });
  if (b.status !== 0 || !existsSync(join(tmp, 'sql-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${trunc(String(e.message).split('\n')[0])}`); }
  }
  if (!browser) { console.log('No system Chrome/Edge found; cannot run SQL highlight check.'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'sql-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/favicon|Failed to load resource/i.test(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__sqlnbMountSqlForSmoke === 'function', null, { timeout: 10000 });

  let failed = false;
  const report = (ok, name, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); if (!ok) failed = true; };
  const min = { keyword: 4.5, string: 4.5, number: 4.5, comment: 3.5, quotedIdentifier: 4.5, placeholder: 4.5 };
  // Surfaces come from the real app CSS fallbacks and host-token overrides; the palette's own backgrounds are never injected.
  const scenarios = [
    { name: 'light, app fallback (#fff)', o: { theme: 'light' } },
    { name: 'dark, app fallback', o: { theme: 'dark' } },
    { name: 'dark, host token #2d2d2d', o: { theme: 'dark', token: '#2d2d2d', fg: '#eeeeee' } },
    { name: 'dark, host token #3c3c3c', o: { theme: 'dark', token: '#3c3c3c', fg: '#eeeeee' } },
    { name: 'light, host token #fdf6e3', o: { theme: 'light', token: '#fdf6e3', fg: '#222222' } },
    { name: 'light, host token #f5f5f5', o: { theme: 'light', token: '#f5f5f5', fg: '#222222' } },
  ];
  const checkRead = (name, r) => {
    for (const [view, bgStr] of [['editor', r.editorBg], ['readonly', r.roBg], ['markdown code block', r.mdBg], ['diff view', r.diffBg]]) {
      const bg = rgb(bgStr);
      const bodyC = { editor: r.body, readonly: r.roBody, 'markdown code block': r.mdBody, 'diff view': r.diffBody }[view];
      const grabbed = { editor: r.editor, readonly: r.readonly, 'markdown code block': r.markdown, 'diff view': r.diff }[view];
      for (const k of Object.keys(min)) {
        const c = grabbed[k], col = rgb(c);
        const cr = col ? ratio(col, bg) : 0;
        report(!!col && c !== bodyC && cr >= min[k], `${name} | ${view} ${k}`, `color ${c} on ${bgStr} (body ${bodyC}) contrast ${cr.toFixed(2)} >= ${min[k]}`);
      }
    }
  };
  for (const sc of scenarios) {
    const r = await page.evaluate((o) => window.__sqlnbMountSqlForSmoke(o), sc.o);
    checkRead(sc.name, r);
  }
  await page.evaluate((o) => window.__sqlnbMountSqlForSmoke(o), { theme: 'dark', token: '#2d2d2d', fg: '#eeeeee' });
  const before = await page.evaluate(() => window.__sqlnbFlipForSmoke({ theme: 'dark', token: '#2d2d2d', fg: '#eeeeee' }));
  const after = await page.evaluate(() => window.__sqlnbFlipForSmoke({ theme: 'light', token: '#fdf6e3', fg: '#222222' }));
  checkRead('live flip dark #2d2d2d -> light #fdf6e3', after);
  report(before.editor.keyword !== after.editor.keyword && before.readonly.keyword !== after.readonly.keyword, 'live flip changes editor + read-only keyword colour', `${before.editor.keyword} -> ${after.editor.keyword}; ${before.readonly.keyword} -> ${after.readonly.keyword}`);
  const back = await page.evaluate(() => window.__sqlnbFlipForSmoke({ theme: 'dark', token: '#3c3c3c', fg: '#eeeeee' }));
  checkRead('live flip back to dark #3c3c3c', back);
  const unexpected = errors.filter((t) => /pageerror|Content Security Policy|unsafe-eval|EvalError|Refused/i.test(t));
  report(unexpected.length === 0, 'no pageerror / CSP messages', unexpected.length ? trunc(unexpected[0]) : 'clean');
  return failed ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(trunc(String(e.stack || e))); code = 1; } finally { await cleanup(); }
console.log(code === 0 ? '\nSQL HIGHLIGHT CHECK PASSED' : code === 2 ? '\n*** SQL HIGHLIGHT CHECK SKIPPED: no Chrome/Edge available (set SMOKE_REQUIRE_BROWSER=1 to fail instead; the release task does) ***' : '\nSQL HIGHLIGHT CHECK FAILED');
process.exit(code);
