import { MAX_NEED_TABLES } from './catalog'

export const NEED_MARKERS = { tables: 'NEED_TABLES:', list: 'NEED_LIST:' } as const

export type NeedRequest = { tables?: string[]; list?: { scope: string } }

const LINE = /^[\s*`>#-]*NEED[_ ]?(TABLES?|LIST)[*`]*\s*[:：](.*)$/i
const FENCE = /^[ \t]*(```|~~~)/
const MAX_NAME = 128

function names(arg: string): string[] {
  const out: string[] = []
  for (const raw of arg.split(/[,，、;；]/)) {
    const n = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^[\s"'`“”‘’\[\]()*<>]+|[\s"'`“”‘’\[\]()*<>.]+$/g, '')
    if (!n || n.length > MAX_NAME) continue
    if (out.some((o) => o.toLowerCase() === n.toLowerCase())) continue
    out.push(n)
    if (out.length >= MAX_NEED_TABLES) break
  }
  return out
}

export function parseNeed(text: string): { need: NeedRequest | null; rest: string } {
  const kept: string[] = []
  const tables: string[] = []
  let list: { scope: string } | undefined
  let fence = ''
  let inComment = false
  // Limit (documented): single-quoted SQL string literals are not tracked, as a prose apostrophe would otherwise hide real NEED lines.
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(line)
    if (f && (!fence || fence === f[1])) { fence = fence ? '' : f[1]; kept.push(line); continue }
    const wasComment = inComment
    if (!fence) {
      let i = 0
      for (let j = line.indexOf(inComment ? '*/' : '/*'); ; j = line.indexOf(inComment ? '*/' : '/*', i)) {
        if (j < 0) break
        inComment = !inComment
        i = j + 2
      }
    }
    const m = fence || wasComment ? null : LINE.exec(line)
    if (!m) { kept.push(line); continue }
    if (/^LIST$/i.test(m[1])) {
      const scope = names(m[2])[0]
      list = { scope: scope ?? '' }
    } else {
      for (const n of names(m[2])) if (tables.length < MAX_NEED_TABLES && !tables.some((o) => o.toLowerCase() === n.toLowerCase())) tables.push(n)
    }
  }
  const rest = kept.join('\n').trim()
  const need: NeedRequest = {}
  if (list) need.list = list
  if (tables.length) need.tables = tables
  return { need: need.list || need.tables ? need : null, rest }
}
