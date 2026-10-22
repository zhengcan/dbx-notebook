import { alignDown, alignUp } from './codePoint'

// Behaviour notes:
// - Removing a fenced code block (toggle) drops the whole fence line, including its language (```sql).
// - Bold/italic over a selection: markers inside the selection are paired by scanning unescaped runs of `*`.
//   * the selection is exactly one wrapped segment -> unwrap it;
//   * several (>= 4 bold markers) or an odd number of markers -> remove all markers inside (cancel bold/italic);
//   * exactly one segment that does not fill the selection -> remove its markers and wrap the whole selection once.
//   An adjacent marker on only one side is removed when it has no partner in its paragraph (an unclosed marker).

export type MdAction = 'heading' | 'bold' | 'italic' | 'code' | 'codeBlock' | 'link' | 'quote' | 'ul' | 'ol' | 'table'

export interface Sel {
  from: number
  to: number
}

export interface Placeholders {
  bold: string
  italic: string
  code: string
  linkText: string
  linkUrl: string
  cell: string
  /** Header cells of the table template; default 列1 / 列2. */
  col1?: string
  col2?: string
}

export interface ApplyOptions {
  eol?: '\n' | '\r\n'
  placeholders?: Placeholders
}

export interface ApplyResult extends Sel {
  text: string
}

const DEFAULT_PLACEHOLDERS: Placeholders = {
  bold: '粗体文字',
  italic: '斜体文字',
  code: '代码',
  linkText: '链接文字',
  linkUrl: 'https://',
  cell: '值',
  col1: '列1',
  col2: '列2',
}

interface Edit {
  start: number
  oldLen: number
  insert: string
}

export function applyMarkdownAction(text: string, sel: Sel, action: MdAction, opts: ApplyOptions = {}): ApplyResult {
  const eol = opts.eol ?? (text.includes('\r\n') ? '\r\n' : '\n')
  const ph = { ...DEFAULT_PLACEHOLDERS, ...opts.placeholders }
  const [from, to] = normalize(text, sel)
  const r = dispatch(text, from, to, action, eol, ph)
  const len = r.text.length
  const f = Math.max(0, Math.min(len, r.from))
  return { text: r.text, from: f, to: Math.max(f, Math.min(len, r.to)) }
}

function dispatch(text: string, from: number, to: number, action: MdAction, eol: string, ph: Placeholders): ApplyResult {
  switch (action) {
    case 'bold':
      return inlineStars(text, from, to, 2, ph.bold)
    case 'italic':
      return inlineStars(text, from, to, 1, ph.italic)
    case 'code':
      return inlineCode(text, from, to, ph.code)
    case 'heading':
      return heading(text, from, to)
    case 'quote':
    case 'ul':
    case 'ol':
      return prefixLines(text, from, to, action)
    case 'codeBlock':
      return codeBlock(text, from, to, eol)
    case 'link':
      return link(text, from, to, ph)
    case 'table':
      return table(text, from, to, eol, ph)
  }
}

/** The range of `after` outside the common prefix and suffix with `before`, aligned to code points. */
export function changedSpan(before: string, after: string): Sel {
  if (before === after) return { from: after.length, to: after.length }
  const max = Math.min(before.length, after.length)
  let p = 0
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++
  let s = 0
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++
  return { from: alignDown(after, p), to: alignUp(after, after.length - s) }
}

function normalize(text: string, sel: Sel): [number, number] {
  const num = (n: number) => (Number.isFinite(n) ? Math.trunc(n) : 0)
  let a = Math.max(0, Math.min(text.length, num(sel.from)))
  let b = Math.max(0, Math.min(text.length, num(sel.to)))
  if (a > b) [a, b] = [b, a]
  a = alignDown(text, a)
  b = alignUp(text, b)
  const inCrlf = (i: number) => i > 0 && text[i - 1] === '\r' && text[i] === '\n'
  const collapsed = a === b
  if (inCrlf(a)) a -= 1
  if (inCrlf(b)) b = collapsed ? b - 1 : b + 1
  return [a, b]
}

const result = (text: string, from: number, to: number): ApplyResult => ({ text, from, to })
const splice = (text: string, from: number, to: number, ins: string) => text.slice(0, from) + ins + text.slice(to)

function lineStart(text: string, i: number): number {
  return i <= 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1
}
function lineEnd(text: string, i: number): number {
  const k = text.indexOf('\n', i)
  return k < 0 ? text.length : k
}
function contentEnd(text: string, ls: number, le: number): number {
  return le > ls && text[le - 1] === '\r' ? le - 1 : le
}

// ---- inline ---------------------------------------------------------------

function isEscaped(text: string, i: number): boolean {
  let n = 0
  while (i - 1 - n >= 0 && text[i - 1 - n] === '\\') n++
  return n % 2 === 1
}

/** Unescaped `*` markers that end exactly at `pos`, never reaching below `lo`. */
function starsBefore(text: string, pos: number, lo: number): number {
  let n = 0
  while (pos - n - 1 >= lo && text[pos - n - 1] === '*') n++
  if (n > 0 && isEscaped(text, pos - n)) n -= 1
  return n
}
/** Unescaped `*` markers that begin exactly at `pos`, never reaching above `hi`. */
function starsAfter(text: string, pos: number, hi: number): number {
  if (isEscaped(text, pos)) return 0
  let n = 0
  while (pos + n < hi && text[pos + n] === '*') n++
  return n
}

function trimRange(text: string, from: number, to: number): [number, number] {
  let a = from
  let b = to
  while (a < b && /\s/.test(text[a])) a++
  while (b > a && /\s/.test(text[b - 1])) b--
  return a === b ? [from, from] : [a, b]
}

interface Token {
  start: number
  len: number
}

interface Literal {
  start: number
  end: number
  /** Inline code fence length (0 for urls). */
  n: number
}

/** Inline code spans and urls in [lo, hi): stars inside them are literal text. */
function literalRanges(text: string, lo: number, hi: number): Literal[] {
  const out: Literal[] = []
  let i = lo
  while (i < hi) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (j < hi && text[j] === '`') j++
    const n = j - i
    if (isEscaped(text, i)) {
      i = j
      continue
    }
    let k = j
    let close = -1
    while (k < hi) {
      if (text[k] !== '`') {
        k++
        continue
      }
      let e = k
      while (e < hi && text[e] === '`') e++
      if (e - k === n) {
        close = k
        break
      }
      k = e
    }
    if (close >= 0) {
      out.push({ start: i, end: close + n, n })
      i = close + n
    } else i = j
  }
  const re = /(?:https?:\/\/|www\.|mailto:)[^\s<>]*/gi
  const slice = text.slice(lo, hi)
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    const url = m[0].replace(/[*_]+$/, '')
    out.push({ start: lo + m.index, end: lo + m.index + url.length, n: 0 })
  }
  return out
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

/**
 * Bold markers (`**`, each pair of stars in a run) or italic markers (one per odd run) in [lo, hi).
 * Escaped stars, stars in inline code or urls, stars with whitespace on both sides (multiplication, list bullets)
 * and a single star between two word characters are literal text, not markers.
 */
function scanTokens(text: string, lo: number, hi: number, width: 1 | 2, lits: Literal[]): Token[] {
  const out: Token[] = []
  let i = lo
  while (i < hi) {
    if (text[i] !== '*') {
      i++
      continue
    }
    let j = i
    while (j < hi && text[j] === '*') j++
    let jf = j
    while (text[jf] === '*') jf++
    let is = i
    while (is > 0 && text[is - 1] === '*') is--
    const a = isEscaped(text, i) ? i + 1 : i
    const n = j - a
    const literal =
      lits.some((l) => i >= l.start && i < l.end) ||
      (isSpace(text[is - 1]) && isSpace(text[jf])) ||
      (jf - is === 1 && isWord(text[is - 1]) && isWord(text[jf]))
    if (!literal) {
      if (width === 2) for (let k = 0; k < Math.floor(n / 2); k++) out.push({ start: a + 2 * k, len: 2 })
      else if (n % 2 === 1) out.push({ start: a, len: 1 })
    }
    i = j
  }
  return out
}

function removeTokens(text: string, from: number, to: number, toks: Token[]): string {
  let out = ''
  let at = from
  for (const t of toks) {
    out += text.slice(at, t.start)
    at = t.start + t.len
  }
  return out + text.slice(at, to)
}

function paragraphBounds(text: string, from: number, to: number): [number, number] {
  const re = /\n[ \t]*\r?\n/g
  let ps = 0
  let pe = text.length
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index + m[0].length <= from) ps = m.index + m[0].length
    else if (m.index >= to) {
      pe = m.index
      break
    }
  }
  return [ps, pe]
}

// width 2 = bold, 1 = italic. Italic is present when the adjacent run is odd, bold when it is at least 2.
function inlineStars(text: string, f0: number, t0: number, width: 1 | 2, placeholder: string): ApplyResult {
  const m = '*'.repeat(width)
  const has = (k: number) => (width === 2 ? k >= 2 : k % 2 === 1)
  const [ps, pe] = paragraphBounds(text, f0, t0)
  const lits = literalRanges(text, ps, pe)
  const inside = lits.some((l) => (l.n > 0 ? f0 >= l.start + l.n && t0 <= l.end - l.n : f0 >= l.start && t0 <= l.end && (f0 > l.start || t0 < l.end)))
  if (inside) return result(text, f0, t0)
  let [from, to] = trimRange(text, f0, t0)
  if (from < to && from === lineStart(text, from)) {
    const lead = /^[ \t]*(?:[-*+]|\d{1,9}[.)]|>)[ \t]+/.exec(text.slice(from, to))
    if (lead && from + lead[0].length < to) from += lead[0].length
  }
  if (from === to) {
    const k = Math.min(starsBefore(text, from, 0), starsAfter(text, from, text.length))
    if (has(k)) return result(splice(text, from - width, from + width, ''), from - width, from - width)
    return result(text.slice(0, from) + m + placeholder + m + text.slice(from), from + width, from + width + placeholder.length)
  }
  const toks = scanTokens(text, from, to, width, lits)
  if (toks.length > 0) {
    const last = toks[toks.length - 1]
    const whole = toks.length === 2 && toks[0].start === from && /^\*+$/.test(text.slice(last.start, to))
    const inner = removeTokens(text, from, to, toks)
    if (whole || toks.length !== 2) return result(splice(text, from, to, inner), from, from + inner.length)
    return result(text.slice(0, from) + m + inner + m + text.slice(to), from + width, from + width + inner.length)
  }
  const nb = starsBefore(text, from, 0)
  const na = starsAfter(text, to, text.length)
  if (has(Math.min(nb, na))) {
    const out = text.slice(0, from - width) + text.slice(from, to) + text.slice(to + width)
    return result(out, from - width, to - width)
  }
  if (has(nb) !== has(na)) {
    const all = scanTokens(text, ps, pe, width, lits)
    const k = has(nb) ? all.map((t) => t.start + t.len <= from).lastIndexOf(true) : all.findIndex((t) => t.start >= to)
    if (k >= 0 && all.length % 2 === 1 && k === all.length - 1) {
      if (has(nb)) return result(splice(text, from - width, from, ''), from - width, to - width)
      return result(splice(text, to, to + width, ''), from, to)
    }
  }
  return result(text.slice(0, from) + m + text.slice(from, to) + m + text.slice(to), from + width, to + width)
}

function ticksBefore(text: string, pos: number, lo = 0): number {
  let n = 0
  while (pos - n - 1 >= lo && text[pos - n - 1] === '`') n++
  return n
}
function ticksAfter(text: string, pos: number, hi = text.length): number {
  let n = 0
  while (pos + n < hi && text[pos + n] === '`') n++
  return n
}
function longestTicks(s: string): number {
  let best = 0
  for (const run of s.match(/`+/g) ?? []) best = Math.max(best, run.length)
  return best
}

function inlineCode(text: string, from: number, to: number, placeholder: string): ApplyResult {
  if (from === to) {
    const n = Math.min(ticksBefore(text, from), ticksAfter(text, from))
    if (n > 0) return result(splice(text, from - n, from + n, ''), from - n, from - n)
    return result(text.slice(0, from) + '`' + placeholder + '`' + text.slice(from), from + 1, from + 1 + placeholder.length)
  }
  const s = text.slice(from, to)
  const ls = ticksAfter(text, from, to)
  if (ls > 0 && ls === ticksBefore(text, to, from) && s.length > 2 * ls) {
    let inner = s.slice(ls, s.length - ls)
    if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1)
    return result(splice(text, from, to, inner), from, from + inner.length)
  }
  for (const pad of [0, 1]) {
    if (pad && !(text[from - 1] === ' ' && text[to] === ' ')) continue
    const nb = ticksBefore(text, from - pad)
    const na = ticksAfter(text, to + pad)
    if (nb > 0 && nb === na) {
      const out = text.slice(0, from - pad - nb) + s + text.slice(to + pad + nb)
      return result(out, from - pad - nb, to - pad - nb)
    }
  }
  const n = longestTicks(s) + 1
  const fence = '`'.repeat(n)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  const out = text.slice(0, from) + fence + pad + s + pad + fence + text.slice(to)
  const o = n + pad.length
  return result(out, from + o, to + o)
}

// ---- line based actions ---------------------------------------------------

interface Line {
  ls: number
  le: number
  ce: number
}

function selectedLines(text: string, from: number, to: number): Line[] {
  const endPos = to > from && text[to - 1] === '\n' ? to - 1 : to
  const lastLe = lineEnd(text, endPos)
  const lines: Line[] = []
  let ls = lineStart(text, from)
  for (;;) {
    const le = lineEnd(text, ls)
    lines.push({ ls, le, ce: contentEnd(text, ls, le) })
    if (le >= lastLe) break
    ls = le + 1
  }
  return lines
}

function applyEdits(text: string, edits: Edit[], from: number, to: number): ApplyResult {
  const raw = edits.filter((e) => e.insert !== text.slice(e.start, e.start + e.oldLen)).sort((a, b) => a.start - b.start)
  const sorted: Edit[] = []
  let covered = 0
  for (const e of raw) {
    const start = Math.max(e.start, covered)
    const end = Math.max(start, e.start + e.oldLen)
    sorted.push({ start, oldLen: end - start, insert: e.insert })
    covered = end
  }
  const map = (pos: number) => {
    let shift = 0
    for (const e of sorted) {
      if (pos > e.start + e.oldLen) shift += e.insert.length - e.oldLen
      else if (pos >= e.start) return e.start + shift + e.insert.length
      else break
    }
    return pos + shift
  }
  let out = ''
  let at = 0
  for (const e of sorted) {
    out += text.slice(at, e.start) + e.insert
    at = e.start + e.oldLen
  }
  out += text.slice(at)
  return result(out, map(from), map(to))
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length
const HEADING = /^(#{1,6})([ \t]+|$)/

function heading(text: string, from: number, to: number): ApplyResult {
  const ls = lineStart(text, from)
  const ce = contentEnd(text, ls, lineEnd(text, from))
  const m = HEADING.exec(text.slice(ls, ce))
  const level = m ? m[1].length : 0
  const next = level === 0 ? 1 : level < 3 ? level + 1 : 0
  const insert = next === 0 ? '' : '#'.repeat(next) + ' '
  return applyEdits(text, [{ start: ls, oldLen: m ? m[0].length : 0, insert }], from, to)
}

const PREFIX = {
  quote: /^>[ ]?/,
  ul: /^[-*+]([ \t]+|$)/,
  ol: /^\d{1,9}[.)]([ \t]+|$)/,
} as const

function prefixLines(text: string, from: number, to: number, kind: 'quote' | 'ul' | 'ol'): ApplyResult {
  let lines = selectedLines(text, from, to)
  const blank = (l: Line) => /^\s*$/.test(text.slice(l.ls, l.ce))
  if (lines.length > 1) lines = lines.filter((l) => !blank(l))
  if (lines.length === 0) return result(text, from, to)
  const info = lines.map((l) => {
    const body = text.slice(l.ls, l.ce)
    const ind = kind === 'quote' ? indentOf(body) : /^[ \t]*(?:>[ ]?[ \t]*)*/.exec(body)![0].length
    const rest = body.slice(ind)
    return { start: l.ls + ind, own: PREFIX[kind].exec(rest), ul: PREFIX.ul.exec(rest), ol: PREFIX.ol.exec(rest) }
  })
  const remove = info.every((i) => i.own)
  let n = 0
  const edits: Edit[] = info.map((i) => {
    n++
    if (remove) return { start: i.start, oldLen: i.own![0].length, insert: '' }
    if (kind === 'quote') return { start: i.start, oldLen: i.own ? i.own[0].length : 0, insert: i.own ? i.own[0] : '> ' }
    if (kind === 'ul') {
      if (i.ul) return { start: i.start, oldLen: i.ul[0].length, insert: i.ul[0] }
      return { start: i.start, oldLen: i.ol ? i.ol[0].length : 0, insert: '- ' }
    }
    return { start: i.start, oldLen: i.ol ? i.ol[0].length : i.ul ? i.ul[0].length : 0, insert: `${n}. ` }
  })
  return applyEdits(text, edits, from, to)
}

// ---- code block -----------------------------------------------------------

interface Fenced {
  open: Line
  close: Line
}

function findFences(text: string): Fenced[] {
  const blocks: Fenced[] = []
  let ls = 0
  let open: { line: Line; ch: string; n: number } | null = null
  for (;;) {
    const le = lineEnd(text, ls)
    const line = { ls, le, ce: contentEnd(text, ls, le) }
    const body = text.slice(ls, line.ce)
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(body)
      if (m && !(m[1][0] === '`' && body.slice(m[0].length).includes('`'))) open = { line, ch: m[1][0], n: m[1].length }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body)
      if (m && m[1][0] === open.ch && m[1].length >= open.n) {
        blocks.push({ open: open.line, close: line })
        open = null
      }
    }
    if (le >= text.length) break
    ls = le + 1
  }
  return blocks
}

function codeBlock(text: string, from: number, to: number, eol: string): ApplyResult {
  const lines = selectedLines(text, from, to)
  const first = lines[0]
  const last = lines[lines.length - 1]
  const block = findFences(text).find(
    (b) => (first.ls >= b.open.ls && first.ls <= b.close.ls) || (first.ls <= b.open.ls && last.ls >= b.close.ls),
  )
  if (block) {
    const { open, close } = block
    const edits: Edit[] = [{ start: open.ls, oldLen: open.le + 1 - open.ls, insert: '' }]
    if (close.le < text.length) {
      edits.push({ start: close.ls, oldLen: close.le + 1 - close.ls, insert: '' })
    } else {
      let s = close.ls - 1
      if (s > 0 && text[s - 1] === '\r') s -= 1
      edits.push({ start: s, oldLen: close.le - s, insert: '' })
    }
    return applyEdits(text, edits, from, to)
  }
  if (from === to) {
    const before = from > 0 && text[from - 1] !== '\n' ? eol : ''
    const after = from < text.length && text[from] !== '\n' && text[from] !== '\r' ? eol : ''
    const head = before + '```' + eol
    const out = text.slice(0, from) + head + eol + '```' + after + text.slice(from)
    return result(out, from + head.length, from + head.length)
  }
  const a = first.ls
  const b = last.le < text.length ? last.le + 1 : text.length
  const content = text.slice(a, b)
  const fence = '`'.repeat(Math.max(3, longestTicks(content) + 1))
  const open = fence + eol
  const close = b === text.length && !text.endsWith('\n') ? eol + fence : fence + eol
  return result(text.slice(0, a) + open + content + close + text.slice(b), from + open.length, to + open.length)
}

// ---- link -----------------------------------------------------------------

function link(text: string, from: number, to: number, ph: Placeholders): ApplyResult {
  const s = text.slice(from, to)
  const unwrap = (start: number, end: number, label: string) =>
    result(splice(text, start, end, label), start, start + label.length)
  const whole = /^\[([^\]\n]*)\]\(([^()\n]*)\)$/.exec(s)
  if (whole) return unwrap(from, to, whole[1])
  if (text[from - 1] === '[') {
    const m = /^\]\([^()\n]*\)/.exec(text.slice(to))
    if (m) return unwrap(from - 1, to + m[0].length, s)
  }
  if (text.slice(from - 2, from) === '](' && text[to] === ')' && !s.includes('\n')) {
    const lb = text.lastIndexOf('[', from - 3)
    const label = lb >= 0 ? text.slice(lb + 1, from - 2) : ''
    if (lb >= 0 && !/[\]\n]/.test(label)) return unwrap(lb, to + 1, label)
  }
  const all = [...s.matchAll(/(?<!!)\[([^\]\n]*)\]\(([^()\n]*)\)/g)]
  if (all.length > 0) {
    const out = s.replace(/(?<!!)\[([^\]\n]*)\]\(([^()\n]*)\)/g, '$1')
    return result(splice(text, from, to, out), from, from + out.length)
  }
  if (from === to || /^(https?:\/\/|mailto:|www\.)\S+$/i.test(s)) {
    const url = from === to ? ph.linkUrl : s
    const out = text.slice(0, from) + `[${ph.linkText}](${url})` + text.slice(to)
    return result(out, from + 1, from + 1 + ph.linkText.length)
  }
  const out = text.slice(0, from) + `[${s}](${ph.linkUrl})` + text.slice(to)
  const u = from + s.length + 3
  return result(out, u, u + ph.linkUrl.length)
}

// ---- table ----------------------------------------------------------------

function table(text: string, from: number, to: number, eol: string, ph: Placeholders): ApplyResult {
  const col1 = ph.col1 ?? '列1'
  const col2 = ph.col2 ?? '列2'
  const endPos = to > from && text[to - 1] === '\n' ? to - 1 : to
  let ls = lineStart(text, endPos)
  let le = lineEnd(text, endPos)
  const isRow = (a: number, b: number) => /^[ \t]{0,3}\|/.test(text.slice(a, b))
  for (const pos of [from, endPos]) {
    const a = lineStart(text, pos)
    const b = lineEnd(text, pos)
    if (!isRow(a, b)) continue
    let end = b
    while (end < text.length && isRow(end + 1, lineEnd(text, end + 1))) end = lineEnd(text, end + 1)
    if (end > le || !isRow(ls, le)) {
      ls = a
      le = end
    }
  }
  const hasBreak = le < text.length
  const p = hasBreak ? le + 1 : text.length
  const lineBlank = /^\s*$/.test(text.slice(ls, contentEnd(text, ls, le)))
  let head = !hasBreak && text.length > 0 && !text.endsWith('\n') ? eol : ''
  if (!lineBlank) head += eol
  let tail = ''
  if (p < text.length) tail = eol + (text[p] === '\n' || text[p] === '\r' ? '' : eol)
  else if (text.endsWith('\n')) tail = eol
  const body = [`| ${col1} | ${col2} |`, '| --- | --- |', `| ${ph.cell} | ${ph.cell} |`].join(eol)
  const out = text.slice(0, p) + head + body + tail + text.slice(p)
  const a = p + head.length + 2
  return result(out, a, a + col1.length)
}
