import type { LabelTarget } from './labelResolve'
import { affectsOf, AFFECT_PLACES, type AffectPlace } from './labelAffects'
import { t } from '../i18n'

export type TabKey = 'table' | 'chart' | 'numbers' | 'categories'
export const TAB_KEYS: readonly TabKey[] = ['table', 'chart', 'numbers', 'categories']

export function tabOf(target: LabelTarget): TabKey {
  switch (target.kind) {
    case 'rowName': case 'columnName': case 'measureName': case 'summary': return 'table'
    case 'title': case 'axis': return 'chart'
    case 'unit': case 'scale': return 'numbers'
    case 'category': case 'nullLabel': return 'categories'
  }
}

export function tabAffectText(rows: { target: LabelTarget }[]): string {
  const seen = new Set<AffectPlace>()
  for (const r of rows) for (const p of affectsOf(r.target)) seen.add(p)
  if (!seen.size) return ''
  return t('label.dialog.tabAffects') + AFFECT_PLACES.filter((p) => seen.has(p)).map((p) => t(`label.aff.${p}`)).join(t('label.aff.sep'))
}

// Single numbering source for right-hand items and preview badges: 1-based in array order, first id wins.
export function numberRows(rows: { id: string }[]): Map<string, number> {
  const m = new Map<string, number>()
  let n = 0
  for (const r of rows) if (!m.has(r.id)) m.set(r.id, ++n)
  return m
}
