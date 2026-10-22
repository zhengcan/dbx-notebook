import { describe, it, expect } from 'vitest'
import { buildChatPrompt } from '../src/ai/promptChat'
import type { ChatMessage } from '../src/ai/chatTypes'

const msgs = (): ChatMessage[] => [
  { id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'q1' }, { kind: 'data', text: 'DATAPROBE' }], at: 1 },
  { id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: 'SELECT SQLPROBE FROM t' }], sqlAfter: 'SELECT SQLPROBE FROM t', at: 2 },
  { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: 'Why: uses SQLPROBE2' }], sqlAfter: 'SELECT SQLPROBE2', at: 3 },
  { id: 'a3', role: 'assistant', parts: [{ kind: 'text', text: 'MDPROBE text' }], markdownAfter: 'MDPROBE text', at: 4 },
  { id: 'a4', role: 'assistant', parts: [{ kind: 'text', text: 'note\nCHARTPROBE' }], chartAfter: '{"x":"CHARTPROBE"}', at: 5 },
]

describe('history privacy matrix', () => {
  for (let m = 0; m < 8; m++) {
    const send = { schema: !!(m & 1), sql: !!(m & 2), data: !!(m & 4) }
    it(`schema=${send.schema} sql=${send.sql} data=${send.data}`, () => {
      const p = buildChatPrompt({ locale: 'en', dialect: 'pg', send, purpose: 'sql', schemas: [], history: msgs(), userText: 'next' }).text
      expect(p.includes('SQLPROBE')).toBe(send.sql)
      expect(p.includes('SQLPROBE2')).toBe(send.sql)
      expect(p.includes('DATAPROBE')).toBe(send.data)
      expect(p.includes('MDPROBE')).toBe(send.data)
      expect(p.includes('CHARTPROBE')).toBe(send.data)
    })
  }
})
