import type { Block } from '@sqlnb/format'

export class DepError extends Error {
  constructor(
    public code: 'SELF' | 'FORWARD' | 'DUPLICATE',
    public blockId: string,
    public name: string,
  ) {
    super(`${code}: ${name}`)
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export function resultNameOf(block: Block): string | undefined {
  if (block.type !== 'sql') return undefined
  const v = (block.metadata as { resultName?: unknown } | undefined)?.resultName
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return NAME_RE.test(t) ? t : undefined
}

export function isResultsBlock(block: Block): boolean {
  return block.type === 'sql' && (block.metadata as { source?: unknown } | undefined)?.source === 'results'
}

interface Tok {
  kind: 'id' | 'p'
  v: string // lowercased identifier, or punctuation char
  quoted: boolean
}

const isStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isPart = (c: number) => isStart(c) || (c >= 48 && c <= 57) || c === 36

function lex(sql: string): Tok[] {
  const out: Tok[] = []
  const n = sql.length
  let i = 0
  const quoted = (close: string, dbl: boolean) => {
    let s = ''
    i++
    while (i < n) {
      if (sql[i] === close) {
        if (dbl && sql[i + 1] === close) { s += close; i += 2; continue }
        i++
        break
      }
      s += sql[i++]
    }
    out.push({ kind: 'id', v: s.toLowerCase(), quoted: true })
  }
  while (i < n) {
    const c = sql.charCodeAt(i)
    const ch = sql[i]
    if (ch === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue } i++; break }
        i++
      }
      out.push({ kind: 'p', v: "'", quoted: false })
    } else if (ch === '{' && sql[i + 1] === '{' && sql.indexOf('}}', i + 2) >= 0) {
      i = sql.indexOf('}}', i + 2) + 2
      out.push({ kind: 'p', v: '?', quoted: false })
    } else if (ch === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i)
      i = e < 0 ? n : e + 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
    } else if (ch === '"') quoted('"', true)
    else if (ch === '`') quoted('`', true)
    else if (ch === '[') quoted(']', false)
    else if (isStart(c)) {
      const s = i++
      while (i < n && isPart(sql.charCodeAt(i))) i++
      out.push({ kind: 'id', v: sql.slice(s, i).toLowerCase(), quoted: false })
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
    else {
      out.push({ kind: 'p', v: ch, quoted: false })
      i++
    }
  }
  return out
}

const isKw = (t: Tok | undefined, kw: string) => !!t && t.kind === 'id' && !t.quoted && t.v === kw
const isP = (t: Tok | undefined, p: string) => !!t && t.kind === 'p' && t.v === p

// token index of the first token after the matching ')' for '(' at i
function skipParens(toks: Tok[], i: number): number {
  let d = 0
  for (; i < toks.length; i++) {
    if (isP(toks[i], '(')) d++
    else if (isP(toks[i], ')') && --d === 0) return i + 1
  }
  return toks.length
}

// Is toks[i] a CTE definition head: ident [ (cols) ] AS [NOT] [MATERIALIZED] ( ?
function isCteHead(toks: Tok[], i: number): boolean {
  if (toks[i]?.kind !== 'id') return false
  let j = i + 1
  if (isP(toks[j], '(')) j = skipParens(toks, j)
  if (!isKw(toks[j], 'as')) return false
  j++
  if (isKw(toks[j], 'not')) j++
  if (isKw(toks[j], 'materialized')) j++
  return isP(toks[j], '(')
}

function cteNames(toks: Tok[]): Set<number> {
  const heads = new Set<number>()
  const active: boolean[] = []
  let d = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (isP(t, '(')) { d++; active[d] = false }
    else if (isP(t, ')')) { active[d] = false; d = Math.max(0, d - 1) }
    else if (isP(t, ';')) { active.length = 0; d = 0 }
    else if (isKw(t, 'with')) {
      let j = i + 1
      if (isKw(toks[j], 'recursive')) j++
      if (isCteHead(toks, j)) { heads.add(j); active[d] = true }
    } else if (isP(t, ',') && active[d] && isCteHead(toks, i + 1)) heads.add(i + 1)
  }
  return heads
}

export function referencedResults(sql: string, names: string[]): string[] {
  if (!names.length) return []
  const byLower = new Map<string, string>()
  for (const n of names) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n)
  const toks = lex(sql)
  const heads = cteNames(toks)
  const shadow = new Set<string>()
  for (const h of heads) shadow.add(toks[h].v)
  const found = new Set<string>()
  const out: string[] = []
  const ENDS = new Set(['where', 'group', 'order', 'having', 'limit', 'union', 'intersect', 'except', 'window', 'on', 'using', 'select', 'with', 'set', 'values', 'returning'])
  const inFrom: boolean[] = [false]
  let expect = false
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const d = inFrom.length - 1
    if (t.kind === 'p') {
      if (t.v === '(') { inFrom.push(expect); continue }
      expect = false
      if (t.v === ')') { if (inFrom.length > 1) inFrom.pop() }
      else if (t.v === ';') { inFrom.length = 1; inFrom[0] = false }
      else if (t.v === ',' && inFrom[d]) expect = true
      continue
    }
    if (!expect) {
      if (!t.quoted) {
        if (t.v === 'from' || t.v === 'join') { inFrom[d] = true; expect = true }
        else if (t.v === 'into' || t.v === 'update') expect = true
        else if (ENDS.has(t.v)) inFrom[d] = false
      }
      continue
    }
    expect = false
    let k = i
    if (isP(toks[k + 1], '.') && toks[k + 2]?.kind === 'id') {
      if (t.quoted || (t.v !== 'main' && t.v !== 'temp')) { i = k + 2; continue }
      k += 2
      i = k
    }
    const c = toks[k]
    if (heads.has(k) || isP(toks[k + 1], '(') || shadow.has(c.v)) continue
    const name = byLower.get(c.v)
    if (name !== undefined && !found.has(name)) { found.add(name); out.push(name) }
  }
  return out
}

export function upstreamOf(block: Block, blocks: Block[]): Block[] {
  if (!isResultsBlock(block)) return []
  const byName = new Map<string, Block[]>()
  const idx = new Map<Block, number>()
  blocks.forEach((b, k) => {
    idx.set(b, k)
    const n = resultNameOf(b)
    if (n === undefined) return
    const key = n.toLowerCase()
    const l = byName.get(key)
    if (l) l.push(b)
    else byName.set(key, [b])
  })
  const me = idx.get(block) ?? blocks.findIndex((b) => b.id === block.id)
  const refs = referencedResults(block.content ?? '', [...byName.values()].map((l) => resultNameOf(l[0])!))
  const res: Block[] = []
  for (const name of refs) {
    const defs = byName.get(name.toLowerCase())!
    if (defs.length > 1) throw new DepError('DUPLICATE', block.id, name)
    const d = defs[0]
    if (d === block || d.id === block.id) throw new DepError('SELF', block.id, name)
    if ((idx.get(d) ?? 0) > me) throw new DepError('FORWARD', block.id, name)
    res.push(d)
  }
  return res.sort((x, y) => idx.get(x)! - idx.get(y)!)
}
