#!/usr/bin/env node
// Real-Chrome check of the ResultTable CSS (extracted from the SFC <style>) with a hand-built table:
// transposed name column keeps its computed width; no content shows left of the sticky column while scrolling.
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sfc = readFileSync(process.env.TABLE_SFC || resolve(here, '../src/blocks/ResultTable.vue'), 'utf8');
const css = sfc.slice(sfc.indexOf('<style'), sfc.indexOf('</style>')).replace(/^<style[^>]*>/, '');
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';

const NAME_W = 80, COL_W = 120, NCOLS = 20;
const html = (transposed, ncols) => `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#1a1a1a;--color-background:#1a1a1a;--color-foreground:#eee;--color-muted:#2a2a2a;--color-border:rgba(255,255,255,.25)}td:not(.rowno){background:#f00!important;color:#f00}${css}</style>
<div id=host><div class="vp-wrap"><div class="viewport${transposed ? ' transposed' : ''}" style="width:var(--w)"><table style="width:${NAME_W + ncols * COL_W}px"><colgroup><col style="width:${NAME_W}px">${('<col style="width:' + COL_W + 'px">').repeat(ncols)}</colgroup>
<thead><tr><th class=rowno>#</th>${Array.from({ length: ncols }, (_, i) => `<th>#${i + 1}</th>`).join('')}</tr></thead>
<tbody>${Array.from({ length: 6 }, (_, r) => `<tr data-row class="${r % 2 ? 'odd' : ''}" style="height:28px"><td class=rowno>${'row' + r}</td>${Array.from({ length: ncols }, (_, c) => `<td class="${c % 2 ? 'num' : ''}">7f${c}oba bad ${r}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div></div>`;

let browser;
async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  const page = await browser.newPage({ viewport: { width: 1600, height: 600 }, deviceScaleFactor: 1.5 });
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

  for (const w of [700, 1400]) {
    await page.setContent(html(true, NCOLS).replace('var(--w)', w + 'px'));
    const r = await page.evaluate(() => ({ first: document.querySelector('th.rowno').getBoundingClientRect().width, second: document.querySelectorAll('th')[1].getBoundingClientRect().width }));
    report(Math.abs(r.first - NAME_W) <= 1 && Math.abs(r.second - COL_W) <= 1, `transposed 1-row ${NCOLS}-col at ${w}px: name ${r.first} (want ${NAME_W}), data ${r.second} (want ${COL_W})`);
  }
  await page.setContent(html(true, 2).replace('var(--w)', '1400px'));
  const few = await page.evaluate(() => ({ first: document.querySelector('th.rowno').getBoundingClientRect().width, second: document.querySelectorAll('th')[1].getBoundingClientRect().width }));
  report(Math.abs(few.first - NAME_W) <= 1 && Math.abs(few.second - COL_W) <= 1, `transposed 2-col at 1400px: name ${few.first}, data ${few.second}`);

  // transposed min width 320 (see transposedColWidth): 2 cols stretched to 460 fill a 1000px scroller exactly; 3 cols at 320 overflow it
  for (const [n, w, wantOverflow] of [[2, 460, false], [3, 320, true]]) {
    await page.setContent(html(true, n).replace('var(--w)', '1000px').replaceAll(`width:${COL_W}px`, `width:${w}px`).replace(`width:${NAME_W + n * COL_W}px`, `width:${NAME_W + n * w}px`));
    const m = await page.evaluate(() => { const v = document.querySelector('.viewport'); return { sw: v.scrollWidth, cw: v.clientWidth, d: document.querySelectorAll('th')[1].getBoundingClientRect().width }; });
    report(Math.abs(m.d - w) <= 1 && (m.sw > m.cw) === wantOverflow, `transposed ${n} data cols of ${w}px in a 1000px scroller: scrollWidth ${m.sw} / clientWidth ${m.cw}, ${wantOverflow ? 'scrolls' : 'fits'}`);
  }
  for (const transposed of [false, true]) {
    await page.setContent(html(transposed, NCOLS).replace('var(--w)', '500px'));
    const offsets = [0, 0.5, 1, 10.33, 33.7, 47.25, 100.1, 255.5, 500.9, 999.99];
    const bad = await page.evaluate((offs) => {
      const vp = document.querySelector('.viewport'), vr = vp.getBoundingClientRect();
      const out = [];
      for (const o of offs) {
        vp.scrollLeft = o;
        for (const y of [vr.top + 14, vr.top + 28 + 14, vr.top + 28 + 42, vr.top + 28 + 70]) {
          for (const dx of [0.5, 1.5, 2.5, 5]) {
            const el = document.elementFromPoint(vr.left + dx, y);
            if (!el || !el.classList.contains('rowno')) out.push(`scroll ${o} y ${y} x+${dx}: ${el && el.tagName + '.' + el.className}`);
          }
        }
      }
      return out;
    }, offsets);
    report(bad.length === 0, `sticky column covers the left edge at ${offsets.length} offsets (${transposed ? 'transposed' : 'normal'})${bad.length ? ': ' + bad[0] : ''}`);
  }
  // Pixel check: data cells are solid red; no red tint may show from the wrapper's left edge through the sticky cell's separator, up to the first pure-red data pixel.
  // Integer device-pixel ratios only: at fractional DPR (e.g. 1.5) Chrome anti-aliases the sticky edge itself, which is not content bleed.
  for (const DPR of [1, 2, 3]) {
  const pg = await browser.newPage({ viewport: { width: 1600, height: 600 }, deviceScaleFactor: DPR });
  for (const transposed of [false, true]) {
    await pg.setContent(html(transposed, NCOLS).replace('var(--w)', '500px'));
    const bleed = [];
    for (const o of [0, 0.5, 10.33, 33.7, 47.25, 100.1, 255.5, 500.9]) {
      const g = await pg.evaluate((off) => {
        const vp = document.querySelector('.viewport'); vp.scrollLeft = off;
        const wr = document.querySelector('.vp-wrap').getBoundingClientRect();
        const st = document.querySelector('td.rowno').getBoundingClientRect();
        return { right: st.right, x: wr.left, y: wr.top, w: Math.ceil(st.right - wr.left) + 4, h: Math.min(wr.height, 120) };
      }, o);
      const buf = await pg.screenshot({ clip: { x: g.x, y: g.y, width: g.w, height: g.h } });
      const hit = await pg.evaluate(async ([b64, stRight, wrLeft, dpr]) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        // (a) every pixel left of the sticky cell's right edge (wrapper border, cell, its separator) has no red tint
        const edge = Math.round((stRight - wrLeft) * dpr);
        for (let y = 0; y < c.height; y++) for (let x = 0; x < edge; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] > d[i + 1] + 25 && d[i] > d[i + 2] + 25) return `red-tinted pixel inside the sticky area at x=${x} y=${y} (${d[i]},${d[i + 1]},${d[i + 2]})`;
        }
        // (b) the first pixel right of the sticky cell, mid-row, is untouched red data (nothing translucent painted over it)
        const my = Math.round((28 + 14 + 28 * 2) * dpr), i2 = (my * c.width + edge) * 4;
        if (!(d[i2] > 240 && d[i2 + 1] < 10 && d[i2 + 2] < 10)) return `pixel right of the sticky cell is not pure data colour: x=${edge} y=${my} (${d[i2]},${d[i2 + 1]},${d[i2 + 2]})`;
        return null;
      }, [buf.toString('base64'), g.right, g.x, DPR]);
      if (hit) bleed.push(`offset ${o}: ${hit}`);
    }
    report(bleed.length === 0, `no scrolled content visible in the sticky column + border pixels (${transposed ? 'transposed' : 'normal'}, DPR ${DPR})${bleed.length ? ': ' + bleed[0] : ''}`);
  }
  await pg.close();
  }
  // Contrast of hovered / selected cells under dark and light token sets (including a host that defines light --color-accent/--color-selection in dark mode).
  const SETS = {
    'dark (light accent/selection/primary)': '--color-background:#1a1a1a;--color-foreground:#eeeeee;--color-muted:#2a2a2a;--color-muted-foreground:#a1a1aa;--color-border:#444;--color-primary:#fafafa;--color-accent:#e5e5e5;--color-selection:#e5e5e5',
    'dark (blue primary)': '--color-background:#1a1a1a;--color-foreground:#eeeeee;--color-muted:#2a2a2a;--color-muted-foreground:#a1a1aa;--color-border:#444;--color-primary:#4a90d9;--color-accent:#333;--color-selection:#264f78',
    'light (dark primary)': '--color-background:#ffffff;--color-foreground:#111111;--color-muted:#f4f4f5;--color-muted-foreground:#6b7280;--color-border:#ddd;--color-primary:#111111;--color-accent:#f4f4f5;--color-selection:#cfe3ff',
    'light (blue primary)': '--color-background:#ffffff;--color-foreground:#111111;--color-muted:#f4f4f5;--color-muted-foreground:#6b7280;--color-border:#ddd;--color-primary:#2563eb;--color-accent:#f4f4f5;--color-selection:#cfe3ff',
  };
  const pg2 = await browser.newPage({ viewport: { width: 900, height: 400 }, deviceScaleFactor: 1 });
  for (const [name, tokens] of Object.entries(SETS)) {
    await pg2.setContent(`<!doctype html><meta charset=utf-8><style>body{margin:0;background:var(--color-background);${tokens}}${css}</style><div class=vp-wrap style="width:600px"><div class=viewport><table style="width:300px"><colgroup><col style="width:60px"><col style="width:120px"><col style="width:120px"></colgroup><tbody>${[0, 1, 2].map((r) => `<tr data-row class="${r % 2 ? 'odd' : ''}" style="height:28px"><td class=rowno>r${r}</td><td data-c class="${r === 2 ? 'selected' : ''}">value ${r}</td><td data-c class=cell-null>NULL</td></tr>`).join('')}</tbody></table></div></div>`);
    const probe = async (sel, pick) => {
      const box = await (await pg2.$(sel)).boundingBox();
      const buf = await pg2.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
      return pg2.evaluate(async ([b64, selector]) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0);
        const bg = cx.getImageData(c.width - 3, 6, 1, 1).data;
        cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = getComputedStyle(document.querySelector(selector)).color; cx.fillRect(0, 0, 1, 1);
        const fg = cx.getImageData(0, 0, 1, 1).data;
        const lum = (a) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
        const l1 = lum(fg), l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }, [buf.toString('base64'), pick]);
    };
    await pg2.hover('tbody tr:nth-child(1) td[data-c]');
    const hoverText = await probe('tbody tr:nth-child(1) td[data-c]:not(.cell-null)', 'tbody tr:nth-child(1) td[data-c]:not(.cell-null)');
    const hoverNull = await probe('tbody tr:nth-child(1) td.cell-null', 'tbody tr:nth-child(1) td.cell-null');
    const hoverRowno = await probe('tbody tr:nth-child(1) td.rowno', 'tbody tr:nth-child(1) td.rowno');
    await pg2.mouse.move(850, 350);
    const selText = await probe('td.selected', 'td.selected');
    const ok = hoverText >= 4.5 && selText >= 4.5 && hoverNull >= 4 && hoverRowno >= 4; // muted (NULL / row number) text keeps its host muted colour: only required not to degrade much
    report(ok, `contrast (text/selected >= 4.5, muted >= 4) on ${name}: hover text ${hoverText.toFixed(1)}, hover NULL ${hoverNull.toFixed(1)}, row number ${hoverRowno.toFixed(1)}, selected ${selText.toFixed(1)}`);
  }
  await pg2.close();
  return failed ? 1 : 0;
}
main().then(async (c) => { if (browser) await browser.close(); process.exit(c); }, async (e) => { console.log('FAIL ' + e.message); if (browser) await browser.close(); process.exit(1); });
