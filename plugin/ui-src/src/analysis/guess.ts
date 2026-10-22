import type { ChartOptions, PivotConfig, View } from '@sqlnb/format'
import type { SourceColumn } from './sql'

export interface Guess { pivot: PivotConfig; chart: ChartOptions; view: View }

// Scatter is aggregated per x value (sum of y), not raw points.
export function guessAnalysis(columns: SourceColumn[]): Guess {
  const first = (k: SourceColumn['kind']) => columns.filter((c) => c.kind === k)
  const [time] = first('temporal')
  const texts = first('text')
  const nums = first('number')
  const sum = (c: SourceColumn) => ({ field: c.name, agg: 'sum' as const })
  if (time && nums[0]) {
    return {
      pivot: { rows: [{ field: time.name, grain: 'month' }], columns: texts[0] ? [{ field: texts[0].name }] : [], values: [sum(nums[0])] },
      chart: { type: 'line' }, view: 'both',
    }
  }
  if (!time && texts[0] && nums[0]) {
    return { pivot: { rows: [{ field: texts[0].name }], columns: [], values: [sum(nums[0])] }, chart: { type: 'bar' }, view: 'both' }
  }
  if (!time && !texts[0] && nums.length >= 2) {
    return { pivot: { rows: [{ field: nums[0].name }], columns: [], values: [sum(nums[1])] }, chart: { type: 'scatter' }, view: 'both' }
  }
  if (!time && !texts[0] && nums.length === 1 && columns.filter((c) => c.kind !== 'boolean' && c.kind !== 'unknown').length === 1) {
    return { pivot: { rows: [], columns: [], values: [sum(nums[0])] }, chart: { type: 'histogram' }, view: 'both' }
  }
  return { pivot: { rows: [], columns: [], values: [] }, chart: { type: 'bar' }, view: 'table' }
}
