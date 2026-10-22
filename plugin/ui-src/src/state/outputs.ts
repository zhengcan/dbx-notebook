import type { Block, OutputEntry } from '@sqlnb/format'
import type { BlockRunState } from './notebookStore'

const HASH_PREFIX = 'fnv1a32:'

export function runToEntry(block: Block, run: BlockRunState, executedAt: string): OutputEntry | null {
  if (block.type !== 'sql') return null
  if (run.status !== 'ok' && run.status !== 'error') return null
  const at = run.executedAt ?? executedAt
  let e: OutputEntry
  if (run.status === 'error') {
    e = { columns: [], rows: [], executedAt: at, elapsedMs: 0, truncated: false, error: run.error?.message || run.error?.code || 'error' }
  } else {
    const r = run.result
    e = {
      columns: (r?.columns ?? []).map((c) => (c.dataType === undefined ? { name: c.name } : { name: c.name, type: c.dataType })),
      rows: r?.rows ?? [],
      executedAt: at,
      elapsedMs: r?.elapsedMs ?? 0,
      truncated: r?.truncated ?? false,
    }
  }
  if (run.ranSqlHash !== undefined) e.sqlHash = HASH_PREFIX + run.ranSqlHash
  if (run.params && Object.keys(run.params).length > 0) e.params = run.params
  if (run.upstream) e.upstream = run.upstream
  return e
}

// `error` stores the message text only; kind/variable/paramCode are not persisted.
// Error runs restore as generic errors with code 'UNKNOWN'; a re-run recomputes them.
export function entryToRun(entry: OutputEntry, dbType?: string): BlockRunState {
  const ranSqlHash = entry.sqlHash?.startsWith(HASH_PREFIX) ? entry.sqlHash.slice(HASH_PREFIX.length) : entry.sqlHash
  const base = { ranSqlHash, params: entry.params, upstream: entry.upstream, executedAt: entry.executedAt, fromFile: true }
  if (typeof entry.error === 'string' && entry.error !== '') {
    return { status: 'error', result: undefined, error: { code: 'UNKNOWN', message: entry.error }, ...base }
  }
  return {
    status: 'ok',
    result: {
      columns: entry.columns.map((c) => ({ name: c.name, dataType: c.type })),
      rows: entry.rows,
      truncated: entry.truncated,
      elapsedMs: entry.elapsedMs,
      dbType: dbType ?? '',
    },
    ...base,
  }
}
