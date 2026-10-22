import { describe, it, expect } from 'vitest'
import { relocateRange } from '../src/markdown/anchor'

describe('relocateRange', () => {
  it('unchanged text keeps the range', () => {
    expect(relocateRange('hello', { from: 2, to: 3 }, 'hello')).toEqual({ from: 2, to: 3, exact: true })
  })
  it('typing after the range leaves it, typing before shifts it', () => {
    expect(relocateRange('hello world', { from: 5, to: 5 }, 'hello world!!')).toEqual({ from: 5, to: 5, exact: true })
    expect(relocateRange('hello world', { from: 5, to: 5 }, 'XXhello world')).toEqual({ from: 7, to: 7, exact: true })
    expect(relocateRange('hello world', { from: 6, to: 11 }, 'hi hello world')).toEqual({ from: 9, to: 14, exact: true })
  })
  it('deleting before shifts left', () => {
    expect(relocateRange('abcdef', { from: 4, to: 4 }, 'cdef')).toEqual({ from: 2, to: 2, exact: true })
  })
  it('an insertion exactly at the caret stays after the pasted image', () => {
    expect(relocateRange('ab', { from: 1, to: 1 }, 'aXb')).toEqual({ from: 1, to: 1, exact: true })
  })
  it('an edit inside the selected range cannot be relocated: caret fallback', () => {
    expect(relocateRange('hello world', { from: 2, to: 8 }, 'helXlo world')).toEqual({ from: 12, to: 12, exact: false })
    expect(relocateRange('hello', { from: 2, to: 2 }, 'hZZ')).toEqual({ from: 3, to: 3, exact: false })
  })
  it('fallback uses the supplied current caret, clamped', () => {
    expect(relocateRange('abc', { from: 1, to: 2 }, 'a1c', 1)).toEqual({ from: 1, to: 1, exact: false })
    expect(relocateRange('abc', { from: 1, to: 2 }, 'a1c', 99)).toEqual({ from: 3, to: 3, exact: false })
  })
})
