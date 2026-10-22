import { describe, it, expect } from 'vitest'
import { dateComparisonHint } from '../src/run/hints'

const vars = [{ name: 'date', inputType: 'date' }, { name: 'n', inputType: 'number' }]
describe('dateComparisonHint', () => {
  it.each([
    'select * from t where c <= {{date}}',
    'select * from t where c = {{ date }}',
    'select * from t where c == {{date}}',
    'select * from t where c BETWEEN {{n}} and {{date}}',
    'select * from t where c between x\n AND {{date}}',
  ])('flags %s', (s) => expect(dateComparisonHint(s, vars)).toBe(true))
  it.each([
    'select * from t where c < {{date}}',
    'select * from t where c >= {{date}}',
    'select * from t where c > {{date}}',
    'select * from t where c <> {{date}}',
    'select * from t where c != {{date}}',
    'select * from t where c <= {{n}}',
    'select * from t where c <= {{other}}',
    'select 1',
  ])('does not flag %s', (s) => expect(dateComparisonHint(s, vars)).toBe(false))
  it('needs a date input', () => expect(dateComparisonHint('c <= {{n}}', [{ name: 'n', inputType: 'text' }])).toBe(false))
})
