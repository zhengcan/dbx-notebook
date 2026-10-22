import { describe, it, expect, vi, afterEach } from 'vitest'
import { useHistoryShortcuts } from '../src/shell/useHistoryShortcuts'

afterEach(() => { document.body.innerHTML = '' })
function fake(order: string[] = []) {
  return {
    history: { canUndo: { value: true }, canRedo: { value: true } },
    sealHistory: vi.fn(() => { order.push('seal') }),
    undo: vi.fn(() => { order.push('undo'); return { ok: true } }),
    redo: vi.fn(() => { order.push('redo'); return { ok: true } }),
  } as any
}
const key = (t: Element, init: KeyboardEventInit) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init }); t.dispatchEvent(e); return e }

describe('history shortcuts: seal, modal dialogs, results', () => {
  it('seals the pending burst before undo/redo', () => {
    const order: string[] = []
    const s = fake(order)
    const stop = useHistoryShortcuts(s)
    key(document.body, { key: 'z', ctrlKey: true }); key(document.body, { key: 'y', ctrlKey: true })
    expect(order).toEqual(['seal', 'undo', 'seal', 'redo'])
    stop()
  })
  it('does nothing while a modal dialog is open (dialogs own their keys)', () => {
    const s = fake()
    const stop = useHistoryShortcuts(s)
    const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true')
    const b = document.createElement('button'); d.appendChild(b); document.body.appendChild(d)
    const e = key(b, { key: 'z', ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(s.undo).not.toHaveBeenCalled()
    key(document.body, { key: 'z', ctrlKey: true })
    expect(s.undo).not.toHaveBeenCalled()
    d.remove()
    key(document.body, { key: 'z', ctrlKey: true })
    expect(s.undo).toHaveBeenCalledTimes(1)
    stop()
  })
  it('routes through the provided actions when given', () => {
    const s = fake()
    const actions = { undo: vi.fn(), redo: vi.fn() }
    const stop = useHistoryShortcuts(s, document, actions)
    key(document.body, { key: 'z', metaKey: true })
    key(document.body, { key: 'z', metaKey: true, shiftKey: true })
    expect(actions.undo).toHaveBeenCalledTimes(1); expect(actions.redo).toHaveBeenCalledTimes(1)
    expect(s.undo).not.toHaveBeenCalled()
    stop()
  })
  it('no undo/redo buttons exist in the toolbar', async () => {
    const src = (await import('../src/shell/Toolbar.vue?raw')).default
    expect(src).not.toMatch(/data-test="(undo|redo)"/)
  })
  it('non-Latin layouts: event.code KeyZ/KeyY is accepted when event.key is not an ASCII letter; a Latin key wins over the code', () => {
    const s = fake()
    const stop = useHistoryShortcuts(s)
    key(document.body, { key: 'я', code: 'KeyZ', ctrlKey: true })
    expect(s.undo).toHaveBeenCalledTimes(1)
    key(document.body, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true })
    expect(s.redo).toHaveBeenCalledTimes(1)
    key(document.body, { key: 'н', code: 'KeyY', ctrlKey: true })
    expect(s.redo).toHaveBeenCalledTimes(2)
    key(document.body, { key: 'w', code: 'KeyZ', ctrlKey: true })   // AZERTY physical Z carrying the letter w: not undo
    expect(s.undo).toHaveBeenCalledTimes(1)
    stop()
  })
  it('Cmd+Y is not redo (only Ctrl+Y), matching the editor', () => {
    const s = fake()
    const stop = useHistoryShortcuts(s)
    key(document.body, { key: 'y', metaKey: true })
    expect(s.redo).not.toHaveBeenCalled()
    stop()
  })
})
