import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSqlEditor } from '../src/editor/sqlEditor'
import { EditorView } from '@codemirror/view'

if (!(Range.prototype as any).getClientRects) { (Range.prototype as any).getClientRects = () => []; (Range.prototype as any).getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) }
afterEach(() => { document.body.innerHTML = '' })
function mk(doc = 'select 1 from t', extra: any = {}) {
  const parent = document.createElement('div'); document.body.appendChild(parent)
  const onChange = vi.fn(), onUndo = vi.fn(() => true), onRedo = vi.fn(() => true)
  const ed = createSqlEditor(parent, { doc, dialect: 'StandardSQL', onChange, onUndo, onRedo, ...extra } as any)
  const view = EditorView.findFromDOM(parent)!
  return { ed, view, onChange, onUndo, onRedo, parent }
}
const press = (view: EditorView, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(e)
  return e
}

describe('SQL editor: single document history', () => {
  it('Mod-z / Mod-Shift-z / Mod-y inside the editor go to the store callbacks, never to a local history', () => {
    const { view, onUndo, onRedo, onChange } = mk()
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    onChange.mockClear()
    const e = press(view, { key: 'z', keyCode: 90, ctrlKey: true })
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('xselect 1 from t')
    press(view, { key: 'Z', keyCode: 90, ctrlKey: true, shiftKey: true })
    press(view, { key: 'y', keyCode: 89, ctrlKey: true })
    expect(onRedo).toHaveBeenCalledTimes(2)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('external setDoc replaces only the changed range: selection maps, no onChange', () => {
    const { ed, view, onChange } = mk('select 1 from t')
    view.dispatch({ selection: { anchor: 15 } })            // end
    ed.setDoc('select 12 from t')
    expect(view.state.doc.toString()).toBe('select 12 from t')
    expect(view.state.selection.main.head).toBe(16)
    view.dispatch({ selection: { anchor: 3 } })
    ed.setDoc('select 1 from tt')
    expect(view.state.selection.main.head).toBe(3)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('setDoc with identical text is a no-op; completely different text still works', () => {
    const { ed, view } = mk('abc')
    ed.setDoc('abc'); expect(view.state.doc.toString()).toBe('abc')
    ed.setDoc('xyz'); expect(view.state.doc.toString()).toBe('xyz')
    ed.setDoc(''); expect(view.state.doc.toString()).toBe('')
  })
  it('non-Latin layout (event.code fallback) reaches the store; Cmd+Y is not redo, Ctrl+Y is', () => {
    const { view, onUndo, onRedo } = mk()
    press(view, { key: 'я', code: 'KeyZ', ctrlKey: true })
    expect(onUndo).toHaveBeenCalledTimes(1)
    press(view, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true })
    press(view, { key: 'н', code: 'KeyY', ctrlKey: true })
    expect(onRedo).toHaveBeenCalledTimes(2)
    press(view, { key: 'y', keyCode: 89, metaKey: true })
    expect(onRedo).toHaveBeenCalledTimes(2)
    press(view, { key: 'y', keyCode: 89, ctrlKey: true })
    expect(onRedo).toHaveBeenCalledTimes(3)
    press(view, { key: 'w', code: 'KeyZ', ctrlKey: true })
    expect(onUndo).toHaveBeenCalledTimes(1)
  })
  it('setDoc normalises CR/CRLF before diffing', () => {
    const { ed, view } = mk('a\nb\nc')
    ed.setDoc('a\r\nB\r\nc')
    expect(view.state.doc.toString()).toBe('a\nB\nc')
    ed.setDoc('a\rB\rc')
    expect(view.state.doc.toString()).toBe('a\nB\nc')
    ed.setDoc('a\r\nB\r\nc')
    expect(view.state.doc.toString()).toBe('a\nB\nc')
  })
  it('ONE keydown through the editor keymap and the document listener undoes exactly one store step', async () => {
    const { useNotebookStore } = await import('../src/state/notebookStore')
    const { createHistoryActions } = await import('../src/shell/historyActions')
    const { useHistoryShortcuts } = await import('../src/shell/useHistoryShortcuts')
    const store = useNotebookStore()
    const id = store.addBlock('markdown', null)
    store.updateContent(id, 'a'); store.sealHistory(); store.updateContent(id, 'b'); store.sealHistory(); store.updateContent(id, 'c')
    const actions = createHistoryActions(store as any)
    const stop = useHistoryShortcuts(store as any, document, actions)
    const { view } = mk('x', { onUndo: () => { actions.undo(); return true } })
    const d0 = store.history.undoDepth.value
    const e = press(view, { key: 'z', keyCode: 90, ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(store.history.undoDepth.value).toBe(d0 - 1)
    stop()
  })
})
