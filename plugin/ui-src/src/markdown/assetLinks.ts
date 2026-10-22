// Markdown image links <-> notebook-relative paths: encoding for inserted links, collection and rewriting for Save As.
import MarkdownIt from 'markdown-it'
import { classifySrc } from './imagePolicy'

const md = new MarkdownIt({ html: false })

/** Percent-encode each path segment so the link text survives Markdown and decodes once to `rel`. */
export function encodeRelPath(rel: string): string {
  return rel.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => (c === '(' || c === ')' ? '%' + c.charCodeAt(0).toString(16).toUpperCase() : c))).join('/')
}

export const imageLinkText = (rel: string): string => `![](${encodeRelPath(rel)})`

const IMG = /(!\[(?:[^\]\\\n]|\\.)*\]\()(<[^<>\n]*>|(?:[^\s()<>]|\([^\s()<>]*\))*)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g
const REF_IMG = /!\[((?:[^\]\\]|\\.)*)\](?:\[((?:[^\]\\]|\\.)*)\]|(?![[(]))/g
const DEF = /^( {0,3}\[)((?:[^\]\\\n]|\\.)+)(\]:[ \t]*)(<[^<>\n]*>|\S+)/gm

interface Analysis {
  text: string
  masked: string
  srcs: Set<string>
  refs: Record<string, { href: string }>
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ')
}

/** Same-length copy of `text` with code blocks, code spans and escaped `!` blanked out. */
function mask(text: string, codeLines: Set<number>): string {
  const lines = text.split('\n').map((l, i) => (codeLines.has(i) ? blank(l) : l))
  const src = lines.join('\n')
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      out += src[i + 1] === '!' ? '\\ ' : src.slice(i, i + 2)
      i += 2
    } else if (c === '`') {
      let n = 1
      while (src[i + n] === '`') n++
      let j = i + n
      let end = -1
      while (j < src.length) {
        if (src[j] === '\n' && src[j + 1] === '\n') break
        if (src[j] === '`') {
          let m = 1
          while (src[j + m] === '`') m++
          if (m === n) { end = j + m; break }
          j += m
        } else j++
      }
      if (end < 0) { out += src.slice(i, i + n); i += n } else { out += blank(src.slice(i, end)); i = end }
    } else { out += c; i++ }
  }
  return out
}

function analyze(text: string): Analysis {
  const env: { references?: Record<string, { href: string }> } = {}
  const tokens = md.parse(text, env as never)
  const codeLines = new Set<number>()
  const srcs = new Set<string>()
  for (const t of tokens) {
    if ((t.type === 'fence' || t.type === 'code_block') && t.map) for (let i = t.map[0]; i < t.map[1]; i++) codeLines.add(i)
    for (const ch of t.children ?? []) if (ch.type === 'image') srcs.add(String(ch.attrGet('src') ?? ''))
  }
  return { text, masked: mask(text, codeLines), srcs, refs: env.references ?? {} }
}

function destOf(raw: string): string {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
}

const normalized = (dest: string) => md.normalizeLink(md.utils.unescapeAll(destOf(dest).trim()))
const stripDot = (p: string) => p.split('/').filter((s) => s !== '.').join('/')

interface Hit { start: number; end: number; dest: string }

/** Destinations of links that markdown-it renders as images (inline form and the definitions their references use). */
function hits(a: Analysis): Hit[] {
  const out: Hit[] = []
  for (const m of a.masked.matchAll(IMG)) {
    const start = m.index + m[1].length
    const dest = a.text.slice(start, start + m[2].length)
    if (a.srcs.has(normalized(dest))) out.push({ start, end: start + dest.length, dest })
  }
  const used = new Set<string>()
  for (const m of a.masked.matchAll(REF_IMG)) {
    const key = md.utils.normalizeReference(m[2] ? m[2] : m[1])
    const ref = a.refs[key]
    if (ref && a.srcs.has(ref.href)) used.add(key)
  }
  if (used.size > 0) {
    for (const m of a.masked.matchAll(DEF)) {
      if (!used.has(md.utils.normalizeReference(m[2]))) continue
      const start = m.index + m[1].length + m[2].length + m[3].length
      out.push({ start, end: start + m[4].length, dest: a.text.slice(start, start + m[4].length) })
    }
  }
  return out
}

/** Decoded, deduplicated relative image paths of links that render as images. */
export function collectRelImageLinks(text: string): string[] {
  const seen = new Set<string>()
  for (const h of hits(analyze(text))) {
    const c = classifySrc(destOf(h.dest))
    if (c.kind === 'relative') seen.add(c.rel)
  }
  return [...seen]
}

/** Rewrites links whose decoded relative path is a key of `mapping` (old -> new, both decoded). */
export function rewriteImageLinks(text: string, mapping: Record<string, string>): string {
  if (Object.keys(mapping).length === 0) return text
  let out = text
  const hs = hits(analyze(text)).sort((x, y) => y.start - x.start)
  for (const h of hs) {
    const d = destOf(h.dest)
    const c = classifySrc(d)
    if (c.kind !== 'relative' || !Object.prototype.hasOwnProperty.call(mapping, c.rel)) continue
    const next = mapping[c.rel]
    if (stripDot(next) === stripDot(c.rel)) continue
    const suffix = d.trim().match(/[?#].*$/s)?.[0] ?? ''
    out = out.slice(0, h.start) + encodeRelPath(next) + suffix + out.slice(h.end)
  }
  return out
}
