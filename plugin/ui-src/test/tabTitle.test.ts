import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createConnectionsStore } from '../src/connections/hostConnections'
import { formatTabTitle, createTabTitleController } from '../src/shell/tabTitle'

const U = 'Untitled notebook'
const setCalls = (f: any) => f.calls.filter((c: any) => c.method === 'request' && c.args.method === 'host.setTitle').map((c: any) => c.args.params.title)

describe('formatTabTitle', () => {
  it('formats', () => {
    expect(formatTabTitle('a.sqlnb', false, U)).toBe('a')
    expect(formatTabTitle('a.sqlnb', true, U)).toBe('● a')
    expect(formatTabTitle(null, false, U)).toBe(U)
    expect(formatTabTitle(null, true, U)).toBe('● ' + U)
    expect(formatTabTitle('x.y.sqlnb', false, U)).toBe('x.y')
    expect(formatTabTitle('销售报表.sqlnb', true, U)).toBe('● 销售报表')
  })
  it('truncates to 80 chars incl ellipsis', () => {
    const t = formatTabTitle('n'.repeat(200) + '.sqlnb', false, U)
    expect(t).toHaveLength(80); expect(t.endsWith('…')).toBe(true)
    expect(formatTabTitle('n'.repeat(200), true, U)).toHaveLength(80)
  })
})

describe('tab title controller', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const mk = (f: any, st: { name: string | null; dirty: boolean }, throttleMs?: number) =>
    createTabTitleController(f, { name: () => st.name, dirty: () => st.dirty, untitled: () => U }, { throttleMs })

  it('zero calls when workbenchTitle=false', async () => {
    const f = createFakeBridge({ floating: true })
    const st = { name: 'a.sqlnb', dirty: false }
    const c = mk(f, st); c.update(); st.dirty = true; c.update()
    await vi.advanceTimersByTimeAsync(10000); c.dispose(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.calls).toHaveLength(0)
  })
  it('20 rapid toggles within the window → 1 request, last value wins', async () => {
    const f = createFakeBridge()
    const st = { name: 'a.sqlnb', dirty: false }
    const c = mk(f, st)
    c.update(); await vi.advanceTimersByTimeAsync(1000)
    expect(setCalls(f)).toEqual(['a'])
    for (let i = 0; i < 21; i++) { st.dirty = !st.dirty; c.update() }
    await vi.advanceTimersByTimeAsync(2000)
    expect(setCalls(f)).toEqual(['a', '● a'])
    expect(f.title).toBe('● a')
  })
  it('first update then a change in window: leading + trailing at most', async () => {
    const f = createFakeBridge()
    const st = { name: 'a.sqlnb', dirty: false }
    const c = mk(f, st)
    c.update(); await vi.advanceTimersByTimeAsync(0)
    st.dirty = true; c.update(); st.dirty = false; c.update(); st.dirty = true; c.update()
    await vi.advanceTimersByTimeAsync(2000)
    expect(setCalls(f)).toEqual(['a', '● a'])
  })
  it('identical title is not re-sent', async () => {
    const f = createFakeBridge()
    const c = mk(f, { name: 'a.sqlnb', dirty: false })
    c.update(); await vi.advanceTimersByTimeAsync(1000); c.update(); await vi.advanceTimersByTimeAsync(1000)
    expect(setCalls(f)).toEqual(['a'])
  })
  it('rejected setTitle → no retry, later change attempted once', async () => {
    let n = 0
    const f = createFakeBridge({ requestHandlers: { 'host.setTitle': () => { n++; throw new Error('Host tab title update is unavailable') } } })
    const st = { name: 'a.sqlnb', dirty: false }
    const c = mk(f, st)
    c.update(); await vi.advanceTimersByTimeAsync(5000)
    expect(n).toBe(1)
    st.dirty = true; c.update(); await vi.advanceTimersByTimeAsync(5000)
    expect(n).toBe(2)
  })
  it('dispose sends null once; update after dispose is a no-op', async () => {
    const f = createFakeBridge()
    const c = mk(f, { name: 'a.sqlnb', dirty: false })
    c.update(); await vi.advanceTimersByTimeAsync(0)
    c.dispose(); c.dispose(); c.update(); await vi.advanceTimersByTimeAsync(2000)
    expect(setCalls(f)).toEqual(['a', null])
  })
  it('dispose without any title set sends nothing', async () => {
    const f = createFakeBridge(); const c = mk(f, { name: 'a', dirty: false })
    c.dispose(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.calls).toHaveLength(0)
  })
  it('title never contains connection names', async () => {
    const f = createFakeBridge({ connections: [{ id: 'cid', name: 'prod-secret', dbType: 'pg' }] })
    const s = createConnectionsStore(f); await s.refresh()
    const c = mk(f, { name: 'report.sqlnb', dirty: true })
    c.update(); await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.stringify(setCalls(f))).not.toMatch(/prod-secret|cid/)
  })
})

import { fileNameOf } from '../src/shell/tabTitle'
describe('tab title hardening', () => {
  it('surrogate pairs never split on truncation', () => {
    for (const pad of ['', 'a']) {
      const t = formatTabTitle(pad + '😀'.repeat(100) + '.sqlnb', false, U)
      expect([...t]).toHaveLength(80)
      expect(t).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }
    expect([...formatTabTitle('报'.repeat(100), true, U)]).toHaveLength(80)
  })
  it('control characters stripped', () => {
    expect(formatTabTitle('a\nb\u0000c\u202e.sqlnb', false, U)).toBe('abc')
    expect(formatTabTitle('\n\t.sqlnb', false, U)).toBe(U)
  })
  it('file names from Windows and posix paths', () => {
    expect(fileNameOf('C:\\Users\\me\\报表.sqlnb')).toBe('报表.sqlnb')
    expect(fileNameOf('/a/b/c.sqlnb')).toBe('c.sqlnb')
    expect(fileNameOf(null)).toBeNull(); expect(fileNameOf('/a/b/')).toBeNull()
  })
  it('synchronous throw / non-promise setTitle is swallowed', async () => {
    vi.useFakeTimers()
    const f = createFakeBridge() as any
    f.setTitle = () => { throw new Error('sync') }
    const c = createTabTitleController(f, { name: () => 'a', dirty: () => false, untitled: () => U })
    expect(() => c.update()).not.toThrow()
    f.setTitle = () => undefined
    expect(() => c.dispose()).not.toThrow()
    vi.useRealTimers()
  })
  it('clock jumping backwards never stalls updates beyond throttle', async () => {
    vi.useFakeTimers()
    const f = createFakeBridge()
    const st = { dirty: false }
    const c = createTabTitleController(f, { name: () => 'a', dirty: () => st.dirty, untitled: () => U }, { throttleMs: 400 })
    c.update(); await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() - 3_600_000)
    st.dirty = true; c.update()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.title).toBe('● a')
    vi.useRealTimers()
  })
})
