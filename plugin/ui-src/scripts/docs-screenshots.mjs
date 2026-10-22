#!/usr/bin/env node
// Regenerates the PNGs in docs/images from the REAL Vue components (smoke build of src/smoke/docsSmokeEntry.ts)
// rendered in headless Chrome with fake 'monthly sales' data and the light DBX theme.
// Usage: npm run docs:screenshots   (from plugin/ui-src; needs system Chrome/Edge). pngquant is used when installed.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const outDir = process.env.DOCS_IMAGES_OUT || resolve(uiSrc, '../../docs/images');
const isWin = process.platform === 'win32';
const ENTRY = 'docs-screenshots.html';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// [file, scene, selector(s) (union of bounding boxes), padding, scale ('css' = 1x to keep the tall overview small; default 2x)]
const SHOTS = [
  ['notebook-overview', 'notebook', ['#docs-root'], 0, 'css'],
  ['block-markdown', 'notebook', ['[data-block-id=b_intro]'], 6],
  ['block-markdown-image', 'mdimage', ['#docs-root'], 8],
  ['block-markdown-toolbar', 'mdtoolbar', ['#docs-root'], 8],
  ['block-input', 'notebook', ['[data-block-id=b_start]', '[data-block-id=b_channel]'], 6],
  ['block-sql', 'notebook', ['[data-block-id=b_sql]'], 6],
  ['block-local-sql', 'notebook', ['[data-block-id=b_local]'], 6],
  ['block-chart', 'notebook', ['[data-block-id=b_chart]'], 6],
  ['block-big-number', 'notebook', ['[data-block-id=b_bn]'], 6],
  ['dialog-advanced-settings', 'labels', ['[data-test=labels-dialog]'], 0],
  ['dialog-export', 'export', ['.ed'], 0],
  ['start-page', 'start', ['.sp'], 12],
  ['start-page-settings', 'start', ['.sp'], 12, undefined, '[data-test=settings-toggle]'],
];

// notebook scene: DOCS_ROOT_WIDTH in docsSmokeEntry.ts (1200) + room, so action buttons (delete, move) never wrap
const VIEWPORT_WIDTH = { notebook: 1240 };

let tmp, server, browser;
async function cleanup() {
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (server) server.close();
  if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

async function main() {
  const { chromium } = await import('playwright-core');
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-docs-'));
  mkdirSync(outDir, { recursive: true });
  const dir = join(tmp, 'site');
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: dir, SMOKE_INPUT: ENTRY } });
  if (b.status !== 0 || !existsSync(join(dir, ENTRY))) { console.log('FAIL  smoke build'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('No system Chrome/Edge found'); return 1; }
  server = createServer((req, res) => {
    const f = join(dir, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, ''));
    if (!f.startsWith(dir) || !existsSync(f) || !extname(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/${ENTRY}`;
  const hasQuant = spawnSync('pngquant', ['--version']).status === 0;
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('404')) errors.push(m.text().split('\n')[0]); });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__docsMount === 'function');
  let scene = null;
  for (const [name, sc, sels, pad, scale, click] of SHOTS) {
    if (scene !== sc || click) {
      await page.setViewportSize({ width: VIEWPORT_WIDTH[sc] || 1040, height: sc === 'labels' ? 560 : 900 });
      await page.evaluate((s) => window.__docsMount(s), sc);
      scene = sc;
      await page.evaluate(() => document.fonts.ready);
      if (sc === 'mdtoolbar') {
        await page.waitForSelector('.md-preview');
        await page.evaluate(() => document.querySelector('.md-preview').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        await page.waitForSelector('.md-toolbar');
        await page.evaluate(() => { const t = document.querySelector('textarea'); t.focus(); const i = t.value.indexOf('区域**'); t.setSelectionRange(i - 2, i + 4); });
      }
      await page.waitForSelector(sc === 'mdtoolbar' ? '.md-toolbar' : sc === 'mdimage' ? '.md-preview img[src^="data:"]' : sc === 'notebook' ? '[data-block-id=b_bn]' : sc === 'start' ? '.sp' : sc === 'labels' ? '[data-test=labels-dialog]' : '.ed');
      if (sc === 'notebook') await page.waitForSelector('[data-block-id=b_chart] svg, [data-block-id=b_chart] canvas');
      await page.waitForTimeout(800);
      await page.mouse.move(0, 0);
      if (sc !== 'mdtoolbar') await page.evaluate(() => document.activeElement && document.activeElement.blur());
    }
    if (click) {
      await page.click(click);
      await page.waitForSelector('[data-test=browser-pick-file]', { state: 'visible' });
      await page.waitForTimeout(500);
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
    }
    const boxes = [];
    for (const s of sels) boxes.push(await page.locator(s).first().boundingBox());
    const x = Math.min(...boxes.map((r) => r.x)) - pad, y = Math.min(...boxes.map((r) => r.y)) - pad;
    const x2 = Math.max(...boxes.map((r) => r.x + r.width)) + pad, y2 = Math.max(...boxes.map((r) => r.y + r.height)) + pad;
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true, scale: scale || 'device', clip: { x: Math.max(0, x), y: Math.max(0, y), width: x2 - Math.max(0, x), height: y2 - Math.max(0, y) } });
    if (hasQuant) spawnSync('pngquant', ['--force', '--skip-if-larger', '--quality=80-98', '--output', file, file]);
    console.log(`${name}.png  ${(statSync(file).size / 1024).toFixed(0)} KB`);
  }
  if (errors.length) { console.log('page errors: ' + errors.join(' | ')); return 1; }
  console.log(`wrote ${SHOTS.length} images to ${outDir}`);
  return 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
