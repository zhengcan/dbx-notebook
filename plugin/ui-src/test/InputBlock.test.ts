import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import InputBlock from '../src/blocks/InputBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

function setup(meta: Record<string, unknown> = {}) {
  setLocale('en')
  const store = useNotebookStore()
  const id = store.addBlock('input', null)
  store.updateMeta(id, meta)
  const w = mount(InputBlock, { props: { blockId: id }, global: { provide: { [StoreKey as symbol]: store } } })
  const meta$ = () => store.nb.value.blocks.find((b) => b.id === id)!.metadata as Record<string, any>
  return { store, id, w, meta: meta$ }
}
const q = (w: any, s: string) => w.find(`[data-test=${s}]`)

describe('InputBlock', () => {
  beforeEach(() => setLocale('en'))

  it('variable name: valid writes, invalid shows error and does not write', async () => {
    const { w, meta } = setup()
    await q(w, 'var-name').setValue('city')
    expect(meta().variable).toBe('city')
    expect(q(w, 'var-error').exists()).toBe(false)
    await q(w, 'var-name').setValue('1bad')
    expect(meta().variable).toBe('city')
    expect(q(w, 'var-error').exists()).toBe(true)
    await q(w, 'var-name').setValue('ok2')
    expect(q(w, 'var-error').exists()).toBe(false)
  })
  it('duplicate variable name shows a warning', async () => {
    const { store, w } = setup()
    const other = store.addBlock('input', null)
    store.updateMeta(other, { variable: 'dup' })
    expect(q(w, 'var-warning').exists()).toBe(false)
    await q(w, 'var-name').setValue('dup')
    expect(q(w, 'var-warning').exists()).toBe(true)
  })
  it('chip shows {{ variable }}', async () => {
    const { w } = setup({ variable: 'abc' })
    expect(q(w, 'chip').text()).toBe('{{ abc }}')
  })
  it('text input writes string', async () => {
    const { w, meta } = setup({ inputType: 'text', value: '' })
    expect(q(w, 'value').attributes('type')).toBe('text')
    await q(w, 'value').setValue('hi')
    expect(meta().value).toBe('hi')
  })
  it('number input writes a number; empty removes value', async () => {
    const { w, meta } = setup({ inputType: 'number', value: 1 })
    expect(q(w, 'value').attributes('type')).toBe('number')
    await q(w, 'value').setValue('42.5')
    expect(meta().value).toBe(42.5)
    await q(w, 'value').setValue('')
    expect('value' in meta()).toBe(false)
  })
  it('date input', async () => {
    const { w, meta } = setup({ inputType: 'date', value: '' })
    expect(q(w, 'value').attributes('type')).toBe('date')
    await q(w, 'value').setValue('2026-01-02')
    expect(meta().value).toBe('2026-01-02')
  })
  it('boolean checkbox writes real boolean', async () => {
    const { w, meta } = setup({ inputType: 'boolean', value: false })
    expect(q(w, 'value').attributes('type')).toBe('checkbox')
    await q(w, 'value').setValue(true)
    expect(meta().value).toBe(true)
    await q(w, 'value').setValue(false)
    expect(meta().value).toBe(false)
  })
  it('type change conversions', async () => {
    const { w, meta } = setup({ inputType: 'text', value: '12' })
    await q(w, 'type').setValue('number')
    expect(meta().inputType).toBe('number')
    expect(meta().value).toBe(12)
    await q(w, 'type').setValue('text')
    expect(meta().value).toBe('12')
    await q(w, 'value').setValue('abc')
    await q(w, 'type').setValue('number')
    expect('value' in meta()).toBe(false)
    await q(w, 'type').setValue('boolean')
    expect('value' in meta()).toBe(false)
  })
  it('leaving select removes options and multiple', async () => {
    const { w, meta } = setup({ inputType: 'select', options: ['a', 'b'], multiple: true, value: ['a'] })
    await q(w, 'type').setValue('text')
    expect(meta().inputType).toBe('text')
    expect('options' in meta()).toBe(false)
    expect('multiple' in meta()).toBe(false)
    expect('value' in meta()).toBe(false)
  })
  it('option editor: auto-typed, blank lines ignored', async () => {
    const { w, meta } = setup({ inputType: 'select', options: [] })
    await q(w, 'options').setValue('a\n\n1\ntrue\n2.5\na\n  \n')
    expect(meta().options).toEqual(['a', 1, true, 2.5])
  })
  it('single select writes selected option with its type; removing option clears value', async () => {
    const { w, meta } = setup({ inputType: 'select', options: ['a', 1], value: 'a' })
    expect(q(w, 'value').element.tagName).toBe('SELECT')
    await q(w, 'value').setValue('1')
    expect(meta().value).toBe(1)
    await q(w, 'options').setValue('a')
    expect('value' in meta()).toBe(false)
  })
  it('multiple: checkbox group writes arrays, pruned when options change', async () => {
    const { w, meta } = setup({ inputType: 'select', options: ['a', 'b', 3], multiple: true })
    const boxes = w.findAll('[data-test=opt-check]')
    expect(boxes.length).toBe(3)
    await boxes[0].setValue(true)
    await boxes[2].setValue(true)
    expect(meta().value).toEqual(['a', 3])
    await boxes[0].setValue(false)
    expect(meta().value).toEqual([3])
    await q(w, 'options').setValue('a\nb')
    expect(meta().value).toEqual([])
  })
  it('multiple toggle converts value', async () => {
    const { w, meta } = setup({ inputType: 'select', options: ['a', 'b'], value: 'a' })
    await q(w, 'multiple').setValue(true)
    expect(meta().multiple).toBe(true)
    expect(meta().value).toEqual(['a'])
    await q(w, 'multiple').setValue(false)
    expect('multiple' in meta()).toBe(false)
    expect(meta().value).toBe('a')
  })
  it('has bilingual aria labels', async () => {
    const { w } = setup()
    expect(q(w, 'var-name').attributes('aria-label')).toBe('Variable name')
    expect(q(w, 'type').attributes('aria-label')).toBe('Input type')
    expect(q(w, 'value').attributes('aria-label')).toBe('Value')
    const s = setup()
    setLocale('zh-CN')
    await s.w.vm.$forceUpdate()
    expect(q(s.w, 'var-name').attributes('aria-label')).toBe('变量名')
  })

  describe('fix round 1', () => {
    it('option draft re-syncs on type round trip', async () => {
      const { w, meta } = setup({ inputType: 'select', options: ['a', 'b'] })
      expect((q(w, 'options').element as HTMLTextAreaElement).value).toBe('a\nb')
      await q(w, 'type').setValue('text')
      await q(w, 'type').setValue('select')
      expect((q(w, 'options').element as HTMLTextAreaElement).value).toBe('')
      await q(w, 'options').setValue('x')
      expect(meta().options).toEqual(['x'])
    })
    it('external options replacement updates the textarea; typing keeps blank lines', async () => {
      const { w, store, id } = setup({ inputType: 'select', options: ['a'] })
      store.updateMeta(id, { options: ['p', 'q', 3] })
      await w.vm.$nextTick()
      expect((q(w, 'options').element as HTMLTextAreaElement).value).toBe('p\nq\n3')
      await q(w, 'options').setValue('p\n\nq\n')
      await w.vm.$nextTick()
      expect((q(w, 'options').element as HTMLTextAreaElement).value).toBe('p\n\nq\n')
    })
    it('parses options losslessly', async () => {
      const { w, meta } = setup({ inputType: 'select', options: [] })
      await q(w, 'options').setValue('007\n1.0\n+1\n.5\n1e3\n9007199254740993\n x \n"1"\n12\n-3\nTrue\ntrue')
      expect(meta().options).toEqual(['007', '1.0', '+1', '.5', '1e3', '9007199254740993', 'x', '"1"', 12, -3, 'True', true])
    })
    it('dedupes options (type+value), shows note, checkbox toggling works', async () => {
      const { w, meta } = setup({ inputType: 'select', multiple: true, options: [] })
      expect(q(w, 'dup-note').exists()).toBe(false)
      await q(w, 'options').setValue('a\na\n1\n1\n')
      expect(meta().options).toEqual(['a', 1])
      expect(q(w, 'dup-note').exists()).toBe(true)
      const boxes = w.findAll('[data-test=opt-check]')
      expect(boxes.length).toBe(2)
      await boxes[1].setValue(true)
      expect(meta().value).toEqual([1])
    })
    it('empty/invalid date removes value', async () => {
      const { w, meta } = setup({ inputType: 'date', value: '2026-01-02' })
      await q(w, 'value').setValue('')
      expect('value' in meta()).toBe(false)
    })
    it('chip is a non-focusable mouse affordance that copies the reference', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      const { w } = setup({ variable: 'abc' })
      expect(q(w, 'chip').element.tagName).not.toBe('BUTTON')
      expect(q(w, 'chip').attributes('aria-hidden')).toBe('true')
      expect(q(w, 'chip').attributes('tabindex')).toBeUndefined()
      await q(w, 'chip').trigger('click')
      expect(writeText).toHaveBeenCalledWith('{{ abc }}')
    })
    it('boolean is indeterminate when unset; click sets true then toggles', async () => {
      const { w, meta } = setup({ inputType: 'boolean' })
      expect((q(w, 'value').element as HTMLInputElement).indeterminate).toBe(true)
      await q(w, 'value').setValue(true)
      expect(meta().value).toBe(true)
      expect((q(w, 'value').element as HTMLInputElement).indeterminate).toBe(false)
      await q(w, 'value').setValue(false)
      expect(meta().value).toBe(false)
    })
    it('number input: unparsable browser value removes value', async () => {
      const { w, meta } = setup({ inputType: 'number', value: 5 })
      const el = q(w, 'value').element as HTMLInputElement
      el.value = '-'
      await q(w, 'value').trigger('input')
      expect('value' in meta()).toBe(false)
      await q(w, 'value').setValue('7')
      el.value = '1e'
      await q(w, 'value').trigger('input')
      expect('value' in meta()).toBe(false)
      await q(w, 'value').setValue('NaN')
      expect('value' in meta()).toBe(false)
    })
  })
})

describe('InputBlock copy-name button', () => {
  const setClip = (v: unknown) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })
  it('is a visible labelled button with live feedback', async () => {
    vi.useFakeTimers()
    setClip({ writeText: vi.fn().mockResolvedValue(undefined) })
    const { w } = setup({ variable: 'abc' })
    const b = q(w, 'copy-var')
    expect(b.element.tagName).toBe('BUTTON')
    expect(b.text()).toContain('Copy name')
    expect(b.attributes('aria-label')).toContain('{{ abc }}')
    expect(q(w, 'copied').attributes('aria-live')).toBe('polite')
    expect(q(w, 'copied').text()).toBe('')
    await b.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(q(w, 'copied').text()).toBe('Copied')
    await vi.advanceTimersByTimeAsync(1600)
    expect(q(w, 'copied').text()).toBe('')
    vi.useRealTimers()
  })
  it('reports failure (not Copied) when the clipboard write rejects and execCommand fails', async () => {
    setClip({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const orig = document.execCommand
    ;(document as any).execCommand = () => false
    const { w } = setup({ variable: 'abc' })
    await q(w, 'copy-var').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(q(w, 'copied').text()).toBe('Copy failed')
    expect(q(w, 'copied').attributes('aria-live')).toBe('polite')
    ;(document as any).execCommand = orig
  })
  it('reports failure when the clipboard is absent', async () => {
    setClip(undefined)
    const orig = document.execCommand
    ;(document as any).execCommand = undefined
    const { w } = setup({ variable: 'abc' })
    await q(w, 'copy-var').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(q(w, 'copied').text()).toBe('Copy failed')
    ;(document as any).execCommand = orig
  })
  it('the chip is not a second accessible control', () => {
    const { w } = setup({ variable: 'abc' })
    expect(w.findAll('button')).toHaveLength(1)
  })

  it('readability: visible label tied to the name input, token-based chip, hint when empty', async () => {
    const src = (await import('../src/blocks/InputBlock.vue?raw')).default as string
    const { w } = setup({ variable: 'date' })
    const lab = q(w, 'var-label')
    expect(lab.exists()).toBe(true)
    expect(lab.text()).toBe('Variable name')
    expect(lab.element.closest('label')!.contains(q(w, 'var-name').element)).toBe(true)
    expect(q(w, 'var-name').attributes('aria-label')).toBe('Variable name')
    expect(q(w, 'chip').text()).toBe('{{ date }}')
    const chipCss = src.match(/\.in-chip \{[^}]*\}/)![0]
    expect(chipCss).toContain('var(--color-background')
    expect(chipCss).toContain('var(--color-foreground')
    expect(chipCss).toContain('color-mix(in srgb, var(--color-foreground')
    expect(chipCss).not.toContain('var(--color-border')
    expect(chipCss).not.toMatch(/--color-accent/)
    const e = setup({ variable: '' })
    expect(q(e.w, 'chip').text()).toBe('Name the variable first')
    expect(q(e.w, 'chip').attributes('data-empty')).toBe('true')
  })

  it('i18n parity for input readability keys', async () => {
    const { t } = await import('../src/i18n')
    setLocale('zh-CN'); const zh = t('in.chipEmpty'); setLocale('en'); const en = t('in.chipEmpty')
    expect(zh).not.toBe('in.chipEmpty'); expect(en).not.toBe('in.chipEmpty'); expect(zh).not.toBe(en)
  })

  it('smoke-check mirror markup (scripts/input-block-check.mjs) stays in sync with the SFC template', async () => {
    const vue = (await import('../src/blocks/InputBlock.vue?raw')).default as string
    const smoke = (await import('../scripts/input-block-check.mjs?raw')).default as string
    const tpl = vue.slice(vue.indexOf('<template>'), vue.indexOf('</template>'))
    for (const needle of ['<label class="in-namebox">', 'class="in-label in-namelabel" data-test="var-label"', 'class="in-field in-name"', 'data-test="var-name"', 'class="in-chip"', ':data-empty=', 'class="in-copy"', 'data-test="copy-var"']) {
      expect(tpl, `SFC: ${needle}`).toContain(needle)
    }
    for (const needle of ['<label class="in-namebox">', 'in-label in-namelabel" data-test="var-label"', 'class="in-field in-name"', 'data-test="var-name"', 'class="in-chip"', 'data-empty="true"', 'class="in-copy"', 'data-test="copy-var"']) {
      expect(smoke, `smoke: ${needle}`).toContain(needle)
    }
    expect(tpl.indexOf('in-namebox')).toBeLessThan(tpl.indexOf('class="in-chip"'))
  })
})
