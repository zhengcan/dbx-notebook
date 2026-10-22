import { watch } from 'vue'
import { describe, it, expect, vi } from 'vitest'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createConnectionsStore } from '../src/connections/hostConnections'

const C = (id: string, name: string, extra: object = {}) => ({ id, name, dbType: 'pg', ...extra })
const reqs = (f: any) => f.calls.filter((c: any) => c.method === 'request')

describe('connections store', () => {
  it('refresh fills list and state ready', async () => {
    const f = createFakeBridge({ connections: [C('2', 'b'), C('1', 'a')] })
    const s = createConnectionsStore(f)
    expect(s.state.value).toBe('idle')
    expect(await s.refresh()).toBe(true)
    expect(s.state.value).toBe('ready')
    expect(s.list().map(c => c.id)).toEqual(['1', '2'])
  })
  it('applies stored mapping before publishing ready (no ambiguous frame)', async () => {
    const f = createFakeBridge({ connections: [C('1', 'dup'), C('2', 'dup')] })
    f.storageGet = (async () => { await new Promise(r => setTimeout(r, 30)); return { dup: '2' } }) as any
    const s = createConnectionsStore(f)
    const seen: string[] = []
    watch(s.state, v => { if (v === 'ready') seen.push(JSON.stringify(s.resolve('dup'))) }, { flush: 'sync' })
    await s.refresh()
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0])).toMatchObject({ status: 'ok', conn: { id: '2' } })
  })
  it('mapping load failure does not block ready', async () => {
    const f = createFakeBridge({ connections: [C('1', 'a')] })
    f.storageGet = (async () => { throw new Error('x') }) as any
    const s = createConnectionsStore(f)
    expect(await s.refresh()).toBe(true); expect(s.state.value).toBe('ready')
  })
  it('no connectionsApi → unavailable, empty, zero requests', async () => {
    const f = createFakeBridge({ caps: { connectionsApi: false }, connections: [C('1', 'a')] })
    const s = createConnectionsStore(f)
    expect(await s.refresh()).toBe(false)
    expect(s.state.value).toBe('unavailable'); expect(s.list()).toEqual([]); expect(f.calls).toHaveLength(0)
  })
  it('denied / rejected / timeout → unavailable and list cleared', async () => {
    const mk = (h: () => unknown, timeoutMs?: number) => {
      const f = createFakeBridge({ connections: [C('1', 'a')], requestHandlers: { 'host.getConnections': h as any } })
      return createConnectionsStore(f, { timeoutMs })
    }
    for (const s of [mk(() => { throw new Error('Missing permission: host.connections:read') }), mk(() => Promise.reject(new Error('x'))), mk(() => new Promise(() => {}), 20)]) {
      s.seedFromContext({ id: 's', name: 'seed', dbType: 'pg' })
      expect(await s.refresh({ force: true })).toBe(false)
      expect(s.state.value).toBe('unavailable')
      expect(s.list().filter(c => c.id !== 's')).toEqual([])
    }
    // previously good list is cleared on failure
    let fail = false
    const f = createFakeBridge({ requestHandlers: { 'host.getConnections': () => { if (fail) throw new Error('boom'); return [C('1', 'a')] } } })
    const s = createConnectionsStore(f, { minRefreshMs: 0 })
    await s.refresh(); expect(s.list()).toHaveLength(1)
    fail = true; await s.refresh({ force: true }); expect(s.list()).toEqual([])
  })
  it('refreshIfStale honors minRefreshMs; force always requests', async () => {
    let t = 0
    const f = createFakeBridge({ connections: [C('1', 'a')] })
    const s = createConnectionsStore(f, { now: () => t, minRefreshMs: 1000 })
    await s.refreshIfStale(); await s.refreshIfStale()
    expect(reqs(f)).toHaveLength(1)
    t = 1500; await s.refreshIfStale(); expect(reqs(f)).toHaveLength(2)
    await s.refresh({ force: true }); expect(reqs(f)).toHaveLength(3)
  })
  it('resolve: ok / unmatched / ambiguous / mapping wins / case-sensitive', async () => {
    const f = createFakeBridge({ connections: [C('1', 'a'), C('2', 'dup'), C('3', 'dup')] })
    const s = createConnectionsStore(f)
    await s.refresh()
    expect(s.resolve('a')).toMatchObject({ status: 'ok', conn: { id: '1' } })
    expect(s.resolve('A').status).toBe('unmatched')
    expect(s.resolve('zz').status).toBe('unmatched')
    const amb = s.resolve('dup'); expect(amb.status).toBe('ambiguous')
    await s.setMapping('dup', '3')
    expect(s.resolve('dup')).toMatchObject({ status: 'ok', conn: { id: '3' } })
    const s2 = createConnectionsStore(f)
    await s2.refresh()
    expect(s2.resolve('dup')).toMatchObject({ status: 'ok', conn: { id: '3' } })
  })
  it('seedFromContext resolves when unavailable and is replaced by the real entry', async () => {
    const f = createFakeBridge({ caps: { connectionsApi: false } })
    const s = createConnectionsStore(f)
    expect(s.seedFromContext({ connectionId: 'x', name: 'n', dbType: 'pg' })).toEqual({ name: 'n', dbType: 'pg' })
    expect(s.seedFromContext({ name: 'n' })).toBeNull()
    expect(s.resolve('n')).toMatchObject({ status: 'ok', conn: { id: 'x' } })
    const f2 = createFakeBridge({ connections: [C('real', 'n')] })
    const s2 = createConnectionsStore(f2)
    s2.seedFromContext({ id: 'x', name: 'n', dbType: 'pg' })
    await s2.refresh()
    expect(s2.list().map(c => c.id)).toEqual(['real'])
  })
  it('privacy: storageSet never called with connection data; legacy keys never read', async () => {
    const f = createFakeBridge({ connections: [C('secret-id', 'secret-name')] })
    const s = createConnectionsStore(f)
    await s.refresh(); s.resolve('secret-name')
    expect(f.calls.filter((c: any) => c.method === 'storageSet')).toEqual([])
    expect(f.calls.some((c: any) => c.method === 'invoke')).toBe(false)
    expect(f.calls.some((c: any) => c.method === 'storageGet' && c.args === 'connections.v1')).toBe(false)
    await s.setMapping('secret-name', 'secret-id')
    const sets = f.calls.filter((c: any) => c.method === 'storageSet') as any[]
    expect(sets.map(c => c.args.key)).toEqual(['connectionMappings.v1'])
    await f.storageSet('connections.v1', [C('old', 'old')])
    const s3 = createConnectionsStore(f); await s3.refresh()
    expect(f.calls.filter((c: any) => c.method === 'storageGet').map((c: any) => c.args)).not.toContain('connections.v1')
    expect(s3.list().map(c => c.id)).toEqual(['secret-id'])
  })
  it('does not log connection data', async () => {
    const spies = (['log', 'warn', 'error', 'debug'] as const).map(k => vi.spyOn(console, k).mockImplementation(() => {}))
    const f = createFakeBridge({ requestHandlers: { 'host.getConnections': () => { throw new Error('boom') } } })
    await createConnectionsStore(f).refresh()
    spies.forEach(s => { expect(JSON.stringify(s.mock.calls)).not.toMatch(/secret/); s.mockRestore() })
  })
})

import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, inject, provide } from 'vue'
import App from '../src/App.vue'
import { ConnectionsKey } from '../src/injection'
import { fakeEditorFactory } from './helpers'
import { parseConnections } from '../src/host/bridge'

describe('store hardening', () => {
  it('App injects a store whose state is a ref and re-renders on transitions', async () => {
    let injected: any = null
    const fail = { v: false }
    const bridge = createFakeBridge({ requestHandlers: { 'host.getConnections': () => { if (fail.v) throw new Error('x'); return [C('1', 'a')] },
      } } as any)
    ;(bridge as any).invoke = async () => ({ items: [] })
    const w = mount(App, {
      props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body,
      global: { mixins: [{ inject: { __c: { from: ConnectionsKey, default: null } }, created(this: any) { if (this.__c) injected ??= this.__c } }] },
    })
    await flushPromises()
    expect(injected).toBeTruthy()
    expect(injected.state.value).toBe('ready')
    const Child = defineComponent({ setup() { const s = inject(ConnectionsKey)!; return () => h('i', s.state.value + ':' + s.list().length) } })
    const Probe = defineComponent({ setup() { provide(ConnectionsKey, injected); return () => h(Child) } })
    const p = mount(Probe)
    expect(p.text()).toBe('ready:1')
    fail.v = true
    await injected.refresh({ force: true }); await flushPromises()
    expect(p.text()).toBe('unavailable:0')
    w.unmount()
  })
  it('after a failure, refreshIfStale backs off 30s; force still asks', async () => {
    vi.useFakeTimers()
    try {
      let t = 0
      const f = createFakeBridge({ requestHandlers: { 'host.getConnections': () => { throw new Error('Missing permission') } } })
      const s = createConnectionsStore(f, { now: () => t, minRefreshMs: 1000 })
      await s.refresh()
      expect(reqs(f)).toHaveLength(1)
      t = 5000; await s.refreshIfStale(); expect(reqs(f)).toHaveLength(1)
      t = 29000; await s.refreshIfStale(); expect(reqs(f)).toHaveLength(1)
      await s.refresh({ force: true }); expect(reqs(f)).toHaveLength(2)
      t = 29000 + 31000; await s.refreshIfStale(); expect(reqs(f)).toHaveLength(3)
    } finally { vi.useRealTimers() }
  })
  it('__proto__/constructor mapping keys are inert', async () => {
    const f = createFakeBridge({ connections: [C('1', 'a'), C('2', 'constructor'), C('3', '__proto__')] })
    await f.storageSet('connectionMappings.v1', JSON.parse('{"__proto__":"1","constructor":"1","toString":"1"}'))
    const s = createConnectionsStore(f); await s.refresh()
    expect(({} as any).polluted).toBeUndefined(); expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(s.resolve('constructor')).toMatchObject({ status: 'ok', conn: { id: '1' } })
    expect(s.resolve('hasOwnProperty').status).toBe('unmatched')
    await s.setMapping('__proto__', '3')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(s.resolve('__proto__')).toMatchObject({ conn: { id: '3' } })
  })
  it('parseConnections: __proto__/constructor keys in host objects, cap, dedupe by id (first wins)', () => {
    const evil = JSON.parse('{"id":"1","name":"a","__proto__":{"x":1},"constructor":{"y":2}}')
    const r = parseConnections([evil])
    expect(Object.keys(r[0]).sort()).toEqual(['connected', 'dialect', 'id', 'name', 'readOnly'])
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: 'i' + i, name: 'n' + i }))
    expect(parseConnections(many)).toHaveLength(2000)
    const d = parseConnections([{ id: '1', name: 'first' }, { id: '1', name: 'second' }])
    expect(d).toHaveLength(1); expect(d[0].name).toBe('first')
  })
})
