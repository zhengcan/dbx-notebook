import { describe, it, expect } from 'vitest'
import { splitPath, joinPath, withExt, suggestFileName } from '../src/export/exportPath'

describe('exportPath', () => {
  it('splits posix and windows paths', () => {
    expect(splitPath('/a/b/r.pdf')).toEqual({ folder: '/a/b', name: 'r.pdf' })
    expect(splitPath('C:\\Users\\me\\r.html')).toEqual({ folder: 'C:\\Users\\me', name: 'r.html' })
    expect(splitPath('/r.pdf')).toEqual({ folder: '/', name: 'r.pdf' })
    expect(splitPath('r.pdf')).toEqual({ folder: '', name: 'r.pdf' })
    expect(splitPath('')).toEqual({ folder: '', name: '' })
  })
  it('joins with the folder separator style', () => {
    expect(joinPath('/a/b', 'r.pdf')).toBe('/a/b/r.pdf')
    expect(joinPath('/a/b/', 'r.pdf')).toBe('/a/b/r.pdf')
    expect(joinPath('/', 'r.pdf')).toBe('/r.pdf')
    expect(joinPath('C:\\x', 'r.pdf')).toBe('C:\\x\\r.pdf')
    expect(joinPath('', 'r.pdf')).toBe('r.pdf')
  })
  it('swaps the extension for the chosen format', () => {
    expect(withExt('r.pdf', 'html')).toBe('r.html')
    expect(withExt('r.HTML', 'pdf')).toBe('r.pdf')
    expect(withExt('r', 'pdf')).toBe('r.pdf')
    expect(withExt('my.report', 'pdf')).toBe('my.report.pdf')
    expect(withExt('', 'pdf')).toBe('')
  })
  it('suggests <file name>-<yyyyMMdd-HHmmss>.<ext>', () => {
    const d = new Date(2026, 9, 20, 8, 5, 9)
    expect(suggestFileName('sales.sqlnb', d, 'html', 'Untitled')).toBe('sales-20261020-080509.html')
    expect(suggestFileName('sales.sqlnb', d, 'pdf', 'Untitled')).toBe('sales-20261020-080509.pdf')
    expect(suggestFileName('', d, 'pdf', 'Untitled')).toBe('Untitled-20261020-080509.pdf')
    expect(suggestFileName('a/b:c?.sqlnb', d, 'pdf', 'Untitled')).toBe('abc-20261020-080509.pdf')
    expect(suggestFileName('销售报表.sqlnb', d, 'pdf', 'Untitled')).toBe('销售报表-20261020-080509.pdf')
  })
})
