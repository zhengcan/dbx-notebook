import type { PivotConfig } from '@sqlnb/format'
import { buildAggregateSql, buildBigNumberSql, buildCompareSql, buildExcludedCountSql } from '../src/analysis/sql'

export const FIXTURE_REL = '../../backend/result-engine/tests/fixtures/analysis_sql.json'

const cols = [
  { name: 'name with space', kind: 'text' as const }, { name: 'created at', kind: 'temporal' as const },
  { name: 'amount', kind: 'number' as const }, { name: '金额', kind: 'number' as const }, { name: 'order', kind: 'text' as const },
]
const odd = [
  { name: 'r0', kind: 'text' as const }, { name: 'c0', kind: 'text' as const },
  { name: 'v0', kind: 'number' as const }, { name: '__sqlnb_r0', kind: 'text' as const },
]
const c = (p: Partial<PivotConfig>): PivotConfig => ({ rows: [], columns: [], values: [], ...p })
const sqlOf = (r: any): string => { if (!r || 'error' in r) throw new Error('fixture case failed: ' + JSON.stringify(r)); return r.sql }

export function fixtureCases(): { name: string; sql: string }[] {
  const items: [string, any][] = [
    ['month', buildAggregateSql('t', c({ rows: [{ field: 'created at', grain: 'month' }], values: [{ field: 'amount', agg: 'sum' }] }), cols)],
    ['week', buildAggregateSql('t', c({ rows: [{ field: 'created at', grain: 'week' }], values: [{ field: '', agg: 'count' }] }), cols)],
    ['median', buildAggregateSql('t', c({ rows: [{ field: 'order' }], values: [{ field: '金额', agg: 'median' }] }), cols)],
    ['distinct', buildAggregateSql('t', c({ rows: [{ field: 'order' }], values: [{ field: 'name with space', agg: 'countDistinct' }] }), cols)],
    ['multi', buildAggregateSql('t', c({ rows: [{ field: 'name with space' }, { field: 'order' }], columns: [{ field: 'created at', grain: 'year' }], values: [{ field: 'amount', agg: 'sum' }] }), cols)],
    ['grand', buildAggregateSql('t', c({ values: [{ field: 'amount', agg: 'sum' }, { field: '金额', agg: 'avg' }] }), cols)],
    ['excluded', buildExcludedCountSql('t', c({ rows: [{ field: 'created at', grain: 'month' }], values: [{ field: '', agg: 'count' }] }), cols)],
    ['excluded_raw', buildExcludedCountSql('t', c({ rows: [{ field: 'created at' }], values: [{ field: '', agg: 'count' }] }), cols)],
    ['first', buildBigNumberSql('t', { field: 'name with space', aggregate: 'first' }, cols)],
    ['last', buildBigNumberSql('t', { field: 'name with space', aggregate: 'last' }, cols)],
    ['bn_distinct', buildBigNumberSql('t', { field: 'order', aggregate: 'distinct' }, cols)],
    ['bn_contains', buildBigNumberSql('t', { field: '', filter: [{ field: 'order', op: 'contains', value: "x%_\\'" }] }, cols)],
    ['bn_filtered_sum', buildBigNumberSql('t', { field: 'amount', aggregate: 'sum', filter: [{ field: 'order', op: 'in', value: ['x', 'y'] }, { field: 'name with space', op: 'notNull' }] }, cols)],
    ['odd_names', buildAggregateSql('odd', c({ rows: [{ field: 'r0' }, { field: '__sqlnb_r0' }], columns: [{ field: 'c0' }], values: [{ field: 'v0', agg: 'sum' }, { field: 'v0', agg: 'max' }] }), odd)],
    ['odd_column_totals', buildAggregateSql('odd', c({ columns: [{ field: 'c0' }], values: [{ field: 'v0', agg: 'sum' }] }), odd)],
  ]
  const cmp: any = buildCompareSql('t', { field: 'amount', aggregate: 'sum', compare: { kind: 'mom', dateField: 'created at' } }, cols)
  items.push(['bn_period', { sql: cmp.periodSql }], ['bn_period_value', { sql: cmp.valueSql('2026-01') }])
  return items.map(([name, r]) => ({ name, sql: sqlOf(r) }))
}
