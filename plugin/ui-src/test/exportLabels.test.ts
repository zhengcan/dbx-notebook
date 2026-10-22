import { describe, it, expect, beforeEach } from 'vitest'
import { buildExportLabels } from '../src/export/labels'
import { messages, setLocale, t } from '../src/i18n'

const tt = (k: string, p?: Record<string, unknown>) => t(k as any, p as any)
const KEYS = ['empty', 'exportedAt', 'dataRunAt', 'dataSource', 'chartUnavailable', 'noData', 'page', 'serial', 'summary', 'continued', 'colon', 'listSep', 'notSet']

describe('buildExportLabels', () => {
  for (const loc of ['zh-CN', 'en']) {
    it(`complete in ${loc}`, () => {
      setLocale(loc)
      const L: any = buildExportLabels(tt)
      for (const k of KEYS) expect(typeof L[k] === 'string' && L[k].length > 0, k).toBe(true)
      expect(L.firstN(50, 120)).toContain('50')
      expect(L.firstN(50, 120)).toContain('120')
      expect(L.truncatedAtRun(5000)).toContain('5000')
      expect(L.firstN(50, 120)).not.toMatch(/\{/)
      for (const k of KEYS) expect(L[k], k).not.toMatch(/[{}]/)
      for (const v of [L.firstN(50, 120), L.truncatedAtRun(5000)]) expect(v).not.toMatch(/[{}]/)
      if (loc === 'en') for (const k of KEYS) expect(L[k]).not.toMatch(/[：；]/)
    })
  }
  it('zh/en exp.* key parity', () => {
    const f = (o: object) => Object.keys(o).filter((k) => k.startsWith('exp.')).sort()
    expect(f(messages['zh-CN'])).toEqual(f(messages.en))
  })
})
