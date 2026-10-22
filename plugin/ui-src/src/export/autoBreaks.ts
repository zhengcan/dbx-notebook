import type { Orientation } from './options'

// A4 minus the 12mm @page side margins, at 96 dpi (see printCss).
const MM_PX = 96 / 25.4
export const contentWidthPx = (o: Orientation) => Math.floor(((o === 'landscape' ? 297 : 210) - 24) * MM_PX)

export const CHAR_PX = 7.5
export const PAGE_PAD_PX = 14
export const MAX_UNITS = 40
const MIN_UNITS = 2

// One unit is an ASCII character; CJK / full-width characters take two.
export const textUnits = (s: string) => Array.from(s).reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0)

const widthPx = (units: number) => PAGE_PAD_PX + CHAR_PX * Math.min(MAX_UNITS, Math.max(MIN_UNITS, units))

export type LeadingColumn = { kind: 'serial'; rowCount: number } | { kind: 'name'; names: string[] }

export interface AutoBreakInput {
  columns: string[]
  rows: string[][]
  orientation: Orientation
  repeatCols: number
  leading: LeadingColumn
}

function layout(input: AutoBreakInput) {
  const n = input.columns.length
  const w = input.columns.map((h, c) => {
    let u = textUnits(h)
    for (const row of input.rows) { const t = row[c]; if (t) u = Math.max(u, Math.min(MAX_UNITS, textUnits(t))); if (u >= MAX_UNITS) break }
    return widthPx(u)
  })
  const lead = input.leading.kind === 'serial'
    ? widthPx(Math.max(3, String(input.leading.rowCount).length + 1))
    : widthPx(Math.min(24, Math.max(4, ...input.leading.names.map(textUnits))))
  const avail = contentWidthPx(input.orientation) - lead
  const fits = w.reduce((a, b) => a + b, 0) <= avail
  const wanted = Math.min(Math.max(0, Math.trunc(input.repeatCols) || 0), Math.max(0, n - 1))
  const repW = w.slice(0, wanted).reduce((a, b) => a + b, 0)
  return { n, w, avail, fits, wanted, repW }
}

// How many leading columns are really repeated on every page: never all columns, and none when they would leave too little room.
export function effectiveRepeat(input: AutoBreakInput): number {
  const l = layout(input)
  if (l.fits) return l.wanted
  return l.repW <= l.avail * 0.6 ? l.wanted : 0
}

// Returns break positions in the same format as manual breaks: a page ends after each returned column index.
export function autoColumnBreaks(input: AutoBreakInput): number[] {
  const l = layout(input)
  if (l.n <= 1 || l.fits) return []
  const { n, w, avail } = l
  const rep = effectiveRepeat(input)
  const breaks: number[] = []
  let start = 0
  while (start < n) {
    let used = w.slice(0, Math.min(rep, start)).reduce((a, b) => a + b, 0)
    let end = start
    used += w[start]
    while (end + 1 < n && used + w[end + 1] <= avail) { end++; used += w[end] }
    if (end < n - 1) breaks.push(end)
    start = end + 1
  }
  return breaks
}
