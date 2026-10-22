#!/usr/bin/env node
// Real-Chrome check of the Markdown editing toolbar mounted in the real MarkdownBlock: clicking a button never blurs the
// textarea or drops back to the preview, every action's result, Mod+B/I/K, roving-tabindex keyboard use, one undo step per
// action, 320/560/960 px layout (no overflow, no overlap, two rows at 320), measured toolbar height, light/dark contrast
// (>= 4.5:1 for icons and focus ring), Chinese and English accessible names, composition guard.
// SMOKE_REQUIRE_BROWSER=1 makes a missing browser a failure; otherwise exit 2 = SKIPPED.
// Screenshots go to SMOKE_SHOT_DIR (default: the OS temp dir).
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
const shotDir = process.env.SMOKE_SHOT_DIR || tmpdir();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const ORDER = ['heading', 'bold', 'italic', 'code', 'codeBlock', 'link', 'quote', 'ul', 'ol', 'table', 'image'];

let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.log('playwright-core is not installed: run `npm install` at the repo root.'); return 1; }
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-mdtb-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp, SMOKE_INPUT: 'mdtoolbar-smoke.html' } });
  if (b.status !== 0 || !existsSync(join(tmp, 'mdtoolbar-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found; cannot run the markdown toolbar check.'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'mdtoolbar-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__sqlnbMountMdTb === 'function');
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const MOD = mac ? 'Meta' : 'Control';
  const mount = async (o) => { await page.evaluate((x) => window.__sqlnbMountMdTb(x), o); await page.waitForTimeout(80); };
  const settle = () => page.waitForTimeout(80);
  const enter = async () => { await page.evaluate(() => document.querySelector('.md-preview').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await page.waitForTimeout(150); };
  const state = () => page.evaluate(() => { const t = document.querySelector('.md-block textarea'); return { editing: !!t, value: t?.value, from: t?.selectionStart, to: t?.selectionEnd, focused: !!t && document.activeElement === t, content: window.__mdStore.content(), depth: window.__mdStore.depth() }; });
  const select = (a, b) => page.evaluate(([x, y]) => { const t = document.querySelector('.md-block textarea'); t.focus(); t.setSelectionRange(x, y); }, [a, b]);
  const setText = (v) => page.evaluate((val) => { const t = document.querySelector('.md-block textarea'); t.focus(); t.value = val; t.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const clickBtn = async (a) => { const bb = await page.locator(`[data-action="${a}"]`).boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await settle(); };
  const geom = () => page.evaluate(() => {
    const tb = document.querySelector('.md-toolbar'), ta = document.querySelector('.md-block textarea'), r = (e) => e.getBoundingClientRect();
    const btns = Array.from(tb.querySelectorAll('button')).map(r), t = r(tb);
    const tops = [...new Set(btns.map((x) => Math.round(x.top)))];
    let overlap = 0;
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) { const p = btns[i], q = btns[j]; if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlap++; }
    return {
      tbH: t.height, rows: tops.length, overlap, minSide: Math.min(...btns.map((x) => Math.min(x.width, x.height))),
      inside: btns.every((x) => x.left >= t.left - 0.5 && x.right <= t.right + 0.5 && x.top >= t.top - 0.5 && x.bottom <= t.bottom + 0.5),
      overflowX: tb.scrollWidth > tb.clientWidth + 1, docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      above: t.bottom <= r(ta).top + 1, gap: r(ta).top - t.bottom, taW: r(ta).width, tbW: t.width, count: btns.length,
    };
  });

  // --- 1. Layout at 960 / 560 / 320, light and dark; height recorded --------------------------------------------------
  const tbHeights = {};
  for (const theme of ['light', 'dark']) {
    for (const width of [960, 560, 320]) {
      const tag = `${theme} ${width}px`;
      await page.setViewportSize({ width: Math.max(width + 40, 360), height: 700 });
      await mount({ theme, value: '# Title\n\nSome **bold** text and `code` here.\n\n- a\n- b', width });
      const ph = await page.evaluate(() => document.querySelector('.md-preview').getBoundingClientRect().height);
      await enter();
      const g = await geom();
      tbHeights[`${width}`] = tbHeights[`${width}`] ?? g.tbH;
      const taH = await page.evaluate(() => document.querySelector('.md-block textarea').getBoundingClientRect().height);
      report(g.count === 11, `${tag}: 11 buttons`);
      report(Math.abs(taH - ph) <= 1, `${tag}: textarea height ${taH.toFixed(1)} equals the preview height ${ph.toFixed(1)}`);
      report(g.rows === (width === 320 ? 2 : 1), `${tag}: ${g.rows} toolbar row(s), toolbar ${g.tbH.toFixed(1)}px high`);
      report(!g.overflowX && !g.docOverflow && g.inside, `${tag}: no horizontal overflow, every button inside the toolbar`);
      const tcs = await page.evaluate(() => {
        const tb = document.querySelector('.md-toolbar'), ta = document.querySelector('.md-block textarea'), tc = getComputedStyle(tb);
        const d = document.createElement('i'); d.style.color = 'var(--color-primary)'; ta.parentElement.appendChild(d); const primary = getComputedStyle(d).color; d.remove();
        const bg = getComputedStyle(ta).backgroundColor;
        const un = { tbBottomW: tc.borderBottomWidth, tbMb: tc.marginBottom, tbRad: tc.borderRadius, taTopW: getComputedStyle(ta).borderTopWidth, taRad: getComputedStyle(ta).borderRadius };
        ta.focus(); const c = getComputedStyle(ta);
        return { ...un, ow: c.outlineWidth, os: c.outlineStyle, oo: parseFloat(c.outlineOffset), oc: c.outlineColor, shadow: c.boxShadow, bw: c.borderTopWidth, primary, bg };
      });
      report(g.gap >= -0.5 && g.gap <= 0.5 && tcs.tbMb === '0px', `${tag}: toolbar and textarea are one piece, no gap (gap ${g.gap.toFixed(1)}px, margin-bottom ${tcs.tbMb})`);
      report(tcs.tbBottomW === '0px' && tcs.taTopW === '1px', `${tag}: a single 1px line between toolbar and textarea (toolbar border-bottom ${tcs.tbBottomW}, textarea border-top ${tcs.taTopW})`);
      report(tcs.tbRad === '4px 4px 0px 0px' && tcs.taRad === '0px 0px 4px 4px', `${tag}: toolbar rounds the top corners, textarea the bottom ones (${tcs.tbRad} / ${tcs.taRad})`);
      const rgbOf = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      report(tcs.ow === '2px' && tcs.os === 'solid' && tcs.oo < 0 && tcs.oc === tcs.primary && tcs.shadow === 'none' && tcs.bw === '1px', `${tag}: focused textarea has a 2px solid primary outline drawn inward, no shadow, border stays 1px (${JSON.stringify({ ow: tcs.ow, os: tcs.os, oo: tcs.oo, oc: tcs.oc, shadow: tcs.shadow })})`);
      report(ratio(rgbOf(tcs.oc), rgbOf(tcs.bg)) >= 3, `${tag}: focus ring vs textarea background ${ratio(rgbOf(tcs.oc), rgbOf(tcs.bg)).toFixed(2)}:1 (>= 3)`);
      report(g.overlap === 0 && g.above, `${tag}: buttons do not overlap each other nor the textarea`);
      report(g.minSide >= 28, `${tag}: every target >= 28px (min ${g.minSide.toFixed(1)})`);
      await page.evaluate(() => { const t = document.querySelector('.md-block textarea'); t.focus(); t.setSelectionRange(0, 7); });
      await setText('line\n'.repeat(12));
      await page.waitForTimeout(100);
      const g2 = await geom();
      report(Math.abs(g2.tbH - g.tbH) <= 0.5, `${tag}: toolbar height stable while typing (${g.tbH.toFixed(1)} -> ${g2.tbH.toFixed(1)})`);
      await page.screenshot({ path: join(shotDir, `mdtb-${theme}-${width}.png`) });
    }
  }
  console.log(`INFO  toolbar height by width: ${JSON.stringify(tbHeights)} (the block is this much taller in edit mode than in preview; the textarea itself keeps the preview height)`);
  await page.setViewportSize({ width: 1000, height: 700 });

  // --- 2. Colours: icon contrast and focus ring, both themes ---------------------------------------------------------
  for (const theme of ['light', 'dark']) {
    await mount({ theme, value: 'hello', width: 560 });
    await enter();
    await page.keyboard.press('Shift+Tab');
    await settle();
    const c = await page.evaluate(() => {
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const tb = document.querySelector('.md-toolbar'), b = document.querySelector('[data-action="heading"]'), bcs = getComputedStyle(b), tcs = getComputedStyle(tb);
      return { icon: rgb(getComputedStyle(b.querySelector('svg')).stroke), fg: rgb(bcs.color), bg: rgb(tcs.backgroundColor), ring: rgb(bcs.outlineColor), ringW: parseFloat(bcs.outlineWidth), ringStyle: bcs.outlineStyle, focused: document.activeElement === b, hoverBg: rgb(getComputedStyle(document.body).getPropertyValue('--color-background') || '255,255,255') };
    });
    report(c.focused, `${theme}: Shift+Tab from the textarea focuses the toolbar's active button`);
    report(ratio(c.icon, c.bg) >= 4.5, `${theme}: icon vs toolbar background ${ratio(c.icon, c.bg).toFixed(2)}:1 (>= 4.5)`);
    report(c.ringStyle !== 'none' && c.ringW >= 2 && ratio(c.ring, c.bg) >= 4.5, `${theme}: focus ring ${c.ringW}px ${c.ringStyle}, ${ratio(c.ring, c.bg).toFixed(2)}:1 against the toolbar (>= 4.5)`);
    const hov = await page.evaluate(() => { const b = document.querySelector('[data-action="bold"]'); return b.getBoundingClientRect().toJSON(); });
    await page.mouse.move(hov.x + 10, hov.y + 10);
    await settle();
    const hc = await page.evaluate(() => { const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number); const b = document.querySelector('[data-action="bold"]'); const cs = getComputedStyle(b); return { fg: rgb(cs.color), bg: rgb(cs.backgroundColor) }; });
    report(ratio(hc.fg, hc.bg) >= 4.5, `${theme}: hovered icon vs hover background ${ratio(hc.fg, hc.bg).toFixed(2)}:1 (>= 4.5)`);
  }

  // --- 3. Mouse: clicking never blurs the textarea nor leaves edit mode; every action's result -------------------------
  const CASES = [
    ['heading', 'hello', [0, 5], '# hello'], ['bold', 'hello', [0, 5], '**hello**'], ['italic', 'hello', [0, 5], '*hello*'], ['code', 'hello', [0, 5], '`hello`'],
    ['codeBlock', 'hello', [0, 5], '```\nhello\n```'], ['link', 'hello', [0, 5], '[hello](https://)'], ['quote', 'hello', [0, 5], '> hello'],
    ['ul', 'hello', [0, 5], '- hello'], ['ol', 'hello', [0, 5], '1. hello'], ['table', 'hello', [0, 5], 'hello\n\n| 列1 | 列2 |\n| --- | --- |\n| 值 | 值 |'],
  ];
  await mount({ theme: 'light', value: 'hello', width: 560 });
  await enter();
  for (const [a, init, [f, t], want] of CASES) {
    await setText(init);
    const d0 = (await state()).depth;
    await select(f, t);
    await clickBtn(a);
    const s = await state();
    report(s.editing && s.focused, `click ${a}: textarea keeps focus and the block stays in edit mode`);
    report(s.content === want && s.value === want, `click ${a}: ${JSON.stringify(init)} -> ${JSON.stringify(s.content)}`);
    report(s.depth === d0 + 1, `click ${a}: exactly one undo step (${d0} -> ${s.depth})`);
    await page.evaluate(() => window.__mdStore.undo());
    await page.waitForTimeout(100);
    const u = await state();
    report(u.content === init && u.editing, `click ${a}: one undo restores ${JSON.stringify(init)}`);
    report(u.depth === d0, `click ${a}: undo depth back to ${d0}`);
    await page.evaluate(() => window.__mdStore.redo());
    await page.waitForTimeout(100);
    report((await state()).content === want, `click ${a}: redo reapplies`);
    await page.evaluate(() => window.__mdStore.undo());
    await page.waitForTimeout(80);
  }
  // Caret after undo = end of the changed span; selection after an action = what the action selected.
  await mount({ theme: 'light', value: 'ab cd ef', width: 560 });
  await enter();
  await select(3, 5);
  await clickBtn('bold');
  let s = await state();
  report(s.from === 5 && s.to === 7, `bold selection restored over the wrapped text (${s.from}-${s.to}, want 5-7)`);
  await page.evaluate(() => window.__mdStore.undo());
  await page.waitForTimeout(100);
  s = await state();
  report(s.content === 'ab cd ef' && s.from === 5 && s.to === 5, `undo caret at the end of the changed span (${s.from}-${s.to}, want 5-5)`);
  await select(0, 2);
  const bb = await page.locator('[data-action="code"]').boundingBox();
  await page.mouse.move(bb.x + 10, bb.y + 10); await page.mouse.down(); await settle();
  s = await state();
  report(s.editing && s.focused && s.from === 0 && s.to === 2, `mouse down on a button: the textarea is still the active element with its selection (${s.from}-${s.to})`);
  await page.mouse.up(); await settle();
  await page.evaluate(() => window.__mdStore.undo());
  await settle();
  // Clicking the toolbar's blank padding or separator must not blur either.
  const pad = await page.evaluate(() => { const r = document.querySelector('.md-toolbar').getBoundingClientRect(); return { x: r.right - 3, y: r.top + 3 }; });
  await page.mouse.click(pad.x, pad.y);
  s = await state();
  report(s.editing && s.focused, 'clicking the blank toolbar area keeps focus and edit mode');
  await page.mouse.click(5, 690);
  await page.waitForTimeout(120);
  report(!(await state()).editing, 'clicking outside the block still returns to the preview');

  // --- 4. Shortcuts ---------------------------------------------------------------------------------------------------
  await mount({ theme: 'light', value: 'hello', width: 560 });
  await enter();
  for (const [k, want] of [['b', '**hello**'], ['i', '*hello*'], ['k', '[hello](https://)']]) {
    await setText('hello'); await select(0, 5);
    await page.keyboard.press(`${MOD}+${k}`);
    await settle();
    s = await state();
    report(s.content === want && s.editing && s.focused, `${MOD}+${k.toUpperCase()}: ${JSON.stringify(s.content)}`);
  }
  await setText('hello'); await select(0, 5);
  const d1 = (await state()).depth;
  await page.keyboard.press(`${MOD}+Shift+b`); await page.keyboard.press(`${MOD}+Alt+b`);
  await settle();
  s = await state();
  report(s.content === 'hello' && s.depth === d1, 'Shift/Alt variants of Mod+B do nothing');

  // --- 5. Keyboard: roving tabindex, Home/End, Tab, Esc, Enter ---------------------------------------------------------
  await mount({ theme: 'light', value: 'hello', width: 560 });
  await enter();
  await select(0, 5);
  const act = () => page.evaluate(() => document.activeElement?.getAttribute('data-action') ?? (document.activeElement?.tagName || '').toLowerCase());
  await page.keyboard.press('Shift+Tab'); await settle();
  report(await act() === 'heading', 'Shift+Tab from the textarea lands on the active toolbar button');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle();
  report(await act() === 'italic', `ArrowRight x2 moves to italic (${await act()})`);
  const stops = await page.evaluate(() => Array.from(document.querySelectorAll('.md-toolbar button')).filter((b) => b.tabIndex === 0).map((b) => b.getAttribute('data-action')));
  report(stops.length === 1 && stops[0] === 'italic', `exactly one tab stop in the toolbar, on the roved button (${stops})`);
  report((await state()).editing, 'the block stays in edit mode while the toolbar has focus');
  await page.keyboard.press('End'); await settle();
  report(await act() === 'image', 'End goes to the last button');
  await page.keyboard.press('ArrowRight'); await settle();
  report(await act() === 'image', 'ArrowRight at the end does not wrap');
  await page.keyboard.press('Home'); await settle();
  report(await act() === 'heading', 'Home goes to the first button');
  await page.keyboard.press('ArrowLeft'); await settle();
  report(await act() === 'heading', 'ArrowLeft at the start does not wrap');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle();
  await page.keyboard.press('Tab'); await settle();
  report(await act() === 'textarea', 'Tab from the toolbar returns to the textarea');
  s = await state();
  report(s.from === 0 && s.to === 5, `the selection survives the trip (${s.from}-${s.to})`);
  await page.keyboard.press('Shift+Tab'); await settle();
  await page.keyboard.press('Escape'); await settle();
  s = await state();
  report(s.editing && s.focused && s.from === 0 && s.to === 5, 'Esc in the toolbar returns to the textarea, selection kept, still editing');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await settle();
  await page.keyboard.press('Enter'); await settle();
  s = await state();
  report(s.content === '**hello**' && s.focused, `Enter on a focused button runs it and returns focus to the textarea (${JSON.stringify(s.content)})`);
  await select(0, 9);
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle();
  await page.keyboard.press('Space'); await settle();
  s = await state();
  report(s.content === '***hello***', `Space on a focused button runs it (${JSON.stringify(s.content)})`);
  await page.keyboard.press('Escape'); await settle();
  await page.keyboard.press('Escape'); await settle();
  report(!(await state()).editing, 'Esc in the textarea still leaves edit mode');
  // Focus moving to something outside from the toolbar leaves edit mode.
  await mount({ theme: 'light', value: 'hello', width: 560 });
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'outside'; document.querySelector('#next').appendChild(i); });
  await enter();
  await page.keyboard.press('Shift+Tab'); await settle();
  await page.focus('#outside'); await page.waitForTimeout(150);
  report(!(await state()).editing, 'focus moving from the toolbar to an outside control leaves edit mode');

  // --- 6. Composition -------------------------------------------------------------------------------------------------
  await mount({ theme: 'light', value: 'hello', width: 560 });
  await enter();
  await select(0, 5);
  await page.evaluate(() => document.querySelector('.md-block textarea').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await settle();
  const dis = await page.evaluate(() => Array.from(document.querySelectorAll('.md-toolbar button')).every((b) => b.getAttribute('aria-disabled') === 'true' && !b.disabled));
  report(dis, 'composition: all buttons aria-disabled (not disabled)');
  await clickBtn('bold');
  await page.keyboard.press(`${MOD}+b`);
  await settle();
  s = await state();
  report(s.content === 'hello' && s.value === 'hello' && s.depth === 0 && s.focused, 'composition: click and Mod+B do nothing and the draft is intact');
  await page.evaluate(() => document.querySelector('.md-block textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await settle();
  report(await page.evaluate(() => document.querySelector('[data-action="bold"]').getAttribute('aria-disabled') === null), 'composition end re-enables the buttons');

  // --- 7. Accessible names, Chinese and English ----------------------------------------------------------------------
  const sc = mac ? '⌘' : 'Ctrl+';
  const WANT = {
    'zh-CN': { label: 'Markdown 格式工具栏', bold: `粗体 (${sc}B)`, italic: `斜体 (${sc}I)`, link: `链接 (${sc}K)`, image: '插入图片…' },
    en: { label: 'Markdown formatting toolbar', bold: `Bold (${sc}B)`, italic: `Italic (${sc}I)`, link: `Link (${sc}K)`, image: 'Insert image…' },
  };
  for (const locale of ['zh-CN', 'en']) {
    await mount({ theme: 'light', value: 'hello', width: 560, locale });
    await enter();
    const n = await page.evaluate(() => ({ label: document.querySelector('[role="toolbar"]').getAttribute('aria-label'), btns: Object.fromEntries(Array.from(document.querySelectorAll('.md-toolbar button')).map((b) => [b.dataset.action, [b.getAttribute('aria-label'), b.title, b.querySelector('svg').getAttribute('aria-hidden')]])) }));
    const w = WANT[locale];
    report(n.label === w.label, `${locale}: toolbar name ${JSON.stringify(n.label)}`);
    report(['bold', 'italic', 'link', 'image'].every((k) => n.btns[k][0] === w[k] && n.btns[k][1] === w[k]), `${locale}: aria-label == title for bold/italic/link/image (${n.btns.bold[0]}, ${n.btns.link[0]})`);
    report(ORDER.every((k) => n.btns[k]?.[0] && n.btns[k][0] === n.btns[k][1] && n.btns[k][2] === 'true'), `${locale}: all 11 buttons named, title == aria-label, icon aria-hidden`);
    if (locale === 'en') {
      await select(0, 5); await clickBtn('table');
      s = await state();
      report(s.content.includes('Column 1') && !/[\u3400-\u9fff]/.test(s.content), `en: table template uses English placeholders (${JSON.stringify(s.content.split('\n')[2])})`);
    }
  }

  // --- 8. Desktop drop and toolbar image picker (fake fileTransfer injected) -------------------------------------------
  const LINK = (n) => `![](n.sqlnb.assets/image-${n}.png)`;
  const H = (id, name = id + '.png') => ({ handleId: id, name, size: 0, contentType: '' });
  const ftState = () => page.evaluate(() => ({ cancels: [...window.__ft.cancels], reads: window.__ft.reads, notice: window.__dropNotice }));
  await mount({ theme: 'light', value: 'hello', width: 560, drop: 'full' });
  await enter();
  await select(2, 2);
  await page.evaluate((h) => window.__ft.emit([h]), H('a'));
  await page.waitForTimeout(300);
  s = await state(); let ft = await ftState();
  report(s.content === `he${LINK(1)}llo`, `host drop: image inserted at the cursor (${JSON.stringify(s.content)})`);
  report(ft.cancels.join() === 'a' && ft.reads === 1, `host drop: handle released once, read once (${ft.cancels}, reads ${ft.reads})`);
  const d0 = s.depth;
  await page.evaluate(() => window.__mdStore.undo()); await settle();
  s = await state();
  report(s.content === 'hello', 'host drop: one undo removes the inserted image');
  await page.evaluate(() => window.__mdStore.redo()); await settle();
  report((await state()).depth === d0, 'host drop: redo restores a single step');
  // a duplicate drop (same dropId) inserts nothing and still releases
  await page.evaluate(() => { window.__ft.emit([{ handleId: 'x1', name: 'x.png', size: 0, contentType: '' }], { dropId: 'dup', truncated: false }); });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__ft.emit([{ handleId: 'x2', name: 'x.png', size: 0, contentType: '' }], { dropId: 'dup', truncated: false }); });
  await page.waitForTimeout(250);
  s = await state(); ft = await ftState();
  report((s.content.match(/!\[\]/g) || []).length === 2 && ft.cancels.includes('x1') && ft.cancels.includes('x2'), `host drop: duplicate dropId inserted once, both handles released (${s.content.match(/!\[\]/g)?.length} links)`);
  // candidate highlight with a non-colour cue, cleared by Escape and by pointermove
  await page.evaluate(() => window.__ft.drag(true)); await settle();
  const hl = await page.evaluate(() => { const b = document.querySelector('.md-block'); return { cand: b.getAttribute('data-drop-candidate'), outline: getComputedStyle(b).outlineStyle }; });
  report(hl.cand === 'true' && hl.outline === 'dashed', `drag: candidate block highlighted with a dashed outline (${JSON.stringify(hl)})`);
  await page.keyboard.press('Escape'); await settle();
  report(await page.evaluate(() => document.querySelector('[data-drop-candidate]') === null), 'drag: Escape clears the highlight');
  await page.evaluate(() => window.__ft.drag(true)); await settle();
  await page.mouse.move(5, 5); await page.mouse.move(40, 40); await settle();
  report(await page.evaluate(() => document.querySelector('[data-drop-candidate]') === null), 'drag: pointermove clears the highlight');
  await page.evaluate(() => { window.__ft.drag(true); window.dispatchEvent(new Event('blur')); }); await settle();
  report(await page.evaluate(() => document.querySelector('[data-drop-candidate]') === null), 'drag: window blur clears the highlight');

  // toolbar insert image via the host picker
  await mount({ theme: 'light', value: 'hello', width: 560, drop: 'full' });
  await enter();
  await select(5, 5);
  await page.evaluate((h) => { window.__ft.pickResult = [h]; }, H('p1'));
  await clickBtn('image'); await page.waitForTimeout(300);
  s = await state(); ft = await ftState();
  report(s.content === `hello${LINK(1)}` && s.editing && s.focused && s.from === s.content.length, `picker: image inserted at the cursor, edit mode and focus kept (${JSON.stringify(s.content)})`);
  report(ft.cancels.join() === 'p1', 'picker: handle released once');
  await page.evaluate(() => window.__mdStore.undo()); await settle();
  report((await state()).content === 'hello', 'picker: one undo removes it');
  await page.evaluate(() => { window.__ft.pickResult = null; });
  const before = (await state()).content;
  await clickBtn('image'); await page.waitForTimeout(200);
  s = await state();
  report(s.content === before && s.editing && !(await ftState()).notice, 'picker: cancel is a silent no-op');

  // degrade: no pick capability → <input type=file> fallback keeps edit mode
  const PNGB = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  for (const mode of ['nopick', 'none']) {
    await mount({ theme: 'light', value: 'hello', width: 560, drop: mode });
    await enter();
    await select(5, 5);
    const bb = await page.locator('[data-action="image"]').boundingBox();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)]);
    report(chooser.isMultiple(), `${mode}: file chooser opens in multiple mode`);
    s = await state();
    report(s.editing, `${mode}: edit mode kept while the chooser is open`);
    await chooser.setFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNGB });
    await page.waitForTimeout(400);
    s = await state();
    report(s.content === `hello${LINK(1)}` && s.editing && s.focused, `${mode}: chosen file inserted (${JSON.stringify(s.content)})`);
  }
  await mount({ theme: 'light', value: 'hello', width: 560, drop: 'none' });
  await page.evaluate(() => window.__ft.drag(true)); await settle();
  report(await page.evaluate(() => document.querySelector('[data-drop-candidate]') === null && !window.__ft.stateCb), 'no fileTransfer: nothing subscribed, no highlight');
  report(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.log('FAIL ' + e.message); await cleanup(); process.exit(1); });
