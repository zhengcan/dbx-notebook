import type { LabelTarget } from './labelResolve'

// Stable DOM id for a LabelTarget (data-label-target); used for focus return after the editor closes.
export function labelTargetId(t: LabelTarget): string {
  switch (t.kind) {
    case 'summary': case 'title': return t.kind
    case 'axis': return `axis:${t.axis}`
    case 'category': return `category:${t.axis}:${t.index}:${t.key}`
    case 'nullLabel': return `null:${t.axis}:${t.index}`
    default: return `${t.kind}:${t.index}`
  }
}

const idx = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null)
const axisOf = (s: string | undefined): 'row' | 'column' | null => (s === 'row' || s === 'column' ? s : null)

export function parseLabelTargetId(s: string): LabelTarget | null {
  const p = s.split(':')
  const k = p[0]
  if (k === 'summary' || k === 'title') return p.length === 1 ? { kind: k } : null
  if (k === 'axis') { const a = p[1]; return p.length === 2 && (a === 'x' || a === 'y' || a === 'legend') ? { kind: 'axis', axis: a } : null }
  if (k === 'category') {
    const axis = axisOf(p[1]), index = idx(p[2])
    return axis && index !== null && p.length >= 4 ? { kind: 'category', axis, index, key: p.slice(3).join(':') } : null
  }
  if (k === 'null') { const axis = axisOf(p[1]), index = idx(p[2]); return axis && index !== null && p.length === 3 ? { kind: 'nullLabel', axis, index } : null }
  if (k === 'rowName' || k === 'columnName' || k === 'measureName' || k === 'unit' || k === 'scale') {
    const index = idx(p[1]); return index !== null && p.length === 2 ? { kind: k, index } : null
  }
  return null
}
