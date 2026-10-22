export interface PreviewSize { width: number; height: number; scroll: boolean }

export const MAX_BARS = 200
const SCROLL_ABOVE = 520

export function previewSize(c: { type: string; categories: number; series: number; hasLegend: boolean; hasTitle: boolean }, avail: { width: number }): PreviewSize {
  const width = avail.width
  if (c.type === 'barHorizontal') {
    const cats = Math.min(Math.max(0, c.categories), MAX_BARS)
    const height = Math.max(260, cats * 24 + 90)
    return { width, height, scroll: height > SCROLL_ABOVE }
  }
  const height = 340 + (c.hasLegend ? 20 : 0) + (c.hasTitle ? 20 : 0)
  return { width, height, scroll: false }
}

export const MIN_DRAW_WIDTH = 160
export const AXIS_RESERVE = 4
export const LEGEND_RESERVE = 8
export const LABEL_FRACTION = 0.55

// Total SVG width for the large preview: with autosize fit/padding the axes and legend are laid out inside it,
// the reserves only keep a safety margin so sub-pixel rounding never overflows the container.
export function chartDrawWidth(containerWidth: number, c: { type: string; hasLegend: boolean }): number {
  return Math.max(MIN_DRAW_WIDTH, Math.floor(containerWidth - AXIS_RESERVE - (c.hasLegend ? LEGEND_RESERVE : 0)))
}

// Category labels are shrunk (never below 8px) so labels up to the cap stay complete; longer ones are truncated by vega at the cap.
export function labelFontSize(cap: number, longest: number): number {
  if (longest <= 0) return 10
  return Math.max(8, Math.min(10, Math.floor(cap / (longest * 0.65))))
}

const TITLE_CHAR_PX = 8
const FULL_WIDTH = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/
// Full-width (CJK, kana, hangul, full-width forms) glyphs are about twice as wide as Latin ones.
export const textUnits = (s: string): number => { let n = 0; for (const ch of s) n += FULL_WIDTH.test(ch) || (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1; return n }

// Vega truncates a long title with an ellipsis: wrap it on spaces (then hard-split) into lines that fit the width.
export function wrapTitle(text: string, width: number): string[] | string {
  const per = Math.max(8, Math.floor(width / TITLE_CHAR_PX))
  if (textUnits(text) <= per) return text
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/)) {
    let w = word
    while (textUnits(w) > per) {
      if (cur) { lines.push(cur); cur = '' }
      let cut = '', u = 0
      for (const ch of w) { const k = textUnits(ch); if (u + k > per) break; cut += ch; u += k }
      if (!cut) cut = [...w][0]
      lines.push(cut)
      w = w.slice(cut.length)
    }
    if (!w) continue
    if (!cur) cur = w
    else if (textUnits(cur) + 1 + textUnits(w) <= per) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : text.trim() || ' '
}
