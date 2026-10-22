import type { ExportModel, SkippedBlock } from './model'
import type { ExportOptions } from './options'

export const BIG_TABLE_ROWS = 5000
export const WIDE_TABLE_COLS = 8

export function exportHints(model: ExportModel, opts: ExportOptions): { bigTables: { blockId: string; rows: number }[]; skipped: SkippedBlock[]; stale: number; wideTables: string[] } {
  const bigTables: { blockId: string; rows: number }[] = []
  const wideTables: string[] = []
  for (const s of model.sections) {
    if (s.kind !== 'table') continue
    const rows = opts.rowLimit === 'all' ? s.totalRows : Math.min(opts.rowLimit, s.totalRows)
    if (rows > BIG_TABLE_ROWS) bigTables.push({ blockId: s.blockId, rows })
    if (s.columns.length > WIDE_TABLE_COLS) wideTables.push(s.blockId)
  }
  return { bigTables, skipped: model.skipped, stale: model.staleBlockIds.length, wideTables }
}
