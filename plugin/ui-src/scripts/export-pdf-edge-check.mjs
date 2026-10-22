#!/usr/bin/env node
// Real-Chrome PDF check: Chrome's printToPDF drops the last pixel column of the content box, so 100%-wide bordered
// boxes (markdown table, data grid, chart) lose their right border. Renders printCss() with the real paper/margins
// of plugin/backend/pdf-export (page.pdf), rasterizes with pdftoppm and asserts the right border column is painted.
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge or pdftoppm; 1 if SMOKE_REQUIRE_BROWSER=1).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const skip = (msg) => { console.log(`SKIPPED: ${msg}`); return requireBrowser ? 1 : 2; };
const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };

const DPI = 300;
const BORDER_MAX = 228; // border #d0d7de ~214 gray; cell/background fill is >= 245

const mixedRow = (i) => `<tr><td class="serial">${i}</td><td class="num nw">${i}</td><td class="txt nw">2026-10-0${i}</td><td class="txt nw">AB-${i}</td><td class="txt">${'Quarterly revenue reconciliation note for the regional office covering supplier invoices and manual adjustments '.repeat(2)}${i === 1 ? 'z'.repeat(80) : ''}</td><td class="num nw">1234.5</td></tr>`;
const mixedHead = '<thead><tr><th class="serial">#</th><th class="num nw">id</th><th class="txt nw">date</th><th class="txt nw">code</th><th class="txt">description</th><th class="num nw">amount</th></tr></thead>';
const bodies = {
  'markdown table': `<section class="md"><table><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>${'<tr><td>alpha</td><td>int</td></tr>'.repeat(4)}</tbody></table></section>`,
  'result grid': `<table class="grid"><thead><tr><th>a</th><th>b</th></tr></thead><tbody>${'<tr><td>1</td><td>x</td></tr>'.repeat(4)}</tbody></table>`,
  'mixed grid': `<table class="grid" style="--serial:3ch">${mixedHead}<tbody>${[1, 2, 3, 4].map(mixedRow).join('')}</tbody></table>`,
  'mixed grid paged': `<table class="grid" style="--serial:3ch">${mixedHead.replace('<th class="num nw">amount</th>', '')}<tbody>${[1, 2, 3, 4].map((i) => mixedRow(i).replace(/<td class="num nw">1234.5<\/td>/, ''))}</tbody></table><p class="cont pg-break">c</p><table class="grid">${mixedHead}<tbody>${[1, 2].map(mixedRow).join('')}</tbody></table>`,
  'chart image': `<div class="chart"><svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:120px;border:1px solid #d0d7de;background:#f6f8fa"></svg></div>`,
};
const papers = [[8.27, 11.69], [8.5, 11], [11.69, 8.27]];
const rightMargins = [0.3, 0.4, 0.5];

async function main() {
  if (!has('pdftoppm')) return skip('pdftoppm not found (poppler)');
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  let browser;
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) return skip('No system Chrome/Edge found');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-edge-'));
  execFileSync('npx', ['vite-node', 'scripts/pdf-edge-css.ts', join(dir, 'p.css')], { cwd: resolve(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
  const css = readFileSync(join(dir, 'p.css'), 'utf8');
  let failed = false;
  let n = 0;
  for (const [label, body] of Object.entries(bodies)) {
    for (const [w, h] of papers) {
      for (const rm of rightMargins) {
        const pdf = join(dir, `t${n}.pdf`);
        const page = await browser.newPage();
        await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${css}</style><body><h1>T</h1>${body}</body>`);
        if (label.startsWith('mixed')) {
          await page.emulateMedia({ media: 'print' });
          await page.setViewportSize({ width: Math.floor((w - 0.4 - rm) * 96), height: 900 });
          const m = await page.evaluate(() => [...document.querySelectorAll('table.grid')].map((tb) => {
            const wd = {};
            for (const th of tb.querySelectorAll('thead th')) wd[th.textContent] = th.getBoundingClientRect().width;
            return { wd, clipped: [...tb.querySelectorAll('th,td')].filter((c) => c.scrollWidth > c.clientWidth + 1).length, over: tb.scrollWidth - tb.clientWidth };
          }));
          const okW = m.every((t) => t.clipped === 0 && t.over <= 0 && t.wd.description > 0 && ['id', 'date', 'code'].every((k) => t.wd[k] < t.wd.description / 2));
          console.log(`${okW ? 'PASS' : 'FAIL'}  ${label} ${w}x${h}in right margin ${rm}in: narrow columns narrower than description, nothing clipped (${JSON.stringify(m.map((t) => Object.fromEntries(Object.entries(t.wd).map(([k, v]) => [k, Math.round(v)]))))})`);
          if (!okW) failed = true;
        }
        await page.pdf({ path: pdf, printBackground: true, width: `${w}in`, height: `${h}in`, margin: { top: '0.5in', bottom: '0.6in', left: '0.4in', right: `${rm}in` } });
        await page.close();
        execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', '-gray', pdf, join(dir, `t${n}`)]);
        const pgm = readFileSync(execFileSync('sh', ['-c', `ls ${dir}/t${n}-*.pgm`]).toString().trim());
        const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 30).toString('latin1'));
        const W = +m[1], H = +m[2], off = pgm.length - W * H;
        const edge = new Map();
        const rows = [];
        for (let y = 0; y < H; y++) {
          let x = W - 1;
          while (x >= 0 && pgm[off + y * W + x] > 250) x--;
          if (x < 0) continue;
          rows.push([y, x]);
          edge.set(x, (edge.get(x) || 0) + 1);
        }
        const [ex] = [...edge.entries()].sort((a, b) => b[1] - a[1])[0] || [-1];
        const edgeRows = rows.filter(([, x]) => x >= ex - 1).map(([y]) => y);
        const med = (x) => { const v = edgeRows.map((y) => pgm[off + y * W + x]).sort((p, q) => p - q); return v[v.length >> 1]; };
        const border = [0, 1, 2, 3].filter((d) => ex - d >= 0 && med(ex - d) <= BORDER_MAX).length;
        const ok = ex >= 0 && border >= 3;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${w}x${h}in right margin ${rm}in: rightmost painted column x=${ex}, ${border}/4 outer columns are border-coloured (need >= 3)`);
        if (!ok) failed = true;
        n++;
      }
    }
  }
  // Long CJK input-variable line: stays inside the right safe margin and shares a page with the following block.
  const longVar = `<p class="in-var">${'变量'}：${'很长的中文筛选值'.repeat(25)}</p>`;
  for (const [w, h] of papers) {
    for (const rm of rightMargins) {
      const pdf = join(dir, `v${n}.pdf`);
      const page = await browser.newPage();
      await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${css}</style><body>${longVar}${bodies['result grid']}</body>`);
      await page.pdf({ path: pdf, printBackground: true, width: `${w}in`, height: `${h}in`, margin: { top: '0.5in', bottom: '0.6in', left: '0.4in', right: `${rm}in` } });
      await page.close();
      execFileSync('pdftoppm', ['-r', String(DPI), '-gray', pdf, join(dir, `v${n}`)]);
      const files = execFileSync('sh', ['-c', `ls ${dir}/v${n}-*.pgm`]).toString().trim().split('\n');
      const pgm = readFileSync(files[0]);
      const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 30).toString('latin1'));
      const W = +m[1], H = +m[2], off = pgm.length - W * H;
      let maxX = -1;
      for (let y = 0; y < H; y++) for (let x = W - 1; x > maxX; x--) if (pgm[off + y * W + x] < 200) { maxX = x; break; }
      const limit = W - Math.round(rm * DPI);
      const ok = files.length === 1 && maxX < limit;
      console.log(`${ok ? 'PASS' : 'FAIL'}  in-var long line ${w}x${h}in right margin ${rm}in: ink x=${maxX} < ${limit}, pages=${files.length} (need 1)`);
      if (!ok) failed = true;
      n++;
    }
  }
  // Labelled pivot + chart (every override kind, from the export fixture): gutter respected and custom labels are in the PDF text layer.
  if (has('pdftotext')) {
    execFileSync('npx', ['vite-node', 'scripts/export-fixture.ts', join(dir, 'fx')], { cwd: resolve(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
    const lab = readFileSync(join(dir, 'fx', 'labels.html'), 'utf8');
    const body = lab.slice(lab.indexOf('<table class="pivot"'), lab.indexOf('<footer') > 0 ? lab.indexOf('<footer') : undefined);
    for (const [w, h] of papers) {
      for (const rm of rightMargins) {
        const pdf = join(dir, `l${n}.pdf`);
        const page = await browser.newPage();
        await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${css}</style><body><section>${body}</body>`);
        await page.pdf({ path: pdf, printBackground: true, width: `${w}in`, height: `${h}in`, margin: { top: '0.5in', bottom: '0.6in', left: '0.4in', right: `${rm}in` } });
        await page.close();
        const text = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
        execFileSync('pdftoppm', ['-r', String(DPI), '-gray', pdf, join(dir, `l${n}`)]);
        const files = execFileSync('sh', ['-c', `ls ${dir}/l${n}-*.pgm`]).toString().trim().split('\n');
        let maxX = -1, limit = 0;
        for (const f of files) {
          const pgm = readFileSync(f);
          const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 30).toString('latin1'));
          const W = +m[1], H = +m[2], off = pgm.length - W * H;
          limit = W - Math.round(rm * DPI);
          for (let y = 0; y < H; y++) for (let x = W - 1; x > maxX; x--) if (pgm[off + y * W + x] < 200) { maxX = x; break; }
        }
        const okT = /合计/.test(text) && /万元/.test(text) && /1,234\.57万元/.test(text) && /会员类型/.test(text) && !/sum\(amt\)/.test(text);
        const ok = okT && maxX < limit;
        console.log(`${ok ? 'PASS' : 'FAIL'}  labelled pivot+chart ${w}x${h}in right margin ${rm}in: custom labels in PDF text=${okT}, ink x=${maxX} < ${limit}`);
        if (!ok) failed = true;
        n++;
      }
    }
  }
  // Info block (hr + footer) at the end: long data source name + 12 run times stay inside the right safe margin and are never split across pages.
  if (has('pdftotext')) {
    const runs = Array.from({ length: 12 }, (_, i) => `<li>#${i + 1} 销售汇总明细第${i + 1}块 · 2026-10-20 08:${String(i).padStart(2, '0')}</li>`).join('');
    const info = `<hr class="info-sep"><footer class="export-info"><p class="meta">导出人：张三</p><p class="meta">导出时间：2026-10-20 08:00</p><p class="meta">数据源名称：${'很长的数据源名称'.repeat(20)}</p><div><p class="meta">数据运行时间：</p><ul class="meta">${runs}</ul></div><div class="note">${'备注'.repeat(60)}</div></footer>`;
    for (const [w, h] of papers) {
      for (const rm of rightMargins) {
        for (const filler of [0, 500, 700, 900]) {
          const pdf = join(dir, `i${n}.pdf`);
          const page = await browser.newPage();
          await page.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>${css}</style><body><div style="height:${filler}px"></div>${bodies['result grid']}<p>BODYEND</p>${info}</body>`);
          await page.pdf({ path: pdf, printBackground: true, width: `${w}in`, height: `${h}in`, margin: { top: '0.5in', bottom: '0.6in', left: '0.4in', right: `${rm}in` } });
          await page.close();
          const pages = execFileSync('pdftotext', ['-layout', pdf, '-']).toString().split('\f').filter((p) => p.trim());
          const holder = pages.map((p, i) => (/#1 销售/.test(p) ? i : -1)).filter((i) => i >= 0);
          const together = holder.length === 1 && /#12 销售/.test(pages[holder[0]]) && /数据源名称/.test(pages[holder[0]]) && /备注备注/.test(pages[holder[0]]) && holder[0] === pages.length - 1;
          execFileSync('pdftoppm', ['-r', String(DPI), '-gray', pdf, join(dir, `i${n}`)]);
          const files = execFileSync('sh', ['-c', `ls ${dir}/i${n}-*.pgm`]).toString().trim().split('\n');
          let maxX = -1, limit = 0;
          for (const f of files) {
            const pgm = readFileSync(f);
            const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 30).toString('latin1'));
            const W = +m[1], H = +m[2], off = pgm.length - W * H;
            limit = W - Math.round(rm * DPI);
            for (let y = 0; y < H; y++) for (let x = W - 1; x > maxX; x--) if (pgm[off + y * W + x] < 200) { maxX = x; break; }
          }
          const last = pages[pages.length - 1];
          const ordered = ['导出人', '导出时间', '数据源名称', '数据运行时间', '#1 销售', '备注备注'].map((k) => last.indexOf(k));
          const inOrder = ordered.every((x, i) => x >= 0 && (i === 0 || x > ordered[i - 1]));
          let gapOk = true, gapNote = 'n/a (footer alone on its page)';
          const bb = execFileSync('pdftotext', ['-bbox', '-f', String(pages.length), '-l', String(pages.length), pdf, '-']).toString();
          const words = [...bb.matchAll(/yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)</g)].map((m) => ({ y0: +m[1], y1: +m[2], t: m[3] }));
          const be = words.find((x) => x.t === 'BODYEND'), first = words.find((x) => x.t.startsWith('导出人'));
          if (be && first) { const gap = first.y0 - be.y1; gapOk = gap >= 19.5; gapNote = `${gap.toFixed(1)}pt`; } else if (be || !first) { gapOk = false; gapNote = 'missing BODYEND/footer text'; }
          const ok = together && maxX < limit && inOrder && gapOk;
          console.log(`${ok ? 'PASS' : 'FAIL'}  info block ${w}x${h}in right margin ${rm}in filler ${filler}px: whole block on the last page=${together}, row order=${inOrder}, body→info gap=${gapNote}, ink x=${maxX} < ${limit}`);
          if (!ok) failed = true;
          n++;
        }
      }
    }
  }
  await browser.close();
  return failed ? 1 : 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
