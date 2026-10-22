#!/usr/bin/env node
// Sandbox CSP smoke test: loads the packaged UI in the dbx-plugin dev host (srcdoc iframe + CSP).
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const pluginDir = resolve(uiSrc, '..');
const DBX_PLUGIN_CLI_VERSION = process.env.DBX_PLUGIN_CLI_VERSION || '0.1.9';
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';

const steps = [];
const consoleErrors = [];
let tmp = null;
let host = null;
let browser = null;

const trunc = (s) => (s.length > 400 ? s.slice(0, 400) + '…' : s);
const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
};

function killHost() {
  if (!host || host.exitCode !== null || !host.pid) return;
  if (isWin) { try { spawnSync('taskkill', ['/pid', String(host.pid), '/T', '/F']); } catch {} return; }
  try { process.kill(-host.pid, 'SIGKILL'); } catch { try { host.kill('SIGKILL'); } catch {} }
}
async function cleanup() {
  if (browser) {
    const b = browser; browser = null;
    await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
  killHost();
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}
process.on('exit', () => { killHost(); if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(1); });
process.on('uncaughtException', async (e) => { console.error(e); await cleanup(); process.exit(1); });

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (host.exitCode !== null) throw new Error('dev host exited early (code ' + host.exitCode + ')');
    try { const r = await fetch(url); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('dev host did not answer HTTP 200 within ' + ms / 1000 + 's');
}

const isCspMsg = (t) => /Content Security Policy|unsafe-eval|EvalError/i.test(t);
const ignorable = (t) => /favicon|Failed to load resource/i.test(t);

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.log('playwright-core is not installed (it is a repo devDependency): run `npm install` at the repo root.'); return 1; }

  if (process.env.SMOKE_SKIP_BUILD === '1') {
    console.log('mode: SMOKE_SKIP_BUILD=1 (using existing plugin/ui, may be stale)');
    if (!existsSync(join(pluginDir, 'ui', 'index.html'))) { record('plugin/ui exists', false); return 1; }
  } else {
    console.log('mode: fresh build (npm run build -w plugin/ui-src)');
    const b = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'build', '-w', 'plugin/ui-src'], { cwd: resolve(pluginDir, '..'), stdio: 'inherit', shell: isWin });
    if (!record('build plugin/ui', b.status === 0)) return 1;
  }

  {
    const assets = join(pluginDir, 'ui', 'assets');
    const html = readFileSync(join(pluginDir, 'ui', 'index.html'), 'utf8');
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
    const body = (f) => readFileSync(join(assets, f), 'utf8');
    const entry = /src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1];
    const fmt = js.filter((f) => body(f).includes('mandatory_block'));
    const evalFiles = js.filter((f) => body(f).includes('new Function'));
    if (!record('sql-formatter is a separate lazy chunk (not the entry, not preloaded by index.html)',
      !!entry && fmt.length === 1 && fmt[0] !== entry && !html.includes(fmt[0]) && body(entry).includes(fmt[0]), fmt.join(',') || 'chunk not found')) return 1;
    if (!record('`new Function` only in the vega bundle', evalFiles.length === 1 && /^vega\.module-/.test(evalFiles[0]), evalFiles.join(','))) return 1;
  }

  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${trunc(String(e.message).split('\n')[0])}`); }
  }
  if (!browser) {
    console.log('No system Chrome/Edge found; cannot run sandbox smoke test.');
    return requireBrowser ? 1 : 2;
  }

  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-smoke-'));
  cpSync(join(pluginDir, 'ui'), join(tmp, 'ui'), { recursive: true });
  cpSync(join(pluginDir, 'assets'), join(tmp, 'assets'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  delete manifest.entrypoints.backend;
  manifest.engines = { host_api: '1' };
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(tmp, 'dbx-plugin.toml'), 'schema_version = 1\n\n[package]\ninclude = ["assets","ui"]\n');
  const wbLabel = manifest.contributions.find((c) => c.type === 'workbench')?.label ?? 'SQL Notebook';

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const cli = '@dbx-app/plugin-cli@' + DBX_PLUGIN_CLI_VERSION;
  const npx = isWin ? 'npx.cmd' : 'npx';
  const pre = spawnSync(npx, ['--yes', cli, '--help'], { timeout: 180000, encoding: 'utf8', shell: isWin });
  if (!record('prefetch ' + cli, pre.status === 0, pre.status === 0 ? '' : trunc(String(pre.stderr || pre.error || '')))) return 1;
  host = spawn(npx, ['--yes', cli, 'dev', '--path', tmp, '--port', String(port)], { detached: !isWin, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostLog = '';
  host.stdout.on('data', (d) => { hostLog += d; });
  host.stderr.on('data', (d) => { hostLog += d; });
  try { await waitHttp(url, 60000); record('dev host started', true, url); }
  catch (e) { record('dev host started', false, e.message); console.log(trunc(hostLog.slice(-800))); return 1; }

  const page = await (await browser.newContext()).newPage();
  const onMsg = (text) => { if (!ignorable(text) || isCspMsg(text)) consoleErrors.push(text); };
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) onMsg(`console.${m.type()}: ${m.text()}`); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const re = new RegExp('^\\s*(' + [wbLabel, 'SQL 笔记本', 'SQL Notebook'].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*$', 'i');
  const cands = page.locator('button, a, [role=button], [role=tab], li, div, span').filter({ hasText: re });
  let clicked = false;
  const n = await cands.count();
  let best = null;
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i);
    const tag = await el.evaluate((e) => e.tagName.toLowerCase());
    const text = ((await el.textContent()) || '').trim();
    if (!re.test(text)) continue;
    if (['button', 'a'].includes(tag)) { best = el; break; }
    best ??= el;
  }
  if (best) { await best.click(); clicked = true; }
  if (!record('open workbench entry in host', clicked)) {
    console.log('Host DOM snippet:\n' + trunc((await page.evaluate(() => document.body.innerHTML)).slice(0, 2000)));
    return 1;
  }

  let frame = null;
  let nFrames = 0;
  const end = Date.now() + 15000;
  while (Date.now() < end && !frame) {
    const fs = page.frames().filter((f) => f.url() === 'about:srcdoc');
    nFrames = fs.length;
    if (fs.length === 1) frame = fs[0];
    else await page.waitForTimeout(250);
  }
  if (!record('exactly one sandbox iframe (about:srcdoc)', !!frame, 'found ' + nFrames)) return 1;

  const step = async (name, fn) => {
    try { await fn(); return record(name, true); }
    catch (e) { return record(name, false, trunc(String(e.message).split('\n')[0])); }
  };
  const bail = async () => {
    await page.waitForTimeout(300);
    return !steps.some((s) => !s.ok);
  };

  await step('iframe is the plugin UI (title + start page/toolbar)', async () => {
    await frame.waitForFunction((t) => document.title === t, manifest.name, { timeout: 10000 });
    await frame.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^\s*(新建笔记本|New notebook)\s*$/.test(b.textContent || '')) || !!document.querySelector('[data-test=toolbar]'), null, { timeout: 10000 });
  });
  await step('#app has children', async () => {
    await frame.waitForFunction(() => (document.querySelector('#app')?.children.length ?? 0) > 0, null, { timeout: 10000 });
  });
  if (await bail()) {
    await step('New notebook shows toolbar', async () => {
      await frame.getByText(/^(新建笔记本|New notebook)$/).first().click({ timeout: 5000 });
      await frame.waitForSelector('[data-test=toolbar]', { timeout: 5000 });
    });
    await step('+ SQL mounts .cm-editor', async () => {
      await frame.getByText('+ SQL', { exact: true }).first().click({ timeout: 5000 });
      await frame.waitForSelector('.cm-editor', { timeout: 5000 });
    });
    await step('AI entry follows aiCompletion (absent when false, present when true)', async () => {
      // The dev host (CLI 0.1.9) reports no capabilities at all; the bridge reads window.dbxPlugin.capabilities on every call.
      // The dev host (CLI 0.1.9) reports no capabilities; the bridge reads window.dbxPlugin.capabilities on every call, so a proxy can stand in for them.
      const setCaps = (v) => frame.evaluate((x) => {
        const h = window.__sqlnbRealHost ?? (window.__sqlnbRealHost = window.dbxPlugin);
        if (!h) throw new Error('window.dbxPlugin missing');
        const proxy = new Proxy(h, { get: (t, k) => (k === 'capabilities' ? { aiCompletion: x, aiCompletionStream: x } : Reflect.get(t, k)) });
        Object.defineProperty(window, 'dbxPlugin', { value: proxy, configurable: true, writable: true });
        return window.dbxPlugin.capabilities.aiCompletion === x;
      }, v);
      const askCount = () => frame.locator('[data-test=ask-ai]').count();
      const addSql = async () => { await frame.getByText('+ SQL', { exact: true }).first().click({ timeout: 5000 }); await frame.waitForTimeout(300); };
      if (!(await setCaps(false))) throw new Error('cannot override capabilities in the dev host');
      const before = await frame.locator('.cm-editor').count();
      await addSql();
      if ((await frame.locator('.cm-editor').count()) <= before) throw new Error('second SQL block did not mount');
      if ((await askCount()) !== 0) throw new Error('ask-ai rendered although aiCompletion is false');
      await setCaps(true);
      await addSql();
      await frame.waitForSelector('[data-test=ask-ai]', { timeout: 5000 });
      if ((await askCount()) !== 1) throw new Error('expected exactly one ask-ai (only the block mounted with aiCompletion:true)');
    });
    await step('+ Markdown shows editable preview', async () => {
      await frame.getByText('+ Markdown', { exact: true }).first().click({ timeout: 5000 });
      await frame.waitForSelector('.md-preview, .md-editor', { timeout: 5000 });
    });
    await step('Markdown heading styles apply under the sandbox CSP (computed h1 size > body, h2 accent border-left)', async () => {
      const ta = frame.locator('textarea.md-editor').first();
      if (!(await ta.count())) await frame.locator('.md-preview').first().dblclick();
      await ta.fill('# Title\n\n## Section\n\ntext');
      await ta.press('Control+Enter');
      await frame.waitForSelector('.md-view h1', { timeout: 5000 });
      const r = await frame.evaluate(() => {
        const cs = (e) => getComputedStyle(e);
        const h1 = document.querySelector('.md-view h1'), h2 = document.querySelector('.md-view h2');
        return { body: parseFloat(cs(document.body).fontSize), h1: parseFloat(cs(h1).fontSize), h2bl: parseFloat(cs(h2).borderLeftWidth), h2blc: cs(h2).borderLeftColor, styled: !!document.head.querySelector('style[data-md-css]') };
      });
      if (!r.styled) throw new Error('style[data-md-css] not injected');
      if (!(r.h1 > r.body)) throw new Error('h1 ' + r.h1 + ' not > body ' + r.body);
      if (!(r.h2bl >= 5) || /rgba\(0, 0, 0, 0\)/.test(r.h2blc)) throw new Error('h2 border-left ' + r.h2bl + ' ' + r.h2blc);
    });
  }

  await page.waitForTimeout(500);
  const bad = consoleErrors.filter((t) => /^pageerror/.test(t) || isCspMsg(t));
  record('no pageerror / CSP / EvalError messages', bad.length === 0, bad.length ? bad.length + ' found' : '');
  if (steps.some((s) => !s.ok)) {
    console.log('\nCollected console errors:');
    for (const t of consoleErrors) console.log('  - ' + trunc(t));
    return 1;
  }
  return 0;
}

let code = 1;
try { code = await main(); }
catch (e) { console.error(trunc(String(e.stack || e))); code = 1; }
finally {
  await cleanup();
}
console.log(code === 0 ? '\nSMOKE PASSED' : code === 2 ? '\nSMOKE SKIPPED' : '\nSMOKE FAILED');
process.exit(code);
