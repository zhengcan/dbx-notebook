#!/usr/bin/env node
// Real-Chrome check of Markdown images: PNG/JPEG/GIF/WebP render at natural size from a fake host client,
// error placeholders carry alt text + hint (no broken icon, no src), no layout jump on re-render, placeholder
// contrast >= 4.5:1 in light and dark, hostile sources never reach the host, and the exported HTML embeds data URIs
// with no external request. SMOKE_REQUIRE_BROWSER=1 makes a missing browser a failure; otherwise exit 2 = SKIPPED.
// Screenshots go to SMOKE_SHOT_DIR (default: the OS temp dir).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const shotDir = process.env.SMOKE_SHOT_DIR || tmpdir();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-mdimg-'));
  const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: tmp, SMOKE_INPUT: 'mdimage-smoke.html' } });
  if (b.status !== 0 || !existsSync(join(tmp, 'mdimage-smoke.html'))) { console.log('FAIL  smoke build'); return 1; }
  console.log('PASS  smoke build');
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; }
    catch (e) { console.log(`browser ${channel} unavailable: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found; cannot run the markdown image check.'); return requireBrowser ? 1 : 2; }
  const external = [];
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p === '/' ? 'mdimage-smoke.html' : p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f)) { if (req.url !== '/favicon.ico') external.push(req.url); res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('request', (r) => requests.push(r.url()));
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  await page.goto(base);
  await page.waitForFunction(() => typeof window.__sqlnbMountMdImg === 'function');
  const fx = await page.evaluate(() => window.__sqlnbMdImgFixtures());
  const images = {
    'pics/a.png': fx.png, 'pics/b.jpg': fx.jpeg, 'pics/c.webp': fx.webp, 'pics/d.gif': fx.gif,
    'gone.png': { error: 'notFound' }, 'photo.avif': { error: 'unsupported' }, 'big.png': { error: 'tooLarge' },
    'broken.png': { ...fx.png, base64: 'AAAA', width: 10, height: 10 },
  };
  const md = ['![png](pics/a.png)', '![jpeg](pics/b.jpg)', '![webp](pics/c.webp)', '![gif](pics/d.gif)'].join('\n\n');
  const state = () => page.evaluate(() => Array.from(document.querySelectorAll('.md-view img, .md-view [data-state]')).map((e) => ({ tag: e.tagName, st: e.getAttribute('data-state'), nw: e.naturalWidth, nh: e.naturalHeight, ok: e.tagName === 'IMG' ? e.complete && e.naturalWidth > 0 : null, role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: e.tagName === 'IMG' ? '' : e.textContent, err: e.getAttribute('data-error'), hasSrc: e.hasAttribute('src') })));

  for (const theme of ['light', 'dark']) {
    await page.evaluate((o) => window.__sqlnbMountMdImg(o), { theme, value: md, path: '/n/report.sqlnb', images, delayMs: 150 });
    const h0 = await page.evaluate(() => document.querySelector('.md-block').getBoundingClientRect().height);
    const loading = await page.evaluate(() => Array.from(document.querySelectorAll('.md-view [data-state="loading"]')).map((e) => ({ h: e.getBoundingClientRect().height, role: e.getAttribute('role'), label: e.getAttribute('aria-label') })));
    report(loading.length === 4 && loading.every((l) => l.h >= 47 && l.role === 'img' && l.label), `${theme}: four loading boxes reserve >= 48px and are role=img with a label (${loading.map((l) => Math.round(l.h)).join(',')})`);
    await page.waitForFunction(() => document.querySelectorAll('.md-view img[data-state="ok"]').length === 4, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const st = await state();
    const want = [['png', 120, 80], ['jpeg', 100, 60], ['webp', 90, 70], ['gif', 8, 6]];
    st.forEach((s, i) => report(s.ok && s.nw === want[i][1] && s.nh === want[i][2], `${theme}: ${want[i][0]} decodes at natural size ${s.nw}x${s.nh}`));
    const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('.md-view img')).map((i) => { const r = i.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    report(JSON.stringify(boxes) === JSON.stringify(want.map((w) => [w[1], w[2]])), `${theme}: laid-out boxes equal the RPC width/height ${JSON.stringify(boxes)}`);
    const rpc = await page.evaluate(() => window.__rpc);
    report(rpc.length === 4 && rpc.every((c) => c.method === 'notebook/readImage' && c.params.notebookPath === '/n/report.sqlnb' && /^pics\/[a-d]\./.test(c.params.relPath)), `${theme}: exactly four readImage calls with the notebook path and relative paths`);
    // Re-render (same images, extra paragraph): served from cache, no jump, no extra RPC.
    const before = await page.evaluate(() => ({ h: document.querySelector('.md-block').getBoundingClientRect().height, next: document.querySelector('#next').getBoundingClientRect().top }));
    await page.evaluate((v) => window.__sqlnbMdSetValue(v), md + '\n\nextra');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ h: document.querySelector('.md-block').getBoundingClientRect().height, imgs: document.querySelectorAll('.md-view img[data-state="ok"]').length, rpc: window.__rpc.length, loading: document.querySelectorAll('.md-view [data-state="loading"]').length }));
    report(after.imgs === 4 && after.loading === 0 && after.rpc === 4, `${theme}: re-render hits the cache (no loading state, rpc stays ${after.rpc})`);
    report(after.h > before.h && after.h - before.h < 40, `${theme}: re-render grows only by the added paragraph (${before.h.toFixed(1)} -> ${after.h.toFixed(1)}), no image jump`);
    report(h0 > 0, `${theme}: initial block height ${h0.toFixed(1)}`);
    await page.screenshot({ path: join(shotDir, `mdimg-${theme}-ok.png`) });

    const emd = ['![Missing pic](gone.png)', '![Weird format](photo.avif)', '![Huge](big.png)', '![Bad bytes](broken.png)', '![](../../etc/passwd)', '![Abs](/etc/hosts)', '![Remote](https://evil.example/x.png)', '![Win](C:\\x.png)', '![Svg](data:image/svg+xml;base64,PHN2Zz4=)'].join('\n\n');
    await page.evaluate((o) => window.__sqlnbMountMdImg(o), { theme, value: emd, path: '/n/report.sqlnb', images });
    await page.waitForFunction(() => document.querySelectorAll('.md-view [data-state="error"]').length >= 4, null, { timeout: 5000 });
    await page.waitForTimeout(200);
    const es = await state();
    const byErr = (c) => es.find((s) => s.err === c);
    report(byErr('notFound')?.text.includes('Missing pic') && byErr('notFound').text.includes('找不到图片'), `${theme}: notFound placeholder shows alt + 「找不到图片」`);
    report(byErr('unsupported')?.text.includes('Weird format') && byErr('unsupported').text.includes('不支持的图片') && !byErr('unsupported').hasSrc, `${theme}: unsupported placeholder shows alt + 「不支持的图片」, no src`);
    report(byErr('tooLarge')?.text.includes('图片过大'), `${theme}: tooLarge placeholder`);
    report(byErr('decodeFailed')?.text.includes('Bad bytes') && byErr('decodeFailed').text.includes('无法显示此图片'), `${theme}: undecodable bytes (onerror) become a placeholder, not a broken icon`);
    report(es.filter((s) => s.tag === 'IMG').length === 0, `${theme}: no <img> left in the error document`);
    report(es.filter((s) => s.st === 'error').every((s) => s.role === 'img' && s.label && s.label.length > 0), `${theme}: every placeholder is role=img with aria-label`);
    const calls = await page.evaluate(() => window.__rpc.map((c) => c.params.relPath));
    report(calls.sort().join(',') === 'big.png,broken.png,gone.png,photo.avif', `${theme}: hostile sources never reach the host (calls: ${calls.join(',')})`);
    const pageText = await page.evaluate(() => document.querySelector('.md-view').innerHTML);
    report(!/evil\.example|\/etc\/|C:\\|\/n\/report/.test(pageText), `${theme}: no path or remote URL leaks into the DOM`);
    const col = await page.evaluate(() => {
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const ph = document.querySelector('.md-view [data-state="error"]');
      const pcs = getComputedStyle(ph);
      return { bg: rgb(pcs.backgroundColor), alt: rgb(getComputedStyle(ph.querySelector('.sqlnb-img-alt')).color), hint: rgb(getComputedStyle(ph.querySelector('.sqlnb-img-hint')).color), hintSize: parseFloat(getComputedStyle(ph.querySelector('.sqlnb-img-hint')).fontSize) };
    });
    const ra = ratio(col.alt, col.bg), rh = ratio(col.hint, col.bg);
    report(ra >= 4.5 && rh >= 4.5, `${theme}: placeholder contrast alt ${ra.toFixed(2)}:1, hint ${rh.toFixed(2)}:1 (>= 4.5)`);
    await page.screenshot({ path: join(shotDir, `mdimg-${theme}-errors.png`) });
  }

  await page.evaluate((o) => window.__sqlnbMountMdImg(o), { theme: 'light', value: '![pic](a.png)', path: null, images });
  await page.waitForTimeout(150);
  const un = await state();
  report(un.length === 1 && un[0].text.includes('保存笔记本后显示图片') && un[0].text.includes('pic') && (await page.evaluate(() => window.__rpc.length)) === 0, 'unsaved notebook: save hint, alt text, zero RPC');
  await page.evaluate((o) => window.__sqlnbMountMdImg(o), { theme: 'light', value: '![pic](a.png)', path: null, images, locale: 'en' });
  await page.waitForTimeout(100);
  report((await state())[0].text.includes('Save the notebook'), 'unsaved notebook: English hint');

  // Export: embedded data URIs, no external request, images decode at natural size.
  const exp = await page.evaluate((o) => window.__sqlnbMdImgExport(o), { value: md + '\n\n![gone](gone.png)\n\n![r](https://evil.example/r.png)', path: '/n/report.sqlnb', images });
  report(exp.ok && (exp.html.match(/<img [^>]*src="data:image\/(png|jpeg|webp|gif);base64,/g) || []).length === 4, 'export: four images embedded as data URIs');
  report(!/\ssrc="(?!data:)/.test(exp.html) && !exp.html.includes('data-sqlnb-src') && !exp.html.includes('evil.example'), 'export: no relative, remote or leftover source in the HTML');
  report(exp.html.includes('sqlnb-img-missing">gone<') && exp.html.includes('1 张图片未嵌入'), 'export: missing image is alt text and counted in the info block');
  const file = join(tmp, 'export.html');
  writeFileSync(file, exp.html);
  const ep = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const ereq = [];
  ep.on('request', (r) => ereq.push(r.url()));
  await ep.goto(pathToFileURL(file).href);
  await ep.waitForLoadState('load');
  const ei = await ep.evaluate(() => Array.from(document.querySelectorAll('img')).map((i) => [i.complete && i.naturalWidth > 0, i.naturalWidth, i.naturalHeight]));
  report(ei.length === 4 && ei.every((x) => x[0]) && JSON.stringify(ei.map((x) => [x[1], x[2]])) === JSON.stringify([[120, 80], [100, 60], [90, 70], [8, 6]]), `export: embedded images decode at natural size ${JSON.stringify(ei)}`);
  report(ereq.every((u) => u.startsWith('file:') || u.startsWith('data:')), `export: no external request (${ereq.length} requests)`);
  await ep.screenshot({ path: join(shotDir, 'mdimg-export.png') });
  const unsavedExp = await page.evaluate((o) => window.__sqlnbMdImgExport(o), { value: md, path: null, images });
  report(unsavedExp.ok && !/<img/.test(unsavedExp.html) && unsavedExp.html.includes('4 张图片未嵌入'), 'export: unsaved notebook gives alt text only');

  // Paste / drop in the Markdown editor (real ClipboardEvent / DragEvent carrying real File objects).
  {
    const sendFiles = (kind, files, extra = {}) => page.evaluate(async ({ kind, files, extra }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.text || '');
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (extra.text) dt.setData('text/plain', extra.text);
      const ta = document.querySelector('textarea.md-editor');
      if (extra.sel) ta.setSelectionRange(extra.sel[0], extra.sel[1]);
      let ev;
      if (kind === 'paste') ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      else ev = new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: extra.x ?? 0, clientY: extra.y ?? 0 });
      ta.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 250));
      return { prevented: ev.defaultPrevented, value: ta.value };
    }, { kind, files, extra });
    const pf = { name: 'shot.png', type: 'image/png', b64: fx.png.base64 };
    const rpcSaves = () => page.evaluate(() => window.__rpc.filter((c) => c.method === 'notebook/saveImage').map((c) => c.params));
    const editMode = async (value, path) => {
      await page.evaluate((o) => window.__sqlnbMountMdPaste(o), { value, path });
      await page.waitForSelector('.md-view');
      await page.dblclick('.md-view');
      await page.waitForSelector('textarea.md-editor');
      await page.focus('textarea.md-editor');
    };
    const REL = /report\.sqlnb\.assets\/image-\d{8}-\d{6}-[0-9a-f]{8}\.png|report\.sqlnb\.assets\/image-20260101-00000\d-abcd123\d\.png/;

    await editMode('hello world', '/n/report.sqlnb');
    let r = await sendFiles('paste', [pf], { sel: [5, 5] });
    const link = '![](report.sqlnb.assets/image-20260101-000001-abcd1231.png)';
    report(r.prevented && r.value === 'hello' + link + ' world', `paste: link inserted at the caret (${r.value})`);
    let saves = await rpcSaves();
    report(saves.length === 1 && saves[0].notebookPath === '/n/report.sqlnb' && saves[0].mime === 'image/png' && saves[0].base64.endsWith('b64>'), 'paste: exactly one saveImage with the notebook path and image/png');
    const caret = await page.evaluate(() => { const t = document.querySelector('textarea.md-editor'); return [t.selectionStart, t.selectionEnd, document.activeElement === t]; });
    report(caret[0] === 5 + link.length && caret[1] === caret[0] && caret[2], `paste: caret after the link and focus kept (${caret})`);
    report((await page.evaluate(() => window.__mdStore.depth())) === 1, 'paste: one history entry');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => { const i = document.querySelector('.md-view img'); return i && i.getAttribute('data-state') === 'ok' && i.naturalWidth === 120; }, null, { timeout: 5000 });
    report(true, 'paste: preview renders the new image at 120x80 after leaving edit mode');
    await page.screenshot({ path: join(shotDir, 'mdimg-paste.png') });
    await page.evaluate(() => window.__mdStore.undo());
    report((await page.evaluate(() => window.__mdStore.content())) === 'hello world', 'undo restores the exact text');
    await page.evaluate(() => window.__mdStore.redo());
    report((await page.evaluate(() => window.__mdStore.content())) === 'hello' + link + ' world', 'redo reapplies the link');

    // Drop at a caret position: start of the 3rd line, and past the end of the 2nd line.
    const text3 = 'first line\nsecond line\nthird line';
    await editMode(text3, '/n/report.sqlnb');
    const geo = await page.evaluate(() => { const t = document.querySelector('textarea.md-editor'); const r = t.getBoundingClientRect(); const cs = getComputedStyle(t); return { left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), top: r.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth), lh: parseFloat(cs.lineHeight) }; });
    r = await sendFiles('drop', [pf], { x: geo.left + 1, y: geo.top + geo.lh * 2.5, sel: [0, 0] });
    report(r.value === 'first line\nsecond line\n' + link + 'third line', `drop: inserted at the start of the dropped-on line (${JSON.stringify(r.value)})`);
    await editMode(text3, '/n/report.sqlnb');
    r = await sendFiles('drop', [pf], { x: geo.left + 600, y: geo.top + geo.lh * 1.5, sel: [0, 0] });
    report(r.value === 'first line\nsecond line' + link + '\nthird line', `drop: past the line end inserts at the end of that line (${JSON.stringify(r.value)})`);
    await editMode(text3, '/n/report.sqlnb');
    r = await sendFiles('drop', [pf], { x: geo.left + 5, y: geo.top + geo.lh * 0.5, sel: [0, 0] });
    report(r.value.indexOf(link) >= 1 && r.value.indexOf(link) <= 3 && r.value.endsWith('\nsecond line\nthird line'), `drop: mid-line x lands inside the first line (${JSON.stringify(r.value.slice(0, 20))})`);

    // Emoji: dropping across a😀b😀c😀😀😀d never leaves a lone surrogate and never loses text.
    {
      const emo = 'a😀b😀c😀😀😀d';
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
      const offsets = new Set();
      let bad = 0, lost = 0, n = 0;
      for (let dx = 0; dx <= 150; dx += 4) {
        await editMode(emo, '/n/report.sqlnb');
        const g2 = await page.evaluate(() => { const t = document.querySelector('textarea.md-editor'); const r = t.getBoundingClientRect(); const cs = getComputedStyle(t); return { left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), top: r.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth), lh: parseFloat(cs.lineHeight) }; });
        const rr = await sendFiles('drop', [pf], { x: g2.left + dx, y: g2.top + g2.lh / 2, sel: [0, 0] });
        const at = rr.value.indexOf('![](');
        offsets.add(at);
        n++;
        if (lone.test(rr.value)) bad++;
        if (rr.value.replace(link, '') !== emo) lost++;
      }
      report(bad === 0 && lost === 0 && offsets.size >= 6, `emoji drop: ${n} positions, no lone surrogate (${bad}), no lost text (${lost}), ${offsets.size} distinct offsets`);
      await editMode(emo, '/n/report.sqlnb');
      r = await sendFiles('paste', [pf], { sel: [2, 2] });
      report(!lone.test(r.value) && r.value === 'a' + link + emo.slice(1), 'paste with the caret inside an emoji pair inserts before the emoji');
    }

    // Mixed drop: png + txt + svg -> only the png is saved; the svg is reported.
    await editMode('abc', '/n/report.sqlnb');
    r = await sendFiles('drop', [pf, { name: 'n.txt', type: 'text/plain', text: 'x' }, { name: 'v.svg', type: 'image/svg+xml', text: '<svg/>' }], { x: geo.left + 600, y: geo.top + geo.lh * 0.5 });
    saves = await rpcSaves();
    const msg = await page.evaluate(() => document.querySelector('.md-notice')?.textContent || '');
    report(saves.length === 1 && r.value.startsWith('abc![](') && msg.includes('1 个文件不是支持的图片'), `mixed drop: one save, svg reported (${msg})`);
    // SVG only: nothing saved, visible message, text unchanged.
    await editMode('abc', '/n/report.sqlnb');
    r = await sendFiles('drop', [{ name: 'v.svg', type: 'image/svg+xml', text: '<svg/>' }, { name: 'p.avif', type: 'image/avif', text: 'x' }]);
    const m2 = await page.evaluate(() => ({ t: document.querySelector('.md-notice')?.textContent || '', role: document.querySelector('.md-notice')?.getAttribute('role') }));
    report(r.prevented && r.value === 'abc' && (await rpcSaves()).length === 0 && m2.t.includes('2 个文件不是支持的图片') && m2.role === 'status', 'svg/avif drop: prevented, nothing saved, visible status message');
    // Text paste untouched; unsaved notebook refuses images with a visible alert.
    await editMode('abc', '/n/report.sqlnb');
    r = await sendFiles('paste', [], { text: 'plain' });
    report(!r.prevented && (await rpcSaves()).length === 0, 'text paste: default not prevented, no RPC');
    await editMode('abc', null);
    r = await sendFiles('paste', [pf]);
    const m3 = await page.evaluate(() => ({ t: document.querySelector('.md-notice')?.textContent || '', role: document.querySelector('.md-notice')?.getAttribute('role'), rpc: window.__rpc.length, depth: window.__mdStore.depth() }));
    report(r.prevented && r.value === 'abc' && m3.t === '请先保存笔记本，再粘贴图片' && m3.role === 'alert' && m3.rpc === 0 && m3.depth === 0, `unsaved notebook: alert "${m3.t}", no RPC, no entry`);
    await page.screenshot({ path: join(shotDir, 'mdimg-paste-unsaved.png') });

    // Block-level drop target: a drop on the preview (the textarea has already lost focus when files come from Finder).
    {
      const dropOn = (sel, kind, files) => page.evaluate(async ({ sel, kind, files }) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(new File([f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.text || '')], f.name, { type: f.type }));
        const el = document.querySelector(sel);
        const ev = new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 3, clientY: 3 });
        el.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r, kind === 'drop' ? 300 : 30));
        return { prevented: ev.defaultPrevented, effect: dt.dropEffect, hint: !!document.querySelector('.md-block.md-drop') };
      }, { sel, kind, files });
      await page.evaluate((o) => window.__sqlnbMountMdPaste(o), { value: 'hello', path: '/n/report.sqlnb' });
      await page.waitForSelector('.md-view');
      const hasTa = () => page.evaluate(() => !!document.querySelector('textarea.md-editor'));
      const e1 = await dropOn('.md-view', 'dragenter', [pf]);
      report(e1.hint && e1.prevented, 'preview dragenter with an image shows the drop hint');
      const outline = await page.evaluate(() => getComputedStyle(document.querySelector('.md-block')).outlineStyle);
      report(outline === 'dashed', `drop hint has a visible outline (${outline})`);
      const e2 = await dropOn('.md-view', 'dragover', [pf]);
      report(e2.prevented, 'preview dragover with an image is prevented');
      const e3 = await dropOn('.md-view', 'dragover', [{ name: 'a.txt', type: 'text/plain', text: 'x' }]);
      report(e3.prevented && e3.effect === 'none', 'preview dragover with a text file is prevented (no navigation) and not droppable');
      await page.evaluate(() => window.__rpc = []);
      const d = await dropOn('.md-view', 'drop', [pf]);
      const saves2 = await rpcSaves();
      const content = await page.evaluate(() => window.__mdStore.content());
      report(d.prevented && !d.hint && saves2.length === 1 && saves2[0].notebookPath === '/n/report.sqlnb', 'preview drop: prevented, hint cleared, one saveImage RPC');
      report(content === 'hello\n\n![](report.sqlnb.assets/image-20260101-000001-abcd1231.png)', `preview drop: encoded link appended as a new paragraph (${JSON.stringify(content)})`);
      report(!(await hasTa()), 'preview drop: block stays in preview');
      await page.waitForFunction(() => { const i = document.querySelector('.md-view img'); return i && i.getAttribute('data-state') === 'ok' && i.naturalWidth === 120; }, null, { timeout: 5000 });
      report(true, 'preview drop: the dropped image renders in the preview');
      report((await page.evaluate(() => window.__mdStore.depth())) === 1, 'preview drop: one history entry');
      await page.evaluate(() => window.__mdStore.undo());
      report((await page.evaluate(() => window.__mdStore.content())) === 'hello', 'preview drop: one undo restores the text');
      await page.evaluate((o) => window.__sqlnbMountMdPaste(o), { value: 'hello', path: '/n/report.sqlnb' });
      await page.waitForSelector('.md-view');
      await dropOn('.md-view', 'drop', [{ name: 'v.svg', type: 'image/svg+xml', text: '<svg/>' }]);
      const msg2 = await page.evaluate(() => document.querySelector('.md-notice')?.textContent || '');
      report(msg2.includes('1 个文件不是支持的图片') && (await page.evaluate(() => window.__mdStore.content())) === 'hello', 'preview drop of svg: notice, text unchanged');

      // Stray / non-image file drags must never reach the browser default (navigation to the file).
      {
        const probe = (sel, kind, f) => page.evaluate(({ sel, kind, f }) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new TextEncoder().encode(f.text)], f.name, { type: f.type }));
          const ev = new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true });
          document.querySelector(sel).dispatchEvent(ev);
          return { prevented: ev.defaultPrevented, effect: dt.dropEffect, hint: !!document.querySelector('.md-block.md-drop') };
        }, { sel, kind, f });
        const navBefore = await page.evaluate(() => location.href);
        const pdf = { name: 'a.pdf', type: 'application/pdf', text: '%PDF' };
        for (const kind of ['dragover', 'drop']) {
          const o = await probe('#next', kind, pdf);
          report(o.prevented, `non-Markdown area: ${kind} with a file is prevented`);
        }
        const o2 = await probe('#next', 'dragover', { name: 'p.png', type: 'image/png', text: 'x' });
        report(o2.prevented && o2.effect === 'none', `non-Markdown area: image dragover is refused (effect ${o2.effect})`);
        const o3 = await probe('.md-view', 'dragover', pdf);
        report(o3.prevented && o3.effect === 'none' && !o3.hint, 'Markdown block: non-image file dragover is prevented, not droppable, no hint');
        const o4 = await probe('.md-view', 'drop', pdf);
        report(o4.prevented, 'Markdown block: non-image file drop is prevented');
        const o5 = await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hi'); const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }); document.querySelector('#next').dispatchEvent(ev); return ev.defaultPrevented; });
        report(!o5, 'text drag is not prevented');
        await page.waitForTimeout(200);
        report((await page.evaluate(() => location.href)) === navBefore && (await page.evaluate(() => !!document.querySelector('.md-block'))), 'page did not navigate away');
      }

      // Window deactivation: the textarea blurs but keeps being document.activeElement; the block must stay in edit mode.
      await page.evaluate((o) => window.__sqlnbMountMdPaste(o), { value: 'keep me', path: '/n/report.sqlnb' });
      await page.waitForSelector('.md-view');
      const hBefore = await page.evaluate(() => document.querySelector('.md-block').getBoundingClientRect().height);
      await page.dblclick('.md-view');
      await page.waitForSelector('textarea.md-editor');
      await page.focus('textarea.md-editor');
      await page.evaluate(() => { document.querySelector('textarea.md-editor').setSelectionRange(3, 3); window.__origHasFocus = document.hasFocus; document.hasFocus = () => false; document.querySelector('textarea.md-editor').dispatchEvent(new FocusEvent('blur')); });
      await page.waitForTimeout(150);
      const st = await page.evaluate(() => { const t = document.querySelector('textarea.md-editor'); return t ? [document.activeElement === t, t.selectionStart] : null; });
      report(st && st[0] && st[1] === 3, `window deactivation: stays in edit mode with the caret kept (${JSON.stringify(st)})`);
      const hEdit = await page.evaluate(() => document.querySelector('.md-block').getBoundingClientRect().height - ((() => { const e = document.querySelector('.md-toolbar'); return e ? e.getBoundingClientRect().height + parseFloat(getComputedStyle(e).marginBottom) : 0; })()));
      report(Math.abs(hEdit - hBefore) < 2, `window deactivation: content height unchanged, toolbar row excluded (${hBefore.toFixed(1)} -> ${hEdit.toFixed(1)})`);
      await page.evaluate(() => { document.hasFocus = window.__origHasFocus; });
      await page.evaluate(() => document.querySelector('textarea.md-editor').blur());
      await page.waitForSelector('.md-view', { timeout: 3000 });
      report(!(await hasTa()), 'real blur (click elsewhere) still returns to preview');
    }
    void REL;
  }

  report(requests.every((u) => u.startsWith(base) || u.startsWith('data:')) && external.length === 0, `page made no external request (${requests.length} requests)`);
  report(errors.length === 0, `no page errors${errors.length ? ': ' + errors[0] : ''}`);
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.log('FAIL ' + e.message); await cleanup(); process.exit(1); });
