import { describe, it, expect } from 'vitest'
import { messages, setLocale, t } from '../src/i18n'

const keys = (l: 'zh-CN' | 'en') => Object.keys(messages[l]).filter((k) => k.startsWith('mdtb.') || k === 'history.label.mdFormat').sort()

describe('mdtb labels', () => {
  it('same key set, non-empty, in zh-CN and en', () => {
    expect(keys('zh-CN')).toEqual(keys('en'))
    expect(keys('en').length).toBeGreaterThanOrEqual(21)
    for (const l of ['zh-CN', 'en'] as const) for (const k of keys(l)) expect((messages[l] as any)[k].length, `${l} ${k}`).toBeGreaterThan(0)
  })
  it('bold/italic/link titles use the {mod} shortcut placeholder', () => {
    for (const l of ['zh-CN', 'en'] as const) {
      setLocale(l)
      expect(t('mdtb.bold', { mod: 'Ctrl+' })).toContain('Ctrl+B')
      expect(t('mdtb.italic', { mod: '⌘' })).toContain('⌘I')
      expect(t('mdtb.link', { mod: '⌘' })).toContain('⌘K')
    }
    setLocale('zh-CN')
  })
  it('the English placeholders contain no CJK; the Chinese ones are Chinese', () => {
    const cjk = /[\u3400-\u9fff]/
    for (const k of keys('en')) expect(cjk.test((messages.en as any)[k]), k).toBe(false)
    expect(cjk.test(messages['zh-CN']['mdtb.ph.col1'])).toBe(true)
  })
})
