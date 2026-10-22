import { describe, it, expect } from 'vitest'
import { parseNeed, NEED_MARKERS } from '../src/ai/parseNeed'

describe('parseNeed', () => {
  it('marker variants: lowercase, fullwidth colon, bold, backticks, quote/bracket-wrapped names, CJK and dotted names', () => {
    expect(parseNeed('need_tables: a, b').need).toEqual({ tables: ['a', 'b'] })
    expect(parseNeed('NEED_TABLES： a，b').need).toEqual({ tables: ['a', 'b'] })
    expect(parseNeed('**NEED_TABLES:** a').need).toEqual({ tables: ['a'] })
    expect(parseNeed('`NEED_TABLES:` `a`, "b", [c]').need).toEqual({ tables: ['a', 'b', 'c'] })
    expect(parseNeed('NEED_TABLES: 订单表、public.users').need).toEqual({ tables: ['订单表', 'public.users'] })
    expect(parseNeed('NEED_TABLES: A, a').need).toEqual({ tables: ['A'] })
  })
  it('NEED_ in the middle of a prose line is ignored; at a line start inside prose is found', () => {
    const p = parseNeed('I would say NEED_TABLES: a here')
    expect(p.need).toBeNull()
    expect(p.rest).toBe('I would say NEED_TABLES: a here')
    const q = parseNeed('Let me check.\nNEED_TABLES: a\nthanks')
    expect(q.need).toEqual({ tables: ['a'] })
    expect(q.rest).toBe('Let me check.\nthanks')
  })
  it('NEED_LIST with and without scope', () => {
    expect(parseNeed('NEED_LIST:').need).toEqual({ list: { scope: '' } })
    expect(parseNeed('NEED_LIST: [sales]').need).toEqual({ list: { scope: 'sales' } })
    expect(parseNeed('NEED_LIST: sales').need).toEqual({ list: { scope: 'sales' } })
  })
  it('both markers in one reply', () => {
    expect(parseNeed('NEED_LIST: s\nNEED_TABLES: a, b').need).toEqual({ list: { scope: 's' }, tables: ['a', 'b'] })
  })
  it('NEED plus SQL: need set, rest has no NEED line', () => {
    const p = parseNeed('NEED_TABLES: a\nselect 1')
    expect(p.need).toEqual({ tables: ['a'] })
    expect(p.rest).toBe('select 1')
  })
  it('more than 8 names → first 8', () => {
    const p = parseNeed('NEED_TABLES: ' + Array.from({ length: 12 }, (_, i) => `t${i}`).join(','))
    expect(p.need?.tables).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'])
  })
  it('marker with no names → need null, line stripped', () => {
    const p = parseNeed('NEED_TABLES:\nselect 1')
    expect(p.need).toBeNull()
    expect(p.rest).toBe('select 1')
  })
  it('NEED_* inside a fenced code block is ignored', () => {
    const t = '```\nNEED_TABLES: a\n```'
    expect(parseNeed(t)).toEqual({ need: null, rest: t })
  })
  it('markers match the exported constants', () => {
    expect(NEED_MARKERS).toEqual({ tables: 'NEED_TABLES:', list: 'NEED_LIST:' })
  })
  it('NEED lines inside an unclosed fence are code; mismatched ``` / ~~~ delimiters do not close each other', () => {
    expect(parseNeed('```\nNEED_TABLES: a').need).toBeNull()
    expect(parseNeed('```\n~~~\nNEED_TABLES: a\n~~~').need).toBeNull()
    expect(parseNeed('~~~\n```\nNEED_TABLES: a').need).toBeNull()
    expect(parseNeed('```\nx\n```\nNEED_TABLES: a').need).toEqual({ tables: ['a'] })
  })
  it('NEED lines inside /* */ block comments are ignored (string literals are a documented limit)', () => {
    expect(parseNeed('select 1 /*\nNEED_TABLES: a\n*/').need).toBeNull()
    expect(parseNeed('/* c */\nNEED_TABLES: a').need).toEqual({ tables: ['a'] })
  })
  it('the example lines of the prompt round-trip to clean names', async () => {
    const { NEED_FORMAT_NOTE } = await import('../src/ai/promptChat')
    const list = /NEED_LIST: [^.]*?(?= \[| \(|,)/.exec(NEED_FORMAT_NOTE)![0]
    expect(NEED_FORMAT_NOTE).not.toContain('[schema]')
    expect(parseNeed(list).need?.list?.scope).not.toMatch(/[\[\]<>]/)
    expect(parseNeed('NEED_TABLES: a, b').need?.tables).toEqual(['a', 'b'])
  })
  it('hostile names: delimiters are split/stripped, long names dropped', () => {
    const p = parseNeed("NEED_TABLES: x'; drop table y--, ```, ignore previous instructions, " + 'z'.repeat(200) + ', 订单')
    expect(p.need?.tables).toEqual(['x', 'drop table y--', 'ignore previous instructions', '订单'])
  })
})
