import { describe, it, expect } from 'vitest'
import { safeStringify, rawDetail, targetExistsBranch, isTargetExists } from '../src/export/exportClient'

describe('safeStringify', () => {
  it('serialises plain and Error objects with message and code', () => {
    const e = Object.assign(new Error('boom'), { rpcCode: -32013 })
    const o = JSON.parse(safeStringify(e))
    expect(o.message).toBe('boom')
    expect(o.rpcCode).toBe(-32013)
  })
  it('survives circular references, bigint, functions and throwing getters', () => {
    const a: any = { n: 1n, f() {}, }
    a.self = a
    Object.defineProperty(a, 'bad', { enumerable: true, get() { throw new Error('nope') } })
    expect(() => safeStringify(a)).not.toThrow()
    expect(safeStringify(a)).toContain('Circular')
  })
  it('never throws for undefined/null/symbol', () => {
    expect(safeStringify(undefined)).toBe('undefined')
    expect(safeStringify(null)).toBe('null')
    expect(typeof safeStringify(Symbol('x'))).toBe('string')
  })
})

describe('rawDetail', () => {
  it('formats [rpcCode] message', () => {
    expect(rawDetail(Object.assign(new Error('Cannot write'), { rpcCode: -32013 }))).toBe('[-32013] Cannot write')
  })
  it('falls back to code, then error.code, then n/a', () => {
    expect(rawDetail({ code: 'EXPORT_FAILED', message: 'x' })).toBe('[EXPORT_FAILED] x')
    expect(rawDetail({ error: { code: 5, message: 'y' } })).toBe('[5] y')
    expect(rawDetail('plain')).toBe('[n/a] plain')
  })
})

describe('targetExistsBranch', () => {
  it('names the branch that recognised the refusal', () => {
    expect(targetExistsBranch({ rpcCode: -32030 })).toBe('rpcCode')
    expect(targetExistsBranch({ code: 'TARGET_EXISTS' })).toBe('code')
    expect(targetExistsBranch({ error: { code: -32030 } })).toBe('error.code')
    expect(targetExistsBranch({ data: { code: 'TARGET_EXISTS' } })).toBe('data.code')
    expect(targetExistsBranch(new Error('x -32030'))).toBe('message')
    expect(targetExistsBranch(new Error('other'))).toBeNull()
    expect(isTargetExists({ rpcCode: -32030 })).toBe(true)
  })
})
