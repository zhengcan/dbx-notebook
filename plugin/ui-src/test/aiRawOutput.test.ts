import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RawOutput from '../src/ai/RawOutput.vue'

describe('RawOutput', () => {
  it('is a collapsed details with a summary; text is plain, selectable', () => {
    const w = mount(RawOutput, { props: { text: '<b>hi</b> & SELECT 1' } })
    const d = w.find('details')
    expect(d.exists()).toBe(true)
    expect(d.attributes('open')).toBeUndefined()
    expect(w.find('summary').text()).toBe('Show model output')
    const pre = w.find('[data-test=raw-output-text]')
    expect(pre.text()).toBe('<b>hi</b> & SELECT 1')
    expect(pre.find('b').exists()).toBe(false)
    expect(pre.attributes('tabindex')).toBe('0')
    expect(pre.attributes('aria-label')).toBeTruthy()
  })
  it('caps at 4000 chars with a note', () => {
    const w = mount(RawOutput, { props: { text: 'x'.repeat(5000) } })
    expect(w.find('[data-test=raw-output-text]').text().length).toBe(4000)
    expect(w.find('[data-test=raw-output-cut]').text()).toMatch(/4000.*5000/)
  })
  it('no note when within the cap; nothing for blank text', () => {
    expect(mount(RawOutput, { props: { text: 'x'.repeat(4000) } }).find('[data-test=raw-output-cut]').exists()).toBe(false)
    expect(mount(RawOutput, { props: { text: '  \n' } }).find('details').exists()).toBe(false)
  })
})
