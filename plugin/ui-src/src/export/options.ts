export type Orientation = 'portrait' | 'landscape'
export type ExportFormat = 'pdf' | 'html'

export type TransposeMode = 'follow' | 'on' | 'off'
export interface BlockOptions { include: boolean; transpose: TransposeMode }

export interface ExportOptions {
  format: ExportFormat
  includeSql: boolean
  header: { exportedAt: boolean; dataRunAt: boolean; dataSource: boolean; exporter: boolean }
  note: string
  rowLimit: 'all' | number
  orientation: Orientation
  repeatCols: number
  filtersLine: boolean
  columnBreaks: Record<string, number[]>
  blocks: Record<string, BlockOptions>
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'pdf',
  includeSql: false,
  header: { exportedAt: true, dataRunAt: true, dataSource: true, exporter: true },
  note: '',
  rowLimit: 'all',
  orientation: 'portrait',
  repeatCols: 0,
  filtersLine: true,
  columnBreaks: {},
  blocks: {},
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function normalizeExportOptions(raw: unknown): ExportOptions {
  const d = DEFAULT_EXPORT_OPTIONS
  const r = isObj(raw) ? raw : {}
  const h = isObj(r.header) ? r.header : {}
  let rowLimit: 'all' | number = 'all'
  if (typeof r.rowLimit === 'number' && Number.isFinite(r.rowLimit)) rowLimit = clamp(Math.trunc(r.rowLimit), 1, 1000000)
  const repeat = typeof r.repeatCols === 'number' && Number.isFinite(r.repeatCols) ? clamp(Math.trunc(r.repeatCols), 0, 5) : d.repeatCols
  const columnBreaks: Record<string, number[]> = {}
  if (isObj(r.columnBreaks)) {
    for (const k of Object.keys(r.columnBreaks)) {
      const v = r.columnBreaks[k]
      if (!Array.isArray(v)) continue
      columnBreaks[k] = [...new Set(v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0))].sort((a, b) => a - b)
    }
  }
  const blocks: Record<string, BlockOptions> = {}
  if (isObj(r.blocks)) {
    for (const k of Object.keys(r.blocks)) {
      const v = r.blocks[k]
      if (!isObj(v)) continue
      blocks[k] = { include: bool(v.include, true), transpose: v.transpose === 'on' || v.transpose === 'off' ? v.transpose : 'follow' }
    }
  }
  return {
    format: r.format === 'html' ? 'html' : 'pdf',
    includeSql: bool(r.includeSql, d.includeSql),
    header: { exportedAt: bool(h.exportedAt, d.header.exportedAt), dataRunAt: bool(h.dataRunAt, d.header.dataRunAt), dataSource: bool(h.dataSource, d.header.dataSource), exporter: bool(h.exporter, d.header.exporter) },
    note: typeof r.note === 'string' ? r.note : '',
    rowLimit,
    orientation: r.orientation === 'landscape' ? 'landscape' : 'portrait',
    repeatCols: repeat,
    filtersLine: bool(r.filtersLine, d.filtersLine),
    columnBreaks,
    blocks,
  }
}
