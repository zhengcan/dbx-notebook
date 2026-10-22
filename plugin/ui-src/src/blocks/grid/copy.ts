import { cellText } from './format'
import { normalize, type Sel } from './selection'

export function escapeTsvCell(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toTsv(rows: unknown[][], sel: Sel, opts?: { withHeader?: string[]; rowLabels?: string[] }): string {
  const n = normalize(sel)
  if (!n || !rows.length) return ''
  const hdr = opts?.withHeader
  let width = hdr ? hdr.length : 0
  for (const row of rows) if (Array.isArray(row) && row.length > width) width = row.length
  const cMax = Math.min(n.c1, width - 1)
  const c0 = Math.max(0, n.c0)
  const rMax = Math.min(n.r1, rows.length - 1)
  const lines: string[] = []
  const labels = opts?.rowLabels
  if (hdr) lines.push([...(labels ? [''] : []), ...hdr.slice(c0, cMax + 1).map((h) => escapeTsvCell(String(h)))].join('\t'))
  for (let r = Math.max(0, n.r0); r <= rMax; r++) {
    const cells: string[] = labels ? [escapeTsvCell(labels[r] ?? '')] : []
    for (let c = c0; c <= cMax; c++) cells.push(escapeTsvCell(cellText(rows[r]?.[c])))
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}
