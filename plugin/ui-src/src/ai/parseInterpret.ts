import { parseInterpretation, type Parsed } from './parse'

export const INTERPRET_MARKERS = { answer: 'ANSWER:', update: 'UPDATE:' } as const

export type InterpretReply = { kind: 'answer'; text: string } | { kind: 'update'; markdown: string }

// The marker must open the reply. Bare markers are upper-case only so prose like "Update: the table has 3 rows" or a
// "# Update: Q3" heading is not mistaken for one; other casings count only when wrapped in ** or backticks.
const KW = '(answer|update|回答|更新)'
const BARE = new RegExp(`^(?!\\s*\`\`\`)[\\s>]*(?:\\*\\*|\`)?(ANSWER|UPDATE|回答|更新)(?:\\*\\*|\`)?[ \\t]*[:：](?:\\*\\*|\`)?[ \\t]*`)
const WRAPPED = new RegExp(`^(?!\\s*\`\`\`)[\\s>]*(?:\\*\\*|\`)[ \\t]*${KW}[ \\t]*(?:[:：][ \\t]*(?:\\*\\*|\`)|(?:\\*\\*|\`)[ \\t]*[:：])[ \\t]*`, 'i')

export function parseInterpretReply(text: string, opts: { truncated: boolean; force: boolean }): Parsed<InterpretReply> {
  const base = parseInterpretation(text, { truncated: opts.truncated })
  if (!base.ok) return base
  const raw = base.value.markdown
  const m = BARE.exec(raw) ?? WRAPPED.exec(raw)
  const marker = m ? (/^(answer|回答)$/i.test(m[1]) ? 'answer' : 'update') : null
  const body = m ? raw.slice(m[0].length).trim() : raw
  const ok = (value: InterpretReply): Parsed<InterpretReply> => ({ ok: true, value, warnings: [] })
  if (opts.force) return body ? ok({ kind: 'update', markdown: body }) : { ok: false, reason: 'empty' }
  if (marker === 'update' && body) return ok({ kind: 'update', markdown: body })
  if (marker === 'answer') return ok({ kind: 'answer', text: body || raw })
  // unmarked replies never change the interpretation: an update needs an explicit UPDATE: (or a forced turn)
  return ok({ kind: 'answer', text: raw })
}
