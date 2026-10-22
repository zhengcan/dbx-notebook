import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ResultTable from '../src/blocks/ResultTable.vue'
import { transposedColWidth, TRANSPOSED_MIN_COL } from '../src/blocks/grid/columnWidths'

const res = (n: number) => ({ columns: [{ name: 'dimension' }, { name: 'status' }], rows: Array.from({ length: n }, (_, i) => [i, i]), truncated: false, elapsedMs: 1, dbType: 'x' })

describe('transposedColWidth (interpretation: max(320, available / n))', () => {
  it('min is 320', () => expect(TRANSPOSED_MIN_COL).toBe(320))
  it('stretches equally when 320*n fits in the available width', () => {
    expect(transposedColWidth(1000, 80, 2)).toBe(460)
    expect(transposedColWidth(1000, 80, 1)).toBe(920)
  })
  it('uses exactly 320 when they do not fit (table scrolls)', () => {
    expect(transposedColWidth(1000, 80, 3)).toBe(320)
    expect(transposedColWidth(1000, 80, 40)).toBe(320)
  })
  it('exactly fitting boundary', () => expect(transposedColWidth(80 + 640, 80, 2)).toBe(320))
  it('floors fractions so the sum never overflows', () => expect(transposedColWidth(1001, 80, 2)).toBe(460))
  it('falls back to the min for unknown/zero/invalid container or zero columns', () => {
    for (const w of [undefined, 0, NaN, -5, 50]) expect(transposedColWidth(w as number, 80, 2)).toBe(320)
    expect(transposedColWidth(1000, 80, 0)).toBe(320)
  })
})

describe('ResultTable transposed colgroup', () => {
  const orig = (globalThis as any).ResizeObserver
  afterEach(() => { (globalThis as any).ResizeObserver = orig })
  it('no ResizeObserver (jsdom): min width', () => {
    const w = mount(ResultTable, { props: { result: res(2), transposed: true } })
    const cols = w.findAll('col')
    expect(cols[0].attributes('style')).toContain('width: 80px')
    expect(cols[1].attributes('style')).toContain('width: 320px')
    expect(w.find('table').attributes('style')).toContain('width: 720px')
  })
  it('stretches to the observed scroller width', async () => {
    let cb: ResizeObserverCallback = () => {}
    ;(globalThis as any).ResizeObserver = class { constructor(c: ResizeObserverCallback) { cb = c } observe() {} disconnect() {} unobserve() {} }
    const w = mount(ResultTable, { props: { result: res(2), transposed: true }, attachTo: document.body })
    const vp = w.find('.viewport').element as HTMLElement
    Object.defineProperty(vp, 'clientWidth', { value: 1000, configurable: true })
    cb([{ contentRect: { width: 1000 } } as ResizeObserverEntry], {} as ResizeObserver)
    await nextTick()
    const cols = w.findAll('col')
    expect(cols[1].attributes('style')).toContain('width: 460px')
    expect(cols[2].attributes('style')).toContain('width: 460px')
    w.unmount()
  })
  it('narrow scroller keeps 320 and the table is wider than the viewport', async () => {
    let cb: ResizeObserverCallback = () => {}
    ;(globalThis as any).ResizeObserver = class { constructor(c: ResizeObserverCallback) { cb = c } observe() {} disconnect() {} unobserve() {} }
    const w = mount(ResultTable, { props: { result: res(3), transposed: true } })
    const vp = w.find('.viewport').element as HTMLElement
    Object.defineProperty(vp, 'clientWidth', { value: 900, configurable: true })
    cb([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver)
    await nextTick()
    expect(w.findAll('col')[1].attributes('style')).toContain('width: 320px')
    expect(w.find('table').attributes('style')).toContain('width: 1040px')
  })
})
