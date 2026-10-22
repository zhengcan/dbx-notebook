import { describe, it, expect } from 'vitest'
import { engineHintText } from '../src/run/engineHints'
import { setLocale } from '../src/i18n'

const zh: Record<string, string> = {
  cast_operator: 'SQLite 不支持 ::，请改用 CAST(x AS 类型)',
  ilike: 'SQLite 没有 ILIKE，请改用 LOWER(a) LIKE LOWER(b)',
  distinct_on: '不支持 DISTINCT ON，请改用 ROW_NUMBER() 窗口函数筛选',
  filter_clause: '此处不支持 FILTER 子句，请改用 CASE WHEN',
  within_group: '不支持 WITHIN GROUP，请改用 percentile_cont(列, 0.5) 或 median(列)',
  regex_operator: "不支持 ~ 运算符，请改用 列 REGEXP '模式'",
}
describe('engineHintText', () => {
  it('maps every rule in zh and en', () => {
    for (const [k, v] of Object.entries(zh)) {
      setLocale('zh-CN')
      expect(engineHintText(k)).toBe(v)
      setLocale('en')
      const en = engineHintText(k)
      expect(en).toBeTruthy()
      expect(en).not.toBe(v)
    }
    setLocale('en')
    expect(engineHintText('cast_operator')).toBe('SQLite has no :: operator; use CAST(x AS type)')
    expect(engineHintText('ilike')).toBe('SQLite has no ILIKE; use LOWER(a) LIKE LOWER(b)')
  })
  it('unknown rule -> undefined', () => {
    expect(engineHintText('nope')).toBeUndefined()
    expect(engineHintText(undefined)).toBeUndefined()
  })
})
