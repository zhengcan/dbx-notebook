#!/usr/bin/env node
// Real-Chrome check: input-variable block readability (name field + {{ name }} chip) in dark and light DBX tokens.
// Uses the CSS of src/blocks/InputBlock.vue (or INPUT_BLOCK_VUE=<path> to test another revision) with markup mirroring its template.
// Exit codes: 0 pass, 1 fail, 2 skipped (1 if SMOKE_REQUIRE_BROWSER=1).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const outDir = process.env.SMOKE_OUT_DIR || mkdtempSync(join(tmpdir(), 'input-block-'));
const vue = readFileSync(process.env.INPUT_BLOCK_VUE || join(here, '../src/blocks/InputBlock.vue'), 'utf8');
const css = [...vue.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const hasLabel = /data-test="var-label"/.test(vue);
const hasHint = /in\.chipEmpty/.test(vue);

const TOKENS = {
  dark: { background: '#09090b', foreground: '#fafafa', muted: '#27272a', 'muted-foreground': '#a1a1aa', border: '#3f3f46', accent: '#e4e4e7', 'accent-foreground': '#a1a1aa', destructive: '#f87171', primary: '#60a5fa' },
  light: { background: '#ffffff', foreground: '#09090b', muted: '#f4f4f5', 'muted-foreground': '#52525b', border: '#d4d4d8', accent: '#f4f4f5', 'accent-foreground': '#18181b', destructive: '#dc2626', primary: '#2563eb' },
};
TOKENS['dark-flat'] = { ...TOKENS.dark, muted: TOKENS.dark.background };
TOKENS['light-flat'] = { ...TOKENS.light, muted: TOKENS.light.background };
const html = (theme, variable, label, hint) => {
  const tk = Object.entries(TOKENS[theme]).map(([k, v]) => `--color-${k}:${v}`).join(';');
  const chip = variable === '' && hint ? '请先填写变量名' : `{{ ${variable} }}`;
  return `<!DOCTYPE html><meta charset="utf-8"><style>${css}</style><body style="${tk};margin:0;padding:16px;width:760px;background:var(--color-background);color:var(--color-foreground);font:14px sans-serif">
<div class="in-block"><div class="in-head">
<label class="in-namebox">${label ? '<span class="in-label in-namelabel" data-test="var-label">变量名</span>' : ''}<input class="in-field in-name" data-test="var-name" value="${variable}" placeholder="变量名" aria-label="变量名"></label>
<select class="in-field"><option>日期</option></select>
<code class="in-chip"${variable === '' ? ' data-empty="true"' : ''} data-test="chip">${chip}</code>
<button class="in-copy" data-test="copy-var">⧉ 复制变量名</button></div>
<div class="in-body"><input class="in-field in-value" type="date" value="2026-01-01"></div></div></body>`;
};

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  let browser;
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failed = true; };
  const probe = (sel) => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/) || s.match(/color\(srgb ([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).map(Number); return s.startsWith('color(') ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1] : [p[0], p[1], p[2], p[3] ?? 1]; };
    const el = document.querySelector(sel);
    const effBg = (start) => { const layers = []; for (let n = start; n; n = n.parentElement) layers.push(parse(getComputedStyle(n).backgroundColor)); let b = [255, 255, 255]; for (const l of layers.reverse()) b = b.map((c, i) => l[3] * l[i] + (1 - l[3]) * c); return b; };
    const bg = effBg(el);
    const bc = parse(getComputedStyle(el).borderTopColor);
    const surround = effBg(el.parentElement);
    const borderC = [0, 1, 2].map((i) => bc[3] * bc[i] + (1 - bc[3]) * surround[i]);
    const fg = parse(getComputedStyle(el).color);
    const fgc = [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]);
    const cs = getComputedStyle(el);
    return { fg: fgc, bg, borderC, surround, family: cs.fontFamily, border: cs.borderTopWidth, text: el.textContent };
  };
  for (const [theme, variable] of [['dark', 'date'], ['light', 'date'], ['dark', ''], ['light', ''], ['dark-flat', 'date'], ['light-flat', 'date']]) {
    const tag = `${theme}${variable === '' ? ' empty' : ''}`;
    const page = await browser.newPage({ viewport: { width: 800, height: 200 } });
    await page.setContent(html(theme, variable, hasLabel, hasHint));
    const name = await page.evaluate(probe, '[data-test=var-name]');
    const chip = await page.evaluate(probe, '[data-test=chip]');
    const cn = ratio(name.fg, name.bg), cc = ratio(chip.fg, chip.bg);
    report(cn >= 4.5, `${tag}: name input text contrast ${cn.toFixed(2)} >= 4.5`);
    report(cc >= 4.5, `${tag}: chip text contrast ${cc.toFixed(2)} >= 4.5`);
    if (theme === 'dark' || theme === 'dark-flat') report(lum(chip.bg) < 0.3, `${tag}: chip is not a near-white pill (bg luminance ${lum(chip.bg).toFixed(2)})`);
    report(/mono/i.test(chip.family) || variable === '', `${tag}: chip is monospace`);
    report(await page.evaluate(() => !!document.querySelector('[data-test=var-label]') && document.querySelector('[data-test=var-label]').offsetParent !== null && !!document.querySelector('[data-test=var-name]').getAttribute('aria-label')), `${tag}: visible name label + accessible name`);
    const cbr = ratio(chip.borderC, chip.surround);
    report(cbr >= 3, `${tag}: chip border vs surrounding surface ${cbr.toFixed(2)} >= 3`);
    const cb = await page.evaluate(() => getComputedStyle(document.querySelector('[data-test=chip]')).borderTopWidth);
    report(parseFloat(cb) >= 1, `${tag}: chip has a border`);
    console.log("  border", chip.borderC, chip.surround); console.log(`  name fg/bg ${name.fg.map(Math.round)} / ${name.bg.map(Math.round)}; chip fg/bg ${chip.fg.map(Math.round)} / ${chip.bg.map(Math.round)}`);
    await page.screenshot({ path: join(outDir, `input-${tag.replace(' ', '-')}.png`) });
    await page.close();
  }
  await browser.close();
  console.log(`screenshots in ${outDir}`);
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
