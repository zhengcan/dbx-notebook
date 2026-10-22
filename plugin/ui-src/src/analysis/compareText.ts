import type { BigNumberCompare } from './analysisState'
import { formatValue } from './pivotModel'

type Tr = (key: string, params?: Record<string, unknown>) => string

export function compareText(c: BigNumberCompare, t: Tr): string {
  const d = c.deltaPct
  let lead = '—'
  if (d !== null && Number.isFinite(d)) {
    const pct = formatValue(Math.abs(d), { kind: 'percent', decimals: 1 })
    const zero = pct === formatValue(0, { kind: 'percent', decimals: 1 })
    lead = `${zero || d === 0 ? '=' : d > 0 ? '▲' : '▼'} ${pct}`
  }
  return t('bn.cmp.text', { lead, prev: c.previous, kind: t(c.kind === 'yoy' ? 'bn.cmp.yoy' : 'bn.cmp.mom') })
}
