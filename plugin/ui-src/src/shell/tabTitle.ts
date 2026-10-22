import type { HostBridge } from '../host/bridge'

const MAX = 80

export function fileNameOf(path: string | null): string | null {
  return path ? path.split(/[\\/]/).pop() || null : null
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g

export function formatTabTitle(name: string | null, dirty: boolean, untitled: string): string {
  const clean = name ? name.replace(CONTROL, '').replace(/\.sqlnb$/i, '').trim() : ''
  const base = clean || untitled
  const t = (dirty ? '● ' : '') + base
  const chars = [...t]
  return chars.length > MAX ? chars.slice(0, MAX - 1).join('') + '…' : t
}

export interface TabTitleDeps { name: () => string | null; dirty: () => boolean; untitled: () => string }

export function createTabTitleController(bridge: HostBridge, deps: TabTitleDeps, opts: { throttleMs?: number } = {}) {
  const throttleMs = opts.throttleMs ?? 400
  let lastSent: string | null | undefined
  let everSet = false
  let disposed = false
  let lastAt = -Infinity
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const supported = () => bridge.capabilities().workbenchTitle === true

  function send(title: string | null) {
    lastSent = title
    lastAt = clock()
    if (title !== null) everSet = true
    try { void Promise.resolve(bridge.setTitle(title)).catch(() => {}) } catch { /* swallowed */ }
  }

  function flush() {
    timer = undefined
    if (disposed || !supported()) return
    const t = formatTabTitle(deps.name(), deps.dirty(), deps.untitled())
    if (t !== lastSent) send(t)
  }

  return {
    update() {
      if (disposed || !supported()) return
      if (timer !== undefined) return
      const wait = Math.min(throttleMs, lastAt + throttleMs - clock())
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (everSet && supported()) send(null)
    },
  }
}
