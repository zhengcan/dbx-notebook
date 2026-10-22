import { reactive } from 'vue'
import type { createCatalogCache, CatalogConn } from '../run/catalog'

type Cache = ReturnType<typeof createCatalogCache>
interface Slot { options: string[]; loading: boolean; error?: string }

export function useCatalogOptions(cache: Cache, conn: () => CatalogConn | undefined, database: () => string | undefined) {
  const db = reactive<Slot>({ options: [], loading: false })
  const sc = reactive<Slot>({ options: [], loading: false })
  const gen = new Map<Slot, number>()
  const bump = (slot: Slot) => { gen.set(slot, (gen.get(slot) ?? 0) + 1); slot.loading = false }
  async function load(slot: Slot, get: (c: CatalogConn) => Promise<string[]>) {
    const c = conn()
    if (!c) return
    bump(slot)
    const g = gen.get(slot)
    slot.loading = true
    slot.error = undefined
    try {
      const r = await get(c)
      if (gen.get(slot) !== g) return
      slot.options = r
    } catch (e) {
      if (gen.get(slot) !== g) return
      slot.options = []
      slot.error = e instanceof Error ? e.message : String(e)
    }
    if (gen.get(slot) === g) slot.loading = false
  }
  const loadDatabases = () => load(db, (c) => cache.getDatabases(c))
  const loadSchemas = () => load(sc, (c) => cache.getSchemas(c, database()))
  function reset() { bump(db); bump(sc); db.options = []; sc.options = []; db.error = sc.error = undefined }
  async function refresh(loaded: { db: boolean; sc: boolean }) {
    const c = conn()
    if (!c) return
    cache.clear(c.id)
    reset()
    if (loaded.db) await loadDatabases()
    if (loaded.sc) await loadSchemas()
  }
  return { db, sc, loadDatabases, loadSchemas, reset, refresh }
}
