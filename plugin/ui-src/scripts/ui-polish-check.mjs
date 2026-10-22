#!/usr/bin/env node
// Real-Chrome UI polish checks. Mounts the REAL components through the smoke vite build (like markdown-layout-check).
// Add a check: push { name, run(ctx) } onto CHECKS; ctx = { page, report, variant? }. Exit: 0 pass, 1 fail,
// 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1). UI_POLISH_OUT sets the screenshot dir.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, '..');
const isWin = process.platform === 'win32';
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const outDir = process.env.UI_POLISH_OUT || join(tmpdir(), 'ui-polish');

// ---- checks -------------------------------------------------------------------------------------------------
const CHECKS = [];

CHECKS.push({
  name: 'export dialog header options (460px)',
  entry: 'export-dialog-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountExportDialogForSmoke === 'function');
    for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) for (const exporterName of ['alice.zhang', null]) {
      const tag = `${locale}/${theme}/${exporterName ? 'exporter' : 'no-exporter'}`;
      await page.evaluate((o) => window.__sqlnbMountExportDialogForSmoke(o), { locale, theme, exporterName });
      await page.waitForSelector('[data-test=header-cols]');
      const r = await page.evaluate(() => {
        const g = document.querySelector('[data-test=header-cols]').closest('fieldset'), cols = document.querySelector('[data-test=header-cols]');
        const L = document.querySelector('[data-test=col-left]').getBoundingClientRect(), R = document.querySelector('[data-test=col-right]').getBoundingClientRect(), G = g.getBoundingClientRect();
        const rows = [...cols.querySelectorAll('label')].map((l) => l.getBoundingClientRect().height / (parseFloat(getComputedStyle(l).lineHeight) || parseFloat(getComputedStyle(l).fontSize) * 1.3));
        const dlg = document.querySelector('.ed');
        const named = (el) => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label')?.textContent.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)));
        const unlabelled = [...dlg.querySelectorAll('input,select,textarea')].filter((el) => el.offsetParent !== null && !named(el)).map((el) => el.getAttribute('data-test') || el.type);
        return { gOver: g.scrollWidth > g.clientWidth, cOver: cols.scrollWidth > cols.clientWidth, dOver: dlg.scrollWidth > dlg.clientWidth, dw: Math.round(parseFloat(getComputedStyle(dlg).width)), L: [L.left, L.right], R: [R.left, R.right], G: [G.left, G.right], maxLines: Math.max(...rows), unlabelled, text: dlg.textContent };
      });
      report(r.dw === 460, `${tag}: dialog content width is 460px (${r.dw})`);
      report(!r.gOver && !r.cOver && !r.dOver, `${tag}: no horizontal overflow`);
      report(r.L[0] >= r.G[0] && r.R[1] <= r.G[1] && r.L[1] <= r.R[0] + 1, `${tag}: columns inside the group, left of right`);
      report(r.maxLines <= 2.2, `${tag}: checkbox rows ≤ 2 lines (${r.maxLines.toFixed(1)})`);
      report(r.unlabelled.length === 0, `${tag}: no unlabelled controls${r.unlabelled.length ? ' (' + r.unlabelled.join(',') + ')' : ''}`);
      report(!r.text.includes('alice.zhang'), `${tag}: user name not rendered`);
      if (exporterName) await page.locator('.ed').screenshot({ path: join(outDir, `dialog-${locale === 'en' ? 'en' : 'zh'}-${theme}.png`) });
    }
  },
});


CHECKS.push({
  name: 'table label edit trigger: no reflow',
  entry: 'pivot-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountPivotForSmoke === 'function');
    const snap = () => page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height, e.scrollWidth].join(','); };
      const vp = document.querySelector('.viewport');
      return { ths: [...document.querySelectorAll('th')].map(r), table: r(document.querySelector('table')), tw: getComputedStyle(document.querySelector('table')).width, vp: vp.scrollLeft + ',' + vp.scrollTop };
    });
    const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((o) => window.__sqlnbMountPivotForSmoke(o), { theme });
      await page.waitForSelector('thead th .lbl-edit', { state: 'attached' });
      const idle = await snap();
      const nth = await page.locator('thead th').count();
      let badHover = 0, badFocus = 0, badEdit = 0, badOp = 0, badInside = 0;
      for (let i = 0; i < nth; i++) {
        const th = page.locator('thead th').nth(i);
        await th.scrollIntoViewIfNeeded();
        const before = await snap();
        await th.hover();
        const hov = await snap();
        if (!sameAs(before, hov)) badHover++;
        const eb = th.locator('.lbl-edit');
        if (await eb.count()) {
          await page.waitForTimeout(250);
          const op = await eb.evaluate((e) => getComputedStyle(e).opacity);
          if (op !== '1') badOp++;
          const inside = await eb.evaluate((e) => { const a = e.getBoundingClientRect(), b = e.closest('th').getBoundingClientRect(); return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5; });
          if (!inside) badInside++;
          await page.mouse.move(2, 2);
          const sb = th.locator('button[data-sort]');
          if (await sb.count()) { await sb.focus(); if (!sameAs(before, await snap())) badFocus++; }
          await eb.focus();
          await page.waitForTimeout(250);
          if (!sameAs(before, await snap())) badEdit++;
          if ((await eb.evaluate((e) => getComputedStyle(e).opacity)) !== '1') badOp++;
        }
        await page.evaluate(() => document.activeElement.blur());
        await page.mouse.move(2, 2);
      }
      report(badHover === 0, `${theme}: header/table geometry identical on hover of all ${nth} headers (${badHover} differ)`);
      report(badFocus === 0 && badEdit === 0, `${theme}: geometry identical on focus of sort/edit buttons (${badFocus}/${badEdit} differ)`);
      report(badOp === 0 && badInside === 0, `${theme}: edit button visible on hover/focus and inside its th (${badOp} opacity, ${badInside} outside)`);
      await page.evaluate(() => { document.querySelector('.viewport').scrollLeft = 0; document.querySelector('.viewport').scrollTop = 0; });
      await page.mouse.move(2, 2);
      const idle2 = await snap();
      report(sameAs(idle, idle2), `${theme}: idle geometry restored`);
      const op0 = await page.locator('thead th .lbl-edit').first().evaluate((e) => getComputedStyle(e).opacity);
      report(op0 === '0', `${theme}: edit button hidden when idle (${op0})`);
      const trunc = await page.evaluate(() => { const t = document.querySelector('th[data-sort-th=name]'); const b = t.querySelector('button[data-sort]'); return { clip: b.scrollWidth > b.clientWidth, title: (t.getAttribute('title') || '').length, w: t.getBoundingClientRect().width }; });
      report(trunc.clip && trunc.title > 100 && trunc.w === 120, `${theme}: long label truncated (w=${trunc.w}) with title tooltip`);
      await page.screenshot({ path: join(outDir, `label-table-idle-${theme}.png`) });
      await page.locator('th[data-sort-th=name]').hover();
      await page.waitForTimeout(250);
      report((await page.locator('th[data-sort-th=name] .lbl-edit').evaluate((e) => getComputedStyle(e).opacity)) === '1', `${theme}: edit button shown while hovering the header`);
      await page.screenshot({ path: join(outDir, `label-table-hover-${theme}.png`) });
      await page.mouse.move(2, 2);
      // Keyboard: edit buttons are not tab stops; F2 on a focused header emits its target
      const tabbable = await page.evaluate(() => [...document.querySelectorAll('.lbl-edit')].filter((e) => e.tabIndex >= 0).length);
      report(tabbable === 0, `${theme}: no edit button is a tab stop (${tabbable})`);
      await page.locator('th[data-sort-th=name] button[data-sort]').focus();
      await page.keyboard.press('Tab');
      const notEdit = await page.evaluate(() => !document.activeElement.classList.contains('lbl-edit'));
      report(notEdit, `${theme}: Tab from sort button skips the edit button`);
      await page.locator('th[data-sort-th=name] button[data-sort]').focus();
      await page.evaluate(() => { window.__pivotEdits.length = 0; });
      await page.keyboard.press('F2');
      await page.locator('th.measure button[data-sort]').first().focus();
      await page.keyboard.press('Shift+F10');
      const ev = await page.evaluate(() => window.__pivotEdits.map((t) => t.kind));
      report(ev.join() === 'rowName,measureName', `${theme}: F2 / Shift+F10 on focused headers emit edit-label (${ev.join()})`);
      const ks = await page.evaluate(() => document.querySelector('th[data-sort-th=name] button[data-sort]').getAttribute('aria-keyshortcuts'));
      report(ks === 'F2', `${theme}: sort buttons announce F2`);
      const hit = await page.evaluate(() => { const r = document.querySelector('.lbl-edit').getBoundingClientRect(); return [r.width, r.height]; });
      report(hit[0] >= 20 && hit[1] >= 20, `${theme}: edit hit target >= 20x20 (${hit.join('x')})`);
      await page.locator('th[data-sort-th=name]').hover();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(outDir, `label-table-focus-${theme}.png`) });
      await page.mouse.move(2, 2);
      await page.evaluate(() => { window.__pivotEdits.length = 0; });
      await page.locator('th[data-sort-th=name] button[data-sort]').click();
      report((await page.evaluate(() => window.__pivotSort()))?.by === 'name' && (await page.locator('th[data-sort-th=name]').getAttribute('aria-sort')) === 'ascending', `${theme}: header click sorts`);
      await page.locator('th[data-sort-th=name]').hover();
      await page.locator('th[data-sort-th=name] .lbl-edit').click();
      const st = await page.evaluate(() => ({ s: window.__pivotSort(), e: window.__pivotEdits }));
      report(st.s.dir === 'asc' && st.e.length === 1 && st.e[0].kind === 'rowName', `${theme}: edit click emits rowName and does not sort`);
      const txt = await page.evaluate(() => document.querySelector('.viewport').textContent);
      report(txt.includes('万元') && txt.includes('是') && txt.includes('未知') && txt.includes('合计'), `${theme}: scale/unit, mapped categories, null label and summary label rendered`);
    }
  },
});

CHECKS.push({
  name: 'labels dialog flow (real AnalysisBlock: open, live edit, Esc, popover exclusion, two blocks; 320/560/960px)',
  entry: 'popover-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountPopoverForSmoke === 'function');
    const DLG = '[data-test=labels-dialog]';
    const BTN = '[data-test=ab-labels-open]';
    for (const theme of ['dark', 'light']) for (const width of [960, 560, 320]) {
      const tag = `${theme}/${width}px`;
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((o) => window.__sqlnbMountPopoverForSmoke(o), { theme, width });
      await page.waitForSelector('thead th .lbl-edit', { state: 'attached' });
      await page.evaluate(() => { window.__popCalls = 0; });
      await page.click(BTN);
      await page.waitForSelector(DLG);
      report((await page.$$(DLG)).length === 1 && (await page.evaluate((q) => document.querySelector(q).contains(document.activeElement), DLG)), `${tag}: 高级设置 opens exactly one dialog with focus inside`);
      const pv = await page.evaluate(() => { const e = document.querySelector('[data-test=labels-preview]'); if (!e) return null; const r = e.getBoundingClientRect(); return { shown: getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 }; });
      if (width === 960) report(!!pv && pv.shown, `${tag}: live preview is visible at the wide layout`);
      else report(!pv || !pv.shown, `${tag}: live preview folded at the narrow layout`);
      await page.click('[role=tab][data-tab=table]');
      const mi = page.locator('[data-label-target="measureName:0"] input');
      await mi.focus();
      await page.keyboard.type('总额ABC');
      report((await page.evaluate(() => window.__popCalls)) === 0, `${tag}: typing does not commit`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      const hdr = await page.evaluate(() => document.querySelector('thead').textContent);
      report(hdr.includes('总额ABC') && (await page.evaluate(() => window.__popCalls)) === 1, `${tag}: Enter commits once and the table header changes live (behind the overlay)`);
      const geo = await page.evaluate((q) => { const p = document.querySelector(q); const r = p.getBoundingClientRect(); return { fit: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, ov: p.scrollWidth <= p.clientWidth + 1, de: document.documentElement.scrollWidth <= innerWidth }; }, DLG);
      report(geo.fit && geo.ov && geo.de, `${tag}: dialog inside the viewport, no horizontal overflow`);
      await page.screenshot({ path: join(outDir, `labels-dialog-flow-${theme}-${width}.png`) });
      await page.evaluate(() => window.__popUndo());
      await page.waitForTimeout(100);
      report((await mi.inputValue()) === '', `${tag}: undo (store) refreshes the input value`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      report(!(await page.$(DLG)) && (await page.evaluate((q) => document.activeElement === document.querySelector(q), BTN)), `${tag}: Esc closes, focus back on the 高级设置 button`);
      await page.evaluate(() => [...document.querySelectorAll('thead th .lbl-edit')].pop().click());
      await page.waitForSelector('[role=dialog][data-test=label-popover]');
      await page.evaluate((q) => document.querySelector(q).click(), BTN);
      await page.waitForSelector(DLG);
      await page.waitForTimeout(50);
      report((await page.$$('[role=dialog]')).length === 1 && !(await page.$('[data-test=label-popover]')), `${tag}: ✎ popover then 高级设置 leaves exactly one dialog`);
      await page.keyboard.press('Escape');
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((o) => window.__sqlnbMountPopoverForSmoke(o), { theme, width: 560, two: true });
      await page.waitForSelector(BTN);
      await page.evaluate((q) => { document.querySelectorAll(q)[0].click(); }, BTN);
      await page.waitForSelector(DLG);
      await page.evaluate((q) => { document.querySelectorAll(q)[1].click(); }, BTN);
      await page.waitForTimeout(100);
      const two = await page.evaluate((q) => ({ n: document.querySelectorAll(q).length, inB: document.querySelectorAll('[data-test=analysis-block]')[1]?.contains(document.querySelector(q)) }), DLG);
      report(two.n === 1 && two.inB, `${theme}: two blocks: opening in B closes A's dialog`);
    }
  },
});

CHECKS.push({
  name: 'chart title and data-value labels follow the theme (>=4.5:1)',
  entry: 'chart-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountLabelChartForSmoke === 'function');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((o) => window.__sqlnbMountLabelChartForSmoke(o), { theme, editable: false, labels: true });
      await page.waitForSelector('.chart-host svg g.role-title text');
      const r = await page.evaluate(() => {
        const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (m) return m[1].split(',').slice(0, 3).map((n) => Number(n)); const h = c.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, '$&$&') : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
        const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const bg = getComputedStyle(document.querySelector('[data-theme]')).backgroundColor;
        const fill = (n) => getComputedStyle(n).fill;
        const title = document.querySelector('g.role-title text');
        const labels = [...document.querySelectorAll('g.layer_1_marks text, g.mark-text.role-mark text')].filter((n) => /\d/.test(n.textContent));
        return { n: labels.length, bg, title: fill(title), titleRatio: ratio(fill(title), bg), label: labels[0] ? fill(labels[0]) : null, labelRatio: labels.length ? Math.min(...labels.map((n) => ratio(fill(n), bg))) : 0 };
      });
      report(r.n > 0, `${theme}: data labels present (${r.n})`);
      report(r.titleRatio >= 4.5, `${theme}: title ${r.title} on ${r.bg} contrast ${r.titleRatio.toFixed(2)}`);
      report(r.labelRatio >= 4.5, `${theme}: data labels ${r.label} on ${r.bg} contrast ${r.labelRatio.toFixed(2)}`);
      await page.screenshot({ path: join(outDir, `chart-text-colours-${theme}.png`) });
    }
  },
});

CHECKS.push({
  name: 'chart text colours resolve modern/var()/alpha tokens and stay >=4.5:1; pie labels carry a halo',
  entry: 'chart-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountLabelChartForSmoke === 'function');
    const light = { background: '#ffffff', sets: ['oklch(0.75 0.01 250)', 'hsl(210 10% 80%)', 'color-mix(in srgb, #fff 80%, #888)', 'rgb(200 200 200 / 0.9)', 'var(--x)', '210 10% 80%'] };
    const dark = { background: '#0a0a0a', sets: ['oklch(0.3 0.01 250)', 'hsl(210 10% 20%)', 'color-mix(in srgb, #000 80%, #777)', 'rgb(40 40 40 / 0.9)', 'var(--x)', '210 10% 20%'] };
    const measure = () => page.evaluate(() => {
      const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); return m ? m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number) : null; };
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const bg = getComputedStyle(document.querySelector('[data-theme]')).backgroundColor;
      const fills = (sel) => [...document.querySelectorAll(sel)].map((n) => getComputedStyle(n).fill);
      const min = (arr) => (arr.length ? Math.min(...arr.map((f) => ratio(f, bg))) : 0);
      return {
        bg,
        title: min(fills('g.role-title text')), axisTitle: min(fills('g.role-axis-title text')), axisLabel: min(fills('g.role-axis-label text')), legend: min(fills('g.role-legend-label text')),
        data: min([...document.querySelectorAll('g.role-mark text')].filter((n) => /\d/.test(n.textContent) && !n.getAttribute('stroke')).map((n) => getComputedStyle(n).fill)),
      };
    });
    for (const [theme, set] of [['light', light], ['dark', dark]]) for (const tok of set.sets) {
      await page.evaluate((o) => window.__sqlnbMountLabelChartForSmoke(o), { theme, editable: false, labels: true, tokens: { foreground: tok, mutedForeground: tok, background: set.background } });
      await page.waitForSelector('.chart-host svg g.role-title text');
      const m = await measure();
      const worst = Math.min(m.title, m.axisTitle, m.axisLabel, m.legend, m.data);
      report(m.data > 0 && worst >= 4.5, `${theme} token "${tok}": title ${m.title.toFixed(1)} axis-title ${m.axisTitle.toFixed(1)} axis-labels ${m.axisLabel.toFixed(1)} legend ${m.legend.toFixed(1)} data ${m.data.toFixed(1)}`);
      if (tok === set.sets[0] || tok === 'var(--x)') await page.screenshot({ path: join(outDir, `chart-token-${theme}-${tok.replace(/\W+/g, '_').slice(0, 20)}.png`) });
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate((o) => window.__sqlnbMountLabelChartForSmoke(o), { theme, editable: false, pie: true });
      await page.waitForSelector('.chart-host svg g.role-title text');
      const r = await page.evaluate(() => {
        const rgb = (c) => /rgba?\(([^)]+)\)/.exec(c)[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
        const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const texts = [...document.querySelectorAll('g.role-mark text')].filter((n) => /\d/.test(n.textContent));
        const halos = texts.filter((n) => n.getAttribute('stroke')), labels = texts.filter((n) => !n.getAttribute('stroke'));
        const slices = [...document.querySelectorAll('g.mark-arc path')].map((n) => getComputedStyle(n).fill);
        const labelVsHalo = Math.min(...labels.map((l, i) => ratio(getComputedStyle(l).fill, getComputedStyle(halos[i]).fill)));
        const same = labels.every((l, i) => halos[i] && halos[i].textContent === l.textContent && halos[i].getAttribute('transform') === l.getAttribute('transform'));
        return { labels: labels.length, halos: halos.length, slices: slices.length, labelVsHalo, same, sw: Math.min(...halos.map((h) => Number(h.getAttribute('stroke-width')))) };
      });
      report(r.labels === 8 && r.halos === 8 && r.slices === 8 && r.same && r.labelVsHalo >= 7 && r.sw >= 2, `${theme}: pie ${JSON.stringify(r)}`);
      await page.screenshot({ path: join(outDir, `chart-pie-halo-${theme}.png`) });
    }
  },
});

CHECKS.push({
  name: 'chart custom labels (titles, axes, legend, ticks, tooltip, click targets)',
  entry: 'chart-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountLabelChartForSmoke === 'function');
    const geo = () => page.evaluate(() => {
      const svg = document.querySelector('.chart-host svg'), r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10).join(','); };
      return { svg: r(svg), plot: r(svg.querySelector('g.role-scope, g.mark-rect')), tw: svg.getAttribute('width') + 'x' + svg.getAttribute('height') };
    });
    let base = null;
    for (const editable of [false, true]) for (const theme of ['dark', 'light']) {
      const tag = `${theme}/${editable ? 'editable' : 'plain'}`;
      await page.evaluate((o) => window.__sqlnbMountLabelChartForSmoke(o), { theme, editable });
      await page.waitForSelector('.chart-host svg g.role-axis-title');
      const t = await page.evaluate(() => {
        const q = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent);
        const axis = (p) => [...document.querySelectorAll(`g.role-axis[aria-label^="${p}"] g.role-axis-title text`)].map((n) => n.textContent);
        return { title: q('g.role-title text'), x: axis('X-axis'), y: axis('Y-axis'), legendTitle: q('g.role-legend-title text'), legend: q('g.role-legend-label text'), xTicks: q('g[aria-label^="X-axis"] g.role-axis-label text'), yTicks: q('g[aria-label^="Y-axis"] g.role-axis-label text'), titles: [...document.querySelectorAll('.chart-host svg title')].map((n) => n.textContent), tips: [...document.querySelectorAll('[aria-label*="万元"]')].map((n) => n.getAttribute('aria-label')) };
      });
      report(t.title.join('') === 'Q3 销售额', `${tag}: chart title (${t.title})`);
      report(t.x.join('') === '渠道' && t.y.join('') === '销售额（万元）', `${tag}: axis titles ${t.x}/${t.y}`);
      report(t.legendTitle.join('') === '是否 VIP', `${tag}: legend title (${t.legendTitle})`);
      report(t.xTicks.join() === '否,是', `${tag}: x ticks mapped (${t.xTicks})`);
      report(t.yTicks.length > 0 && t.yTicks.every((x) => !x.includes('万元')) && Math.max(...t.yTicks.map((x) => Number(x.replace(/,/g, '')))) < 100, `${tag}: y ticks scaled, unitless (${t.yTicks})`);
      const bar = page.locator('g.mark-rect path').first();
      await bar.hover();
      await page.waitForTimeout(150);
      const tip = await page.evaluate(() => { const b = document.querySelector('[data-chart-tooltip]'); return b ? (getComputedStyle(b).display !== 'none' ? b.textContent : 'HIDDEN:' + b.textContent) : 'NOBOX'; });
      report(tip.includes('12.5万元') && tip.includes('渠道: 否') && tip.includes('是否 VIP'), `${tag}: hover tooltip shows resolved labels + scaled value + unit (${tip.replace(/\n/g, ' | ')})`);
      const g = await geo();
      if (!base) base = g;
      else report(g.svg === base.svg && g.plot === base.plot && g.tw === base.tw, `${tag}: same svg/plot geometry as plain (${g.svg} vs ${base.svg})`);
      if (editable) {
        const idle = await geo();
        await page.locator('g.role-axis[aria-label^="Y-axis"] g.role-axis-title text').hover();
        await page.locator('g.role-title text').hover();
        const hov = await geo();
        report(JSON.stringify(idle) === JSON.stringify(hov), `${tag}: hovering titles causes no layout shift`);
        const dec = await page.locator('g.role-title text').evaluate((e) => getComputedStyle(e).textDecorationLine + '/' + getComputedStyle(e).cursor);
        report(dec === 'underline/pointer', `${tag}: hover shows underline + pointer (${dec})`);
        await page.evaluate(() => { window.__chartEdits.length = 0; });
        await page.locator('g.role-title text').click();
        await page.locator('g.role-axis[aria-label^="X-axis"] g.role-axis-title text').click();
        await page.locator('g.role-axis[aria-label^="Y-axis"] g.role-axis-title text').click();
        await page.locator('g.role-legend-title text').click();
        await page.locator('g.role-legend-label text', { hasText: '销售额' }).first().click().catch(() => {});
        const ev = await page.evaluate(() => window.__chartEdits.map((e) => e.kind + (e.axis ? ':' + e.axis : '')));
        report(ev.join() === 'title,axis:x,axis:y,axis:legend', `${tag}: clicks emit targets (${ev})`);
      } else {
        await page.evaluate(() => { window.__chartEdits.length = 0; });
        await page.locator('g.role-title text').click({ force: true }).catch(() => {});
        report((await page.evaluate(() => window.__chartEdits.length)) === 0, `${tag}: not editable emits nothing`);
      }
      await page.screenshot({ path: join(outDir, `label-chart-${theme}${editable ? '' : '-plain'}.png`) });
    }
  },
});

CHECKS.push({
  name: 'label popover (real AnalysisBlock: table + chart triggers, 600px viewport)',
  entry: 'popover-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountPopoverForSmoke === 'function');
    const inView = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }, sel);
    const DLG = '[role=dialog][data-test=label-popover]';
    const thRects = () => page.evaluate(() => [...document.querySelectorAll('thead th')].map((e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].join(','); }).join('|'));
    for (const theme of ['dark', 'light']) for (const width of [560, 320]) {
      const tag = `${theme}/${width}px`;
      await page.evaluate((o) => window.__sqlnbMountPopoverForSmoke(o), { theme, width });
      await page.waitForSelector('thead th .lbl-edit', { state: 'attached' });
      await page.waitForSelector('.chart-host svg g.role-title');
      const th = page.locator('thead th').last();
      const before = await thRects();
      await th.hover();
      await page.waitForTimeout(250);
      const op = await th.locator('.lbl-edit').evaluate((e) => getComputedStyle(e).opacity);
      report(op === '1' && before === (await thRects()), `${tag}: hover shows edit button, header rects unchanged`);
      const lastId = await th.locator('.lbl-edit').getAttribute('data-label-target');
      await th.locator('.lbl-edit').click();
      await page.waitForSelector(DLG);
      report(await inView(DLG), `${tag}: dialog inside the viewport (right-most column)`);
      const rr = await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), innerWidth, innerHeight].join(','); }, DLG);
      console.log('      dialog rect l,t,r,b,vw,vh = ' + rr);
      report(await page.evaluate(() => document.querySelector('[data-test=analysis-block]').contains(document.querySelector('[role=dialog]'))), `${tag}: dialog lives inside the block root`);
      report(await page.evaluate((q) => document.activeElement === document.querySelector(q + ' input'), DLG), `${tag}: input focused`);
      await page.evaluate(() => { window.__popCalls = 0; });
      await page.keyboard.type('季度ABC');
      report((await page.evaluate(() => window.__popCalls)) === 0, `${tag}: typing does not commit`);
      if (width === 560) await page.screenshot({ path: join(outDir, `label-popover-${theme}.png`) });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const hdr = await page.evaluate(() => document.querySelector('thead').textContent);
      report(hdr.includes('季度ABC') && (await page.evaluate(() => window.__popCalls)) === 1 && !(await page.$(DLG)), `${tag}: Enter commits once, closes, header shows new text`);
      report(await page.evaluate((id) => document.activeElement?.classList.contains('lbl-edit') && document.activeElement.getAttribute('data-label-target') === id, lastId), `${tag}: focus back on the trigger after Enter`);
      await page.evaluate(() => { window.__popCalls = 0; });
      await page.locator('thead th').last().hover();
      await page.locator('thead th').last().locator('.lbl-edit').click();
      await page.waitForSelector(DLG);
      await page.keyboard.type('zzz');
      await page.keyboard.press('Escape');
      report(!(await page.$(DLG)) && (await page.evaluate(() => window.__popCalls)) === 0 && (await page.evaluate(() => document.activeElement?.classList.contains('lbl-edit'))), `${tag}: Escape closes without change, focus on trigger`);
      await page.locator('.chart-host g.role-title text').first().click();
      await page.waitForSelector(DLG);
      console.log('      chart dialog rect ' + (await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ' vp ' + innerWidth + 'x' + innerHeight; }, DLG)));
      report((await page.evaluate(() => document.querySelector('[role=dialog] input').value)) === '销售额' && (await inView(DLG)), `${tag}: chart title click opens popover in viewport`);
      if (width === 560) await page.screenshot({ path: join(outDir, `label-popover-chart-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((o) => window.__sqlnbMountPopoverForSmoke(o), { theme, width: 560 });
      await page.waitForSelector('thead th button[data-sort]');
      await page.locator('thead th button[data-sort]').first().focus();
      await page.keyboard.press('F2');
      await page.waitForSelector(DLG);
      await page.keyboard.type('地区X');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      const ok = await page.evaluate(() => document.querySelector('thead').textContent.includes('地区X') && window.__popMeta().pivot.rows[0].label === '地区X');
      report(ok && !(await page.$(DLG)), `${theme}: keyboard sequence (focus sort button, F2, type, Enter) renames row field`);
      report(await page.evaluate(() => document.activeElement?.getAttribute('data-label-target') === 'rowName:0'), `${theme}: focus returned to the header edit button after keyboard edit`);
      await page.locator('thead th button[data-sort]').first().focus();
      await page.keyboard.press('F2');
      await page.waitForSelector(DLG);
      for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
      report(await page.evaluate(() => document.querySelector('[role=dialog]').contains(document.activeElement)), `${theme}: Tab x4 stays inside the dialog (trap)`);
      await page.keyboard.press('Escape');
      await page.locator('thead th button[data-sort]').first().click({ timeout: 3000 }).catch((e) => console.log(String(e.message).slice(0, 600)));
      report((await page.evaluate(() => window.__popMeta().pivot.sort))?.by === 'name', `${theme}: sort click still sorts while popover closed`);
    }
  },
});

CHECKS.push({
  name: 'labels preview (320/560px, themes, hostile labels, highlight)',
  entry: 'labels-preview-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountPreviewForSmoke === 'function');
    const targets = [{ kind: 'title' }, { kind: 'category', axis: 'row', index: 0, key: 'a' }, { kind: 'scale', index: 0 }];
    for (const theme of ['dark', 'light']) for (const width of [560, 320]) {
      const tag = `${theme}/${width}px`;
      await page.evaluate((o) => window.__sqlnbMountPreviewForSmoke(o), { theme, width, active: targets[0] });
      for (const [i, tg] of targets.entries()) {
        await page.evaluate((a) => window.__pvSetActive(a), tg);
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
          const root = document.querySelector('[data-test=labels-preview]'), b = root.getBoundingClientRect();
          const act = [...root.querySelectorAll('[data-active=true]')];
          const clipped = act.some((e) => { const x = e.getBoundingClientRect(); return x.left - 2 < b.left || x.right + 2 > b.right || x.top - 2 < b.top || x.bottom + 2 > b.bottom; });
          const outline = act.length ? getComputedStyle(act[0]).outlineStyle : 'none';
          const mh = [...root.querySelectorAll('.lpv-meas')].map((e) => Math.round(e.getBoundingClientRect().left));
          const body = [...root.querySelectorAll('.lpv-row, .lpv-grid > .lpv-num')].slice(0, mh.length).map((e) => Math.round(e.getBoundingClientRect().left));
          const aligned = mh.length > 0 && mh.every((x, i) => x === body[i]);
          return { aligned, over: root.scrollWidth > root.clientWidth, n: act.length, clipped, outline, img: !!root.querySelector('img,b'), focus: !!root.querySelector('[tabindex],button,a,input') };
        });
        report(r.aligned && !r.over && r.n > 0 && !r.clipped && r.outline === 'solid' && !r.img && !r.focus, `${tag} target#${i}: no overflow, ${r.n} highlight(s) visible/unclipped, text only (${JSON.stringify(r)})`);
        if (i === 1) await page.screenshot({ path: join(outDir, `labels-preview-${theme}-${width}.png`) });
      }
    }
  },
});

CHECKS.push({
  name: 'labels dialog shell (real LabelsDialog + store; 960/560/320px, themes, focus trap, Esc/IME, scroll lock)',
  entry: 'labels-dialog-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountLabelsDialogForSmoke === 'function');
    const DLG = '[data-test=labels-dialog]';
    const inDlg = () => page.evaluate((q) => !!document.activeElement && !!document.querySelector(q)?.contains(document.activeElement), DLG);
    for (const theme of ['dark', 'light']) for (const width of [960, 560, 320]) {
      const tag = `${theme}/${width}px`;
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate((o) => window.__sqlnbMountLabelsDialogForSmoke(o), { theme, hostile: true });
      await page.evaluate(() => { document.getElementById('scroller').scrollTop = 150; });
      const before = await page.evaluate(() => document.getElementById('scroller').scrollTop);
      await page.click('#opener');
      await page.waitForSelector(DLG);
      report(await page.evaluate(() => document.getElementById('blockroot').contains(document.querySelector('[data-test=labels-dialog]'))), `${tag}: dialog lives inside the block root, not body`);
      report(await inDlg(), `${tag}: focus moved into the dialog`);
      const TABS = { table: '表格', chart: '图表', numbers: '数值', categories: '分类值' };
      const tabsOk = await page.evaluate(() => { const d = document.querySelector('[data-test=labels-dialog]').getBoundingClientRect(); const ts = [...document.querySelectorAll('[data-test=labels-tabs] [role=tab]')]; return { n: ts.length, within: ts.every((t) => { const r = t.getBoundingClientRect(); return r.left >= d.left - 0.5 && r.right <= d.right + 0.5 && r.width > 0; }), names: ts.map((t) => t.querySelector('.ld-t').textContent), role: document.querySelector('[data-test=labels-tabs]').getAttribute('role') }; });
      report(tabsOk.n === 4 && tabsOk.within && tabsOk.role === 'tablist' && tabsOk.names.join() === Object.values(TABS).join(), `${tag}: tablist with 4 tabs 表格/图表/数值/分类值, all inside the dialog (${JSON.stringify(tabsOk)})`);
      const lay = await page.evaluate(() => {
        const pv = document.querySelector('[data-test=labels-preview-slot]'), pn = document.querySelector('[data-test=labels-panel]');
        const pr = pv.getBoundingClientRect(), nr = pn.getBoundingClientRect();
        return { pvDisplay: getComputedStyle(pv).display, pvRight: pr.right, pnLeft: nr.left, pvW: pr.width, intersects: pr.width > 0 && pr.left < nr.right && pr.right > nr.left && pr.top < nr.bottom && pr.bottom > nr.top };
      });
      report(width > 640 ? lay.pvDisplay !== 'none' && lay.pvRight <= lay.pnLeft + 0.5 && !lay.intersects : lay.pvDisplay === 'none', `${tag}: ${width > 640 ? 'preview left, items right, no intersection' : 'preview hidden, tabs remain'} (${JSON.stringify(lay)})`);
      let over = [];
      for (const g of Object.keys(TABS)) {
        await page.click(`[role=tab][data-tab=${g}]`);
        const o = await page.evaluate((q) => ['', ' .ld-split', ' .ld-content', ' .ld-head', ' .ld-foot', ' .ld-tabs', ' .ld-banner'].map((sfx) => { const e = document.querySelector(q + sfx); return e && e.scrollWidth > e.clientWidth + 1 ? q + sfx : ''; }).filter(Boolean), DLG);
        over = over.concat(o.map((x) => g + ':' + x));
        const rowOver = await page.evaluate(() => [...document.querySelectorAll('.lp-row')].filter((r) => r.scrollWidth > r.clientWidth + 1).length);
        if (rowOver) over.push(g + ':rows=' + rowOver);
        const ban = await page.textContent('[data-test=labels-banner]');
        report(ban.startsWith('此页影响：') && ban.length > 6, `${tag}: ${TABS[g]} tab banner "${ban}"`);
        const nums = await page.evaluate(() => [...document.querySelectorAll('[data-test=labels-panel] [data-test=label-num]')].slice(0, 5).map((e) => e.textContent).join());
        report(nums.startsWith('1,2'), `${tag}: ${TABS[g]} tab numbers restart at 1 (${nums})`);
      }
      report(over.length === 0, `${tag}: no horizontal overflow in any tab (${over.join(',')})`);
      const foot = await page.evaluate(() => ({ total: document.querySelector('[data-test=labels-total]').textContent, all: document.querySelector('[data-test=labels-reset-all]').textContent, done: document.querySelector('[data-test=labels-close]').textContent, tab: document.querySelector('[data-test=labels-reset-tab]').textContent, old: !!document.querySelector('[data-test=labels-groups],[data-test=labels-reset-group]') || /撤销历史/.test(document.querySelector('[data-test=labels-dialog]').textContent) }));
      report(/^已自定义 \d+ 项$/.test(foot.total) && /^全部恢复自动（\d+）$/.test(foot.all) && foot.done === '完成' && /^恢复本页自动（\d+）$/.test(foot.tab) && !foot.old, `${tag}: footer 已自定义 N 项 / 全部恢复自动（N） / 完成, per-tab reset, no 撤销历史 (${JSON.stringify(foot)})`);
      const kb = { ok: true, log: [] };
      await page.focus('[role=tab][data-tab=table]');
      for (const [k, want] of [['ArrowRight', 'chart'], ['ArrowRight', 'numbers'], ['ArrowRight', 'categories'], ['ArrowRight', 'table'], ['ArrowLeft', 'categories'], ['Home', 'table'], ['End', 'categories'], ['Home', 'table']]) {
        await page.keyboard.press(k);
        const got = await page.evaluate(() => ({ f: document.activeElement.dataset.tab, s: document.querySelector('[role=tab][aria-selected=true]').dataset.tab, lab: document.querySelector('[data-test=labels-panel]').getAttribute('aria-labelledby') === document.activeElement.id }));
        if (got.f !== want || got.s !== want || !got.lab) { kb.ok = false; kb.log.push(`${k}->${JSON.stringify(got)} want ${want}`); }
      }
      report(kb.ok, `${tag}: real ArrowRight/ArrowLeft/Home/End move focus + selection, panel aria-labelledby follows (${kb.log.join(';')})`);
      await page.keyboard.press('Tab');
      report(await page.evaluate(() => !!document.activeElement.closest('[data-test=labels-panel],.ld-banner')), `${tag}: Tab from the tab moves into the panel/banner`);
      await page.focus('[role=tab][data-tab=table]');
      report(await page.evaluate(() => document.querySelector('[data-test=labels-dialog]').contains(document.activeElement)), `${tag}: tab focus stays inside the dialog`);
      report(await page.evaluate(() => { const tb = document.querySelector('#tb-btn').getBoundingClientRect(); const el = document.elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2); return !!el && !!el.closest('[data-test=labels-dialog],[data-test=labels-backdrop]'); }), `${tag}: dialog overlays the sticky toolbar`);
      await page.screenshot({ path: join(outDir, `labels-dialog-${theme}-${width}.png`) });
      if (width === 320) { await page.click('[role=tab][data-tab=categories]'); await page.screenshot({ path: join(outDir, `labels-dialog-${theme}-${width}-cats.png`) }); await page.click('[role=tab][data-tab=table]'); }

      {
        await page.click('[role=tab][data-tab=categories]');
        const SQ = '[data-test=label-search]';
        const rowsN = () => page.evaluate(() => document.querySelector('[data-test=labels-dialog] section.lp-group[data-group="row:0"]').querySelectorAll('.lp-row').length);
        report((await page.$(SQ)) !== null && (await rowsN()) === 51, `${tag}: 120 categories -> search box present, 50 category rows (+null) shown`);
        await page.fill(SQ, '渠道');
        await page.waitForTimeout(80);
        const cnt = await page.textContent('[data-test=label-search-count]');
        report(/^匹配 \d+ \/ 共 120 个$/.test(cnt) && (await rowsN()) > 1 && (await rowsN()) < 51, `${tag}: CJK query filters rows and shows count (${cnt})`);
        report(await page.evaluate(() => document.querySelector('[data-test=label-search]').scrollWidth <= document.querySelector('[data-test=labels-dialog]').clientWidth && document.querySelector('[data-test=labels-dialog]').scrollWidth <= document.querySelector('[data-test=labels-dialog]').clientWidth), `${tag}: search UI causes no horizontal overflow`);
        report(await page.evaluate(() => document.querySelectorAll('[data-test=labels-dialog] section.lp-group[data-group="row:0"] [data-label-target^="null:"]').length === 1 && !document.querySelector('[data-test=label-showall]')), `${tag}: null row stays and show-all toggle hidden during a query`);
        await page.screenshot({ path: join(outDir, `labels-dialog-${theme}-${width}-search.png`) });
        await page.click('[data-test=label-search-clear]');
        report(await page.evaluate(() => document.activeElement === document.querySelector('[data-test=label-search]')) && (await rowsN()) === 51, `${tag}: clear button restores rows and returns focus to the search input`);
        await page.fill(SQ, 'zzzz');
        report((await page.textContent('[data-test=label-search-empty]')) === '无匹配项', `${tag}: no-match shows a text message`);
        await page.fill(SQ, '');
        await page.click('[role=tab][data-tab=table]');
      }

      let stay = true;
      await page.focus('[data-test=labels-close]');
      for (let i = 0; i < 45; i++) { await page.keyboard.press('Tab'); if (!(await inDlg())) { stay = false; break; } }
      for (let i = 0; i < 12 && stay; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inDlg())) stay = false; }
      report(stay, `${tag}: real Tab x45 / Shift+Tab x12 never leave the dialog`);
      await page.focus('[data-test=labels-close]');
      await page.keyboard.press('Tab');
      report(await page.evaluate(() => document.activeElement === document.querySelector('[data-test=labels-dialog]').querySelector('button,input,[tabindex]:not([tabindex="-1"])')), `${tag}: Tab from the last control wraps to the first`);
      await page.keyboard.press('Shift+Tab');
      report(await page.evaluate(() => document.activeElement === document.querySelector('[data-test=labels-close]')), `${tag}: Shift+Tab from the first wraps to the last`);

      await page.mouse.move(width / 2, 4);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(80);
      report(await page.evaluate((b) => document.getElementById('scroller').scrollTop === b && getComputedStyle(document.getElementById('scroller')).overflow === 'hidden', before), `${tag}: wheel over the backdrop does not scroll the page; scroller locked`);
      await page.mouse.click(2, 2);
      await page.waitForTimeout(80);
      report((await page.evaluate(() => window.__ldCloses)) === 0 && !!(await page.$(DLG)), `${tag}: backdrop click does not close`);
      if (width > 640) {
        await page.evaluate((q) => { document.querySelector(q).style.width = '400px'; }, DLG);
        await page.waitForTimeout(80);
        report((await page.evaluate(() => getComputedStyle(document.querySelector('[data-test=labels-preview-slot]')).display)) === 'none', `${tag}: forcing the panel to 400px (viewport unchanged) hides the preview (container query, not viewport)`);
        await page.evaluate((q) => { document.querySelector(q).style.width = ''; }, DLG);
      }

      await page.click('[role=tab][data-tab=table]');
      const inp = page.locator(`${DLG} [data-test=label-input]`).first();
      await inp.focus();
      const stored = await inp.inputValue();
      await page.evaluate(() => { window.__ldCalls = 0; });
      await page.keyboard.type('abc');
      report((await page.evaluate(() => window.__ldCalls)) === 0, `${tag}: typing does not commit`);
      await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
      report(!!(await page.$(DLG)) && (await inp.inputValue()).endsWith('abc'), `${tag}: Esc during IME composition is ignored`);
      await page.keyboard.press('Escape');
      report(!!(await page.$(DLG)) && (await inp.inputValue()) === stored, `${tag}: first Esc on a dirty input reverts to the stored value (${JSON.stringify(stored)}) and keeps the dialog open`);
      await page.keyboard.press('Escape');
      await page.waitForSelector(DLG, { state: 'detached' });
      report(await page.evaluate((b) => document.activeElement?.id === 'opener' && document.getElementById('scroller').scrollTop === b && document.getElementById('scroller').style.overflow !== 'hidden', before), `${tag}: second Esc closes; focus back on the 高级设置 button, scroll position unchanged, lock released`);

      await page.click('#opener');
      await page.waitForSelector(DLG);
      await page.evaluate(() => { window.__ldCalls = 0; });
      await page.click('[data-test=labels-reset-all]');
      const res = await page.evaluate(() => ({ n: window.__ldCalls, title: window.__ldMeta().chartOptions.title, sum: window.__ldMeta().pivot.summaryLabel }));
      report(res.n === 1 && res.title === undefined && res.sum === undefined, `${tag}: 全部恢复自动 = exactly one setAnalysis, labels removed (${JSON.stringify(res)})`);
      report((await page.locator('[data-test=labels-reset-all]').isDisabled()), `${tag}: reset-all disabled once nothing is customised`);
      await page.click('[data-test=labels-close]');
    }
  },
});

CHECKS.push({
  name: 'labels dialog numbered preview (real dialog + preview; 960px, themes, four tabs)',
  entry: 'labels-dialog-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountLabelsDialogForSmoke === 'function');
    const DLG = '[data-test=labels-dialog]';
    for (const theme of ['dark', 'light']) {
      const tag = `${theme}/960px/numbered preview`;
      await page.setViewportSize({ width: 960, height: 800 });
      await page.evaluate((o) => window.__sqlnbMountLabelsDialogForSmoke(o), { theme });
      await page.click('#opener');
      await page.waitForSelector(DLG);
      for (const tab of ['table', 'chart', 'numbers', 'categories']) {
        await page.click(`[role=tab][data-tab=${tab}]`);
        await page.waitForTimeout(80);
        const m = await page.evaluate(() => {
          const slot = document.querySelector('[data-test=labels-preview-slot]');
          const heads = [...document.querySelectorAll('[data-test=labels-dialog] [data-test=label-num]')].map((e) => e.textContent.trim());
          const bs = [...slot.querySelectorAll('.lp-badge')];
          const badges = bs.map((b) => b.textContent.trim());
          const dist = bs.map((b) => { const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; return Math.hypot(Math.max(p.left - cx, 0, cx - p.right), Math.max(p.top - cy, 0, cy - p.bottom)); });
          const sr = slot.getBoundingClientRect(), items = [...document.querySelectorAll('[data-test=labels-dialog] .lp-row')].map((e) => e.getBoundingClientRect());
          const overlap = items.some((r) => r.width > 0 && r.left < sr.right && sr.left < r.right && r.top < sr.bottom && sr.top < r.bottom);
          const dlg = document.querySelector('[data-test=labels-dialog]');
          return { heads, badges, dist, overlap, over: dlg.scrollWidth > dlg.clientWidth || slot.scrollWidth > slot.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, hidden: slot.querySelector('[data-test=labels-preview]')?.getAttribute('aria-hidden') };
        });
        report(m.badges.length > 0 && m.badges.every((d) => m.heads.includes(d)) && new Set(m.badges).size === m.badges.length, `${tag}/${tab}: badge digits [${m.badges}] are a duplicate-free subset of heading digits [${m.heads.length}]`);
        report(m.heads.every((d, i) => d === String(i + 1)), `${tag}/${tab}: headings numbered 1..${m.heads.length}`);
        report(m.dist.every((d) => d <= 24), `${tag}/${tab}: every badge within 24px of the element it numbers (max ${Math.round(Math.max(0, ...m.dist))}px)`);
        report(!m.overlap && !m.over, `${tag}/${tab}: preview overlaps no item, no overflow`);
        report(m.hidden === 'true', `${tag}/${tab}: preview aria-hidden`);
        await page.screenshot({ path: join(outDir, `labels-dialog-numbered-${theme}-960-${tab}.png`) });
      }
      await page.click('[data-test=labels-close]');
    }
  },
});
CHECKS.push({
  name: 'config panel alignment (real AnalysisBlock: 标题 aligned, 2x input, 高级设置 next to 总汇总; 320/560/960px)',
  entry: 'popover-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountPopoverForSmoke === 'function');
    const W0 = 153; // title input width measured in real Chrome before E1 (560px container; same at 320/960)
    for (const theme of ['dark', 'light']) for (const width of [960, 560, 320]) {
      const tag = `${theme}/${width}px`;
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((o) => window.__sqlnbMountPopoverForSmoke(o), { theme, width, badges: true });
      await page.waitForSelector('[data-test=ab-labels-open]');
      const m = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const L = (e) => e.getBoundingClientRect().left;
        const lab = (row) => q(`[data-row=${row}] .ab-rlabel, [data-row=${row}] .fp-label`);
        const rows = ['title', 'rows', 'cols', 'values', 'summary'];
        const labels = rows.map((r) => lab(r));
        const ctl = ['[data-row=title] input', '[data-row=rows] .fp-chips, [data-row=rows] .fp-chip, [data-row=rows] button', '[data-row=summary] input[type=checkbox]'].map((s) => q(s));
        const first = (row) => { const l = lab(row); return l && l.nextElementSibling; };
        const inp = q('[data-test=ab-title]'), grand = q('[data-test=ab-summary-grand]').closest('label'), btn = q('[data-test=ab-labels-open]');
        const sum = q('[data-row=summary]');
        const badges = [...sum.querySelectorAll('.ab-badge')];
        const R = (e) => e.getBoundingClientRect();
        const ir = R(inp), gr = R(grand), br = R(btn);
        const tl = lab('title');
        return {
          labelsX: labels.map((e) => e && Math.round(L(e) * 2) / 2),
          labelsW: labels.map((e) => e && Math.round(R(e).width * 2) / 2),
          ctlX: ['title', 'rows', 'cols', 'values', 'summary'].map((r) => { const f = first(r), l = lab(r); return f && Math.abs(R(f).top - R(l).top) < 12 ? Math.round(L(f) * 2) / 2 : (r === 'title' || r === 'summary' ? -1 : null); }),
          titleLabelIsLabel: !!tl && tl.tagName === 'LABEL' && tl.getAttribute('for') === inp.id && !!inp.id,
          inW: ir.width, cw: q('[data-test=analysis-block]') ? q('[data-test=analysis-block]').clientWidth : innerWidth,
          inOver: ir.right > R(inp.closest('.ab-row')).right + 0.5,
          next: grand.nextElementSibling === btn,
          gap: br.left - gr.right, sameLine: Math.abs(br.top - gr.top) < 12,
          noOverlap: badges.every((b) => { const x = R(b); return x.right <= br.left + 0.5 || x.left >= br.right - 0.5 || x.bottom <= br.top + 0.5 || x.top >= br.bottom - 0.5; }),
          noClip: badges.every((b) => b.scrollWidth <= b.clientWidth + 1),
          nb: badges.length,
          noOverflow: document.documentElement.scrollWidth <= innerWidth && sum.scrollWidth <= sum.clientWidth + 1,
          text: btn.textContent, haspopup: btn.getAttribute('aria-haspopup'),
          beforeBadges: badges.every((b) => !!(btn.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)),
        };
      });
      const eq = (a) => a.every((x) => x !== null && Math.abs(x - a[0]) <= 0.5);
      const eqc = (a) => { const v = a.filter((x) => x !== null); return v.length >= 3 && v.every((x) => x >= 0 && Math.abs(x - v[0]) <= 0.5); };
      report(eq(m.labelsX) && eq(m.labelsW), `${tag}: label cells x/width aligned across 标题/行/列/值/汇总 (${JSON.stringify(m.labelsX)} w ${JSON.stringify(m.labelsW)})`);
      report(eqc(m.ctlX), `${tag}: first control starts at the same x in every row (${JSON.stringify(m.ctlX)})`);
      report(m.titleLabelIsLabel, `${tag}: 标题 is a <label for> bound to the input`);
      const ratio = m.inW / W0;
      if (m.inW + 1 < 2 * W0) report(!m.inOver && m.inW > 60, `${tag}: input shrinks (W0=${W0}, width ${m.inW}, ratio ${ratio.toFixed(2)}) and does not overflow its row`);
      else report(Math.abs(m.inW - 2 * W0) <= 1 && !m.inOver, `${tag}: input width ${m.inW} is 2.0 x W0=${W0} (ratio ${ratio.toFixed(2)}, ±1px)`);
      report(m.next && m.beforeBadges && m.nb >= 3, `${tag}: 高级设置 is right after 总汇总 and before every badge (${m.nb} badges)`);
      report(m.sameLine ? m.gap >= 4 && m.gap <= 16 : true, `${tag}: gap after 总汇总 ${Math.round(m.gap)}px (same line: ${m.sameLine})`);
      report(m.noOverlap && m.noClip && m.noOverflow, `${tag}: button does not overlap/clip badges, no horizontal overflow`);
      report(m.text === '高级设置' && m.haspopup === 'dialog', `${tag}: button text 高级设置, aria-haspopup=dialog`);
      const lay = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const title = q('[data-row=title]'), rows = q('[data-row=rows]');
        return { above: title.getBoundingClientRect().bottom <= rows.getBoundingClientRect().top + 0.5 && !!(title.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING), alone: title.children.length === 2 && title.children[0].tagName === 'LABEL' && title.children[1].tagName === 'INPUT' && !title.closest('.ab-opts') };
      });
      report(lay.above && lay.alone, `${tag}: 标题 row is above the 行 row and holds only its label + input`);
      const lg = await page.evaluate(() => {
        const row = document.querySelector('[data-row=title]'), lab = row.querySelector('label'), inp = row.querySelector('input');
        lab.textContent = 'A very long English label for title';
        const r = row.getBoundingClientRect(), ir = inp.getBoundingClientRect();
        return { w: ir.width, over: ir.right > r.right + 0.5 || row.scrollWidth > row.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth };
      });
      report(!lg.over && lg.w >= 120, `${tag}: long title label: no overflow, input keeps ${Math.round(lg.w)}px (>=120)`);
      await page.screenshot({ path: join(outDir, `config-alignment-${theme}-${width}.png`) });
    }
  },
});

CHECKS.push({
  name: 'start page settings disclosure + browser pickers (collapsed default, keyboard, a11y, 320/560/960px)',
  entry: 'start-page-smoke.html',
  async run({ page, report }) {
    await page.waitForFunction(() => typeof window.__sqlnbMountStartPageForSmoke === 'function');
    for (const locale of ['zh-CN', 'en']) for (const theme of ['dark', 'light']) for (const width of [960, 560, 320]) {
      const tag = `${locale}/${theme}/${width}px`;
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((o) => window.__sqlnbMountStartPageForSmoke(o), { theme, locale, path: '', bad: false, pick: '/picked' });
      await page.waitForSelector('[data-test=settings-toggle]');
      const q = (s) => page.locator(s);
      const state = () => page.evaluate(() => { const t = document.querySelector('[data-test=settings-toggle]'), b = document.getElementById(t.getAttribute('aria-controls')); return { exp: t.getAttribute('aria-expanded'), vis: !!b && b.offsetParent !== null && b.getBoundingClientRect().height > 0, tag: t.tagName, inH3: !!t.closest('h3') }; });
      let st = await state();
      report(st.exp === 'false' && !st.vis && st.tag === 'BUTTON' && st.inH3, `${tag}: collapsed by default (aria-expanded=false, panel hidden, button in heading)`);
      await page.focus('[data-test=settings-toggle]');
      await page.keyboard.press('Enter');
      st = await state();
      report(st.exp === 'true' && st.vis, `${tag}: Enter expands`);
      await page.keyboard.press('Space');
      st = await state();
      report(st.exp === 'false' && !st.vis, `${tag}: Space collapses`);
      await page.keyboard.press('Enter');
      const m = await page.evaluate(() => {
        const names = ['browser-pick-file', 'browser-pick-dir'].map((k) => { const b = document.querySelector(`[data-test=${k}]`); return b && { name: b.getAttribute('aria-label'), text: b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }; });
        const inp = document.querySelector('[data-test=browser-path]'), r = inp.getBoundingClientRect();
        const colour = getComputedStyle(document.querySelector('.sp')).color;
        return { names, inpW: r.width, inpRO: inp.readOnly, over: document.documentElement.scrollWidth > innerWidth, panelOver: document.querySelector('.sp-settings').scrollWidth > document.querySelector('.sp-settings').clientWidth + 1, colour, status: document.querySelector('[data-test=browser-status]').getAttribute('role') };
      });
      report(m.names.every((n) => n && n.name && n.text), `${tag}: both picker buttons present with a11y names (${m.names.map((n) => n && n.text).join(' / ')})`);
      report(m.inpW >= 120 && !m.inpRO, `${tag}: path input editable and ${Math.round(m.inpW)}px wide (>=120)`);
      report(!m.over && !m.panelOver, `${tag}: no horizontal overflow`);
      report(m.colour === (theme === 'dark' ? 'rgb(250, 250, 250)' : 'rgb(10, 10, 10)') && m.status === 'status', `${tag}: dark/light tokens applied (${m.colour}), status line is role=status`);
      await page.keyboard.press('Tab');
      const focusIn = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-test'));
      report(focusIn === 'max-rows', `${tag}: Tab from the expanded toggle enters the panel (${focusIn})`);
      await page.focus('[data-test=settings-toggle]');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      const afterCollapsed = await page.evaluate(() => document.activeElement && document.activeElement.closest('#sp-settings-body') ? 'inside' : 'outside');
      report(afterCollapsed === 'outside', `${tag}: collapsed panel is skipped by Tab (${afterCollapsed})`);
      await page.focus('[data-test=settings-toggle]');
      await page.keyboard.press('Enter');
      await q('[data-test=browser-pick-file]').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-test=browser-path]').value === '/picked/file');
      report(true, `${tag}: keyboard-activated file picker fills the input`);
      await q('[data-test=browser-pick-dir]').click();
      await page.waitForFunction(() => document.querySelector('[data-test=browser-path]').value === '/picked/dir');
      report(true, `${tag}: folder picker fills the input`);
      if (width !== 560) await page.screenshot({ path: join(outDir, `start-settings-${locale === 'en' ? 'en' : 'zh'}-${theme}-${width}.png`) });
      await page.evaluate((o) => window.__sqlnbMountStartPageForSmoke(o), { theme, locale, path: '/bad/chrome', bad: true });
      await page.waitForFunction(() => document.querySelector('[data-test=settings-warning]'));
      st = await state();
      const warn = await page.evaluate(() => ({ label: document.querySelector('[data-test=settings-toggle]').getAttribute('aria-label'), st: document.querySelector('[data-test=browser-status]').getAttribute('data-state'), over: document.documentElement.scrollWidth > innerWidth }));
      report(st.exp === 'true' && !!warn.label && warn.st === 'notFound' && !warn.over, `${tag}: invalid path auto-opens, header flagged (${warn.label}), status notFound`);
      await page.keyboard.press('Escape');
      await page.evaluate((o) => window.__sqlnbMountStartPageForSmoke(o), { theme, locale, path: '', bad: false });
      await page.waitForSelector('[data-test=settings-toggle]');
      await page.screenshot({ path: join(outDir, `start-collapsed-${locale === 'en' ? 'en' : 'zh'}-${theme}-${width}.png`) });
    }
  },
});

// ---- runner -------------------------------------------------------------------------------------------------
let tmp = null, browser = null, server = null;
async function cleanup() {
  if (browser) { const b = browser; browser = null; await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]); }
  if (server) { server.close(); server = null; }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
}

async function main() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  const entries = [...new Set(CHECKS.map((c) => c.entry))];
  tmp = mkdtempSync(join(tmpdir(), 'sqlnb-polish-'));
  mkdirSync(outDir, { recursive: true });
  for (const entry of entries) {
    if (process.env.SMOKE_ONLY && !CHECKS.some((c) => c.entry === entry && c.name.includes(process.env.SMOKE_ONLY))) continue;
    const dir = join(tmp, entry.replace(/\.html$/, ''));
    const b = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'smoke'], { cwd: uiSrc, stdio: 'inherit', shell: isWin, env: { ...process.env, SMOKE_OUT_DIR: dir, SMOKE_INPUT: entry } });
    if (b.status !== 0 || !existsSync(join(dir, entry))) { console.log(`FAIL  smoke build ${entry}`); return 1; }
  }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',').map((c) => c.trim()).filter(Boolean)) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log('browser: ' + channel); break; } catch { /* next */ }
  }
  if (!browser) { console.log('SKIPPED: No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  server = createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = join(tmp, p.replace(/^\/+/, ''));
    if (!f.startsWith(tmp) || !existsSync(f) || !extname(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  for (const c of CHECKS) {
    if (process.env.SMOKE_ONLY && !c.name.includes(process.env.SMOKE_ONLY)) continue;
    console.log(`# ${c.name}`);
    const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(`${base}/${c.entry.replace(/\.html$/, '')}/${c.entry}`);
    try { await c.run({ page, report }); } catch (e) { report(false, `${c.name}: threw ${String(e.message).split('\n')[0]}`); }
    report(errors.length === 0, `${c.name}: no page errors${errors.length ? ' (' + errors[0] + ')' : ''}`);
    await page.close();
  }
  console.log(`screenshots in ${outDir}`);
  return failed ? 1 : 0;
}
main().then(async (c) => { await cleanup(); process.exit(c); }, async (e) => { console.error(e); await cleanup(); process.exit(1); });
