import type { BigNumberCompare } from '../analysis/analysisState'
import type { ExportModel, TableSection, PivotSection, Section } from './model'
import type { ExportOptions } from './options'
import { printCss } from './printCss'
import { renderMarkdownSafe } from './markdown'
import { textUnits } from './autoBreaks'
import { highlightCode } from './codeHighlight'

export { renderMarkdownSafe }

export interface ChartSvg { svg: string | null; error?: string }
export interface ExportLabels {
  firstN(n: number, m: number): string
  truncatedAtRun(k: number): string
  empty: string; exportedAt: string; dataRunAt: string; dataSource: string
  chartUnavailable: string; noData: string; page: string; serial: string
  summary: string; notSet: string; continued: string; colon: string; listSep: string; compare?: (c: BigNumberCompare) => string
  exporter: string
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function fitFont(columns: number): number {
  return columns <= 8 ? 100 : Math.max(60, 100 - (columns - 8) * 2)
}

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'clippath', 'lineargradient', 'radialgradient', 'stop', 'use', 'image', 'title', 'desc', 'mask', 'pattern', 'symbol', 'marker'])
const isHref = (n: string) => n === 'href' || n === 'xlink:href'

function cleanSvgNode(el: Element) {
  for (const child of Array.from(el.children)) {
    if (!SVG_ELEMENTS.has(child.localName.toLowerCase())) { child.remove(); continue }
    cleanSvgNode(child)
  }
  const tag = el.localName.toLowerCase()
  for (const a of Array.from(el.attributes)) {
    const n = a.name.toLowerCase()
    const v = a.value
    if (n.startsWith('on')) el.removeAttribute(a.name)
    else if (isHref(n)) {
      const ok = tag === 'image' ? /^data:image\//i.test(v) : v.startsWith('#')
      if (!ok) el.removeAttribute(a.name)
    } else if (/javascript:|@import|expression\(|url\(\s*['"]?(?!#)/i.test(v)) el.removeAttribute(a.name)
  }
  if (tag === 'image' && !el.hasAttribute('href') && !el.hasAttribute('xlink:href')) el.remove()
}

export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.localName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return ''
  cleanSvgNode(root)
  return new XMLSerializer().serializeToString(root)
}

const e = escapeHtml

export const NOWRAP_MAX = 24
const NOWRAP_BUDGET = 100

export function columnWrapClass(values: string[], header: string, kind: 'num' | 'text' | 'date' | 'bool'): '' | 'nw' {
  if (kind !== 'text') return 'nw'
  const longest = Math.max(textUnits(header), ...values.map((v) => textUnits(v ?? '')))
  return longest <= NOWRAP_MAX ? 'nw' : ''
}

function renderTable(s: TableSection, o: ExportOptions, L: ExportLabels): string {
  const split = s.groups.length > 1
  const out: string[] = []
  if (s.title) out.push(`<h2>${e(s.title)}</h2>`)
  if (s.sql !== undefined) out.push(`<pre class="sql">${highlightCode(s.sql, 'sql')}</pre>`)
  if (s.rows.length === 0) {
    out.push(`<p class="empty">${e(L.noData)}</p>`)
  } else {
    const tr = s.transposed === true && !!s.rowNames
    const serialCh = tr
      ? Math.min(24, Math.max(4, ...s.rowNames!.map((n) => textUnits(n))))
      : Math.max(3, String(s.rows.length).length + 1)
    const style = ` style="--${tr ? 'name' : 'serial'}:${serialCh}ch${split ? '' : `;font-size:${fitFont(s.columns.length)}%`}"`
    s.groups.forEach((g, gi) => {
      let cols = g.cols
      const rep = s.repeat ?? o.repeatCols
      if (rep > 0) {
        const pre = Array.from({ length: Math.min(rep, s.columns.length) }, (_, i) => i).filter((i) => !g.cols.includes(i))
        cols = [...pre, ...g.cols]
      }
      const wrap = new Map<number, string>()
      let used = 0
      const widths = new Map<number, number>()
      for (const c of cols) {
        const vals = s.rows.map((row, ri) => (s.nullMask[ri]?.[c] ? '' : row[c] ?? ''))
        const w = Math.max(textUnits(s.columns[c]), ...vals.map((v) => textUnits(v)))
        widths.set(c, w)
        const nw = columnWrapClass(vals, s.columns[c], s.numeric[c] ? 'num' : 'text') === 'nw'
        wrap.set(c, nw ? ' nw' : '')
        if (nw) used += w + 2
      }
      for (const c of [...cols].sort((a, b) => widths.get(b)! - widths.get(a)!)) {
        if (used <= NOWRAP_BUDGET) break
        if (!s.numeric[c] && wrap.get(c)) { wrap.set(c, ''); used -= widths.get(c)! + 2 }
      }
      const cls = (c: number) => `${s.numeric[c] ? 'num' : 'txt'}${wrap.get(c) ?? ''}`
      const th = cols.map((c) => `<th class="${cls(c)}">${e(s.columns[c])}</th>`).join('')
      const body = s.rows.map((row, ri) => {
        const tds = cols.map((c) => (s.nullMask[ri]?.[c]
          ? '<td class="null"></td>'
          : `<td class="${cls(c)}">${e(row[c] ?? '')}</td>`)).join('')
        return `<tr>${tr ? `<td class="rowname">${e(s.rowNames![ri] ?? '')}</td>` : `<td class="serial">${ri + 1}</td>`}${tds}</tr>`
      }).join('')
      if (gi > 0) out.push(`<p class="cont pg-break">${e(s.title ? `${s.title} (${L.continued})` : L.continued)}</p>`)
      out.push(`<table class="grid"${style}><thead><tr>${tr ? '<th class="rowname">#</th>' : `<th class="serial">${e(L.serial)}</th>`}${th}</tr></thead><tbody>${body}</tbody></table>`)
    })
  }
  if (s.limitedNote === 'first-n') out.push(`<p class="note-after">${e(L.firstN(s.shownRows, s.totalRows))}</p>`)
  else if (s.limitedNote === 'truncated-at-run') out.push(`<p class="note-after">${e(L.truncatedAtRun(s.shownRows))}</p>`)
  return `<section class="tbl${split && s.rows.length > 0 ? ' split' : ''}">${out.join('')}</section>`
}

function renderPivot(s: PivotSection, L: ExportLabels): string {
  const m = s.model
  if (!m.rowLabels.length) return ''
  const levels = m.columnHeaders[0]?.length ?? 1
  const rh = Math.max(1, m.rowHeaders.length)
  const hasRowTot = !!m.rowTotals
  const head: string[] = []
  const span = (n: number) => (n > 1 ? ` colspan="${n}"` : '')
  const nm = Math.max(1, m.measures.length)
  for (let l = 0; l < levels; l++) {
    const last = l === levels - 1
    const lead = last ? m.rowHeaders.map((h) => `<th>${e(h)}</th>`).join('') : `<th${span(rh)}></th>`
    let mid = ''
    if (last) mid = m.columnHeaders.map((h) => `<th>${e(h[l] ?? '')}</th>`).join('')
    else {
      const key = (h: string[]) => JSON.stringify(h.slice(0, l + 1))
      for (let i = 0; i < m.columnHeaders.length;) {
        let j = i + 1
        while (j < m.columnHeaders.length && key(m.columnHeaders[j]) === key(m.columnHeaders[i])) j++
        mid += `<th${span(j - i)}>${e(m.columnHeaders[i][l] ?? '')}</th>`
        i = j
      }
    }
    const tail = !hasRowTot ? '' : last ? m.measures.map((x) => `<th>${e(x)}</th>`).join('') : `<th${span(nm)}></th>`
    head.push(`<tr>${lead}${mid}${tail}</tr>`)
  }
  const rows = m.cells.map((cs, i) => {
    const lab = m.rowLabels[i].map((x) => `<th>${e(x)}</th>`).join('')
    const vals = cs.map((v) => `<td class="num">${e(v)}</td>`).join('')
    const tot = m.rowTotals ? m.rowTotals[i].map((v) => `<td class="num">${e(v)}</td>`).join('') : ''
    return `<tr>${lab}${vals}${tot}</tr>`
  })
  if (m.columnTotals) {
    const tot = m.rowTotals ? (m.grandTotal ?? m.measures.map(() => '')).map((v) => `<td class="num">${e(v)}</td>`).join('') : ''
    rows.push(`<tr><th${span(rh)}>${e(m.summaryLabel ?? L.summary)}</th>${m.columnTotals.map((v) => `<td class="num">${e(v)}</td>`).join('')}${tot}</tr>`)
  }
  const cap = s.title ? `<caption>${e(s.title)}</caption>` : ''
  return `<section><table class="pivot">${cap}<thead>${head.join('')}</thead><tbody>${rows.join('')}</tbody></table></section>`
}

function renderSection(s: Section, o: ExportOptions, charts: Record<string, ChartSvg>, L: ExportLabels, captioned: Set<string>): string {
  switch (s.kind) {
    case 'input': return `<p class="in-var">${e(s.name + L.colon + (s.text || L.notSet))}</p>`
    case 'markdown': return `<section class="md">${s.html ?? renderMarkdownSafe(s.source, { highlightCode: true })}</section>`
    case 'table': return renderTable(s, o, L)
    case 'pivot': return renderPivot(s, L)
    case 'big-number':
      return `<section class="big-number">${s.items.map((i) => `<div class="bn"><div class="v">${e(i.text)}</div><div class="l" title="${e(i.label)}">${e(i.label)}</div>${i.compare ? `<div class="c">${e(i.compare)}</div>` : ''}</div>`).join('')}</section>`
    case 'chart': {
      const c = charts[s.blockId]
      const svg = c?.svg ? sanitizeSvg(c.svg) : ''
      // The rendered svg carries the chart's own title; the table caption (pivot section) carries the other one.
      const title = !svg && s.title && !captioned.has(s.blockId) ? `<h2>${e(s.title)}</h2>` : ''
      return `<section class="chart">${title}${svg || `<p class="empty">${e(L.chartUnavailable)}</p>`}</section>`
    }
  }
}

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function renderExportHtml(model: ExportModel, options: ExportOptions, charts: Record<string, ChartSvg>, labels: ExportLabels, extra: { imageNote?: string } = {}): string {
  const info: string[] = []
  if (model.exporter) info.push(`<p class="meta">${e(labels.exporter + labels.colon)}${e(model.exporter)}</p>`)
  if (options.header.exportedAt) info.push(`<p class="meta">${e(labels.exportedAt + labels.colon)}${e(fmtTime(model.exportedAt))}</p>`)
  if (options.header.dataSource && model.dataSources.length) info.push(`<p class="meta">${e(labels.dataSource + labels.colon)}${e(model.dataSources.join(', '))}</p>`)
  if (options.header.dataRunAt && model.runTimes.length) {
    const lis = model.runTimes.map((r) => `<li>${e(`#${r.index} ${r.name} · ${fmtTime(r.at)}`)}</li>`).join('')
    info.push(`<div><p class="meta">${e(labels.dataRunAt + labels.colon)}</p><ul class="meta">${lis}</ul></div>`)
  }
  if (model.note) info.push(`<div class="note">${e(model.note)}</div>`)
  if (extra.imageNote) info.push(`<div class="note">${e(extra.imageNote)}</div>`)
  const tail = info.length ? `\n<hr class="info-sep"><footer class="export-info">${info.join('\n')}</footer>` : ''
  const captioned = new Set(model.sections.filter((s) => s.kind === 'pivot' && s.title).map((s) => s.blockId))
  const body = model.sections.map((s) => renderSection(s, options, charts, labels, captioned)).join('\n')
  const css = printCss({ orientation: options.orientation }).replace(/<\/style/gi, '<\\/style')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${e(model.documentTitle)}</title><style>${css}</style></head><body>
${body}${tail}
</body></html>`
}
