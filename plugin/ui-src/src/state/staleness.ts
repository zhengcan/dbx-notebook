import type { Block, InputVar } from '@sqlnb/format'
import type { BlockRunState } from './notebookStore'
import { hashSql } from './hash'
import { isResultsBlock } from '../run/deps'

export type StaleReason = 'sql' | 'params' | 'upstream' | 'source'

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => valuesEqual(x, bb[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return ka.length === kb.length && ka.every((k) => k in (b as object) && valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

export function staleReasons(
  block: Block,
  run: BlockRunState | undefined,
  ctx: { vars: InputVar[]; upstream?: (block: Block) => StaleReason | null },
): StaleReason[] {
  if (block.type !== 'sql' || !run || (run.status !== 'ok' && run.status !== 'error')) return []
  const out: StaleReason[] = []
  if (run.ranSqlHash === undefined || hashSql(block.content ?? '') !== run.ranSqlHash) out.push('sql')
  if (run.params) {
    const byName = new Map(ctx.vars.map((x) => [x.name, x]))
    const changed = Object.entries(run.params).some(([name, val]) => {
      const cur = byName.get(name)
      return !cur || !valuesEqual(cur.value, val)
    })
    if (changed) out.push('params')
  }
  if (run.ranSource !== undefined && run.ranSource !== (isResultsBlock(block) ? 'results' : 'database')) out.push('source')
  const up = ctx.upstream?.(block)
  if (up) out.push('upstream')
  return out
}
