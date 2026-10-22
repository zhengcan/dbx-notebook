import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { highlightTree, tags as t } from '@lezer/highlight'
import { ensureSqlPaletteStyle, type SqlTokenKind } from './sqlPalette'

const cls = (k: SqlTokenKind) => `sql-${k}`

const style = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.typeName], class: cls('keyword') },
  { tag: t.string, class: cls('string') },
  { tag: t.number, class: cls('number') },
  { tag: [t.lineComment, t.blockComment], class: cls('comment') },
  { tag: t.operator, class: cls('operator') },
  { tag: t.standard(t.name), class: cls('function') },
  { tag: [t.name, t.special(t.name)], class: cls('identifier') },
  { tag: t.special(t.string), class: cls('quotedIdentifier') },
])

// Single-line `{{ name }}`, one level of inner braces allowed. Placeholders win over string/comment colouring.
const PLACEHOLDER_RE = /\{\{(?:[^{}\n]|\{[^{}\n]*\})*\}\}/g

const placeholderPlugin = ViewPlugin.fromClass(class {
  deco: DecorationSet
  matcher = new MatchDecorator({ regexp: PLACEHOLDER_RE, decoration: Decoration.mark({ class: cls('placeholder') }) })
  constructor(view: EditorView) { this.deco = this.matcher.createDeco(view) }
  update(u: ViewUpdate) { this.deco = this.matcher.updateDeco(u, this.deco) }
}, { decorations: (v) => v.deco })

// Colours come from CSS custom properties (see sqlPalette), so the extension is theme independent.
export function sqlHighlightExtension(): Extension {
  ensureSqlPaletteStyle()
  return [syntaxHighlighting(style), placeholderPlugin]
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

interface Seg { from: number; to: number; kind: string }

function segments(text: string): Seg[] {
  const out: Seg[] = []
  const tree = sql().language.parser.parse(text)
  highlightTree(tree, style, (from, to, c) => {
    const m = /sql-([A-Za-z]+)/.exec(c)
    if (m) out.push({ from, to, kind: m[1] })
  })
  const ph: Seg[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) ph.push({ from: m.index!, to: m.index! + m[0].length, kind: 'placeholder' })
  if (!ph.length) return out
  const merged: Seg[] = []
  let pi = 0
  for (const s of out) {
    let from = s.from
    while (pi < ph.length && ph[pi].to <= from) pi++
    let j = pi
    while (j < ph.length && ph[j].from < s.to) {
      if (ph[j].from > from) merged.push({ from, to: ph[j].from, kind: s.kind })
      from = Math.max(from, ph[j].to)
      j++
    }
    if (from < s.to) merged.push({ from, to: s.to, kind: s.kind })
  }
  return [...merged, ...ph].sort((a, b) => a.from - b.from)
}

// NOTE: no production caller yet; Task 4 (chat code blocks, DiffView) consumes it. Callers should run
// applySqlContrastGuard(surfaceEl, containerEl) on the element that hosts the output.
export const HIGHLIGHT_MAX_CHARS = 512_000

export function highlightSql(text: string, opts: { maxChars?: number } = {}): string {
  if (!text) return ''
  if (text.length > (opts.maxChars ?? HIGHLIGHT_MAX_CHARS)) return esc(text)
  ensureSqlPaletteStyle()
  let segs: Seg[]
  try { segs = segments(text) } catch { return esc(text) }
  let out = ''
  let pos = 0
  for (const s of segs) {
    if (s.from < pos) continue
    out += esc(text.slice(pos, s.from)) + `<span class="sql-${s.kind}">${esc(text.slice(s.from, s.to))}</span>`
    pos = s.to
  }
  return out + esc(text.slice(pos))
}
