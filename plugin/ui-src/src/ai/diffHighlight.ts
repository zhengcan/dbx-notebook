import { highlightSql } from '../editor/sqlHighlight'

// Above this many diff lines, highlighting is skipped (plain escaped text) to keep large diffs responsive.
export const DIFF_HIGHLIGHT_MAX_LINES = 600

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const MAX_LINE_CHARS = 2000

// Each line is tokenised on its own: multi-line block comments / strings may be coloured imprecisely.
export function makeLineHighlighter(enabled: boolean): (text: string) => string {
  if (!enabled) return esc
  const memo = new Map<string, string>()
  return (text) => {
    let h = memo.get(text)
    if (h === undefined) { h = highlightSql(text, { maxChars: MAX_LINE_CHARS }); memo.set(text, h) }
    return h
  }
}
