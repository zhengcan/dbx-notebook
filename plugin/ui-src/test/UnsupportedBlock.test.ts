import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import UnsupportedBlock from '../src/blocks/UnsupportedBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

describe('UnsupportedBlock', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('shows type and read-only json, truncated', () => {
    const store = useNotebookStore()
    store.nb.value.blocks.push({ id: 'b1', type: 'chart', content: 'x'.repeat(10000) } as any)
    const w = mount(UnsupportedBlock, { props: { blockId: 'b1' }, global: { provide: { [StoreKey as symbol]: store } } })
    expect(w.text()).toContain('不支持的块类型：chart（内容已保留）')
    const pre = w.find('pre')
    expect(pre.text()).toContain('"type": "chart"')
    expect(pre.text().length).toBeLessThan(4200)
    expect(w.find('textarea').exists()).toBe(false)
  })
})
