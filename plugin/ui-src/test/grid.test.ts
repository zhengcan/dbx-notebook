import { describe, it, expect } from 'vitest'
import { cellKind, cellText, isLongCell } from '../src/blocks/grid/format'
import { normalize, selectCell, extendTo, selectRow, selectColumn, selectAll, move } from '../src/blocks/grid/selection'
import { toTsv } from '../src/blocks/grid/copy'
import { initialWidths, clampWidth } from '../src/blocks/grid/columnWidths'

describe('format', () => {
  it('cellKind', () => {
    expect(cellKind(null)).toBe('null')
    expect(cellKind(undefined)).toBe('null')
    expect(cellKind(1)).toBe('number')
    expect(cellKind(true)).toBe('boolean')
    expect(cellKind('12')).toBe('string')
    expect(cellKind({ a: 1 })).toBe('json')
    expect(cellKind([1])).toBe('json')
  })
  it('cellText', () => {
    expect(cellText(null)).toBe('')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText(5)).toBe('5')
    expect(cellText(false)).toBe('false')
  })
  it('isLongCell', () => {
    expect(isLongCell('x'.repeat(201))).toBe(true)
    expect(isLongCell('x'.repeat(200))).toBe(false)
    expect(isLongCell('a\nb')).toBe(true)
    expect(isLongCell({ a: 1 })).toBe(true)
    expect(isLongCell('abc')).toBe(false)
  })
})

describe('selection', () => {
  it('normalize', () => {
    expect(normalize({ r0: 3, c0: 4, r1: 1, c1: 2 })).toEqual({ r0: 1, c0: 2, r1: 3, c1: 4 })
    expect(normalize(null)).toBeNull()
  })
  it('select helpers', () => {
    expect(selectCell(2, 3)).toEqual({ r0: 2, c0: 3, r1: 2, c1: 3 })
    expect(selectRow(2, 5)).toEqual({ r0: 2, c0: 0, r1: 2, c1: 4 })
    expect(selectColumn(1, 7)).toEqual({ r0: 0, c0: 1, r1: 6, c1: 1 })
    expect(selectAll(3, 4)).toEqual({ r0: 0, c0: 0, r1: 2, c1: 3 })
    expect(extendTo(selectCell(1, 1), 3, 0)).toEqual({ r0: 1, c0: 1, r1: 3, c1: 0 })
  })
  it('move clamps', () => {
    expect(move(selectCell(0, 0), -1, -1, 3, 3, false)).toEqual(selectCell(0, 0))
    expect(move(selectCell(2, 2), 1, 1, 3, 3, false)).toEqual(selectCell(2, 2))
    expect(move(selectCell(1, 1), 1, 0, 3, 3, false)).toEqual(selectCell(2, 1))
  })
  it('move extend keeps anchor', () => {
    const s = move(selectCell(1, 1), 1, 1, 5, 5, true)
    expect(s).toEqual({ r0: 1, c0: 1, r1: 2, c1: 2 })
    expect(move(s, 5, 5, 5, 5, true)).toEqual({ r0: 1, c0: 1, r1: 4, c1: 4 })
  })
  it('move with null sel / empty grid', () => {
    expect(move(null, 1, 1, 3, 3, false)).toEqual(selectCell(0, 0))
    expect(move(null, 1, 1, 0, 0, false)).toBeNull()
  })
})

describe('toTsv', () => {
  const rows = [['a', 1, null], ['b\tc', 'x\ny', 'q"r']]
  it('single cell and rectangle', () => {
    expect(toTsv(rows, selectCell(0, 1))).toBe('1')
    expect(toTsv(rows, { r0: 0, c0: 0, r1: 1, c1: 0 })).toBe('a\n"b\tc"')
  })
  it('null is empty, escapes', () => {
    expect(toTsv(rows, selectAll(2, 3))).toBe('a\t1\t\n"b\tc"\t"x\ny"\t"q""r"')
    expect(toTsv([['a\rb']], selectCell(0, 0))).toBe('"a\rb"')
  })
  it('header', () => {
    expect(toTsv(rows, selectAll(2, 3), { withHeader: ['h1', 'h"2', 'h3'] }).split('\n')[0]).toBe('h1\t"h""2"\th3')
    expect(toTsv(rows, selectCell(1, 1), { withHeader: ['h1', 'h2', 'h3'] })).toBe('h2\n"x\ny"')
  })
  it('empty selection', () => {
    expect(toTsv(rows, null)).toBe('')
    expect(toTsv([], selectAll(0, 0))).toBe('')
  })
})

describe('columnWidths', () => {
  it('initialWidths within [80,320]', () => {
    const w = initialWidths([{ name: 'a' }, { name: 'x'.repeat(100) }, { name: 'n' }], [[1, 'y'.repeat(500), 3]])
    expect(w).toHaveLength(3)
    expect(w[0]).toBe(80)
    expect(w[1]).toBe(320)
    expect(w.every((x) => x >= 80 && x <= 320)).toBe(true)
  })
  it('handles empty', () => {
    expect(initialWidths([], [])).toEqual([])
    expect(initialWidths([{ name: 'a' }], [])).toEqual([80])
  })
  it('clampWidth', () => {
    expect(clampWidth(10)).toBe(48)
    expect(clampWidth(5000)).toBe(800)
    expect(clampWidth(100)).toBe(100)
  })
})

describe('hardening', () => {
  it('toTsv clamps columns to data (instant on huge selection)', () => {
    const t0 = Date.now()
    expect(toTsv([['a', 'b']], { r0: 0, c0: 0, r1: 0, c1: 1e9 })).toBe('a\tb')
    expect(toTsv([['a']], { r0: 0, c0: 0, r1: 1e9, c1: 1e9 })).toBe('a')
    expect(toTsv([['a']], { r0: 0, c0: 0, r1: 0, c1: 1e9 }, { withHeader: ['x', 'y'] })).toBe('x\ty\na\t')
    expect(Date.now() - t0).toBeLessThan(200)
  })
  it('toTsv reversed/out-of-range/negative', () => {
    const rows = [['a', 'b'], ['c', 'd']]
    expect(toTsv(rows, { r0: 1, c0: 1, r1: 0, c1: 0 })).toBe(toTsv(rows, { r0: 0, c0: 0, r1: 1, c1: 1 }))
    expect(toTsv(rows, { r0: 5, c0: 5, r1: 9, c1: 9 })).toBe('')
    expect(toTsv(rows, { r0: -3, c0: -3, r1: 0, c1: 0 })).toBe('a')
  })
  it('cellText robust', () => {
    expect(cellText({ a: 1n })).toBe('[object Object]')
    const o: any = {}; o.self = o
    expect(cellText(o)).toBe('[object Object]')
    expect(cellText(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(cellKind(new Date(0))).toBe('string')
    expect(cellText({ toJSON: () => undefined })).toBe('[object Object]')
    expect(isLongCell(new Date(0))).toBe(false)
  })
  it('selection edge cases', () => {
    expect(selectRow(1, 0)).toBeNull()
    expect(selectColumn(1, 0)).toBeNull()
    expect(move(selectCell(1, 1), NaN, Infinity, 3, 3, false)).toEqual(selectCell(1, 1))
    expect(move({ r0: 9, c0: 9, r1: 1, c1: 1 }, 0, 0, 3, 3, true)).toEqual({ r0: 2, c0: 2, r1: 1, c1: 1 })
  })
  it('initialWidths tolerant', () => {
    expect(initialWidths([{ name: 5 as any }, { name: undefined as any }], [null as any, [1], [1, 2, 3]])).toEqual([80, 80])
  })
})
