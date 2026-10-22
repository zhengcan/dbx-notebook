import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useHistoryShortcuts } from '../src/shell/useHistoryShortcuts'

function fakeStore(depth = { undo: 1, redo: 1 }) {
  return {
    history: { canUndo: { value: depth.undo > 0 }, canRedo: { value: depth.redo > 0 } },
    undo: vi.fn(() => ({ ok: true })),
    redo: vi.fn(() => ({ ok: true })),
  } as any
}
const ws: any[] = []
afterEach(() => { ws.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
function mk(store = fakeStore()) {
  const w = mount(defineComponent({ setup() { useHistoryShortcuts(store); return () => h('div') } }), { attachTo: document.body })
  ws.push(w)
  return store
}
function key(target: Element, init: KeyboardEventInit & { isComposing?: boolean } = {}) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init })
  target.dispatchEvent(e)
  return e
}
const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); return d.firstElementChild as HTMLElement }

describe('useHistoryShortcuts', () => {
  it('Cmd/Ctrl+Z undo, shift/Ctrl+Y redo from body', () => {
    const s = mk()
    expect(key(document.body, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
    key(document.body, { key: 'z', ctrlKey: true })
    expect(s.undo).toHaveBeenCalledTimes(2)
    expect(key(document.body, { key: 'Z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    key(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    key(document.body, { key: 'y', ctrlKey: true })
    expect(s.redo).toHaveBeenCalledTimes(3)
    expect(s.undo).toHaveBeenCalledTimes(2)
  })
  it('works from block container and button', () => {
    const s = mk()
    key(el('<div data-test="block"><button>x</button></div>').querySelector('button')!, { key: 'z', ctrlKey: true })
    expect(s.undo).toHaveBeenCalledTimes(1)
  })
  it.each([
    '<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"></div>', '<div contenteditable=""></div>',
    '<div class="cm-editor"><div class="cm-content"><span class="x">a</span></div></div>',
  ])('ignores inside %s', (html) => {
    const s = mk()
    const root = el(html)
    const target = root.querySelector('.x') ?? root
    const e = key(target, { key: 'z', ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(s.undo).not.toHaveBeenCalled()
    key(target, { key: 'y', ctrlKey: true })
    expect(s.redo).not.toHaveBeenCalled()
  })
  it('ignores composing, alt, defaultPrevented, other keys', () => {
    const s = mk()
    key(document.body, { key: 'z', ctrlKey: true, isComposing: true })
    key(document.body, { key: 'z', ctrlKey: true, altKey: true })
    key(document.body, { key: 'z' })
    key(document.body, { key: 'x', ctrlKey: true })
    const pre = (e: Event) => e.preventDefault()
    document.addEventListener('keydown', pre, true)
    key(document.body, { key: 'z', ctrlKey: true })
    document.removeEventListener('keydown', pre, true)
    expect(s.undo).not.toHaveBeenCalled()
  })
  it('empty stack → no preventDefault', () => {
    const s = mk(fakeStore({ undo: 0, redo: 0 }))
    expect(key(document.body, { key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key(document.body, { key: 'y', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(s.undo).not.toHaveBeenCalled()
  })
  it('removed on unmount', () => {
    const s = mk()
    ws.pop()!.unmount()
    key(document.body, { key: 'z', ctrlKey: true })
    expect(s.undo).not.toHaveBeenCalled()
  })
})
