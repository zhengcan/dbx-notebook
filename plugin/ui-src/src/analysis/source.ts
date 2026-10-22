import type { Block } from '@sqlnb/format'
import type { useNotebookStore, BlockRunState } from '../state/notebookStore'
import { resultNameOf } from '../run/deps'
import { columnKind, type SourceColumn } from './sql'

type Store = ReturnType<typeof useNotebookStore>

export type SourceErrorCode = 'NO_SOURCE' | 'SOURCE_NOT_RUN'
export interface ResolvedSource { block: Block; run: BlockRunState; name: string; columns: SourceColumn[]; executedAt?: string; partial: boolean }
export interface SourceError { error: { code: SourceErrorCode } }

export function findSourceBlock(store: Pick<Store, 'nb'>, dataName: string): Block | undefined {
  if (typeof dataName !== 'string' || !dataName) return undefined
  const key = dataName.toLowerCase()
  return store.nb.value.blocks.find((b) => resultNameOf(b)?.toLowerCase() === key)
}

export function resolveSource(store: Pick<Store, 'nb' | 'runs' | 'isPartial'>, dataName: string): ResolvedSource | SourceError {
  const block = findSourceBlock(store, dataName)
  if (!block) return { error: { code: 'NO_SOURCE' } }
  const run = store.runs.get(block.id)
  if (!run || run.status !== 'ok' || !run.result) return { error: { code: 'SOURCE_NOT_RUN' } }
  const rows = run.result.rows
  const columns = run.result.columns.map((c, i) => {
    const sample = rows.find((r) => r[i] !== null && r[i] !== undefined)?.[i]
    return { name: c.name, kind: columnKind(c.dataType, sample) }
  })
  return {
    block, run, name: resultNameOf(block)!, columns, executedAt: run.executedAt,
    partial: run.result.truncated === true || store.isPartial(block.id),
  }
}
