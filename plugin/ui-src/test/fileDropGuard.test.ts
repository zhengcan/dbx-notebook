import { describe, it, expect, afterEach } from 'vitest'
import { installFileDropGuard } from '../src/shell/fileDropGuard'
import { file, fakeDt } from './mdImageHelpers'

const fire = (el: EventTarget, type: string, dt: DataTransfer) => {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as any
  ev.dataTransfer = dt
  el.dispatchEvent(ev)
  return ev as Event
}
let off: (() => void) | null = null
afterEach(() => { off?.(); off = null; document.body.innerHTML = '' })

describe('file drop guard', () => {
  it('prevents navigation for file drags anywhere in the document', () => {
    off = installFileDropGuard(document)
    const div = document.body.appendChild(document.createElement('div'))
    const dt = fakeDt([file('a.pdf', 'application/pdf')])
    expect(fire(div, 'dragover', dt).defaultPrevented).toBe(true)
    expect((dt as any).dropEffect).toBe('none')
    expect(fire(div, 'drop', fakeDt([file('a.png', 'image/png')])).defaultPrevented).toBe(true)
  })
  it('leaves text, link and input-text drags alone', () => {
    off = installFileDropGuard(document)
    const input = document.body.appendChild(document.createElement('input'))
    for (const dt of [fakeDt([], 'hi', ['text/plain']), fakeDt([], '', ['text/uri-list'])]) {
      expect(fire(input, 'dragover', dt).defaultPrevented).toBe(false)
      expect(fire(input, 'drop', dt).defaultPrevented).toBe(false)
    }
  })
  it('does not override a handler that already took the event (dropEffect kept)', () => {
    off = installFileDropGuard(document)
    const div = document.body.appendChild(document.createElement('div'))
    div.addEventListener('dragover', (e) => { e.preventDefault(); (e as any).dataTransfer.dropEffect = 'copy' })
    const dt = fakeDt([file('a.png', 'image/png')])
    fire(div, 'dragover', dt)
    expect((dt as any).dropEffect).toBe('copy')
  })
  it('dispose removes the listeners', () => {
    off = installFileDropGuard(document)
    off(); off = null
    expect(fire(document.body, 'dragover', fakeDt([file('a.pdf', 'application/pdf')])).defaultPrevented).toBe(false)
  })
})
