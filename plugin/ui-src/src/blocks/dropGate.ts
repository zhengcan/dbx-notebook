export type GateResult = 'ok' | 'duplicate'
export interface DropGate { claim(path: 'html5' | 'host', sig: string, dropId?: string): GateResult }

const WINDOW_MS = 1000
const MAX_IDS = 32

export function dropSignature(items: Array<{ name: string; size: number }>): string {
  return items.map((i) => `${i.name}:${i.size}`).sort().join('|')
}

// A host drop that carries a dropId is only a duplicate of the same dropId, or of an HTML5 drop with the
// same signature (both paths firing). Without a dropId the signature window applies to both paths.
export function createDropGate(now: () => number = Date.now): DropGate {
  const seen: Record<'html5' | 'host', Map<string, number>> = { html5: new Map(), host: new Map() }
  const ids: string[] = []
  const fresh = (m: Map<string, number>, sig: string, t: number) => {
    const last = m.get(sig)
    return last !== undefined && t >= last && t - last <= WINDOW_MS
  }
  return {
    claim(path, sig, dropId) {
      const t = now()
      if (dropId) {
        if (ids.includes(dropId)) return 'duplicate'
        ids.push(dropId)
        if (ids.length > MAX_IDS) ids.shift()
      }
      const other = path === 'host' ? 'html5' : 'host'
      const dup = fresh(seen[other], sig, t) || (!dropId && fresh(seen[path], sig, t))
      seen[path].set(sig, t)
      for (const m of Object.values(seen)) for (const [k, v] of m) if (t < v || t - v > WINDOW_MS) m.delete(k)
      return dup ? 'duplicate' : 'ok'
    },
  }
}
