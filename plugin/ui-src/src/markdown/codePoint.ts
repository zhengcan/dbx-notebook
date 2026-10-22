const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff

/** True when `off` lies between the two halves of a surrogate pair. */
export function insideSurrogatePair(text: string, off: number): boolean {
  return off > 0 && off < text.length && isHigh(text.charCodeAt(off - 1)) && isLow(text.charCodeAt(off))
}

/** Clamps `off` into the text and moves it to the code point boundary before the pair it falls in the middle of. */
export function alignDown(text: string, off: number): number {
  const o = Math.max(0, Math.min(off, text.length))
  return insideSurrogatePair(text, o) ? o - 1 : o
}

/** Same, but moves to the boundary after the pair (used for the end of a selection). */
export function alignUp(text: string, off: number): number {
  const o = Math.max(0, Math.min(off, text.length))
  return insideSurrogatePair(text, o) ? o + 1 : o
}
