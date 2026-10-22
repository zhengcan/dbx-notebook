import { computed, ref, type Ref } from 'vue'
import type { ChartOptions, PivotConfig } from '@sqlnb/format'
import { t } from '../../i18n'
import { autoLabels, isOverridden, resolveLabels, type LabelCtx, type LabelTarget } from '../labelResolve'
import { isValidScale, patchLabel } from '../labelPatch'
import { labelTargetId } from '../labelTargetId'
import { affectText, affectsOf } from '../labelAffects'
import type { TabKey } from '../labelTabs'
import { filterCategories, matchesText, normQuery, SEARCH_CAP } from '../labelSearch'

export type Cfg = { pivot: PivotConfig; chart: ChartOptions }
export type Patch = ReturnType<typeof patchLabel>
export interface Row { access?: string; id: string; target: LabelTarget; name: string; placeholder: string; value: string; overridden: boolean; maxlength: number; affects: string; scale?: boolean; disabled?: boolean; unused?: boolean }
export interface Group { key: string; tab: TabKey; title?: string; rows: Row[]; more?: { axis: 'row' | 'column'; index: number; n: number; all: boolean }; search?: { field: string; query: string; total: number; matched: number; capped: boolean } }

export const MAX_SHOWN = 50
const text = (v: unknown) => (typeof v === 'string' ? v : '')

export function useLabelRows(cfg: Ref<Cfg>, ctx: Ref<LabelCtx>, categories: Ref<{ row: string[][]; column: string[][] }>, onCommit?: (patch: Patch) => void) {
  const resolved = computed(() => resolveLabels(cfg.value, ctx.value))
  const auto = computed(() => autoLabels(cfg.value, ctx.value))
  const expanded = ref<Record<string, boolean>>({})
  const invalid = ref<Record<string, boolean>>({})
  const queries = ref<Record<string, { field: string; q: string }>>({})

  function row(target: LabelTarget, name: string, placeholder: string, value: unknown, extra: Partial<Row> = {}): Row {
    return { id: labelTargetId(target), target, name, placeholder, value: text(value), overridden: isOverridden(cfg.value, target), maxlength: 200, affects: affectText(affectsOf(target)), ...extra }
  }

  const groups = computed<Group[]>(() => {
    const { pivot, chart } = cfg.value
    const out: Group[] = []
    const names: Row[] = []
    pivot.rows.forEach((r, i) => names.push(row({ kind: 'rowName', index: i }, `${t('label.rowName')} · ${r.field}`, r.field, r.label)))
    pivot.columns.forEach((r, i) => names.push(row({ kind: 'columnName', index: i }, `${t('label.columnName')} · ${r.field}`, r.field, r.label)))
    out.push({ key: 'names', tab: 'table', rows: names })
    const meas: Row[] = []
    pivot.values.forEach((v, i) => meas.push(row({ kind: 'measureName', index: i }, `${t('label.measureName')} · ${auto.value.measureNames[i]}`, auto.value.measureNames[i], v.label)))
    meas.push(row({ kind: 'summary' }, t('label.summary'), ctx.value.summary, pivot.summaryLabel))
    out.push({ key: 'measures', tab: 'table', rows: meas })
    out.push({
      key: 'chart',
      tab: 'chart',
      rows: [
        row({ kind: 'title' }, t('label.title'), '', chart.title),
        row({ kind: 'axis', axis: 'x' }, t('label.axisX'), auto.value.axis.x, chart.axisTitles?.x),
        row({ kind: 'axis', axis: 'y' }, t('label.axisY'), auto.value.axis.y, chart.axisTitles?.y),
        row({ kind: 'axis', axis: 'legend' }, t('label.axisLegend'), auto.value.axis.legend, chart.axisTitles?.legend),
      ],
    })
    const units: Row[] = []
    pivot.values.forEach((v, i) => {
      const nm = auto.value.measureNames[i]
      units.push(row({ kind: 'unit', index: i }, `${t('label.unit')} · ${nm}`, '', v.format?.unit, { maxlength: 20 }))
      const pct = v.format?.kind === 'percent'
      units.push(row({ kind: 'scale', index: i }, `${t('label.scale')} · ${nm}`, '1', v.format?.scale, { scale: true, disabled: pct, maxlength: 20 }))
    })
    if (units.length) out.push({ key: 'units', tab: 'numbers', rows: units })
    for (const axis of ['row', 'column'] as const) {
      const refs = axis === 'row' ? pivot.rows : pivot.columns
      refs.forEach((ref, index) => {
        const keys = categories.value[axis][index] ?? []
        const gk = `${axis}:${index}`
        const all = expanded.value[gk] === true
        const big = keys.length > MAX_SHOWN
        const rawQ = big && queries.value[gk]?.field === ref.field ? queries.value[gk].q : ''
        const q = normQuery(rawQ)
        const searching = q !== ''
        const hit = searching ? filterCategories(keys, ref.valueLabels, q, SEARCH_CAP) : undefined
        const shown = hit ? hit.keys : all ? keys : keys.slice(0, MAX_SHOWN)
        const lookup = (k: string) => (ref.valueLabels && Object.prototype.hasOwnProperty.call(ref.valueLabels, k) ? ref.valueLabels[k] : '')
        const rows: Row[] = shown.map((k) => row({ kind: 'category', axis, index, key: k }, k, k, lookup(k), { access: `${k} · ${ref.field}` }))
        rows.push(row({ kind: 'nullLabel', axis, index }, t('label.null'), ctx.value.empty, ref.nullLabel, { access: `${t('label.null')} · ${ref.field}` }))
        const have = new Set(keys)
        for (const k of Object.keys(ref.valueLabels ?? {})) {
          if (have.has(k)) continue
          if (searching && !matchesText(q, k, ref.valueLabels![k])) continue
          rows.push(row({ kind: 'category', axis, index, key: k }, k, k, ref.valueLabels![k], { unused: true, access: `${k} · ${ref.field}` }))
        }
        out.push({ key: gk, tab: 'categories', title: `${t('label.values')} · ${ref.field}`, rows, more: big && !searching ? { axis, index, n: keys.length, all } : undefined, search: big ? { field: ref.field, query: rawQ, total: keys.length, matched: hit ? hit.total : keys.length, capped: !!hit?.capped } : undefined })
      })
    }
    return out
  })

  const anyOverride = computed(() => groups.value.some((g) => g.rows.some((r) => r.overridden)))

  function clearInvalid(id: string) {
    if (invalid.value[id]) { const { [id]: _x, ...rest } = invalid.value; invalid.value = rest }
  }
  function commitRow(r: Row, v: string) {
    if (r.scale && v.trim() !== '' && !isValidScale(v)) { invalid.value = { ...invalid.value, [r.id]: true }; return }
    clearInvalid(r.id)
    if (v === r.value) return
    const p = patchLabel(cfg.value, r.target, v)
    if (p.pivot || p.chartOptions) onCommit?.(p)
  }
  const escapeRow = (r: Row) => clearInvalid(r.id)
  const resetRow = (r: Row) => onCommit?.(patchLabel(cfg.value, r.target, null))
  function toggleExpanded(key: string) { expanded.value = { ...expanded.value, [key]: !(expanded.value[key] === true) } }
  function setQuery(key: string, q: string) {
    const [axis, i] = key.split(':')
    const field = (axis === 'row' ? cfg.value.pivot.rows : cfg.value.pivot.columns)[Number(i)]?.field ?? ''
    queries.value = { ...queries.value, [key]: { field, q } }
  }
  function expandFor(target: LabelTarget) {
    if (target.kind === 'category' && target.index >= 0) {
      const g = categories.value[target.axis][target.index]
      if (g && g.indexOf(target.key) >= MAX_SHOWN) expanded.value = { ...expanded.value, [`${target.axis}:${target.index}`]: true }
    }
  }
  return { groups, resolved, auto, invalid, anyOverride, commitRow, escapeRow, resetRow, toggleExpanded, setQuery, expandFor }
}
