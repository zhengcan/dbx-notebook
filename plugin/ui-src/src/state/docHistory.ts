import { clone, type Block, type Notebook } from '@sqlnb/format'
import type { DocDelta, DocEntry } from './history'

export type Touched = { ids: string[]; order?: boolean; doc?: ('settings' | 'connections' | 'metadata')[] }

export function cloneTouched(nb: Notebook, t: Touched): DocDelta {
  const d: DocDelta = { blocks: new Map() }
  for (const id of t.ids) {
    const b = nb.blocks.find((x) => x.id === id)
    d.blocks.set(id, b ? (clone(b) as Block) : null)
  }
  if (t.order) d.order = nb.blocks.map((b) => b.id)
  for (const k of t.doc ?? []) (d as any)[k] = nb[k] === undefined ? undefined : clone(nb[k])
  return d
}

export function applyDelta(nb: Notebook, d: DocDelta): void {
  for (const [id, b] of d.blocks) {
    const i = nb.blocks.findIndex((x) => x.id === id)
    if (b === null) { if (i >= 0) nb.blocks.splice(i, 1) }
    else if (i >= 0) nb.blocks[i] = clone(b) as Block
    else nb.blocks.push(clone(b) as Block)
  }
  if (d.order) {
    const byId = new Map(nb.blocks.map((b) => [b.id, b]))
    const wanted = new Set(d.order)
    const ordered = d.order.map((id) => byId.get(id)).filter((b): b is Block => !!b)
    const rest = nb.blocks.filter((b) => !wanted.has(b.id))
    nb.blocks.splice(0, nb.blocks.length, ...ordered, ...rest)
  }
  for (const k of ['settings', 'connections', 'metadata'] as const) {
    if (k in d) (nb as any)[k] = d[k] === undefined ? undefined : clone(d[k])
  }
}

export function deltaBytes(d: DocDelta): number {
  let n = 0
  for (const [id, b] of d.blocks) n += id.length * 2 + (b ? JSON.stringify(b).length * 2 : 8)
  if (d.order) n += d.order.reduce((a, x) => a + x.length * 2 + 8, 0)
  for (const k of ['settings', 'connections', 'metadata'] as const) if (d[k] !== undefined) n += JSON.stringify(d[k]).length * 2
  return n
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)

// metadata.spec of a chart block is derived from its config and the upstream columns (regenSpec); it never takes part in conflict checks.
function comparable(b: Block | null | undefined): unknown {
  if (!b || b.type !== 'chart' || !b.metadata || !('spec' in b.metadata)) return b
  const { spec: _spec, ...rest } = b.metadata as Record<string, unknown>
  return { ...b, metadata: rest }
}

export function sameDelta(a: DocDelta, b: DocDelta): boolean {
  if (a.blocks.size !== b.blocks.size) return false
  for (const [id, x] of a.blocks) {
    if (!b.blocks.has(id) || !same(x, b.blocks.get(id))) return false
  }
  if (!same(a.order, b.order)) return false
  for (const k of ['settings', 'connections', 'metadata'] as const) if (!same(a[k], b[k])) return false
  return true
}

export function checkDelta(nb: Notebook, e: DocEntry, dir: 'undo' | 'redo'): 'ok' | 'conflict' {
  const expected = dir === 'undo' ? e.after : e.before
  for (const [id, b] of expected.blocks) {
    const live = nb.blocks.find((x) => x.id === id)
    if (b === null ? live : !live || !same(comparable(live), comparable(b))) return 'conflict'
  }
  for (const k of ['settings', 'connections', 'metadata'] as const) {
    if (k in expected && !same(nb[k], expected[k])) return 'conflict'
  }
  if (dir === 'redo' && e.after.order) {
    const ord = e.after.order
    for (const [id, b] of e.after.blocks) {
      if (b === null || e.before.blocks.get(id) !== null) continue
      const prev = ord[ord.indexOf(id) - 1]
      if (prev !== undefined && !e.after.blocks.has(prev) && !nb.blocks.some((x) => x.id === prev)) return 'conflict'
    }
  }
  return 'ok'
}
