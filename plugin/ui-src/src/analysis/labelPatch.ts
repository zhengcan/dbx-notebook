import type { ChartOptions, FieldRef, NumberFormat, PivotConfig, ValueSpec } from '@sqlnb/format'
import { isOverridden, type LabelTarget } from './labelResolve'

// Pure patch builder (no Vue/DOM). Labels are stored literally as plain text (never HTML).
// Returned patches replace the whole affected array/object so they compose with store.setAnalysis;
// `undefined` means "remove key" (back to auto).
type Cfg = { pivot: PivotConfig; chart: ChartOptions }
type Patch = { pivot?: Partial<PivotConfig>; chartOptions?: Partial<ChartOptions> }

const SCALE_RE = /^\s*[+]?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i
const MAX_LABEL = 200, MAX_UNIT = 20, MAX_SCALE = 1e12

export function isValidScale(text: string): boolean {
  if (!SCALE_RE.test(text)) return false
  const n = Number(text)
  return Number.isFinite(n) && n > 0 && n <= MAX_SCALE
}

// Cap by code points so surrogate pairs are never split.
const cap = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s }

export function patchLabel(cfg: Cfg, target: LabelTarget, text: string | null): Patch {
  const blank = text === null || text.trim() === ''
  const val = blank ? undefined : cap(text as string, MAX_LABEL)
  const { pivot, chart } = cfg
  const refPatch = (axis: 'row' | 'column' | undefined, index: number, f: (r: FieldRef) => FieldRef): Patch => {
    const key = axis === 'column' ? 'columns' : 'rows'
    const arr = pivot[key] ?? []
    if (!arr[index]) return {}
    return { pivot: { [key]: arr.map((r, i) => (i === index ? f(r) : r)) } }
  }
  const setKey = <T extends object>(o: T, k: string, v: unknown): T => {
    const c = { ...o } as Record<string, unknown>
    if (v === undefined) delete c[k]; else c[k] = v
    return c as T
  }
  switch (target.kind) {
    case 'rowName': return refPatch('row', target.index, (r) => setKey(r, 'label', val))
    case 'columnName': return refPatch('column', target.index, (r) => setKey(r, 'label', val))
    case 'nullLabel': return refPatch(target.axis, target.index, (r) => setKey(r, 'nullLabel', val))
    case 'category':
      return refPatch(target.axis, target.index, (r) => {
        const out: Record<string, string> = {}
        const put = (k: string, x: string) => Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true })
        for (const k of Object.keys(r.valueLabels ?? {})) if (k !== target.key) put(k, r.valueLabels![k])
        if (val !== undefined) put(target.key, val)
        return setKey(r, 'valueLabels', Object.keys(out).length ? out : undefined)
      })
    case 'measureName':
    case 'unit':
    case 'scale': {
      const values = pivot.values ?? []
      const v = values[target.index]
      if (!v) return {}
      let next = v
      if (target.kind === 'measureName') next = setKey(v, 'label', val)
      else {
        const f: NumberFormat = { ...(v.format ?? { kind: 'thousands' }) }
        if (target.kind === 'unit') {
          if (blank) delete f.unit; else f.unit = cap(text as string, MAX_UNIT)
        } else {
          if (f.kind === 'percent') return {}
          if (blank) delete f.scale
          else {
            if (!isValidScale(text as string)) return {}
            f.scale = Number(text)
          }
        }
        const rest: ValueSpec = { ...v }
        delete rest.format
        const isDefault = f.kind === 'thousands' && Object.keys(f).length === 1
        if (!v.format && isDefault) return {}
        next = isDefault ? rest : { ...v, format: f }
        if (v.format && JSON.stringify(v.format) === JSON.stringify(f)) return {}
      }
      return { pivot: { values: values.map((x, i) => (i === target.index ? next : x)) } }
    }
    case 'summary': return { pivot: { summaryLabel: val } }
    case 'title': return { chartOptions: { title: val } }
    case 'axis': {
      const t = setKey({ ...(chart.axisTitles ?? {}) }, target.axis, val)
      return { chartOptions: { axisTitles: Object.keys(t).length ? t : undefined } }
    }
  }
}

// Every scope name appears once: the four tabs plus 'all'.
export type ScopeKey = 'table' | 'chart' | 'numbers' | 'categories'
const ALL_SCOPES: ScopeKey[] = ['table', 'chart', 'numbers', 'categories']
const expand = (scope: 'all' | ScopeKey): ScopeKey[] => (scope === 'all' ? ALL_SCOPES : [scope])

function scopeTargets(cfg: Cfg, scope: ScopeKey): LabelTarget[] {
  const { pivot } = cfg
  const out: LabelTarget[] = []
  if (scope === 'table') {
    ;(pivot.rows ?? []).forEach((_, index) => out.push({ kind: 'rowName', index }))
    ;(pivot.columns ?? []).forEach((_, index) => out.push({ kind: 'columnName', index }))
    ;(pivot.values ?? []).forEach((_, index) => out.push({ kind: 'measureName', index }))
    out.push({ kind: 'summary' })
  } else if (scope === 'chart') {
    out.push({ kind: 'title' }, { kind: 'axis', axis: 'x' }, { kind: 'axis', axis: 'y' }, { kind: 'axis', axis: 'legend' })
  } else if (scope === 'numbers') {
    ;(pivot.values ?? []).forEach((_, index) => out.push({ kind: 'unit', index }, { kind: 'scale', index }))
  } else {
    for (const axis of ['row', 'column'] as const) {
      ;((axis === 'row' ? pivot.rows : pivot.columns) ?? []).forEach((r, index) => {
        out.push({ kind: 'nullLabel', axis, index })
        for (const key of Object.keys(r.valueLabels ?? {})) out.push({ kind: 'category', axis, index, key })
      })
    }
  }
  return out
}

// Number of label overrides in scope, read from the config itself (independent of rendering, collapse or search).
// Counts exactly the targets resetLabels() removes, including valueLabels keys no longer present in the data.
export function countOverrides(cfg: Cfg, scope: 'all' | ScopeKey): number {
  const scopes = expand(scope)
  let n = 0
  for (const s of scopes) for (const target of scopeTargets(cfg, s)) if (isOverridden(cfg, target)) n++
  return n
}

// ONE patch that removes every label override in scope (back to auto); {} when nothing is overridden.
export function resetLabels(cfg: Cfg, scope: 'all' | ScopeKey): Patch {
  const scopes = expand(scope)
  let c = cfg
  const out: Patch = {}
  for (const s of scopes) {
    for (const target of scopeTargets(cfg, s)) {
      if (!isOverridden(c, target)) continue
      const p = patchLabel(c, target, null)
      if (!p.pivot && !p.chartOptions) continue
      c = { pivot: { ...c.pivot, ...(p.pivot ?? {}) } as PivotConfig, chart: { ...c.chart, ...(p.chartOptions ?? {}) } as ChartOptions }
      if (p.pivot) out.pivot = { ...(out.pivot ?? {}), ...p.pivot }
      if (p.chartOptions) out.chartOptions = { ...(out.chartOptions ?? {}), ...p.chartOptions }
    }
  }
  return out
}

// Ref-change rule (spec "Duplicate/renamed fields"): a different field drops label, valueLabels and
// nullLabel; same field with a different grain keeps label/nullLabel and drops valueLabels.
// Other properties come from newRef; inputs are never mutated.
export function resetRefOverrides(oldRef: FieldRef | undefined, newRef: FieldRef): FieldRef {
  const out = { ...newRef } as Record<string, unknown>
  const copyVL = (): void => {
    if (!newRef.valueLabels) return
    const vl: Record<string, string> = {}
    for (const k of Object.keys(newRef.valueLabels)) Object.defineProperty(vl, k, { value: newRef.valueLabels[k], enumerable: true, writable: true, configurable: true })
    out.valueLabels = vl
  }
  if (!oldRef) { copyVL(); return out as unknown as FieldRef }
  if (oldRef.field !== newRef.field) {
    delete out.label; delete out.valueLabels; delete out.nullLabel
    return out as unknown as FieldRef
  }
  if (out.label === undefined && oldRef.label !== undefined) out.label = oldRef.label
  if (out.nullLabel === undefined && oldRef.nullLabel !== undefined) out.nullLabel = oldRef.nullLabel
  if (oldRef.grain === newRef.grain) copyVL(); else delete out.valueLabels
  return out as unknown as FieldRef
}
