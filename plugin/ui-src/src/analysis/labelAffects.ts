import type { LabelTarget } from './labelResolve'
import { t } from '../i18n'

// Where each label shows up. Every claim is pinned to real render behaviour in test/labelAffects.test.ts
// (which also lists the file:line evidence). Do not add a place here without a code reference there.
export type AffectPlace = 'tableHeader' | 'rowHeader' | 'legend' | 'totalsRow' | 'axisX' | 'axisY' | 'chartTitle' | 'tooltip' | 'cells' | 'chartTicks' | 'export'
export const AFFECT_PLACES: readonly AffectPlace[] = ['tableHeader', 'rowHeader', 'legend', 'totalsRow', 'axisX', 'axisY', 'chartTitle', 'tooltip', 'cells', 'chartTicks', 'export']

const ROW_CATEGORY: AffectPlace[] = ['rowHeader', 'chartTicks', 'tooltip', 'export']
const COLUMN_CATEGORY: AffectPlace[] = ['tableHeader', 'legend', 'tooltip', 'export']

export function affectsOf(target: LabelTarget): AffectPlace[] {
  switch (target.kind) {
    case 'rowName': return ['tableHeader', 'axisX', 'tooltip', 'export']
    case 'columnName': return ['legend', 'tooltip', 'export']
    case 'measureName': return ['tableHeader', 'totalsRow', 'legend', 'axisY', 'tooltip', 'export']
    case 'summary': return ['totalsRow', 'export']
    case 'title': return ['chartTitle', 'export']
    case 'axis': return target.axis === 'x' ? ['axisX', 'tooltip', 'export'] : target.axis === 'y' ? ['axisY', 'tooltip', 'export'] : ['legend', 'tooltip', 'export']
    case 'unit': return ['cells', 'totalsRow', 'axisY', 'tooltip', 'export']
    case 'scale': return ['cells', 'totalsRow', 'chartTicks', 'tooltip', 'export']
    case 'category': case 'nullLabel': return [...(target.axis === 'row' ? ROW_CATEGORY : COLUMN_CATEGORY)]
  }
}

export function affectText(places: AffectPlace[]): string {
  if (!places.length) return ''
  return t('label.aff.lead') + places.map((p) => t(`label.aff.${p}`)).join(t('label.aff.sep'))
}
