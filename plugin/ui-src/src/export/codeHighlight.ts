import type { Parser, Tree } from '@lezer/common'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import { StreamLanguage } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { SQL_PALETTE } from '../editor/sqlPalette'
import { shell } from '@codemirror/legacy-modes/mode/shell'

// Export-time syntax highlighting. Output is escaped text with <span class="tok-x"> wrappers only; the
// language comes from a strict allow-list, so user content never reaches a class name or attribute.

export const CODE_MAX_CHARS = 200_000
export const CODE_MAX_LINES = 5_000

const ALIASES = new Map<string, string>([
  ['sql', 'sql'], ['postgres', 'sql'], ['postgresql', 'sql'], ['pgsql', 'sql'], ['mysql', 'sql'], ['sqlite', 'sql'], ['tsql', 'sql'], ['mariadb', 'sql'],
  ['json', 'json'], ['jsonc', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['javascript', 'javascript'], ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['typescript', 'typescript'], ['ts', 'typescript'], ['tsx', 'typescript'],
  ['python', 'python'], ['py', 'python'],
  ['bash', 'bash'], ['sh', 'bash'], ['shell', 'bash'], ['zsh', 'bash'],
])

export const CODE_LANGS = ['sql', 'json', 'yaml', 'javascript', 'typescript', 'python', 'bash'] as const
export type CodeLang = (typeof CODE_LANGS)[number]

export function canonicalLang(info: string | null | undefined): CodeLang | null {
  if (!info) return null
  const first = info.trim().split(/\s+/)[0].toLowerCase()
  return (ALIASES.get(first) as CodeLang | undefined) ?? null
}

const PARSERS: Record<CodeLang, () => Parser> = {
  sql: () => sql().language.parser,
  json: () => json().language.parser,
  yaml: () => yaml().language.parser,
  javascript: () => javascript({ jsx: true }).language.parser,
  typescript: () => javascript({ typescript: true }).language.parser,
  python: () => python().language.parser,
  bash: () => StreamLanguage.define(shell).parser,
}
const cache = new Map<CodeLang, Parser>()
function parserFor(lang: CodeLang): Parser {
  let p = cache.get(lang)
  if (!p) { p = PARSERS[lang](); cache.set(lang, p) }
  return p
}

export const CODE_CLASSES = ['keyword', 'atom', 'string', 'number', 'comment', 'function', 'name', 'operator', 'punct', 'type', 'meta'] as const
const VALID = new Set<string>(CODE_CLASSES.map((c) => `tok-${c}`))

const highlighter = tagHighlighter([
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: [t.bool, t.null, t.atom, t.self], class: 'tok-atom' },
  { tag: [t.string, t.regexp, t.escape], class: 'tok-string' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.name), t.macroName], class: 'tok-function' },
  { tag: [t.name, t.labelName], class: 'tok-name' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: [t.meta, t.processingInstruction], class: 'tok-meta' },
])

export function escapeCode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function overCap(text: string): boolean {
  if (text.length > CODE_MAX_CHARS) return true
  let lines = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (++lines > CODE_MAX_LINES) return true
  return false
}

export interface HighlightOpts { parse?: (text: string, lang: CodeLang) => Tree }

/** Inner HTML for a <code> element: all text escaped, token spans only. Never throws; falls back to plain escaped text. */
export function highlightCode(text: string, info: string | null | undefined, opts: HighlightOpts = {}): string {
  if (!text) return ''
  const lang = canonicalLang(info)
  if (!lang || overCap(text)) return escapeCode(text)
  try {
    const tree = opts.parse ? opts.parse(text, lang) : parserFor(lang).parse(text)
    let out = ''
    let pos = 0
    highlightTree(tree, highlighter, (from, to, classes) => {
      const c = classes.split(/\s+/).find((x) => VALID.has(x))
      if (!c || from < pos || to > text.length || to <= from) return
      out += escapeCode(text.slice(pos, from)) + `<span class="${c}">${escapeCode(text.slice(from, to))}</span>`
      pos = to
    })
    return out + escapeCode(text.slice(pos))
  } catch {
    return escapeCode(text)
  }
}

export const CODE_BG = '#f6f8fa'

// Light print theme (GitHub Primer, shared with the editor's SQL palette where the colour matches): every colour is >= 4.5:1 on CODE_BG. Single source for the export stylesheet.
const P = SQL_PALETTE.light
export const CODE_THEME_LIGHT: Record<(typeof CODE_CLASSES)[number], string> = {
  keyword: P.keyword, atom: P.number, string: P.string, number: P.number, comment: '#57606a', function: '#6639ba', name: P.plain,
  operator: P.placeholder, punct: '#57606a', type: P.placeholder, meta: '#6639ba',
}

export function codeThemeCss(): string {
  const vars = CODE_CLASSES.map((k) => `--tok-${k}:${CODE_THEME_LIGHT[k]}`).join(';')
  const rules = CODE_CLASSES.map((k) => `.tok-${k}{color:var(--tok-${k})}`).join('')
  return `:root{${vars}}${rules}pre.sql,.md pre{-webkit-print-color-adjust:exact;print-color-adjust:exact}.tok-comment{font-style:italic}`
}
