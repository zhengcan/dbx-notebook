import { describe, it, expect } from 'vitest'
import { messages, setLocale, t } from '../src/i18n'

const keys = (o: object) => Object.keys(o).filter((k) => k.startsWith('mdimg.')).sort()

describe('mdimg i18n', () => {
  it('zh/en key parity incl. decodeFailed', () => {
    expect(keys(messages['zh-CN'])).toEqual(keys(messages.en))
    expect(keys(messages.en)).toContain('mdimg.decodeFailed')
    for (const loc of ['zh-CN', 'en'] as const) for (const k of keys(messages[loc])) expect((messages[loc] as any)[k], `${loc} ${k}`).toBeTruthy()
  })
  it('required zh hints', () => {
    setLocale('zh-CN')
    expect(t('mdimg.notFound')).toBe('找不到图片')
    expect(t('mdimg.unsupported')).toBe('不支持的图片')
    expect(t('mdimg.tooLarge')).toBe('图片过大')
    expect(t('mdimg.invalidPath')).toBe('无效的图片路径')
    expect(t('mdimg.decodeFailed')).toBe('无法显示此图片')
    expect(t('mdimg.needsSave')).toBe('保存笔记本后显示图片')
    expect(t('mdimg.exportSkipped', { n: 3 })).toBe('3 张图片未嵌入')
  })
  it('paste/drop/Save As keys exist in both languages with the expected placeholders', () => {
    const ks = ['mdimg.saveFirst', 'mdimg.pasteFailed', 'mdimg.copyFailed', 'mdimg.tooMany', 'mdimg.unsupportedSkipped', 'mdimg.movedWhileSaving', 'mdimg.copyFailedNames', 'history.label.insertImage']
    for (const loc of ['zh-CN', 'en'] as const) for (const k of ks) expect((messages[loc] as any)[k], `${loc} ${k}`).toBeTruthy()
    for (const k of ['mdimg.copyFailed', 'mdimg.tooMany', 'mdimg.unsupportedSkipped']) for (const loc of ['zh-CN', 'en'] as const) expect((messages[loc] as any)[k]).toContain('{n}')
    setLocale('zh-CN')
    expect(t('mdimg.saveFirst')).toBe('请先保存笔记本，再粘贴图片')
    expect(t('history.label.insertImage')).toBe('插入图片')
    expect(t('mdimg.copyFailed', { n: 2 })).toBe('2 张图片未能复制到新位置')
    setLocale('en')
    expect(t('history.label.insertImage')).toBe('Insert image')
    setLocale('zh-CN')
  })
  it('hints never leak path placeholders', () => {
    for (const loc of ['zh-CN', 'en'] as const) for (const k of keys(messages[loc])) expect((messages[loc] as any)[k].replace('{n}', '').replace('{names}', '')).not.toMatch(/[{}\\/]/)
  })
})
