export interface Relocated { from: number; to: number; exact: boolean }

/**
 * Maps a range captured on `base` onto `current` (the text after the user kept typing) by prefix/suffix matching.
 * Edits strictly before or after the range are followed; an edit overlapping it falls back to the caret (or the end).
 */
export function relocateRange(base: string, range: { from: number; to: number }, current: string, caret?: number): Relocated {
  if (base === current) return { ...range, exact: true }
  let p = 0
  const max = Math.min(base.length, current.length)
  while (p < max && base[p] === current[p]) p++
  let s = 0
  while (s < max - p && base[base.length - 1 - s] === current[current.length - 1 - s]) s++
  if (range.to <= p) return { ...range, exact: true }
  if (range.from >= base.length - s) {
    const d = current.length - base.length
    return { from: range.from + d, to: range.to + d, exact: true }
  }
  const at = Math.max(0, Math.min(caret ?? current.length, current.length))
  return { from: at, to: at, exact: false }
}
