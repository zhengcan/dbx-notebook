import { cellText } from './format'

const CHAR_PX = 8
const PAD_PX = 24

export function clampWidth(w: number): number {
  return Math.max(48, Math.min(800, w))
}

export function initialWidths(columns: { name: string }[], rows: unknown[][]): number[] {
  const sample = rows.slice(0, 50)
  return columns.map((col, i) => {
    let len = String(col?.name ?? '').length
    for (const row of sample) len = Math.max(len, cellText(Array.isArray(row) ? row[i] : null).length)
    return Math.max(80, Math.min(320, len * CHAR_PX + PAD_PX))
  })
}

export const TRANSPOSED_MIN_COL = 320

// Interpretation of the requested rule ("if minWidth*cols > total visible width then total/cols, otherwise the min width"):
// taken literally that would shrink columns below the minimum when there are many of them, so each data column is
// max(min, available / n): they share the free width equally when 320*n fits, else stay at 320 and the table scrolls.
export function transposedColWidth(containerWidth: number | undefined, nameWidth: number, n: number, min = TRANSPOSED_MIN_COL): number {
  if (!containerWidth || !Number.isFinite(containerWidth) || n < 1) return min
  const available = containerWidth - nameWidth
  if (!(available > 0)) return min
  return Math.max(min, Math.floor(available / n))
}
