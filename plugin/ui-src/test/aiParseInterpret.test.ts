import { describe, it, expect } from 'vitest'
import { parseInterpretReply, INTERPRET_MARKERS } from '../src/ai/parseInterpret'
import { MAX_OUTPUT_CHARS } from '../src/ai/parse'

const p = (t: string, force = false, truncated = false) => parseInterpretReply(t, { truncated, force })
const v = (t: string, force = false) => { const r = p(t, force); if (!r.ok) throw new Error(r.reason); return r.value }

describe('parseInterpretReply', () => {
  it('markers constant', () => { expect(INTERPRET_MARKERS).toEqual({ answer: 'ANSWER:', update: 'UPDATE:' }) })
  it('UPDATE: marker variants', () => {
    for (const x of ['UPDATE: # T', 'UPDATE：# T', '**update:** # T', '`Update:`\n# T', '**UPDATE:** # T', '`UPDATE:`\n# T', '更新：# T', '> UPDATE: # T']) expect(v(x), x).toEqual({ kind: 'update', markdown: '# T' })
  })
  it('ANSWER: variants', () => {
    for (const x of ['ANSWER: hi', 'ANSWER：hi', '**answer:** hi', '**ANSWER:** hi', '`ANSWER:`\nhi', '回答：hi']) expect(v(x), x).toEqual({ kind: 'answer', text: 'hi' })
  })
  it('unmarked replies are always ANSWER on chat turns: headings, bullet lists, long prose', () => {
    expect(v('Three reasons:\n- a\n- b\n- c')).toEqual({ kind: 'answer', text: 'Three reasons:\n- a\n- b\n- c' })
    expect(v('## Why\n\nBecause.').kind).toBe('answer')
    expect(v('x '.repeat(3000)).kind).toBe('answer')
    expect(v('Because of X.').kind).toBe('answer')
  })
  it('headings / prose that merely contain the word are not markers', () => {
    for (const x of ['# Update: Q3 results', 'Update: the table has 3 rows', 'Answer: maybe', '## UPDATE: x']) expect(v(x).kind, x).toBe('answer')
  })
  it('forced empty UPDATE body is an error, never the literal marker', () => {
    expect(p('UPDATE:', true)).toEqual({ ok: false, reason: 'empty' })
    expect(p('**UPDATE:**', true)).toEqual({ ok: false, reason: 'empty' })
  })
  it('a marker inside a code fence is not a marker', () => {
    expect(v('```\nUPDATE: x\n```').kind).toBe('answer')
  })
  it('force: unmarked prose and even ANSWER-marked text are treated as update', () => {
    expect(v('plain', true)).toEqual({ kind: 'update', markdown: 'plain' })
    expect(v('ANSWER: plain', true)).toEqual({ kind: 'update', markdown: 'plain' })
    expect(v('UPDATE: # T', true)).toEqual({ kind: 'update', markdown: '# T' })
  })
  it('ANSWER containing a full interpretation is still an answer', () => {
    expect(v('ANSWER: # H\n- a\n- b\n- c').kind).toBe('answer')
  })
  it('empty UPDATE body falls back to answer of the raw text', () => {
    expect(v('UPDATE:')).toEqual({ kind: 'answer', text: 'UPDATE:' })
  })
  it('truncated / empty / too-long fail', () => {
    expect(p('x', false, true)).toEqual({ ok: false, reason: 'truncated' })
    expect(p('  ')).toEqual({ ok: false, reason: 'empty' })
    expect(p('x'.repeat(MAX_OUTPUT_CHARS + 1))).toEqual({ ok: false, reason: 'too-long' })
  })
})
