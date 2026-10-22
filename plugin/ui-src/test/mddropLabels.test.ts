import { describe, it, expect } from 'vitest'
import { messages } from '../src/i18n'

const keys = (l: 'zh-CN' | 'en') => Object.keys(messages[l]).filter((k) => k.startsWith('mddrop.')).sort()

describe('mddrop labels', () => {
  it('same key set, non-empty, in zh-CN and en', () => {
    expect(keys('zh-CN')).toEqual(keys('en'))
    expect(keys('en')).toEqual(['mddrop.addedTo', 'mddrop.hint', 'mddrop.notImages', 'mddrop.pickBlock', 'mddrop.truncated'])
    for (const l of ['zh-CN', 'en'] as const) for (const k of keys(l)) expect((messages[l] as any)[k].length, `${l} ${k}`).toBeGreaterThan(0)
  })
  it('{n} placeholder in both languages', () => {
    for (const l of ['zh-CN', 'en'] as const) expect((messages[l] as any)['mddrop.notImages']).toContain('{n}')
  })
  it('English text has no CJK', () => {
    for (const k of keys('en')) expect(/[\u3400-\u9fff]/.test((messages.en as any)[k]), k).toBe(false)
  })
})
