import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHostBridge, HostError } from '../src/host/bridge'

function install(over: Record<string, unknown> = {}) {
  const w = window as any
  w.dbxPlugin = { ready: Promise.resolve(), locale: 'zh-CN', context: {}, capabilities: { dataApi: true }, ...over }
  return w.dbxPlugin
}

describe('host bridge', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })

  it('capabilities all false when fields missing', () => {
    install({ capabilities: {} })
    expect(createHostBridge().capabilities()).toMatchObject({
      dataApi: false, schemaMetadataApi: false, storage: false, aiCompletion: false,
    })
  })

  it('maps "Connection is not open" to NOT_OPEN', async () => {
    install({ queryData: vi.fn().mockRejectedValue(new Error('Connection is not open')) })
    await expect(createHostBridge().queryData({ connectionId: 'c', sql: 'select 1' }))
      .rejects.toMatchObject({ name: 'HostError', code: 'NOT_OPEN' })
  })

  it('maps PLUGIN_DATA_ACCESS_NOT_GRANTED to NOT_GRANTED (string rejection)', async () => {
    install({ queryData: vi.fn().mockRejectedValue('PLUGIN_DATA_ACCESS_NOT_GRANTED: nope') })
    const p = createHostBridge().queryData({ connectionId: 'c', sql: 'select 1' })
    await expect(p).rejects.toBeInstanceOf(HostError)
    await expect(p).rejects.toMatchObject({ code: 'NOT_GRANTED' })
  })

  it('maps read-only rejection to NOT_READONLY', async () => {
    install({ queryData: vi.fn().mockRejectedValue(new Error('Only read-only statements are allowed')) })
    await expect(createHostBridge().queryData({ connectionId: 'c', sql: 'drop table x' }))
      .rejects.toMatchObject({ code: 'NOT_READONLY' })
  })

  it('throws UNSUPPORTED without calling host when dataApi=false', async () => {
    const queryData = vi.fn()
    install({ capabilities: { dataApi: false }, queryData })
    await expect(createHostBridge().queryData({ connectionId: 'c', sql: 'select 1' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(queryData).not.toHaveBeenCalled()
  })
})

describe('host bridge theme/env', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })
  it('theme defaults to light without editor', () => {
    ;(window as any).dbxPlugin = {}
    expect(createHostBridge().theme()).toEqual({ appearance: 'light' })
  })
  it('theme reads host theme', () => {
    ;(window as any).dbxPlugin = { theme: { appearance: 'dark', editor: { fontSize: 15, fontFamily: 'Mono' } } }
    expect(createHostBridge().theme()).toEqual({ appearance: 'dark', editor: { fontSize: 15, fontFamily: 'Mono' } })
  })
  it('onEnv subscribes to dbx-plugin-env and unsubscribes', () => {
    const fn = vi.fn()
    const off = createHostBridge().onEnv(fn)
    window.dispatchEvent(new Event('dbx-plugin-env'))
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    window.dispatchEvent(new Event('dbx-plugin-env'))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('rpcCode mapping', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })
  const reject = async (rej: unknown): Promise<HostError> => {
    ;(window as any).dbxPlugin = { ready: Promise.resolve(), invoke: vi.fn().mockRejectedValue(rej) }
    return createHostBridge().invoke('m', {}).then(() => { throw new Error('resolved') }, (e) => e as HostError)
  }
  it('parses [code] prefix and strips it', async () => {
    const e = await reject(new Error('[-32011] stale mtime'))
    expect(e.rpcCode).toBe(-32011); expect(e.message).toBe('stale mtime'); expect(e.rawMessage).toBe('[-32011] stale mtime')
  })
  it('parses prefix with path', async () => {
    const e = await reject(new Error('[-32012] parent directory missing: /x'))
    expect(e.rpcCode).toBe(-32012); expect(e.message).toBe('parent directory missing: /x')
  })
  it('parses prefix from string rejection', async () => {
    expect((await reject('[-32010] not found')).rpcCode).toBe(-32010)
  })
  it('ignores 5-digit numbers without prefix', async () => {
    const e = await reject(new Error('failed at 12345 bytes'))
    expect(e.rpcCode).toBeUndefined(); expect(e.message).toBe('failed at 12345 bytes')
  })
  it('ignores non-leading prefix', async () => {
    expect((await reject(new Error('x [-32011] y'))).rpcCode).toBeUndefined()
  })
  it('numeric err.code is a secondary source', async () => {
    expect((await reject(Object.assign(new Error('x'), { code: -32013 }))).rpcCode).toBe(-32013)
  })
  it('forwards timeoutMs', async () => {
    const invoke = vi.fn().mockResolvedValue(1)
    ;(window as any).dbxPlugin = { ready: Promise.resolve(), invoke }
    await createHostBridge().invoke('m', { a: 1 }, { timeoutMs: 5 })
    expect(invoke).toHaveBeenCalledWith('m', { a: 1 }, { timeoutMs: 5 })
  })
})

describe('host bridge AI', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })

  it('aiModelDiscovery capability', () => {
    install({ capabilities: { aiModelDiscovery: true } })
    expect(createHostBridge().capabilities().aiModelDiscovery).toBe(true)
    install({ capabilities: {} })
    expect(createHostBridge().capabilities().aiModelDiscovery).toBe(false)
  })

  it('classifies AI host errors', async () => {
    const run = (m: string): Promise<any> => { install({ invoke: vi.fn().mockRejectedValue(new Error(m)) }); return createHostBridge().invoke('x', {}).catch((e: any) => e) }
    expect((await run('AI generation cancelled.')).code).toBe('AI_CONSENT_DECLINED')
    expect((await run('AI is already generating. Please wait.')).code).toBe('AI_BUSY')
    expect((await run('something else')).code).toBe('UNKNOWN')
  })

  it('onEvent filters host events by method and passes params (dbxPlugin.onEvent)', () => {
    let l!: (m: unknown) => void
    install({ onEvent: (fn: any) => { l = fn; return () => {} } })
    const got: unknown[] = []
    createHostBridge().onEvent('host.ai.generationChunk', (p) => got.push(p))
    l({ type: 'event', method: 'host.download.progress', params: 1 })
    l({ type: 'env', method: 'host.ai.generationChunk', params: 3 })
    l({ type: 'event', method: 'host.ai.generationChunk', params: { a: 2 } })
    expect(got).toEqual([{ a: 2 }])
  })

  it('onEvent falls back to dbx-plugin-event DOM event and unsubscribes', () => {
    install({})
    const got: unknown[] = []
    const off = createHostBridge().onEvent('e', (p) => got.push(p))
    document.dispatchEvent(new CustomEvent('dbx-plugin-event', { detail: { type: 'event', method: 'e', params: 7 } }))
    off()
    document.dispatchEvent(new CustomEvent('dbx-plugin-event', { detail: { type: 'event', method: 'e', params: 8 } }))
    expect(got).toEqual([7])
  })
})

describe('host bridge channels (regression: 0.5.0 sent host.ai.* via backend.invoke)', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })

  function realShape() {
    const request = vi.fn(async (_m: string, _p?: unknown, _o?: unknown): Promise<unknown> => [])
    const invoke = vi.fn(async (m: string, p: unknown, o?: any) => request('backend.invoke', { method: m, params: p, timeoutMs: o?.timeoutMs }))
    install({ request, invoke, capabilities: { aiCompletion: true, aiCompletionStream: true } })
    return { request, invoke }
  }

  it('request() goes to host request, never invoke, and forwards options-free params', async () => {
    const { request, invoke } = realShape()
    await createHostBridge().request('host.ai.listModels', {})
    expect(request).toHaveBeenCalledWith('host.ai.listModels', {})
    expect(invoke).not.toHaveBeenCalled()
  })

  it('request() maps errors like invoke', async () => {
    install({ request: vi.fn().mockRejectedValue(new Error('AI is already generating. Please wait.')) })
    await expect(createHostBridge().request('host.ai.generateText', {})).rejects.toMatchObject({ code: 'AI_BUSY' })
  })

  it('request() times out via options when given', async () => {
    const { request } = realShape()
    await createHostBridge().request('host.ai.generateText', { a: 1 }, { timeoutMs: 9 })
    expect(request).toHaveBeenCalledWith('host.ai.generateText', { a: 1 }, { timeoutMs: 9 })
  })

  it('every AI client call uses request and never invoke', async () => {
    const { request, invoke } = realShape()
    const models = [{ configId: 'c', model: 'm', name: 'M', isDefault: true }]
    let hang = false
    request.mockImplementation(async (m: string) => (m === 'host.ai.listModels' ? models : hang ? new Promise(() => {}) : 'text'))
    const { createAiClient } = await import('../src/ai/aiClient')
    const client = createAiClient(createHostBridge())
    await client.listModels()
    await client.generate({ task: 'rewrite', prompt: 'p' })
    hang = true
    const ctl = new AbortController()
    const p = client.generate({ task: 'rewrite', prompt: 'p', signal: ctl.signal })
    await new Promise((r) => setTimeout(r, 10))
    ctl.abort()
    await p.catch(() => {})
    const names = request.mock.calls.map((c) => c[0])
    expect(names).toEqual(expect.arrayContaining(['host.ai.listModels', 'host.ai.generateTextStream', 'host.ai.cancelGeneration']))
    install({ request, invoke, capabilities: { aiCompletion: true } })
    hang = false
    await createAiClient(createHostBridge()).generate({ task: 'rewrite', prompt: 'p' })
    expect(request.mock.calls.map((c) => c[0])).toContain('host.ai.generateText')
    expect(invoke).not.toHaveBeenCalled()
    expect(names).not.toContain('backend.invoke')
  })

  it('backend callers still use invoke (backend.invoke), not request directly', async () => {
    const { request, invoke } = realShape()
    await createHostBridge().invoke('notebook/read', { path: 'x' })
    expect(invoke).toHaveBeenCalledWith('notebook/read', { path: 'x' })
    expect(request).toHaveBeenCalledWith('backend.invoke', expect.objectContaining({ method: 'notebook/read' }))
  })
})

import { createFakeBridge } from '../src/host/fakeBridge'
import { parseConnections } from '../src/host/bridge'
import { createConnectionsStore } from '../src/connections/hostConnections'

describe('host title / connections', () => {
  beforeEach(() => { delete (window as any).dbxPlugin })

  it('setTitle sends host.setTitle via request with {title}', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    install({ capabilities: { workbenchTitle: true }, request })
    await createHostBridge().setTitle('a')
    expect(request).toHaveBeenCalledWith('host.setTitle', { title: 'a' })
  })
  it('setTitle null sends {title:null}', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    install({ capabilities: { workbenchTitle: true }, request })
    await createHostBridge().setTitle(null)
    expect(request).toHaveBeenCalledWith('host.setTitle', { title: null })
  })
  it('setTitle/getTitle without workbenchTitle throws UNSUPPORTED and makes zero host calls', async () => {
    const request = vi.fn(); const invoke = vi.fn()
    install({ capabilities: { workbenchTitle: 'yes' }, request, invoke })
    const b = createHostBridge()
    await expect(b.setTitle('a')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(b.getTitle()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(request).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled()
  })
  it('getTitle uses request', async () => {
    const request = vi.fn().mockResolvedValue('t')
    install({ capabilities: { workbenchTitle: true }, request })
    expect(await createHostBridge().getTitle()).toBe('t')
    expect(request.mock.calls[0][0]).toBe('host.getTitle')
  })
  it('getConnections without connectionsApi throws UNSUPPORTED, zero calls', async () => {
    const request = vi.fn()
    install({ capabilities: {}, request })
    await expect(createHostBridge().getConnections()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(request).not.toHaveBeenCalled()
  })
  it('getConnections maps isConnected/dialect aliases', async () => {
    const request = vi.fn().mockResolvedValue([
      { id: '1', name: 'a', dialect: 'pg', isConnected: true, readOnly: true, database: 'd', schema: 's' },
      { id: '2', name: 'b', dbType: 'mysql', connected: true },
    ])
    install({ capabilities: { connectionsApi: true }, request })
    const r = await createHostBridge().getConnections()
    expect(request).toHaveBeenCalledWith('host.getConnections', {})
    expect(r).toEqual([
      { id: '1', name: 'a', dialect: 'pg', connected: true, readOnly: true, database: 'd', schema: 's' },
      { id: '2', name: 'b', dialect: 'mysql', connected: true, readOnly: false },
    ])
  })
  it('parseConnections drops bad entries and secret-looking keys; non-array → []', () => {
    const r = parseConnections([{ id: '1', name: 'a', host: 'h', password: 'p', url: 'u' }, { id: '', name: 'x' }, { name: 'y' }, null, 5])
    expect(r).toHaveLength(1)
    expect(Object.keys(r[0]).sort()).toEqual(['connected', 'dialect', 'id', 'name', 'readOnly'])
    expect(parseConnections({})).toEqual([]); expect(parseConnections('x')).toEqual([]); expect(parseConnections(null)).toEqual([])
  })
  it('capabilities reports workbenchTitle/connectionsApi only when === true', () => {
    install({ capabilities: { workbenchTitle: 1, connectionsApi: 'true' } })
    expect(createHostBridge().capabilities()).toMatchObject({ workbenchTitle: false, connectionsApi: false })
    install({ capabilities: { workbenchTitle: true, connectionsApi: true } })
    expect(createHostBridge().capabilities()).toMatchObject({ workbenchTitle: true, connectionsApi: true })
  })
  it('permission denied maps to HostError and never escapes store.refresh', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Missing permission: host.connections:read'))
    install({ capabilities: { connectionsApi: true }, request })
    const b = createHostBridge()
    await expect(b.getConnections()).rejects.toMatchObject({ name: 'HostError', code: 'UNKNOWN' })
    const s = createConnectionsStore(b)
    await expect(s.refresh({ force: true })).resolves.toBe(false)
    expect(s.state.value).toBe('unavailable')
  })

  it('fake: floating → setTitle rejects UNSUPPORTED', async () => {
    const f = createFakeBridge({ floating: true })
    await expect(f.setTitle('x')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(f.calls).toHaveLength(0); expect(f.titleCalls).toBe(0)
  })
  it('fake: setTitle records and slices to 256; null resets', async () => {
    const f = createFakeBridge()
    await f.setTitle('a'.repeat(300))
    expect(f.title).toHaveLength(256); expect(f.titleCalls).toBe(1)
    expect(await f.getTitle()).toHaveLength(256)
    await f.setTitle(null); expect(f.title).toBeNull()
  })
  it('fake: denyConnections rejects; no capability → zero calls; invoke host.* still rejects', async () => {
    const d = createFakeBridge({ denyConnections: true })
    await expect(d.getConnections()).rejects.toThrow(/Missing permission/)
    const n = createFakeBridge({ caps: { connectionsApi: false } })
    await expect(n.getConnections()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(n.calls).toHaveLength(0)
    await expect(createFakeBridge().invoke('host.setTitle', {})).rejects.toBeTruthy()
  })
  it('fake: getConnections returns opts.connections', async () => {
    const f = createFakeBridge({ connections: [{ id: '1', name: 'a', dbType: 'pg' }] })
    expect(await f.getConnections()).toMatchObject([{ id: '1', name: 'a', dialect: 'pg' }])
  })
})
