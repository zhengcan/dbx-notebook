import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LabelRow from '../src/analysis/labels/LabelRow.vue'

const row = { id: 'title', target: { kind: 'title' } as any, name: 'Title', placeholder: 'auto', value: '', overridden: false, maxlength: 200, affects: 'x' }

describe('LabelRow', () => {
  it('typed text survives a re-render caused by an unrelated prop change', async () => {
    const w = mount(LabelRow, { props: { row, inputId: 'i1', invalid: false }, attachTo: document.body })
    const inp = w.find('input').element as HTMLInputElement
    inp.value = 'typed'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await w.setProps({ scalesId: 'sc' })
    await w.setProps({ row: { ...row, affects: 'y' } })
    expect((w.find('input').element as HTMLInputElement).value).toBe('typed')
    w.unmount()
  })
})
