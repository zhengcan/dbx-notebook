import { ref, type Ref } from 'vue'
import { clampMaxRows, DEFAULT_MAX_ROWS } from '@sqlnb/format'
import type { HostBridge } from '../host/bridge'

const KEY = 'settings.maxRows.v1'

export interface PluginSettingsOpts { now?: () => number; minRefreshMs?: number; timeoutMs?: number }

export interface PluginSettings {
  maxRows: Ref<number>
  load(): Promise<void>
  refreshIfStale(): Promise<void>
  setMaxRows(n: unknown): Promise<number>
}

export function createPluginSettings(bridge: HostBridge, opts: PluginSettingsOpts = {}): PluginSettings {
  const now = opts.now ?? (() => Date.now())
  const minRefreshMs = opts.minRefreshMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 2500
  const maxRows = ref(DEFAULT_MAX_ROWS)
  let lastRefresh = -Infinity
  let writes = 0

  async function bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    p.catch(() => {})
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('storage timeout')), timeoutMs) })])
    } finally { clearTimeout(timer) }
  }

  async function read() {
    lastRefresh = now()
    const seen = writes
    try {
      const v = await bounded(bridge.storageGet<unknown>(KEY))
      if (seen !== writes) return
      maxRows.value = typeof v === 'number' && Number.isFinite(v) ? clampMaxRows(v) : DEFAULT_MAX_ROWS
    } catch {
      // storage unavailable: keep the current in-memory value
    }
  }

  return {
    maxRows,
    load: read,
    refreshIfStale: async () => {
      if (now() - lastRefresh < minRefreshMs) return
      await read()
    },
    async setMaxRows(n: unknown) {
      const v = clampMaxRows(n)
      writes++
      maxRows.value = v
      try { await bounded(bridge.storageSet(KEY, v)) } catch { /* keep in memory */ }
      return v
    },
  }
}
