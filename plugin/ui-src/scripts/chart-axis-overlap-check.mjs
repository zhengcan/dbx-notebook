#!/usr/bin/env node
// Real-Chrome check: in the REAL ChartView (docs sample notebook), no axis title may intersect an axis tick label, in any
// document font. Vega measures text on a canvas, so the chart config must carry the document's real font family
// (`font: 'inherit'` is invalid for canvas and falls back to the default sans-serif -> measured != rendered).
// Exit: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const uiSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const ENTRY = 'docs-screenshots.html';
const FONTS = ["system-ui, -apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif", 'Georgia, serif', "'Courier New', monospace", 'Arial, sans-serif'];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
let tmp, server, browser;

async function cleanup() {
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (server) server.close();
  if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

async function main() {
  const { chromium } = await import('playwright-core');
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-axis-'));
  const dir = join(tmp, 'site');
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: dir, SMOKE_INPUT: ENTRY } });
  if (b.status !== 0 || !existsSync(join(dir, ENTRY))) { console.log('FAIL  smoke build'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found'); return process.env.SMOKE_REQUIRE_BROWSER === '1' ? 1 : 2; }
  server = createServer((req, res) => {
    const f = join(dir, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, ''));
    if (!f.startsWith(dir) || !existsSync(f) || !extname(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let failed = false;
  for (const font of FONTS) {
    const page = await browser.newPage({ viewport: { width: 1040, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/${ENTRY}`);
    await page.waitForFunction(() => typeof window.__docsMount === 'function');
    await page.evaluate((f) => { document.documentElement.style.setProperty('--docs-font', f); }, font);
    await page.evaluate(() => window.__docsMount('notebook'));
    await page.waitForSelector('[data-block-id=b_chart] g.role-axis');
    await page.waitForTimeout(600);
    const bad = await page.evaluate(() => {
      const svg = [...document.querySelectorAll('[data-block-id=b_chart] svg')].find((s) => s.querySelector('.role-axis'));
      const out = [];
      let titles = 0;
      for (const ax of svg.querySelectorAll('.role-axis')) {
        const lab = [...ax.querySelectorAll('.role-axis-label text')].map((t) => [t.textContent, t.getBoundingClientRect()]);
        for (const t of ax.querySelectorAll('.role-axis-title text')) {
          titles++;
          const r = t.getBoundingClientRect();
          for (const [txt, l] of lab) if (Math.min(r.right, l.right) - Math.max(r.left, l.left) > 0.5 && Math.min(r.bottom, l.bottom) - Math.max(r.top, l.top) > 0.5) out.push(`${t.textContent} x ${txt}`);
        }
      }
      return { out, titles };
    });
    const ok = bad.titles >= 2 && bad.out.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  axis titles clear of tick labels [${font.split(',')[0]}]${bad.out.length ? ' overlaps: ' + bad.out.join('; ') : ''}${bad.titles < 2 ? ' (axis titles not found)' : ''}`);
    if (!ok) failed = true;
    await page.close();
  }
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
