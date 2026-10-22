#!/usr/bin/env node
// Real-Chrome check of the numbered preview badges (own entry; kept apart from ui-polish-check.mjs).
// Exit: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1). UI_POLISH_OUT sets the screenshot dir.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const outDir = process.env.UI_POLISH_OUT || join(tmpdir(), 'ui-polish');
const ENTRY = 'preview-badges-smoke.html';
const TABS = ['table', 'chart', 'numbers', 'categories'];

let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}

const measure = () => {
  const root = document.querySelector('[data-test=labels-preview]');
  const rr = root.getBoundingClientRect();
  const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const badges = [...root.querySelectorAll('.lp-badge')].map((b) => {
    const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(), cs = getComputedStyle(b);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = Math.max(p.left - cx, 0, cx - p.right), dy = Math.max(p.top - cy, 0, cy - p.bottom);
    const L1 = lum(cs.color), L2 = lum(cs.backgroundColor), hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    const host = b.parentElement, tn = [...host.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim()) || host.querySelector('.lpv-t')?.firstChild;
    let text = null;
    if (tn) { const rg = document.createRange(); rg.selectNodeContents(tn); const tr = rg.getBoundingClientRect(); text = [tr.left, tr.top, tr.right, tr.bottom]; }
    return { text, n: b.textContent, rect: [r.left, r.top, r.right, r.bottom], dist: Math.hypot(dx, dy), host: b.parentElement.textContent.replace(b.textContent, ''), w: r.width, h: r.height, contrast: (hi + 0.05) / (lo + 0.05), pos: cs.position, pe: cs.pointerEvents, ariaHidden: b.getAttribute('aria-hidden'), inside: r.left >= rr.left - 0.5 && r.right <= rr.right + 0.5 && r.top >= rr.top - 0.5 };
  });
  const geo = [rr, ...[...root.querySelectorAll('.lpv-c,.lpv-title')].map((e) => e.getBoundingClientRect())].map((r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(','));
  return { badges, geo, over: root.scrollWidth > root.clientWidth, img: !!root.querySelector('img,b'), rootHidden: root.getAttribute('aria-hidden'), focus: !!root.querySelector('[tabindex],button,a,input') };
};
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-badges-'));
  mkdirSync(outDir, { recursive: true });
  const dir = join(tmp, 'b');
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: dir, SMOKE_INPUT: ENTRY } });
  if (b.status !== 0 || !existsSync(join(dir, ENTRY))) { console.log(`FAIL  smoke build ${ENTRY}`); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; } catch { /* next */ }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f) || !extname(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`${base}/b/${ENTRY}`);
  await page.waitForFunction(() => typeof window.__sqlnbMountBadgesForSmoke === 'function');
  for (const theme of ['dark', 'light']) for (const width of [420, 928]) for (const tab of TABS) for (const hostile of [false, true]) {
    const tag = `${theme}/${width}px/${tab}${hostile ? '/hostile' : ''}`;
    await page.evaluate((o) => window.__sqlnbMountBadgesForSmoke(o), { theme, width, tab, hostile, badges: true });
    const hide = await page.addStyleTag({ content: '.lp-badge{display:none !important}' });
    const before = await page.evaluate(measure);
    await hide.evaluate((e) => e.remove());
    await page.waitForTimeout(30);
    const after = await page.evaluate(measure);
    const targets = await page.evaluate(() => window.__pbTargets);
    const bs = after.badges;
    report(before.badges.length === bs.length && JSON.stringify(before.geo) === JSON.stringify(after.geo), `${tag}: adding badges shifts no layout (${after.geo.length} boxes, same keys shown, badges hidden vs shown)`);
    report(bs.length > 0 && bs.every((x) => /^\d+$/.test(x.n) && x.ariaHidden === 'true' && x.pos === 'absolute' && x.pe === 'none'), `${tag}: ${bs.length} badges are digits, aria-hidden, absolute, pointer-events none`);
    report(bs.every((x) => x.h >= 14 && x.w >= 14), `${tag}: every badge >= 14px`);
    report(bs.every((x) => x.dist <= 24), `${tag}: badge centre within 24px of its element (max ${Math.max(...bs.map((x) => x.dist)).toFixed(1)})`);
    let ov = null;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (overlap(bs[i].rect, bs[j].rect)) ov = `${bs[i].n}/${bs[j].n}`;
    report(!ov, `${tag}: no two badges overlap${ov ? ' (' + ov + ')' : ''}`);
    report(bs.every((x) => x.text) && bs.every((x) => !overlap(x.rect, x.text)), `${tag}: no badge covers its host's text (Range over first text node)`);
    const digits = bs.map((x) => Number(x.n)).sort((p, q) => p - q);
    const shown = new Set(digits);
    report(digits.length === shown.size && digits.every((n) => targets.some((t) => t.n === n)), `${tag}: each digit once and from the map (${digits.join(',')})`);
    if (tab !== 'categories') report(shown.size === targets.length, `${tag}: all ${targets.length} numbered items have a badge (${shown.size})`);
    else report(shown.has(1) && shown.has(2) && shown.has(3), `${tag}: lowest numbered category items 1,2,3 have badges`);
    report(Math.min(...bs.map((x) => x.contrast)) >= 4.5, `${tag}: badge text contrast >= 4.5 (${Math.min(...bs.map((x) => x.contrast)).toFixed(1)})`);
    report(!after.over && bs.every((x) => x.inside), `${tag}: preview scrollWidth <= clientWidth, badges inside the preview`);
    report(!after.img && after.rootHidden === 'true' && !after.focus, `${tag}: text only, root aria-hidden, no focusables`);
    if (!hostile && width === 420) await page.screenshot({ path: join(outDir, `preview-badges-${theme}-${tab}.png`) });
    if (hostile && width === 420) await page.screenshot({ path: join(outDir, `preview-badges-${theme}-${tab}-hostile.png`) });
  }
  report(errors.length === 0, `no page errors${errors.length ? ' (' + errors[0] + ')' : ''}`);
  console.log(`screenshots in ${outDir}`);
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
