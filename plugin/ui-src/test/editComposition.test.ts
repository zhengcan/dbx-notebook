import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownBlock from '../src/blocks/MarkdownBlock.vue'
import InputBlock from '../src/blocks/InputBlock.vue'
import { createCompositionGate } from '../src/editor/compositionGate'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale, t, messages } from '../src/i18n'

describe('composition gate (CodeMirror updates)', () => {
  it('emits nothing while composing, once at the first update after / at compositionend', () => {
    const out: string[] = []
    const g = createCompositionGate((d) => out.push(d))
    g.update(true, true, 'n'); g.update(true, true, 'ni'); g.update(true, true, '你')
    expect(out).toEqual([])
    g.update(true, false, '你好')
    expect(out).toEqual(['你好'])
    g.end('你好'); expect(out).toEqual(['你好'])
  })
  it('compositionend with no later update flushes once', () => {
    const out: string[] = []
    const g = createCompositionGate((d) => out.push(d))
    g.update(true, true, '你')
    g.end('你'); g.end('你')
    expect(out).toEqual(['你'])
  })
  it('plain edits pass through; no change = no emit', () => {
    const out: string[] = []
    const g = createCompositionGate((d) => out.push(d))
    g.update(true, false, 'a'); g.update(false, false, 'a'); g.end('a')
    expect(out).toEqual(['a'])
  })
})

describe('IME: one store step per composition', () => {
  beforeEach(() => setLocale('en'))
  it('MarkdownBlock emits nothing during composition and once at compositionend', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
    const ta = w.find('textarea')
    await ta.trigger('compositionstart')
    for (const v of ['n', 'ni', '你']) { (ta.element as HTMLTextAreaElement).value = v; await ta.trigger('input', { isComposing: true }) }
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await ta.trigger('compositionend')
    expect(w.emitted('update:modelValue')).toEqual([['你']])
    w.unmount()
  })
  it('InputBlock text value likewise (store: 1 step)', async () => {
    setLocale('en')
    const store = useNotebookStore()
    const id = store.addBlock('input', null)
    store.history.clear()
    const w = mount(InputBlock, { props: { blockId: id }, global: { provide: { [StoreKey as symbol]: store } } })
    const el = w.find('[data-test=value]')
    await el.trigger('compositionstart')
    for (const v of ['n', 'ni', '你']) { (el.element as HTMLInputElement).value = v; await el.trigger('input', { isComposing: true }) }
    expect(store.history.undoDepth.value).toBe(0)
    await el.trigger('compositionend')
    expect(store.history.undoDepth.value).toBe(1)
    expect((store.nb.value.blocks[0].metadata as any).value).toBe('你')
  })
})

describe('history.label i18n parity', () => {
  it('zh-CN and en define the same history.label keys', () => {
    const keys = (l: string) => Object.keys((messages as any)[l]).filter((k) => k.startsWith('history.label.')).sort()
    expect(keys('en').length).toBeGreaterThanOrEqual(6)
    expect(keys('zh-CN')).toEqual(keys('en'))
    expect(keys('en')).toContain('history.label.editChart')
    expect(t('history.label.editSql')).not.toBe('history.label.editSql')
  })
})

describe('native undo in a textarea', () => {
  it('historyUndo input events are recorded like any edit (no loop, no recursion)', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
    const ta = w.find('textarea')
    ;(ta.element as HTMLTextAreaElement).value = 'abc'
    await ta.trigger('input', { inputType: 'insertText' })
    ;(ta.element as HTMLTextAreaElement).value = 'ab'
    await ta.trigger('input', { inputType: 'historyUndo' })
    expect(w.emitted('update:modelValue')).toEqual([['abc'], ['ab']])
    w.unmount()
  })
})

describe('re-render during composition keeps the composed text', () => {
  it('MarkdownBlock: forced re-render mid-composition does not reset the textarea', async () => {
    const w = mount(MarkdownBlock, { props: { modelValue: '' }, attachTo: document.body })
    const ta = w.find('textarea')
    await ta.trigger('compositionstart')
    ;(ta.element as HTMLTextAreaElement).value = 'ni'
    await ta.trigger('input', { isComposing: true })
    w.vm.$forceUpdate(); await w.vm.$nextTick()
    expect((ta.element as HTMLTextAreaElement).value).toBe('ni')
    ;(ta.element as HTMLTextAreaElement).value = '你'
    await ta.trigger('compositionend')
    expect(w.emitted('update:modelValue')).toEqual([['你']])
    w.unmount()
  })
  it('InputBlock: a store change that re-renders the block mid-composition keeps the field text (value, name, options)', async () => {
    setLocale('en')
    const store = useNotebookStore()
    const id = store.addBlock('input', null)
    store.updateMeta(id, { inputType: 'select', options: ['a'] })
    store.history.clear()
    const w = mount(InputBlock, { props: { blockId: id }, global: { provide: { [StoreKey as symbol]: store } } })
    for (const sel of ['var-name', 'options']) {
      const el = w.find(`[data-test=${sel}]`)
      await el.trigger('compositionstart')
      ;(el.element as HTMLInputElement).value = 'zh'
      await el.trigger('input', { isComposing: true })
      store.updateMeta(id, { x: Math.random() }); await w.vm.$nextTick()
      w.vm.$forceUpdate(); await w.vm.$nextTick()
      expect((el.element as HTMLInputElement).value).toBe('zh')
      await el.trigger('compositionend')
    }
    const t0 = mount(InputBlock, { props: { blockId: store.addBlock('input', id) }, global: { provide: { [StoreKey as symbol]: store } } })
    const v = t0.find('[data-test=value]')
    await v.trigger('compositionstart')
    ;(v.element as HTMLInputElement).value = 'zh'
    await v.trigger('input', { isComposing: true })
    t0.vm.$forceUpdate(); await t0.vm.$nextTick()
    expect((v.element as HTMLInputElement).value).toBe('zh')
  })
})
