interface Flight<T> { fp: string; p: Promise<T> }

// Per-store, per-block in-flight dedupe + supersession token. A run whose fingerprint equals the
// in-flight one is shared; any other run takes a new token so older runs see isLatest() === false.
export function createFlights<T>() {
  const inflight = new WeakMap<object, Map<string, Flight<T>>>()
  const tokens = new WeakMap<object, Map<string, number>>()
  return {
    run(store: object, blockId: string, fp: string, exec: (isLatest: () => boolean) => Promise<T>): Promise<T> {
      let m = inflight.get(store)
      if (!m) inflight.set(store, (m = new Map()))
      let tk = tokens.get(store)
      if (!tk) tokens.set(store, (tk = new Map()))
      const cur = m.get(blockId)
      if (cur && cur.fp === fp) return cur.p
      const token = (tk.get(blockId) ?? 0) + 1
      tk.set(blockId, token)
      const p: Promise<T> = exec(() => tk!.get(blockId) === token).finally(() => {
        if (m!.get(blockId)?.p === p) m!.delete(blockId)
      })
      m.set(blockId, { fp, p })
      return p
    },
  }
}
