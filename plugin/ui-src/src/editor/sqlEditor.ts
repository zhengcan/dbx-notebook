import { ChangeSet, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { createCompositionGate } from './compositionGate'
import { sqlHighlightExtension } from './sqlHighlight'
import { applySqlContrastGuard } from './sqlPalette'
import { keywordCompletionSource, MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'

export type DialectName = 'PostgreSQL' | 'MySQL' | 'SQLite' | 'MSSQL' | 'StandardSQL'

export function dialectForDbType(dbType: string): DialectName {
  switch ((dbType ?? '').toLowerCase()) {
    case 'postgres': case 'postgresql': case 'cockroach': case 'redshift': case 'greenplum': return 'PostgreSQL'
    case 'mysql': case 'mariadb': case 'tidb': case 'doris': case 'starrocks': return 'MySQL'
    case 'sqlite': return 'SQLite'
    case 'sqlserver': case 'mssql': return 'MSSQL'
    default: return 'StandardSQL'
  }
}

const DIALECTS = { PostgreSQL, MySQL, SQLite, MSSQL, StandardSQL }
const dialectOf = (d: string) => DIALECTS[d as DialectName] ?? StandardSQL

// Single-quoted strings: '' is always an escape. A backslash-escaped quote (\') is
// honoured (MySQL) only if that leaves the string terminated; otherwise backslash is literal.
function scanQuoted(s: string, start: number, allowBackslash: boolean): number {
  let i = start + 1
  while (i < s.length) {
    if (allowBackslash && s[i] === '\\') { i += 2; continue }
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i += 2; continue }
      return i + 1
    }
    i++
  }
  return -1
}

function stripCommentsAndStrings(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '-' && s[i + 1] === '-') {
      const e = s.indexOf('\n', i)
      i = e < 0 ? s.length : e
      out += ' '
    } else if (c === '/' && s[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < s.length && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2 }
        else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      out += ' '
    } else if (c === "'") {
      let e = scanQuoted(s, i, true)
      if (e < 0) e = scanQuoted(s, i, false)
      i = e < 0 ? s.length : e
      out += ' '
    } else if (c === '$' && !/\w/.test(s[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 80))
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length)
        i = end < 0 ? s.length : end + m[0].length
        out += ' '
      } else { out += c; i++ }
    } else { out += c; i++ }
  }
  return out
}

const IDENT = String.raw`(?:"[^"]+"|`+'`[^`]+`'+String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`
const TOKEN_RE = new RegExp(String.raw`${IDENT}(?:\s*\.\s*${IDENT})*|[(),;]|\S`, 'g')
const PART_RE = new RegExp(IDENT, 'g')
const SPECIAL_FN = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION'])
const STOP = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'JOIN', 'ON', 'WINDOW', 'SELECT', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'SET', 'VALUES', 'USING', 'EXCEPT', 'INTERSECT', 'OFFSET', 'FETCH', 'FOR', 'RETURNING'])

interface Tok { text: string; id: boolean }

export function extractTableNames(src: string): string[] {
  const toks: Tok[] = [...stripCommentsAndStrings(src).matchAll(TOKEN_RE)].map((m) => ({
    text: m[0], id: /^["`[A-Za-z_]/.test(m[0]),
  }))
  const word = (k: number) => {
    const t = toks[k]
    return t && t.id && /^[A-Za-z_][\w$]*$/.test(t.text) ? t.text.toUpperCase() : ''
  }
  const out: string[] = []
  const take = (k: number): boolean => {
    const t = toks[k]
    if (!t || !t.id || STOP.has(word(k))) return false
    const name = (t.text.match(PART_RE) ?? []).map((p) => (/^["`[]/.test(p) ? p.slice(1, -1) : p)).join('.')
    if (name && !out.includes(name)) out.push(name)
    return true
  }
  const stack: boolean[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.text === '(') { stack.push(SPECIAL_FN.has(word(i - 1))); continue }
    if (t.text === ')') { stack.pop(); continue }
    const w = word(i)
    if (w === 'FROM' && !stack.some(Boolean)) {
      let j = i + 1
      while (take(j)) {
        j++
        while (toks[j]?.id && !STOP.has(word(j))) j++
        if (toks[j]?.text === ',') j++
        else break
      }
      i = j - 1
    } else if (w === 'JOIN' || w === 'INTO' || (w === 'UPDATE' && word(i - 1) !== 'FOR')) {
      take(i + 1)
    }
  }
  return out
}

export interface ColumnCompletionOpts {
  columnsFor?: (table: string) => Promise<string[]>
  completionTables?: () => Promise<string[]>
}

export function createColumnCompletion(opts: ColumnCompletionOpts) {
  const cache = new Map<string, Promise<string[]>>()
  let gen = 0
  const cols = (table: string): Promise<string[]> => {
    if (!opts.columnsFor) return Promise.resolve([])
    let p = cache.get(table)
    if (!p) {
      const g = gen
      const mine: Promise<string[]> = opts.columnsFor(table).catch(() => {
        if (g === gen && cache.get(table) === mine) cache.delete(table)
        return [] as string[]
      })
      p = mine
      cache.set(table, p)
    }
    return p
  }
  return {
    clearCache: () => { gen++; cache.clear() },
    async names(src: string): Promise<Completion[]> {
      const out: Completion[] = []
      const seen = new Set<string>()
      const add = (label: string, type: string) => {
        if (!seen.has(label)) { seen.add(label); out.push({ label, type }) }
      }
      for (const tbl of extractTableNames(src)) for (const c of await cols(tbl)) add(c, 'property')
      try { for (const n of (await opts.completionTables?.()) ?? []) add(n, 'class') } catch { /* ignore */ }
      return out
    },
  }
}

export interface SqlEditorOpts extends ColumnCompletionOpts {
  doc: string
  dialect: string
  fontFamily?: string
  fontSize?: number
  onChange(doc: string): void
  onRun?(): void
  /** Document-level history: the editor has no history of its own. Return true when handled. */
  onUndo?(): boolean
  onRedo?(): boolean
}

export interface SqlEditorHandle {
  setDoc(s: string): void
  getDoc(): string
  setDialect(d: string): void
  setFont(family?: string, size?: number): void
  setDark(b: boolean): void
  clearCache(): void
  destroy(): void
  focus?(): void
}

const fontTheme = (family?: string, size?: number) => {
  const s: Record<string, string> = {}
  if (family) s.fontFamily = family
  if (size) s.fontSize = `${size}px`
  return EditorView.theme({ '&': s, '.cm-scroller': s })
}

const darkTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--color-background, #fff)', color: 'var(--color-foreground, #111)' },
  '.cm-gutters': { backgroundColor: 'var(--color-background, #fff)', color: 'var(--color-muted-foreground, #888)', borderColor: 'var(--color-border, #ccc)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-foreground, #111)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--color-selection, color-mix(in srgb, var(--color-foreground, #111) 18%, transparent))' },
}, { dark: true })

export function createSqlEditor(parent: HTMLElement, opts: SqlEditorOpts): SqlEditorHandle {
  const completion = createColumnCompletion(opts)
  const lang = new Compartment()
  const font = new Compartment()
  const dark = new Compartment()
  let dialect = opts.dialect
  const langExt = () => sql({ dialect: dialectOf(dialect) })
  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const w = ctx.matchBefore(/[\w$]+/)
    if (!w && !ctx.explicit) return null
    const options = await completion.names(ctx.state.doc.toString())
    return options.length ? { from: w ? w.from : ctx.pos, options } : null
  }
  let silent = false
  const gate = createCompositionGate((d) => opts.onChange(d))
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        keymap.of([
          { key: 'Mod-Enter', run: () => { opts.onRun?.(); return true } },
          { key: 'Mod-z', run: () => { opts.onUndo?.(); return true }, preventDefault: true },
          { key: 'Mod-Shift-z', run: () => { opts.onRedo?.(); return true }, preventDefault: true },
          { key: 'Ctrl-y', run: () => { opts.onRedo?.(); return true }, preventDefault: true },
          ...defaultKeymap.filter((k) => k.key !== 'Mod-z' && k.key !== 'Mod-y'),
        ]),
        lang.of(langExt()),
        autocompletion({ override: [source, (c) => keywordCompletionSource(dialectOf(dialect))(c)] }),
        font.of(fontTheme(opts.fontFamily, opts.fontSize)),
        dark.of([]),
        sqlHighlightExtension(),
        EditorView.updateListener.of((u) => { if (!silent) gate.update(u.docChanged, u.view.composing, u.state.doc.toString()) }),
        // non-Latin layouts: keymaps match on event.key, so fall back to the physical key here (same rule as the global shortcuts)
        EditorView.domEventHandlers({
          keydown: (e) => {
            const k = e.key.toLowerCase()
            if (/^[a-z]$/.test(k) || e.altKey || e.isComposing) return false
            const mac = /Mac|iPhone|iPad/.test(navigator.platform)
            const mod = mac ? e.metaKey : e.ctrlKey
            if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) opts.onRedo?.(); else opts.onUndo?.(); return true }
            if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyY') { e.preventDefault(); opts.onRedo?.(); return true }
            return false
          },
        }),
        EditorView.domEventHandlers({ compositionend: (_e, v) => { queueMicrotask(() => gate.end(v.state.doc.toString())); return false } }),
      ],
    }),
  })
  const guard = applySqlContrastGuard(view.dom, parent)
  return {
    setDoc(s) {
      s = s.replace(/\r\n?/g, '\n')
      const cur = view.state.doc.toString()
      if (s === cur) return
      // replace only the changed range so the selection maps naturally
      let a = 0
      const max = Math.min(cur.length, s.length)
      while (a < max && cur.charCodeAt(a) === s.charCodeAt(a)) a++
      if (a > 0 && (cur.charCodeAt(a - 1) & 0xfc00) === 0xd800) a--
      let ce = cur.length, se = s.length
      while (ce > a && se > a && cur.charCodeAt(ce - 1) === s.charCodeAt(se - 1)) { ce--; se-- }
      if (ce < cur.length && (cur.charCodeAt(ce) & 0xfc00) === 0xdc00) { ce++; se++ }
      silent = true
      const change = { from: a, to: ce, insert: s.slice(a, se) }
      // caret at/after the changed range ends up after the replacement (continue typing where the change happened)
      const selection = view.state.selection.map(ChangeSet.of(change, cur.length), 1)
      view.dispatch({ changes: change, selection, annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] })
      silent = false
    },
    getDoc: () => view.state.doc.toString(),
    setDialect(d) { dialect = d; view.dispatch({ effects: lang.reconfigure(langExt()) }) },
    setFont(f, size) { view.dispatch({ effects: font.reconfigure(fontTheme(f, size)) }) },
    setDark(b) { view.dispatch({ effects: dark.reconfigure(b ? darkTheme : []) }); guard.refresh() },
    clearCache: completion.clearCache,
    destroy() { guard.dispose(); view.destroy() },
    focus() { view.focus() },
  }
}
