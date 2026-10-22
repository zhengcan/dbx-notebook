#!/usr/bin/env node
// Real-Chrome check: big-number labels clamp to 2 lines (app card CSS from BigNumberBlock.vue and exported printCss),
// cards in a row have equal height, long/unbroken labels do not overflow, and the PDF keeps the visible label text.
// Exit codes: 0 pass, 1 fail, 2 skipped (1 if SMOKE_REQUIRE_BROWSER=1).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const skip = (msg) => { console.log(`SKIPPED: ${msg}`); return requireBrowser ? 1 : 2; };
const outDir = process.env.SMOKE_OUT_DIR || mkdtempSync(join(tmpdir(), 'bn-label-'));
const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };

const LABELS = ['Revenue', 'Total net revenue for the whole region this quarter after returns and adjustments', '长'.repeat(200), 'x'.repeat(80), 'a '.repeat(150), 'مبيعات '.repeat(30) + '🚀'.repeat(40)];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const vue = readFileSync(join(here, '../src/analysis/BigNumberBlock.vue'), 'utf8');
const appCss = [...vue.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const appBody = (theme) => `<body style="--color-foreground:${theme === 'dark' ? '#eee' : '#111'};--color-muted-foreground:${theme === 'dark' ? '#aaa' : '#666'};background:${theme === 'dark' ? '#1b1b1b' : '#fff'};width:900px"><div class="bn-out">${LABELS.map((l, i) => `<div class="bn-card"><div class="bn-value">${i}42</div><div class="bn-compare">▲ 1% vs x</div><div class="bn-label" title="${esc(l)}">${esc(l)}</div></div>`).join('')}</div></body>`;
const exportBody = `<body><section class="big-number">${LABELS.map((l, i) => `<div class="bn"><div class="v">${i}42</div><div class="l" title="${esc(l)}">${esc(l)}</div><div class="c">▲ 1% vs x</div></div>`).join('')}</section></body>`;

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  let browser;
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) return skip('No system Chrome/Edge found');
  const dir = mkdtempSync(join(tmpdir(), 'bn-css-'));
  execFileSync('npx', ['vite-node', 'scripts/pdf-edge-css.ts', join(dir, 'p.css')], { cwd: resolve(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
  const printCss = readFileSync(join(dir, 'p.css'), 'utf8');
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failed = true; };
  const probe = ({ card, label, value }) => {
    const cards = [...document.querySelectorAll(card)];
    const ls = [...document.querySelectorAll(label)];
    return {
      heights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
      lines: ls.map((l) => l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight)),
      over: ls.map((l) => l.scrollWidth > l.clientWidth + 1 || l.getBoundingClientRect().right > l.parentElement.getBoundingClientRect().right + 1),
      titled: ls.every((l, i) => l.getAttribute('title') === l.textContent),
      vfs: [...new Set([...document.querySelectorAll(value)].map((v) => getComputedStyle(v).fontSize))],
    };
  };
  const check = (tag, r) => {
    report(r.lines.every((n) => n <= 2.05), `${tag}: every label <= 2 lines (${r.lines.map((n) => n.toFixed(1)).join(',')})`);
    report(r.heights.length > 1 && new Set(r.heights).size === 1, `${tag}: equal card heights (${r.heights.join(',')})`);
    report(r.over.every((o) => !o), `${tag}: no label overflow`);
    report(r.titled, `${tag}: full text in title`);
    report(r.vfs.length === 1, `${tag}: value font-size consistent (${r.vfs})`);
  };
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 940, height: 700 } });
    await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${appCss}</style>${appBody(theme)}`);
    check(`app ${theme}`, await page.evaluate(probe, { card: '.bn-card', label: '.bn-label', value: '.bn-value' }));
    await page.screenshot({ path: join(outDir, `cards-${theme}.png`) });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 940, height: 700 } });
  await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${printCss}</style>${exportBody}`);
  check('export', await page.evaluate(probe, { card: '.bn', label: '.bn .l', value: '.bn .v' }));
  await page.screenshot({ path: join(outDir, 'export-cards.png') });
  await page.emulateMedia({ media: 'print' });
  check('export print', await page.evaluate(probe, { card: '.bn', label: '.bn .l', value: '.bn .v' }));
  if (has('pdftotext')) {
    const pdf = join(outDir, 'cards.pdf');
    await page.pdf({ path: pdf, format: 'A4' });
    const txt = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
    const lines = (await page.evaluate(() => [...document.querySelectorAll('.bn .l')].map((l) => l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight))));
    report(txt.includes('Revenue') && txt.includes('长长长') && txt.includes('xxxxxxxx'), 'pdf: visible label text present');
    report(!txt.includes('长'.repeat(200)), 'pdf: 200-char label is clamped, not fully printed');
    report(lines.every((n) => n <= 2.05), 'pdf: label <= 2 lines in print media');
  } else if (requireBrowser) report(false, 'pdftotext missing (required when SMOKE_REQUIRE_BROWSER=1)');
  else console.log('note: pdftotext missing, PDF text check skipped');
  await browser.close();
  console.log(`screenshots in ${outDir}`);
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
