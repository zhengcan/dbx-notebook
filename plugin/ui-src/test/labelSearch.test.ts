import { describe, it, expect } from 'vitest'
import { filterCategories, SEARCH_CAP } from '../src/analysis/labelSearch'

const keys = ['AB-1', '线上渠道', '1', '0', 'x(1)', 'a[b', 'c\\d']
describe('filterCategories', () => {
  it('case-insensitive ASCII', () => expect(filterCategories(keys, undefined, 'ab', 200).keys).toEqual(['AB-1']))
  it('CJK substring', () => expect(filterCategories(keys, undefined, '渠', 200).keys).toEqual(['线上渠道']))
  it('matches display text, not only key', () => expect(filterCategories(keys, { '1': '是' }, '是', 200).keys).toEqual(['1']))
  it('empty and whitespace query = all', () => {
    expect(filterCategories(keys, undefined, '', 200).keys).toEqual(keys)
    expect(filterCategories(keys, undefined, '   ', 200).keys).toEqual(keys)
  })
  it('trims', () => expect(filterCategories(keys, undefined, '  ab ', 200).keys).toEqual(['AB-1']))
  it('no match', () => expect(filterCategories(keys, undefined, 'zzz', 200)).toEqual({ keys: [], total: 0, capped: false }))
  it('regex specials are literal', () => {
    expect(filterCategories(keys, undefined, '(', 200).keys).toEqual(['x(1)'])
    expect(filterCategories(keys, undefined, '[', 200).keys).toEqual(['a[b'])
    expect(filterCategories(keys, undefined, '\\', 200).keys).toEqual(['c\\d'])
    expect(filterCategories(keys, undefined, '.*', 200).keys).toEqual([])
  })
  it('very long query', () => expect(filterCategories(keys, undefined, 'a'.repeat(100000), 200).keys).toEqual([]))
  it('caps at 200 but reports total', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `k${i}`)
    const t0 = performance.now()
    const r = filterCategories(many, { k1: '甲' }, 'k', SEARCH_CAP)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(r.keys.length).toBe(200)
    expect(r.total).toBe(5000)
    expect(r.capped).toBe(true)
  })
  it('120 keys uncapped', () => {
    const r = filterCategories(Array.from({ length: 120 }, (_, i) => `k${i}`), undefined, 'k', 200)
    expect(r.keys.length).toBe(120); expect(r.capped).toBe(false)
  })
  it('does not match inherited props as labels', () => expect(filterCategories(['a'], {}, 'constructor', 200).keys).toEqual([]))
})
