import { describe, it, expect } from 'vitest'
import { splitDbxBoilerplate, isMissingObjectError } from '../src/run/errorHints'

const B = 'SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.'
describe('splitDbxBoilerplate', () => {
  it('splits the exact PG message', () => {
    const r = splitDbxBoilerplate(`ERROR: relation "xxx" does not exist ${B}`)
    expect(r.main).toBe('ERROR: relation "xxx" does not exist')
    expect(r.redacted).toBe(B)
  })
  it('no boilerplate', () => {
    expect(splitDbxBoilerplate('  boom ')).toEqual({ main: 'boom' })
  })
  it('multiple sentences keep everything after', () => {
    const r = splitDbxBoilerplate(`A failed. B too. ${B} Extra tail.`)
    expect(r.main).toBe('A failed. B too.')
    expect(r.redacted).toBe(`${B} Extra tail.`)
  })
  it('empty', () => { expect(splitDbxBoilerplate('')).toEqual({ main: '' }) })
})
describe('isMissingObjectError', () => {
  it.each(['relation "x" does not exist', "Table 'a.b' doesn't exist", '表 x 不存在', 'Unknown database foo', 'undefined column y', 'no such table: t', 'Invalid object name x'])('matches %s', (m) => {
    expect(isMissingObjectError(m)).toBe(true)
  })
  it.each(['syntax error at or near "x"', 'permission denied for table t', ''])('not %s', (m) => {
    expect(isMissingObjectError(m)).toBe(false)
  })
})
