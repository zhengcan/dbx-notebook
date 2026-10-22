#!/usr/bin/env node
// Undo/redo check: keyboard-only document history in real Chrome (CodeMirror, Markdown, input blocks, IME, focus, live region) under the DBX sandbox CSP.
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
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-undo-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp, SMOKE_INPUT: 'undo-smoke.html' } });
  if (b.status !== 0 || !existsSync(join(tmp, 'undo-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${trunc(String(e.message).split('\n')[0])}`); }
  }
  if (!browser) { console.log('No system Chrome/Edge found; cannot run undo check.'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'undo-smoke.html' : p.replace(/^\/+/, ''));
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
  await page.waitForFunction(() => typeof window.__sqlnbMountUndoForSmoke === 'function', null, { timeout: 10000 });
  await page.evaluate(() => window.__sqlnbMountUndoForSmoke());
  await page.waitForSelector('.cm-content');

  let failed = false;
  const report = (ok, name, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); if (!ok) failed = true; };
  const U = (fn, arg) => page.evaluate(fn, arg);
  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
  const st = () => U(() => ({ ids: window.__undo.ids(), depth: window.__undo.depth(), redo: window.__undo.redo(), dirty: window.__undo.dirty(), live: window.__undo.live(), active: window.__undo.active(), calls: { ...window.__undo.calls }, s1: window.__undo.content('s1'), m1: window.__undo.content('m1') }));
  const settle = () => page.waitForTimeout(60);
  const blur = async () => { await page.mouse.click(5, 5); await settle(); };
  const cdp = await page.context().newCDPSession(page);

  // 1. CodeMirror: typing is one step; Mod+Z with the editor focused is a STORE undo (single history), caret sane, no extra step.
  const base = await st();
  report(base.depth === 0 && !base.dirty, 'start: empty history, clean', JSON.stringify({ depth: base.depth, dirty: base.dirty }));
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' where 1=1', { delay: 5 });
  await settle();
  let s = await st();
  report(s.s1 === 'select 1 where 1=1' && s.depth === 1, 'typing in CodeMirror = one coalesced step', `s1=${s.s1} depth=${s.depth}`);
  await page.keyboard.press(`${MOD}+z`);
  await settle();
  s = await st();
  const cm = await U(() => ({ text: document.querySelector('.cm-content').textContent }));
  report(s.s1 === 'select 1' && s.depth === 0 && s.redo === 1, 'Mod+Z inside the editor undoes the store step (no extra step)', `s1=${s.s1} depth=${s.depth} redo=${s.redo}`);
  report(cm.text === 'select 1' && s.active.endsWith('.cm'), 'editor text follows the store and keeps focus', `text=${cm.text} focus=${s.active}`);
  report(/^Undone: /.test(s.live), 'live region announces the undo', JSON.stringify(s.live));
  await page.keyboard.press(`${MOD}+Shift+z`);
  await settle();
  s = await st();
  report(s.s1 === 'select 1 where 1=1' && s.depth === 1 && s.redo === 0, 'Mod+Shift+Z inside the editor redoes', `s1=${s.s1} depth=${s.depth}`);
  report(/^Redone: /.test(s.live), 'live region announces the redo', JSON.stringify(s.live));
  await page.keyboard.type('X');
  await settle();
  s = await st();
  report(s.s1.endsWith('1=1X'), 'caret stayed at the end after redo (typing continues there)', s.s1);
  await page.keyboard.press(`${MOD}+z`); await settle();
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(s.s1 === 'select 1' && s.dirty === false, 'undo back to the opening state is clean', `s1=${s.s1} dirty=${s.dirty}`);

  // 2. Markdown textarea: native undo inside, document undo outside.
  await page.dblclick('[data-block-id=m1] .md-preview');
  await page.waitForSelector('[data-block-id=m1] textarea');
  await page.keyboard.press('End');
  await page.keyboard.type(' world', { delay: 5 });
  await settle();
  const callsBefore = (await st()).calls.undo;
  await page.keyboard.press(`${MOD}+z`);
  await settle();
  s = await st();
  report(s.calls.undo === callsBefore, 'Mod+Z inside the Markdown textarea is native (store shortcut ignored)', `calls=${s.calls.undo}`);
  report(s.m1 === (await U(() => document.querySelector('[data-block-id=m1] textarea')?.value)), 'store follows the textarea after a native undo', `m1=${s.m1}`);
  await page.keyboard.type(' again', { delay: 5 });
  await blur();
  s = await st();
  await page.keyboard.press(`${MOD}+z`);
  await settle();
  s = await st();
  report(s.calls.undo === callsBefore + 1, 'Mod+Z outside fields is the document undo', `calls=${s.calls.undo}`);
  // reset: undo everything so later steps start clean
  for (let i = 0; i < 6; i++) { await page.keyboard.press(`${MOD}+z`); await settle(); }
  await page.keyboard.press(`${MOD}+Shift+z`); await page.keyboard.press(`${MOD}+z`); await settle();

  // 3. Structure by UI then keyboard undo with focus outside fields.
  const ids0 = (await st()).ids;
  await page.click('[data-block-id=s1] ~ [data-test=insert] [data-test=add-md]');
  await settle();
  s = await st();
  report(s.ids.length === ids0.length + 1, 'add via the insert row', s.ids.join(','));
  report(/^textarea/.test(s.active), 'a NEWLY created empty Markdown block autofocuses its editor', s.active);
  await blur();
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(JSON.stringify(s.ids) === JSON.stringify(ids0), 'undo of an add removes it again', s.ids.join(','));
  report(s.active === 'div[notebook-view]', 'focus after undoing an add is the notebook container, not a block', s.active);
  await page.keyboard.press(`${MOD}+Shift+z`); await settle();
  s = await st();
  report(s.ids.length === ids0.length + 1 && !/textarea|input/.test(s.active), 'a RESTORED empty Markdown block (redo of the add) does not autofocus', `${s.ids.join(',')} focus=${s.active}`);
  await page.keyboard.press(`${MOD}+z`); await settle();
  await page.hover('[data-block-id=i1]');
  await page.click('[data-block-id=i1] [data-test=del]');
  await settle();
  s = await st();
  report(!s.ids.includes('i1'), 'delete block via UI', s.ids.join(','));
  await blur();
  await page.focus('body').catch(() => {});
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(JSON.stringify(s.ids) === JSON.stringify(ids0), 'undo of a delete restores id and position', s.ids.join(','));
  report(!/textarea|input/.test(s.active), 'restored block does not steal focus', s.active);
  await page.keyboard.press(`${MOD}+Shift+z`); await settle();
  s = await st();
  report(!s.ids.includes('i1'), 'redo removes it again', s.ids.join(','));
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(JSON.stringify(s.ids) === JSON.stringify(ids0), 'undo restores the deleted block again before the move test', s.ids.join(','));
  await page.hover('[data-block-id=s1]');
  await page.click('[data-block-id=s1] [data-test=down]'); await settle();
  s = await st();
  report(s.ids.join(',') === 'm1,s1,i1,m2', 'move down via UI', s.ids.join(','));
  await blur();
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(JSON.stringify(s.ids) === JSON.stringify(ids0), 'undo of a move restores the exact original order', s.ids.join(','));

  // 4. Plain input fields keep native undo.
  s = await st();
  const c0 = s.calls.undo;
  await page.click('[data-block-id=i1] [data-test=value]');
  await page.keyboard.type('yy'); await settle();
  await page.keyboard.press(`${MOD}+z`); await settle();
  s = await st();
  report(s.calls.undo === c0, 'Mod+Z inside an input block field is native', `calls=${s.calls.undo}`);
  await blur();

  // 5. IME: a composition is one step, nothing mid-composition (real Chrome, CDP Input.imeSetComposition).
  const ime = async (selector, label, read) => {
    await page.click(selector);
    const d0 = (await st()).depth;
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: 'ni hao', selectionStart: 6, selectionEnd: 6 });
    await settle();
    const mid = await st();
    report(mid.depth === d0, `${label}: no step while composing`, `depth ${d0} -> ${mid.depth}`);
    await cdp.send('Input.insertText', { text: '你好' });
    await settle();
    const end = await st();
    const val = await U(read);
    report(end.depth === d0 + 1 && /你好/.test(val), `${label}: exactly one step at commit with the composed text`, `depth ${d0} -> ${end.depth}; value=${JSON.stringify(val)}`);
    await blur();
  };
  await ime('.cm-content', 'CodeMirror', () => window.__undo.content('s1'));
  await page.dblclick('[data-block-id=m1] .md-preview').catch(() => {});
  await page.waitForSelector('[data-block-id=m1] textarea').catch(() => {});
  if (await page.$('[data-block-id=m1] textarea')) await ime('[data-block-id=m1] textarea', 'Markdown textarea', () => window.__undo.content('m1'));
  else report(false, 'Markdown textarea opens for IME', 'textarea missing');
  await ime('[data-block-id=i1] [data-test=value]', 'input block value', () => window.__undo.meta('i1').value);
  // re-render during composition must not reset the field
  const rerender = async (label, selector, commitRead) => {
    await page.click(selector);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await U(() => window.__undo.rerender());
    await settle();
    const v = await U((sel) => document.querySelector(sel)?.value, selector);
    report(typeof v === 'string' && v.includes('zhong'), `${label}: a Vue re-render mid-composition does not reset the composed text`, JSON.stringify(v));
    await cdp.send('Input.insertText', { text: '中' });
    await settle();
    report(/中/.test(String(await U(commitRead))), `${label}: the composition still commits`, 'ok');
    await blur();
  };
  await page.dblclick('[data-block-id=m1] .md-preview').catch(() => {});
  await page.waitForSelector('[data-block-id=m1] textarea').catch(() => {});
  await rerender('Markdown textarea', '[data-block-id=m1] textarea', () => window.__undo.content('m1'));
  await rerender('input block value', '[data-block-id=i1] [data-test=value]', () => window.__undo.meta('i1').value);
  await rerender('input block name (invalid chars stay as draft)', '[data-block-id=i1] [data-test=var-name]', () => document.querySelector('[data-block-id=i1] [data-test=var-name]').value);

  // Cmd+Y is not redo inside the editor (same as outside); Ctrl+Y is
  await page.click('.cm-content');
  await page.keyboard.press(`${MOD}+z`); await settle();
  const r0 = await st();
  await page.keyboard.press('Meta+y'); await settle();
  const r1 = await st();
  report(r1.redo === r0.redo, 'Cmd+Y does nothing inside the editor', `redo ${r0.redo} -> ${r1.redo}`);
  await page.keyboard.press('Control+y'); await settle();
  const r2 = await st();
  report(r2.redo === r0.redo - 1, 'Ctrl+Y redoes inside the editor', `redo ${r1.redo} -> ${r2.redo}`);
  await blur();

  const unexpected = errors.filter((t) => /pageerror|Content Security Policy|unsafe-eval|EvalError|Refused|console\.error/i.test(t));
  report(unexpected.length === 0, 'no pageerror / CSP / console errors', unexpected.length ? trunc(unexpected[0]) : 'clean');
  await page.screenshot({ path: join(tmp, 'undo.png') }).catch(() => {});
  return failed ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(trunc(String(e.stack || e))); code = 1; } finally { await cleanup(); }
console.log(code === 0 ? '\nUNDO CHECK PASSED' : code === 2 ? '\n*** UNDO CHECK SKIPPED: no Chrome/Edge available (set SMOKE_REQUIRE_BROWSER=1 to fail instead; the release task does) ***' : '\nUNDO CHECK FAILED');
process.exit(code);
