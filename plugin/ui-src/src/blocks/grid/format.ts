export type CellKind = 'null' | 'number' | 'boolean' | 'string' | 'json'

export function cellKind(v: unknown): CellKind {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'bigint') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (v instanceof Date) return 'string'
  if (typeof v === 'object') return 'json'
  return 'string'
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString()
  if (typeof v === 'object') {
    try {
      const j = JSON.stringify(v)
      if (typeof j === 'string') return j
    } catch {}
    try {
      const s = String(v)
      return typeof s === 'string' ? s : ''
    } catch {
      return ''
    }
  }
  return String(v)
}

export function isLongCell(v: unknown): boolean {
  if (cellKind(v) === 'json') return true
  const s = cellText(v)
  return s.length > 200 || s.includes('\n')
}
