import { HostError, mapHostError, parseConnections, type Capabilities, type HostBridge } from './bridge'

export type FakeBridge = HostBridge & { title: string | null; titleCalls: number; calls: unknown[]; emitEnv(): void; emit(name: string, payload: unknown): void }

export type InvokeHandler = (params: any) => unknown | Promise<unknown>

export function createFakeBridge(opts: Partial<HostBridge> & { caps?: Partial<Capabilities>; locale?: string; invokeHandlers?: Record<string, InvokeHandler>; requestHandlers?: Record<string, InvokeHandler>; floating?: boolean; connections?: unknown[]; denyConnections?: boolean } = {}): FakeBridge {
  const calls: unknown[] = []
  const caps: Capabilities = {
    dataApi: true, schemaMetadataApi: true, storage: true, aiCompletion: false,
    workbenchTitle: !opts.floating, connectionsApi: true, ...opts.caps,
  }
  const state = { title: null as string | null, titleCalls: 0 }
  const builtins: Record<string, InvokeHandler> = {
    'host.setTitle': (p) => {
      if (!p || !(typeof p.title === 'string' || p.title === null)) throw new Error('Invalid title')
      if (!caps.workbenchTitle) throw new Error('Host tab title update is unavailable')
      state.titleCalls++
      state.title = typeof p.title === 'string' ? (p.title.trim().slice(0, 256) || null) : null
    },
    'host.getTitle': () => {
      if (!caps.workbenchTitle) throw new Error('Host tab title update is unavailable')
      return state.title ?? ''
    },
    'host.getConnections': () => {
      if (!caps.connectionsApi) throw new Error('Method not found: host.getConnections')
      if (opts.denyConnections) throw new Error('Missing permission: host.connections:read')
      return opts.connections ?? []
    },
  }
  const store = new Map<string, unknown>()
  const listeners = new Set<(c: Record<string, unknown>) => void>()
  const envListeners = new Set<() => void>()
  const eventListeners = new Map<string, Set<(p: unknown) => void>>()
  const rec = (method: string, args: unknown) => calls.push({ method, args })
  const base: HostBridge = {
    ready: async () => {},
    capabilities: () => caps,
    locale: () => opts.locale ?? 'en',
    context: () => ({}),
    onContext(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    theme: () => ({ appearance: 'light' }),
    onEnv(fn) { envListeners.add(fn); return () => envListeners.delete(fn) },
    onEvent(name, fn) {
      const set = eventListeners.get(name) ?? new Set()
      eventListeners.set(name, set); set.add(fn)
      return () => { set.delete(fn) }
    },
    async queryData(req) {
      rec('queryData', req)
      if (!caps.dataApi) throw new HostError('UNSUPPORTED', 'dataApi')
      return { columns: [], rows: [], truncated: false, elapsedMs: 0, dbType: 'fake' }
    },
    async getTableMetadata(req) {
      rec('getTableMetadata', req)
      if (!caps.schemaMetadataApi) throw new HostError('UNSUPPORTED', 'schemaMetadataApi')
      return { columns: [] }
    },
    async storageGet<T>(key: string) {
      if (!caps.storage) throw new HostError('UNSUPPORTED', 'storage')
      rec('storageGet', key); return (store.get(key) ?? null) as T | null
    },
    async storageSet(key, value) {
      if (!caps.storage) throw new HostError('UNSUPPORTED', 'storage')
      rec('storageSet', { key, value }); store.set(key, value)
    },
    async request<T>(method: string, params?: unknown) { rec('request', { method, params })
      const h = opts.requestHandlers?.[method] ?? builtins[method]
      if (!h) throw mapHostError(new Error(`Method not found: ${method}`))
      try { return (await h(params)) as T } catch (e) { throw mapHostError(e) }
    },
    async setTitle(title) {
      if (caps.workbenchTitle !== true) throw new HostError('UNSUPPORTED', 'workbenchTitle')
      await base.request('host.setTitle', { title })
    },
    async getTitle() {
      if (caps.workbenchTitle !== true) throw new HostError('UNSUPPORTED', 'workbenchTitle')
      return base.request<string>('host.getTitle')
    },
    async getConnections() {
      if (caps.connectionsApi !== true) throw new HostError('UNSUPPORTED', 'connectionsApi')
      return parseConnections(await base.request<unknown>('host.getConnections', {}))
    },
    async invoke<T>(method: string, params: unknown) { rec('invoke', { method, params })
      // Real host forwards invoke to the plugin's own sidecar, which has no host.* methods.
      if (method.startsWith('host.')) throw mapHostError(new Error(`Method not found: ${method}`))
      const h = opts.invokeHandlers?.[method]
      try { return (h ? await h(params) : undefined) as T } catch (e) { throw mapHostError(e) }
    },
  }
  const { caps: _c, locale: _l, invokeHandlers: _i, requestHandlers: _r, floating: _f, connections: _cn, denyConnections: _d, ...overrides } = opts
  Object.defineProperty(base, 'title', { get: () => state.title, enumerable: true })
  Object.defineProperty(base, 'titleCalls', { get: () => state.titleCalls, enumerable: true })
  return Object.assign(base, overrides, { calls, emitEnv: () => envListeners.forEach((f) => f()),
    emit: (name: string, payload: unknown) => [...(eventListeners.get(name) ?? [])].forEach((f) => f(payload)) }) as FakeBridge
}
