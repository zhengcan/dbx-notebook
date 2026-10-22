export type Sel = { r0: number; c0: number; r1: number; c1: number } | null

export function normalize(s: Sel): Sel {
  if (!s) return null
  return { r0: Math.min(s.r0, s.r1), c0: Math.min(s.c0, s.c1), r1: Math.max(s.r0, s.r1), c1: Math.max(s.c0, s.c1) }
}

export function selectCell(r: number, c: number): Sel {
  return { r0: r, c0: c, r1: r, c1: c }
}

export function extendTo(sel: Sel, r: number, c: number): Sel {
  if (!sel) return selectCell(r, c)
  return { r0: sel.r0, c0: sel.c0, r1: r, c1: c }
}

export function selectRow(r: number, nCols: number): Sel {
  if (!(nCols > 0)) return null
  return { r0: r, c0: 0, r1: r, c1: nCols - 1 }
}

export function selectColumn(c: number, nRows: number): Sel {
  if (!(nRows > 0)) return null
  return { r0: 0, c0: c, r1: nRows - 1, c1: c }
}

export function selectAll(nRows: number, nCols: number): Sel {
  if (nRows <= 0 || nCols <= 0) return null
  return { r0: 0, c0: 0, r1: nRows - 1, c1: nCols - 1 }
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n))

export function move(sel: Sel, dr: number, dc: number, nRows: number, nCols: number, extend: boolean): Sel {
  if (nRows <= 0 || nCols <= 0) return null
  if (!sel) return selectCell(0, 0)
  const d = (n: number) => (Number.isFinite(n) ? n : 0)
  const r = clamp(sel.r1 + d(dr), nRows - 1)
  const c = clamp(sel.c1 + d(dc), nCols - 1)
  if (!extend) return selectCell(r, c)
  return { r0: clamp(sel.r0, nRows - 1), c0: clamp(sel.c0, nCols - 1), r1: r, c1: c }
}
