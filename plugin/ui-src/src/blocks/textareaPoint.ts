// Character offset in a textarea closest to a viewport point, measured with a hidden mirror element
// (caretPositionFromPoint does not report text-control offsets reliably).
const COPY = ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const

export function pointOffset(el: HTMLTextAreaElement, x: number, y: number): number | null {
  if (typeof document === 'undefined') return null
  const box = el.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  const cs = getComputedStyle(el)
  const m = document.createElement('div')
  for (const k of COPY) (m.style as unknown as Record<string, string>)[k] = cs[k]
  Object.assign(m.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top - el.scrollTop}px`, visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', pointerEvents: 'none' })
  const text = el.value
  const node = document.createTextNode(text)
  m.appendChild(node)
  document.body.appendChild(m)
  try {
    const range = document.createRange()
    const at = (i: number) => { range.setStart(node, i); range.setEnd(node, i); return range.getBoundingClientRect() }
    let lo = 0, hi = text.length
    // Find the first offset whose caret is below the point's line, then the first on that line at or past x.
    const lineOf = (i: number) => { const r = at(i); return { top: r.top, bottom: r.bottom, left: r.left } }
    const sameOrAfterLine = (i: number) => lineOf(i).bottom > y
    if (!text) return 0
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sameOrAfterLine(mid)) hi = mid; else lo = mid + 1 }
    const start = lo
    const line = lineOf(start)
    let end = start
    while (end < text.length && text[end] !== '\n' && lineOf(end + 1).top === line.top) end++
    let best = start
    for (let i = start; i <= end; i++) {
      if (lineOf(i).left <= x) best = i
      else break
    }
    return best
  } finally {
    m.remove()
  }
}
