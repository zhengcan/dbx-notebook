#!/usr/bin/env node
// Real-Chrome check of the exported report HTML/PDF: no scripts/requests, serial column on every column page,
// one page-break per column group, @page orientation, wide table and chart fit the print width.
// Exit codes: 0 pass, 1 fail, 2 skipped (no Chrome/Edge; 1 if SMOKE_REQUIRE_BROWSER=1).
// Optional: SMOKE_SIDECAR=<path to sidecar binary> also runs export/pdfStart against the real sidecar.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireBrowser = process.env.SMOKE_REQUIRE_BROWSER === '1';
const PORTRAIT_PX = Math.floor((210 - 24) / 25.4 * 96); // A4 width minus @page margins
const LANDSCAPE_PX = Math.floor((297 - 24) / 25.4 * 96);

const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };

let browser;
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'export-check-'));
  execFileSync('npx', ['vite-node', 'scripts/export-fixture.ts', dir], { cwd: resolve(here, '..'), stdio: ['ignore', 'ignore', 'inherit'] });

  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('playwright-core is not installed'); return 1; }
  for (const channel of (process.env.SMOKE_BROWSER_CHANNELS || 'chrome,msedge').split(',')) {
    try { browser = await chromium.launch({ channel: channel.trim(), headless: true }); break; } catch { /* next */ }
  }
  if (!browser) { console.log('No system Chrome/Edge found'); return requireBrowser ? 1 : 2; }
  let failed = false;
  const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };
  const pdftotext = has('pdftotext');
  const pdfinfo = has('pdfinfo');
  if (!pdftotext) {
    if (requireBrowser) report(false, 'pdftotext missing (required when SMOKE_REQUIRE_BROWSER=1)');
    else console.log('NOTE  pdftotext missing: PDF text assertions skipped');
  }

  async function open(name, width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: true });
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.emulateMedia({ media: 'print' });
    const url = pathToFileURL(join(dir, `${name}.html`)).href;
    await page.goto(url);
    await page.waitForLoadState('load');
    return { page, ctx, requests, url };
  }
  const pdfPages = async (page, file) => {
    await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const info = pdfinfo ? execFileSync('pdfinfo', [file]).toString() : '';
    const text = pdftotext ? execFileSync('pdftotext', ['-layout', file, '-']).toString().split('\f').filter((p) => p.trim()) : [];
    return { info, pages: text };
  };

  // The block after a column-paginated table starts on a fresh page: no wide-table cell on its page, and it comes after the last column page.
  const newPageAfterSplit = (pages, label) => {
    const lastWide = pages.reduce((m, p, i) => (/v\d+_\d+/.test(p) ? i : m), -1);
    const next = pages.findIndex((p) => /Very long category name/.test(p));
    report(lastWide >= 0 && next > lastWide && !/v\d+_\d+/.test(pages[next]), `${label}: the block after the split table starts on a new page (last column page ${lastWide + 1}, next block page ${next + 1})`);
  };

  // --- paged (portrait, manual column groups, repeatCols 1)
  {
    const { page, ctx, requests, url } = await open('paged', PORTRAIT_PX);
    const external = requests.filter((u) => u !== url && !/^(data|about):/.test(u));
    report(external.length === 0, `no requests besides the document (${external.length} extra)`);
    const s = await page.evaluate(() => ({ scripts: document.querySelectorAll('script').length, pwned: window.__pwned, links: document.querySelectorAll('link,iframe,object,embed,[onerror],[onload],[onclick]').length, jsHref: document.querySelectorAll('a[href^="javascript:" i]').length, remote: document.querySelectorAll('[src^="http"],[href^="http"]').length }));
    report(s.scripts === 0 && s.pwned === undefined && s.links === 0 && s.jsHref === 0 && s.remote === 0, `no <script>/handlers/remote refs, payload not executed (${JSON.stringify(s)})`);
    const t = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table.grid')].filter((tb) => tb.querySelectorAll('thead th').length > 6);
      return {
        n: tables.length,
        serialFirst: tables.every((tb) => tb.querySelector('thead th:first-child')?.classList.contains('serial')),
        breaks: [...document.querySelectorAll('.cont.pg-break')].map((e) => getComputedStyle(e).breakBefore),
        repeated: tables.map((tb) => tb.querySelectorAll('thead th')[1]?.textContent),
        heads: tables.map((tb) => tb.querySelectorAll('thead th').length),
      };
    });
    report(t.n === 3, `3 column-group tables (got ${t.n})`);
    report(t.serialFirst, 'serial column is the first header cell of every group table');
    report(t.breaks.length === 2 && t.breaks.every((b) => b === 'page'), `page-break before groups 2 and 3 (${t.breaks})`);
    report(t.repeated[1] === 'col0' && t.repeated[2] === 'col0' && t.heads.join() === '11,12,12', `repeatCols=1 repeats col0 (${t.repeated}; header counts ${t.heads})`);
    const iv = await page.evaluate(() => {
      const els = [...document.body.children];
      const vars = els.filter((e) => e.classList.contains('in-var'));
      const idx = vars.map((e) => els.indexOf(e));
      return { texts: vars.map((e) => e.textContent), prev: idx.map((i) => els[i - 1]?.className), next: idx.map((i) => els[i + 1]?.className), bold: document.querySelectorAll('.in-var b,.in-var i').length, filters: document.querySelectorAll('.filters').length, brk: vars[0] ? getComputedStyle(vars[0]).breakAfter : '' };
    });
    report(iv.texts.length === 2 && iv.texts[0] === '城市<b>：上海 & <i>x</i>' && iv.texts[1] === 'empty：（未设置）' && iv.bold === 0 && iv.filters === 0, `input-variable lines escaped, in place, no aggregate (${JSON.stringify(iv.texts)})`);
    report(/md/.test(iv.prev[0]) && /tbl/.test(iv.next[0]) && /chart|tbl/.test(iv.prev[1]) && /tbl/.test(iv.next[1]) && iv.brk === 'avoid', `in-var lines sit between neighbours in DOM order, break-after: avoid (${iv.prev}|${iv.next}|${iv.brk})`);
    const ib = await page.evaluate(() => {
      const kids = [...document.body.children];
      const f = kids[kids.length - 1];
      const hr = kids[kids.length - 2];
      const lastSection = kids.filter((e) => e.tagName === 'SECTION').pop();
      return {
        footer: f?.className, hr: hr?.className, count: document.querySelectorAll('.export-info').length,
        rows: [...(f?.children ?? [])].map((e) => e.textContent),
        runs: [...document.querySelectorAll('.export-info li')].map((e) => e.textContent),
        before: !!lastSection && (lastSection.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        gap: (() => { const els = [...document.body.children]; const prev = els[els.length - 3]; const fs = parseFloat(getComputedStyle(document.body).fontSize); return prev ? hr.getBoundingClientRect().top - prev.getBoundingClientRect().bottom - 0 >= 2 * fs - 0.5 : false; })(),
        brk: f ? getComputedStyle(f).breakInside : '', bold: document.querySelectorAll('.export-info b').length,
      };
    });
    report(ib.footer === 'export-info' && ib.hr === 'info-sep' && ib.count === 1 && ib.before, `info block is the last element, after hr.info-sep and the last section (${ib.hr}|${ib.footer})`);
    report(ib.gap, 'hr.info-sep is at least 2em below the last body element');
    report(ib.rows.findIndex((r) => r.includes('生产数据库-主库')) < ib.rows.findIndex((r) => r.includes('导出备注')) && ib.rows.findIndex((r) => /^数据运行时间/.test(r)) < ib.rows.findIndex((r) => r.includes('导出备注')), 'info rows: data source before run times before note');
    report(ib.runs.length === 3 && /^#3 wide · /.test(ib.runs[0]) && /^#4 sales · /.test(ib.runs[1]) && /^#6 tr · /.test(ib.runs[2]), `run times: one per result block in block order, chart source once (${ib.runs})`);
    report(ib.rows.some((r) => r.includes('生产数据库-主库')) && ib.rows.some((r) => r.includes('导出备注 <b>x</b>\n第二行')) && ib.bold === 0 && ib.brk === 'avoid', 'info block: data source, escaped note with newline, break-inside: avoid');
    const nb = await page.evaluate(() => { const n = document.querySelector('section.tbl.split')?.nextElementSibling; return n ? getComputedStyle(n).breakBefore : null; });
    report(nb === 'page', `the element after the split table has break-before: page (${nb})`);
    const css = await page.evaluate(() => document.querySelector('style').textContent.match(/@page\{[^}]*\}/)?.[0] ?? '');
    report(/size:\s*A4 portrait/i.test(css), `@page is A4 portrait (${css})`);
    const file = join(dir, 'paged.pdf');
    const { info, pages } = await pdfPages(page, file);
    if (pdfinfo) report(/Page size:\s+59\d(\.\d+)? x 84\d/.test(info), 'PDF page size is A4 portrait');
    if (pdftotext) {
      const tablePages = pages.filter((p) => /v\d+_\d+/.test(p));
      report(tablePages.length >= 3 && tablePages.every((p) => p.includes('序号')), `every table page has the serial header 序号 (${tablePages.length} table pages)`);
      const later = pages.filter((p) => /v\d+_(1\d|2\d)\b/.test(p));
      report(later.length > 0 && later.every((p) => p.includes('col0')), `repeated column col0 present on all later-group pages (${later.length})`);
      report(pages.some((p) => p.includes('中文名1')) && pages.some((p) => p.includes('标题')), 'CJK text is extractable from the PDF');
      report(!pages.some((p) => p.includes('报告')), 'the notebook metadata.title (报告) is not printed in the PDF');
      newPageAfterSplit(pages, 'paged');
      const lastP = pages[pages.length - 1];
      const hasAll = (p) => p.includes('生产数据库-主库') && p.includes('导出备注') && p.includes('#4 sales');
      report(hasAll(lastP) && pages.filter(hasAll).length === 1 && pages.filter((p) => /导出时间/.test(p)).length === 1, 'info block is complete on the last page and appears exactly once (not split)');
    }
    await ctx.close();
  }

  // --- auto pagination (default): columns are grouped by content width, every group table fits the page, repeat col on every page
  {
    const { page, ctx } = await open('auto-repeat', PORTRAIT_PX);
    const a = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table.grid')].filter((tb) => tb.querySelectorAll('thead th').length > 4 && !tb.querySelector('th.rowname'));
      return {
        n: tables.length, over: tables.map((tb) => tb.scrollWidth - tb.clientWidth), root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        serialFirst: tables.every((tb) => tb.querySelector('thead th:first-child')?.classList.contains('serial')),
        repeated: tables.map((tb) => tb.querySelectorAll('thead th')[1]?.textContent),
        breaks: [...document.querySelectorAll('.cont.pg-break')].length,
        sizes: tables.map((tb) => tb.style.fontSize),
      };
    });
    report(a.n >= 2 && a.breaks === a.n - 1, `auto: 30 columns split into ${a.n} page-width groups with ${a.breaks} page breaks`);
    report(a.over.every((x) => x <= 0) && a.root <= 0, `auto: every group fits the page width (overflow ${a.over})`);
    report(a.serialFirst && a.repeated.every((x) => x === 'col0'), `auto: serial first and col0 repeated on every group (${a.repeated})`);
    report(a.sizes.every((x) => x === ''), 'auto: split tables are not font-shrunk');
    const file = join(dir, 'auto.pdf');
    const { pages } = await pdfPages(page, file);
    if (pdftotext) {
      report(pages.filter((p) => /v\d+_\d+/.test(p)).every((p) => p.includes('序号')), 'auto: PDF table pages carry the serial header');
      newPageAfterSplit(pages, 'auto');
    }
    await ctx.close();
  }

  // --- mixed-content tables (id, date, code, long description, amount): content-adaptive widths, nothing clipped
  {
    const { page, ctx } = await open('mixed', PORTRAIT_PX);
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const sections = [...document.querySelectorAll('section.tbl')];
      const body = document.body.getBoundingClientRect();
      return {
        root: root.scrollWidth - root.clientWidth,
        tables: sections.map((sec) => {
          const tb = sec.querySelector('table.grid');
          const w = {};
          for (const th of tb.querySelectorAll('thead th')) w[th.textContent] = th.getBoundingClientRect().width;
          const clipped = [...tb.querySelectorAll('th,td')].filter((c) => c.scrollWidth > c.clientWidth + 1).length;
          return { w, clipped, right: tb.getBoundingClientRect().right, name: sec.querySelector('h2')?.textContent, fixed: getComputedStyle(tb).tableLayout };
        }),
        bodyRight: body.right,
      };
    });
    report(m.tables.length === 2 && m.root <= 0, `mixed: two tables, no horizontal page scroll (${m.root})`);
    for (const t of m.tables) {
      report(t.fixed === 'auto' && t.right <= m.bodyRight + 1, `${t.name}: table-layout auto, right edge ${t.right.toFixed(1)} <= content edge ${m.bodyRight.toFixed(1)}`);
      report(t.clipped === 0, `${t.name}: no clipped cells`);
      const narrow = ['id', 'date', 'code', 'amount'].filter((k) => k in t.w);
      report(t.w.description > 0 && narrow.length >= 2 && narrow.every((k) => t.w[k] < t.w.description / 2), `${t.name}: narrow columns are measurably narrower than description (${JSON.stringify(Object.fromEntries(Object.entries(t.w).map(([k, v]) => [k, Math.round(v)])))})`);
    }
    await page.screenshot({ path: process.env.EXPORT_TABLES_PNG || join(dir, 'export-tables.png'), fullPage: true });
    console.log(`NOTE  screenshot ${process.env.EXPORT_TABLES_PNG || join(dir, 'export-tables.png')}`);
    await ctx.close();
  }

  // --- transposed export: name column replaces the serial column, #1..#N headers, NULL cells empty, escaped names
  {
    const { page, ctx } = await open('transposed', PORTRAIT_PX);
    const r = await page.evaluate(() => {
      const tb = [...document.querySelectorAll('table.grid')].find((x) => x.querySelector('th.rowname'));
      if (!tb) return null;
      return {
        heads: [...tb.querySelectorAll('thead th')].map((th) => th.textContent),
        serial: tb.querySelectorAll('.serial').length,
        names: [...tb.querySelectorAll('tbody td.rowname')].map((td) => td.textContent),
        nulls: tb.querySelectorAll('td.null').length,
        over: tb.scrollWidth - tb.clientWidth,
        injected: document.querySelectorAll('table.grid b').length,
      };
    });
    report(!!r && r.heads.join('|') === '#|#1|#2|#3' && r.serial === 0, `transposed: header # | #1 | #2 | #3, no serial column (${r && r.heads})`);
    report(!!r && r.names.join('|') === 'id|name <b>|amount' && r.injected === 0, `transposed: original column names label the rows, escaped (${r && r.names})`);
    report(!!r && r.nulls === 1 && r.over <= 0, 'transposed: NULL stays an empty cell and the table fits the page');
    if (pdftotext) {
      const { pages } = await pdfPages(page, join(dir, 'transposed.pdf'));
      report(pages.some((p) => p.includes('alpha') && p.includes('中文名') && p.includes('amount')), 'transposed: PDF text has names and values');
    }
    await ctx.close();
  }

  // --- fit (auto column groups) in both orientations: no horizontal overflow, chart fits the print width
  const groupCounts = {};
  for (const [name, w, tag] of [['fit-portrait', PORTRAIT_PX, 'A4 portrait'], ['fit-landscape', LANDSCAPE_PX, 'A4 landscape']]) {
    const { page, ctx } = await open(name, w);
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const tb = [...document.querySelectorAll('table.grid')].find((x) => x.querySelectorAll('thead th').length > 6);
      const svg = document.querySelector('.chart svg');
      const sr = svg?.getBoundingClientRect();
      const texts = svg ? [...svg.querySelectorAll('text')].map((t) => t.getBoundingClientRect()) : [];
      return {
        overflow: root.scrollWidth - root.clientWidth, tableOver: tb ? tb.scrollWidth - tb.clientWidth : -1, groups: [...document.querySelectorAll('table.grid')].filter((x) => x.querySelectorAll('thead th').length > 6).length,
        svgW: sr?.width ?? -1, bodyW: document.body.clientWidth, svgAttr: Number(svg?.getAttribute('width')),
        clipped: sr ? texts.filter((r) => r.right > sr.right + 1 || r.left < sr.left - 1).length : -1,
        css: document.querySelector('style').textContent.match(/@page\{[^}]*\}/)?.[0] ?? '',
      };
    });
    groupCounts[name] = m.groups;
    report(m.groups >= 1 && m.overflow <= 0 && m.tableOver <= 0, `${name}: wide table fits the page width (overflow ${m.overflow}/${m.tableOver})`);
    report(m.svgW > 0 && m.svgW <= m.bodyW && m.svgAttr <= m.bodyW && m.clipped === 0, `${name}: chart SVG ${m.svgW}px (attr ${m.svgAttr}) fits the ${m.bodyW}px content width, ${m.clipped} text(s) clipped`);
    report(m.css.includes(tag), `${name}: @page ${tag}`);
    if (pdfinfo) {
      const { info } = await pdfPages(page, join(dir, `${name}.pdf`));
      report(name.endsWith('landscape') ? /Page size:\s+84\d(\.\d+)? x 59\d/.test(info) : /Page size:\s+59\d(\.\d+)? x 84\d/.test(info), `${name}: PDF page size matches orientation`);
    }
    await ctx.close();
  }

  report(groupCounts['fit-landscape'] < groupCounts['fit-portrait'], `auto: landscape needs fewer page groups than portrait (${groupCounts['fit-landscape']} < ${groupCounts['fit-portrait']})`);

  // --- custom labels (all override kinds) in HTML, SVG and the real PDF text layer
  {
    const { page, ctx } = await open('labels', PORTRAIT_PX);
    const m = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('table.pivot th')].map((e) => e.textContent);
      const tds = [...document.querySelectorAll('table.pivot td')].map((e) => e.textContent);
      const body = [...document.querySelectorAll('table.pivot tbody tr')].map((r) => r.querySelector('th')?.textContent);
      const texts = [...document.querySelectorAll('section.chart svg text')].map((e) => e.textContent);
      return {
        ths, tds, body, texts, pwned: window.__pwned,
        bTags: document.querySelectorAll('table.pivot b, section.chart b, table.pivot img, section.chart img').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        html: document.body.innerText,
      };
    });
    const has = (a, x) => a.some((t) => t === x || (t ?? '').includes(x));
    report(has(m.ths, '是否 VIP') && has(m.ths, '销售额') && has(m.ths, '合计') && has(m.ths, '渠道'.slice(0, 0) + '线上 <img'), `labels: custom row/measure/summary/column headers rendered as text (${JSON.stringify(m.ths.slice(0, 4))})`);
    report(m.body.join(',') === '是,否,未知,合计', `labels: mapped categories and sort by RAW value desc (${m.body.join(',')})`);
    report(m.tds.includes('1,234.57万元') && m.tds.includes('5,000.00万元'), 'labels: scaled values with unit');
    report(!/sum\(amt\)|\bvip\b/.test(m.ths.join('|')) && !m.texts.some((t) => /^(vip|ch|amt)$/.test(t)), 'labels: auto names absent from table headers and chart text');
    report(['季度销售 <b>报告</b>', '会员类型', '金额（自定义）', '渠道名称', '否', '是', '未知'].every((x) => has(m.texts, x)), `labels: chart title/axis/legend/ticks (${m.texts.filter(Boolean).slice(0, 6).join(' ')}…)`);
    report(m.bTags === 0 && m.pwned === undefined, 'labels: hostile markup stays text, nothing executed');
    report(m.overflow <= 0, `labels: no horizontal overflow (${m.overflow})`);
    await page.screenshot({ path: join(dir, 'export-labels.png'), fullPage: true });
    console.log(`INFO  screenshot ${join(dir, 'export-labels.png')}`);
    if (pdfinfo && pdftotext) {
      const { pages } = await pdfPages(page, join(dir, 'labels.pdf'));
      const all = pages.join('\n');
      report(/合计/.test(all) && /万元/.test(all) && /是否/.test(all) && /1,234\.57万元/.test(all) && !/sum\(amt\)/.test(all), 'labels: PDF text layer has custom summary/unit/header and no auto names');
    }
    await ctx.close();
  }

  // --- optional: real sidecar
  if (process.env.SMOKE_SIDECAR) {
    const out = join(dir, 'sidecar.pdf');
    const html = readFileSync(join(dir, 'paged.html'), 'utf8');
    const dataDir = mkdtempSync(join(tmpdir(), 'export-data-'));
    const child = spawn(process.env.SMOKE_SIDECAR, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = ''; const waiters = new Map(); let id = 0;
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch { /* not json */ } } });
    const rpc = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
    const st = await rpc('export/pdfStart', { html, path: out, orientation: 'portrait' });
    let s = { state: 'running' };
    for (let n = 0; n < 240 && s.state === 'running'; n++) { await new Promise((r) => setTimeout(r, 500)); s = (await rpc('export/pdfStatus', { jobId: st.result?.jobId })).result ?? s; }
    report(s.state === 'done' && existsSync(out) && readFileSync(out).subarray(0, 5).toString() === '%PDF-', `sidecar PDF job finished (${s.state})`);
    child.kill();
    report(!readdirSync(dataDir).some((f) => f.startsWith('export-profile-')), 'no export-profile-* left after the job');
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 600 } });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(join(dir, 'mdwide.html')).href);
    const m = await page.evaluate(() => { const el = document.querySelector('.md-view'); return { sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }; });
    report(m.sw > m.cw && m.ox === 'auto', `markdown wide table scrolls in preview (scrollWidth ${m.sw} > clientWidth ${m.cw}, overflow-x ${m.ox})`);
    await ctx.close();
  }

  await browser.close();
  return failed ? 1 : 0;
}

main().then((c) => process.exit(c), async (e) => { console.error(e); try { await browser?.close(); } catch { /* ignore */ } process.exit(1); });
