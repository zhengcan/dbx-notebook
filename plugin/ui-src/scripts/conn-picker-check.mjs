#!/usr/bin/env node
// Real-Chrome check of ConnectionPicker option styling: optgroups render, disabled (not connected) options stay
// readable and distinguishable from enabled ones in light and dark. Exit: 0 pass, 1 fail, 2 skipped (1 if SMOKE_REQUIRE_BROWSER=1).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sfc = readFileSync(resolve(here, '../src/shell/ConnectionPicker.vue'), 'utf8');
const css = sfc.slice(sfc.indexOf('<style'), sfc.indexOf('</style>')).replace(/^<style[^>]*>/, '').replace(/\[data-v-[^\]]*\]/g, '');
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const THEMES = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted-foreground:#737373',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted-foreground:#a3a3a3',
};
const html = (vars, bg, fg) => `<!doctype html><meta charset=utf-8><style>body{margin:0;${vars};background:var(--color-background);color:var(--color-foreground)}select{background:${bg};color:${fg}}${css}</style>
<div class="cp"><select id=s><optgroup label="Connected"><option>prod (postgres) · connected</option></optgroup><optgroup label="Not connected"><option disabled class="cp-grey">dev (mysql) · not connected</option></optgroup></select></div>`;
const lum = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
const parse = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let browser;
async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  const page = await browser.newPage();
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  for (const [name, vars] of Object.entries(THEMES)) {
    const bgv = vars.match(/--color-background:([^;]+)/)[1];
    await page.setContent(html(vars, bgv, 'var(--color-foreground)'));
    const r = await page.evaluate(() => {
      const s = document.getElementById('s');
      const on = s.querySelector('optgroup:first-child option'), off = s.querySelector('option[disabled]');
      return { groups: s.querySelectorAll('optgroup').length, onColor: getComputedStyle(on).color, offColor: getComputedStyle(off).color, bg: getComputedStyle(s).backgroundColor, disabled: off.disabled, label: s.querySelectorAll('optgroup')[1].label, text: off.textContent };
    });
    const bg = parse(r.bg), on = parse(r.onColor), off = parse(r.offColor);
    const cOn = ratio(on, bg), cOff = ratio(off, bg);
    report(r.groups === 2 && r.disabled && r.text.includes('not connected'), `${name}: 2 optgroups, disabled option carries "not connected" text`);
    report(r.onColor !== r.offColor, `${name}: disabled colour ${r.offColor} differs from enabled ${r.onColor}`);
    report(cOff >= 3, `${name}: disabled text contrast ${cOff.toFixed(2)}:1 (enabled ${cOn.toFixed(2)}:1) on ${r.bg}`);
  }
  await browser.close();
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c), async (e) => { console.error(e); try { await browser?.close(); } catch { /* ignore */ } process.exit(1); });
