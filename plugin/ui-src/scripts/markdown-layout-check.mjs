#!/usr/bin/env node
// Real-Chrome check: a markdown block keeps its height and the siblings keep their position when switching
// preview -> edit and edit -> preview (light and dark, with the D v2 heading styles active). Heights are the content
// area without the editing toolbar: the toolbar sits above the textarea and adds its own fixed row(s) in edit mode only.
// SMOKE_REQUIRE_BROWSER=1 makes a missing browser a failure; otherwise exit 2 = loudly SKIPPED.
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

const long = Array.from({ length: 6 }, (_, i) => `# Heading ${i + 1}\n\nParagraph ${i + 1} with **bold**, \`code\` and a [link](https://example.com).\n\n## Section ${i + 1}\n\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n\`\`\`sql\nSELECT ${i} FROM t;\n\`\`\`\n\n> quote ${i}\n\n- one\n- two\n`).join('\n');
const CASES = [['long', long], ['short', 'just one line'], ['empty', '']];

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
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-md-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp, SMOKE_INPUT: 'markdown-smoke.html' } });
  if (b.status !== 0 || !existsSync(join(tmp, 'markdown-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found; cannot run markdown layout check.'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'markdown-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  const measure = () => page.evaluate(() => {
    const top = (s) => document.querySelector(s).getBoundingClientRect().top;
    const blk = document.querySelector('.md-block').getBoundingClientRect();
    const tbh = (() => { const e = document.querySelector('.md-toolbar'); return e ? e.getBoundingClientRect().height + parseFloat(getComputedStyle(e).marginBottom) : 0; })();
    return { h: blk.height - tbh, tbh, prev: top('#prev'), next: top('#next') - tbh, editing: !!document.querySelector('.md-block textarea'), h1: !!document.querySelector('.md-view h1') };
  });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__sqlnbMountMdForSmoke === 'function');
  for (const theme of ['light', 'dark']) {
    for (const [name, value] of CASES) {
      await page.evaluate((o) => window.__sqlnbMountMdForSmoke(o), { theme, value });
      await page.waitForTimeout(100);
      const label = `${theme} ${name}`;
      let a = await measure();
      if (a.editing) { await page.evaluate(() => document.querySelector('.md-block textarea').blur()); await page.waitForTimeout(100); a = await measure(); }
      if (name === 'long') report(a.h1, `${label}: heading styles are active in the preview`);
      await page.evaluate(() => { const keys = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontSize', 'lineHeight', 'letterSpacing', 'boxSizing']; const c = getComputedStyle(document.querySelector('.md-preview')); window.__pvMetrics = Object.fromEntries(keys.map((k) => [k, c[k]])); });
      await page.evaluate(() => document.querySelector('.md-preview').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      await page.waitForTimeout(150);
      const e = await measure();
      report(e.editing, `${label}: preview -> edit shows the textarea`);
      const sbEdit = await page.evaluate(() => { const t = document.querySelector('.md-block textarea'); return t.scrollHeight > t.clientHeight + 1; });
      report(!sbEdit, `${label}: no inner scrollbar while editing`);
      const metrics = await page.evaluate(() => { const keys = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontSize', 'lineHeight', 'letterSpacing', 'boxSizing']; const t = getComputedStyle(document.querySelector('.md-block textarea')); const pv = window.__pvMetrics; return keys.filter((k) => t[k] !== pv[k]).map((k) => `${k}: ${t[k]} vs ${pv[k]}`); });
      report(metrics.length === 0, `${label}: textarea/preview computed metrics match${metrics.length ? ' (' + metrics.join('; ') + ')' : ''}`);
      report(Math.abs(e.h - a.h) <= 1 && Math.abs(e.next - a.next) <= 1 && e.prev === a.prev, `${label} preview->edit: block ${a.h.toFixed(1)} -> ${e.h.toFixed(1)}, next top ${a.next.toFixed(1)} -> ${e.next.toFixed(1)}, prev top ${a.prev} -> ${e.prev}`);
      await page.evaluate(() => document.querySelector('.md-block textarea').blur());
      await page.waitForTimeout(150);
      const back = await measure();
      report(!back.editing, `${label}: blur returns to the preview`);
      report(Math.abs(back.h - e.h) <= 1 && Math.abs(back.next - e.next) <= 1 && back.prev === e.prev, `${label} edit->preview: block ${e.h.toFixed(1)} -> ${back.h.toFixed(1)}, next top ${e.next.toFixed(1)} -> ${back.next.toFixed(1)}, prev top ${e.prev} -> ${back.prev}`);
      const sb = await page.evaluate(() => { const t = document.querySelector('.md-block textarea'); return t ? t.scrollHeight > t.clientHeight + 1 : false; });
      report(!sb, `${label}: no inner scrollbar needed`);
    }
  }
  for (const theme of ['light', 'dark']) {
    const tag = `${theme} edit session`;
    await page.evaluate((o) => window.__sqlnbMountMdForSmoke(o), { theme, value: long, spacer: 300 });
    await page.waitForTimeout(100);
    await page.evaluate(() => document.querySelector('.md-preview').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(50);
    const snap = () => page.evaluate(() => { const t = document.querySelector('.md-block textarea'); const tbh = (() => { const e = document.querySelector('.md-toolbar'); return e ? e.getBoundingClientRect().height + parseFloat(getComputedStyle(e).marginBottom) : 0; })(); return { h: document.querySelector('.md-block').getBoundingClientRect().height - tbh, next: document.querySelector('#next').getBoundingClientRect().top - tbh, y: scrollY, sb: t.scrollHeight > t.clientHeight + 1 }; });
    const typeVal = async (v) => { await page.evaluate((val) => { const t = document.querySelector('.md-block textarea'); t.value = val; t.dispatchEvent(new Event('input', { bubbles: true })); }, v); await page.waitForTimeout(100); };
    const s0 = await snap();
    await typeVal('x');
    const s1 = await snap();
    report(Math.abs(s1.h - s0.h) <= 1 && Math.abs(s1.next - s0.next) <= 1 && Math.abs(s1.y - s0.y) <= 1 && !s1.sb, `${tag}: short text keeps the preview height ${s0.h.toFixed(1)} -> ${s1.h.toFixed(1)}, scrollY ${s0.y} -> ${s1.y}, next ${s0.next.toFixed(1)} -> ${s1.next.toFixed(1)}`);
    await typeVal('line\n'.repeat(400));
    const s2 = await snap();
    report(s2.h > s1.h + 100 && !s2.sb && Math.abs(s2.next - s1.next - (s2.h - s1.h)) <= 1 && Math.abs(s2.y - s1.y) <= 1, `${tag}: taller text grows ${s1.h.toFixed(1)} -> ${s2.h.toFixed(1)}, no scrollbar, next shifts by the growth, scrollY ${s1.y} -> ${s2.y}`);
    await typeVal('line\n'.repeat(399));
    const s3 = await snap();
    report(!s3.sb && Math.abs((s2.h - s3.h) - 23.8) <= 2 && Math.abs(s3.y - s2.y) <= 1, `${tag}: deleting a line shrinks by one line (${s2.h.toFixed(1)} -> ${s3.h.toFixed(1)}), scrollY ${s2.y} -> ${s3.y}`);
    await typeVal('x');
    const s4 = await snap();
    report(Math.abs(s4.h - s0.h) <= 1 && Math.abs(s4.y - s3.y) <= 1, `${tag}: deleting back returns to the start height ${s4.h.toFixed(1)} (want ${s0.h.toFixed(1)}), scrollY ${s3.y} -> ${s4.y}`);
    await typeVal('word '.repeat(6000));
    const w1 = await snap();
    await page.evaluate(() => { document.querySelector('.app').style.width = '380px'; });
    await page.waitForTimeout(250);
    const w2 = await snap();
    report(!w2.sb && w2.h > w1.h, `${tag}: narrower container refits (${w1.h.toFixed(1)} -> ${w2.h.toFixed(1)}), no scrollbar`);
    await page.evaluate(() => { document.querySelector('.app').style.width = '720px'; });
    await page.waitForTimeout(250);
    const w3 = await snap();
    report(!w3.sb && Math.abs(w3.h - w1.h) <= 1, `${tag}: wider container refits back (${w3.h.toFixed(1)} vs ${w1.h.toFixed(1)}), no scrollbar`);
    await page.evaluate(() => window.__sqlnbMdSetValue('ext\n'.repeat(120)));
    await page.waitForTimeout(150);
    const x1 = await snap();
    report(!x1.sb && x1.h > 120 * 20, `${tag}: external value change refits (${x1.h.toFixed(1)}), no scrollbar`);
  }
  report(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.log('FAIL ' + e.message); await cleanup(); process.exit(1); });
