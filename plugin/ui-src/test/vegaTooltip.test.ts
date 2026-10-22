import { describe, it, expect, afterEach, vi } from 'vitest'
import { attachTooltip } from '../src/analysis/vegaRuntime'

function setup() {
  let handler: any
  const view = { tooltip: (h: any) => { handler = h } }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const box = attachTooltip(view, el)
  el.appendChild(box)
  return { box, show: (value: unknown, x = 10, y = 10) => handler({}, { clientX: x, clientY: y }, {}, value) }
}
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('chart tooltip (Plan 13 T9 fix)', () => {
  it('renders label and value as plain text: no element is created', () => {
    const { box, show } = setup()
    show({ '<img src=x onerror=alert(1)>': '<b>x</b>', '<b>y</b>': '<img src=x onerror=alert(1)>' })
    expect(box.children.length).toBe(0)
    expect(box.querySelector('img,b')).toBeNull()
    expect(box.textContent).toContain('<img src=x onerror=alert(1)>: <b>x</b>')
    expect(box.style.display).toBe('block')
  })
  it('hides on empty value', () => {
    const { box, show } = setup()
    show({ a: 1 }); show(null)
    expect(box.style.display).toBe('none')
  })
  it('clamps horizontally and flips above the cursor when it would pass the bottom', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(300)
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(400)
    const { box, show } = setup()
    show({ a: 1 }, 390, 100)
    expect(box.style.left).toBe('110px')
    expect(box.style.top).toBe('112px')
    show({ a: 1 }, 20, 280)
    expect(box.style.top).toBe('228px')
    show({ a: 1 }, 20, 10)
    expect(box.style.top).toBe('22px')
  })
})
