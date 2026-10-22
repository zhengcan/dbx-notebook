import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CellDetail from '../src/blocks/CellDetail.vue'
import { setLocale } from '../src/i18n'

let w: ReturnType<typeof mount> | null = null
function make(value: unknown, column = 'col', open = true) {
  w?.unmount()
  w = mount(CellDetail, { props: { open, column, value }, attachTo: document.body })
  return w
}
function setClipboard(writeText?: (s: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true })
}
const winKey = (key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(e)
  return e
}
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; setClipboard(undefined); delete (document as any).execCommand })

describe('CellDetail', () => {
  beforeEach(() => setLocale('en'))

  it('renders nothing when closed', () => {
    expect(make('x', 'c', false).find('[role=dialog]').exists()).toBe(false)
  })

  it('shows plain string verbatim in a pre, with dialog a11y', () => {
    const w = make('hello\nworld', 'name')
    const d = w.find('[role=dialog]')
    expect(d.attributes('aria-modal')).toBe('true')
    expect(d.attributes('aria-label')).toBe('name')
    expect(d.attributes('tabindex')).toBe('-1')
    expect(w.find('pre').text()).toBe('hello\nworld')
  })

  it('pretty-prints objects, arrays and JSON strings', () => {
    expect(make({ a: 1 }).find('pre').text()).toBe('{\n  "a": 1\n}')
    expect(make([1, 2]).find('pre').text()).toBe('[\n  1,\n  2\n]')
    expect(make('{"a":[1]}').find('pre').text()).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(make('123').find('pre').text()).toBe('123')
  })

  it('invalid JSON-looking string is shown as-is', () => {
    expect(make('{abc').find('pre').text()).toBe('{abc')
  })

  it('bigint is shown via cellText', () => {
    expect(make(12345678901234567890n).find('pre').text()).toBe('12345678901234567890')
  })

  it('shows NULL hint for null', () => {
    expect(make(null).find('.cdt-null').text()).toBe('NULL')
  })

  it('two opens in a row show the second value', async () => {
    const w = make('A', 'c1')
    await w.setProps({ value: 'B', column: 'c2' })
    expect(w.find('pre').text()).toBe('B')
    expect(w.find('[role=dialog]').attributes('aria-label')).toBe('c2')
  })

  it('copy writes displayed text to clipboard', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    const w = make({ a: 1 })
    await w.find('[data-test=copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('execCommand fallback works; failure shows notice, success clears it', async () => {
    const exec = vi.fn(() => false)
    ;(document as any).execCommand = exec
    const w = make('abc')
    await w.find('[data-test=copy]').trigger('click'); await flushPromises()
    expect(exec).toHaveBeenCalledWith('copy')
    expect(w.text()).toContain('Copy failed')
    exec.mockReturnValue(true)
    await w.find('[data-test=copy]').trigger('click'); await flushPromises()
    expect(w.text()).not.toContain('Copy failed')
  })

  it('copyFailed resets on close/open', async () => {
    ;(document as any).execCommand = () => false
    const w = make('abc')
    await w.find('[data-test=copy]').trigger('click'); await flushPromises()
    expect(w.text()).toContain('Copy failed')
    await w.setProps({ open: false }); await w.setProps({ open: true })
    expect(w.text()).not.toContain('Copy failed')
  })

  it('truncates > 100k chars in display but copies full text', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    const big = 'x'.repeat(100_005)
    const w = make(big)
    expect(w.find('pre').text().length).toBe(100_000)
    expect(w.find('[data-test=truncated]').exists()).toBe(true)
    await w.find('[data-test=copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(big)
    expect(make('short').find('[data-test=truncated]').exists()).toBe(false)
  })

  it('huge JSON-looking string (1.5M) is not pretty-printed; copy is original', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard(writeText)
    const big = '[' + '1,'.repeat(750_000) + '1]'
    const parse = vi.spyOn(JSON, 'parse')
    const w = make(big)
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
    expect(w.find('pre').text()).toBe(big.slice(0, 100_000))
    expect(w.find('[data-test=truncated]').exists()).toBe(true)
    await w.find('[data-test=copy]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(big)
  })

  it('Esc (on dialog) and overlay click emit close', async () => {
    const w = make('x')
    await w.find('[role=dialog]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('.cdt-backdrop').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    await w.find('[role=dialog]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
  })

  it('Esc closes even when focus is on body after clicking the pre', async () => {
    const w = make('x')
    await flushPromises()
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    winKey('Escape')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('Tab wraps within the dialog, also from body', async () => {
    const w = make('x')
    await flushPromises()
    const copy = w.find('[data-test=copy]').element as HTMLElement
    const pre = w.find('pre').element as HTMLElement
    expect(document.activeElement).toBe(copy)
    pre.focus()
    const e = winKey('Tab')
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(copy)
    const e2 = winKey('Tab', { shiftKey: true })
    expect(e2.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(pre)
    ;(document.activeElement as HTMLElement).blur()
    winKey('Tab')
    expect(document.activeElement).toBe(copy)
  })

  it('window listener removed after close and on unmount', async () => {
    const w1 = make('x')
    await w1.setProps({ open: false })
    winKey('Escape')
    expect(w1.emitted('close')).toBeUndefined()
    const rm = vi.spyOn(window, 'removeEventListener')
    const w2 = make('y')
    w2.unmount(); w = null
    expect(rm).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  })

  it('focuses Copy on open and restores previous focus on close', async () => {
    const btn = document.createElement('div'); btn.tabIndex = 0; document.body.appendChild(btn); btn.focus()
    const w = make('x', 'c', false)
    await w.setProps({ open: true }); await flushPromises()
    expect(document.activeElement).toBe(w.find('[data-test=copy]').element)
    await w.setProps({ open: false }); await flushPromises()
    expect(document.activeElement).toBe(btn)
  })
})
