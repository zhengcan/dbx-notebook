#!/usr/bin/env node
// Real-Chrome check of the "export finished" dialog (OK + Open): initial focus on OK, both buttons visible and named,
// Enter = OK, Tab order, Open closes the dialog / a failed Open shows a role=alert and keeps it open, AA contrast in light and dark.
// Exit codes: 0 pass, 1 fail, 2 skipped (1 if SMOKE_REQUIRE_BROWSER=1).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const ENTRY = 'export-done-smoke.html';
let tmp, server, browser;

const probe = () => {
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const ratio = (a, b) => { const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const btn = (id) => document.querySelector(`[data-test=cd-${id}]`);
  const info = (id) => { const b = btn(id); if (!b) return null; const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), w: r.width, h: r.height, ratio: ratio(cs.color, cs.backgroundColor), x: r.x }; };
  const err = document.querySelector('[data-test=cd-error]');
  const dlg = document.querySelector('[role=dialog]');
  return {
    ok: info('ok'), open: info('open'),
    focus: document.activeElement?.getAttribute('data-test'),
    outline: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : '',
    err: err ? { text: err.textContent, role: err.getAttribute('role'), ratio: ratio(getComputedStyle(err).color, getComputedStyle(dlg).backgroundColor) } : null,
    dialog: !!dlg, described: dlg?.getAttribute('aria-describedby') && !!document.getElementById(dlg.getAttribute('aria-describedby'))?.textContent,
  };
};

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-done-'));
  const dir = join(tmp, 'export-done-smoke');
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: dir, SMOKE_INPUT: ENTRY } });
  if (b.status !== 0 || !existsSync(join(dir, ENTRY))) { console.log(`FAIL  smoke build ${ENTRY}`); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; } catch { /* next */ }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const f = join(tmp, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f) || !extname(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/export-done-smoke/${ENTRY}`;
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__sqlnbMountExportDoneForSmoke === 'function');
  const mount = async (o) => { await page.evaluate((x) => window.__sqlnbMountExportDoneForSmoke(x), o); await page.waitForSelector('[data-test=cd-ok]'); await page.waitForTimeout(50); };
  const result = () => page.evaluate(() => window.__sqlnbDoneResult);
  const calls = () => page.evaluate(() => window.__sqlnbOpenCalls);

  for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
    const tag = `${locale}/${theme}`;
    await mount({ locale, theme, failOpen: false });
    const r = await page.evaluate(probe);
    report(r.ok?.text === (locale === 'en' ? 'OK' : '确定') && r.open?.text === (locale === 'en' ? 'Open' : '打开'), `${tag}: buttons "${r.ok?.text}" + "${r.open?.text}"`);
    report(r.ok.w > 20 && r.ok.h > 15 && r.open.w > 20 && r.open.h > 15, `${tag}: both buttons visible`);
    report(r.ok.x < r.open.x, `${tag}: OK before Open`);
    report(r.focus === 'cd-ok', `${tag}: initial focus on OK (${r.focus})`);
    report(r.described === true, `${tag}: dialog described by its message`);
    report(r.ok.ratio >= 4.5, `${tag}: OK contrast ${r.ok.ratio.toFixed(2)}`);
    report(r.open.ratio >= 4.5, `${tag}: Open contrast ${r.open.ratio.toFixed(2)}`);
    await page.keyboard.press('Tab');
    const t1 = await page.evaluate(probe);
    report(t1.focus === 'cd-open', `${tag}: Tab moves to Open`);
    report(t1.outline !== 'none', `${tag}: keyboard focus indicator drawn on Open (${t1.outline})`);
    await page.keyboard.press('Tab');
    report((await page.evaluate(probe)).focus === 'cd-ok', `${tag}: Tab wraps to OK`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    report((await result()) === 'ok' && (await calls()) === 0, `${tag}: Enter = OK, nothing opened`);

    await mount({ locale, theme, failOpen: false });
    await page.keyboard.press('Escape'); await page.waitForTimeout(50);
    report((await result()) === 'ok', `${tag}: Esc closes`);

    await mount({ locale, theme, failOpen: false });
    await page.click('[data-test=cd-open]'); await page.waitForTimeout(80);
    report((await result()) === 'open' && (await calls()) === 1 && !(await page.evaluate(probe)).dialog, `${tag}: Open runs once and closes`);

    await mount({ locale, theme, failOpen: true });
    await page.click('[data-test=cd-open]'); await page.waitForTimeout(80);
    const f = await page.evaluate(probe);
    report(f.dialog && (await result()) === null && f.err?.role === 'alert' && f.err.text.length > 5, `${tag}: failed Open keeps dialog with role=alert ("${f.err?.text}")`);
    report(f.err && f.err.ratio >= 4.5, `${tag}: error contrast ${f.err?.ratio.toFixed(2)}`);
    await page.screenshot({ path: join(process.env.UI_POLISH_OUT || tmpdir(), `export-done-${locale}-${theme}.png`) });
    await page.click('[data-test=cd-ok]'); await page.waitForTimeout(50);
    report((await result()) === 'ok', `${tag}: OK still works after a failed Open`);
  }
  await mount({ locale: 'en', theme: 'light', failOpen: 'network' });
  await page.click('[data-test=cd-open]'); await page.waitForTimeout(80);
  const nf = await page.evaluate(probe);
  report(nf.dialog && nf.err?.role === 'alert' && /network location/.test(nf.err.text), `network-location refusal shows its own alert ("${nf.err?.text}")`);
  report(errors.length === 0, `no page errors${errors.length ? ' (' + errors[0] + ')' : ''}`);
  return failed ? 1 : 0;
}
const cleanup = async () => { try { await browser?.close(); } catch {} try { server?.close(); } catch {} try { tmp && rmSync(tmp, { recursive: true, force: true }); } catch {} };
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
