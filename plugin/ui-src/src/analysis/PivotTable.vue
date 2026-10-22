<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { SUMMARIES, type PivotConfig, type Summary } from '@sqlnb/format'
import { t } from '../i18n'
import { formatValue, toTsv, type PivotModel } from './pivotModel'
import type { LabelTarget } from './labelResolve'
import { labelTargetId, parseLabelTargetId } from './labelTargetId'

type Sort = PivotConfig['sort']
const ROW_H = 28
const HEAD_H = 28
const OVERSCAN = 10
const LABEL_W = 120
const props = withDefaults(defineProps<{ model: PivotModel; sort: Sort | null; viewportHeight?: number; editable?: boolean }>(), { viewportHeight: 320, editable: false })
const emit = defineEmits<{ (e: 'update:sort', s: Sort | null): void; (e: 'update:summary', p: { valueIndex: number; summary: Summary }): void; (e: 'edit-label', p: { target: LabelTarget; el: HTMLElement }): void; (e: 'copied'): void; (e: 'copyFailed'): void }>()

const scrollTop = ref(0)
const viewport = ref<HTMLElement | null>(null)
const copyFailed = ref(false)
let failTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.model, () => { scrollTop.value = 0; if (viewport.value) viewport.value.scrollTop = 0 })

const nm = computed(() => Math.max(1, props.model.measures.length))
const nRowDims = computed(() => Math.max(1, props.model.rowHeaders.length))
const levels = computed(() => props.model.columnHeaders[0]?.length ?? 1)
const empty = computed(() => !props.model.rowLabels.length || !props.model.columnHeaders.length)
const hasRowTotals = computed(() => !!(props.model.rowTotals || props.model.grandTotal))
const hasFoot = computed(() => !!(props.model.columnTotals || props.model.grandTotal))
const nBodyCols = computed(() => props.model.columnHeaders.length)

interface HCell { text: string; span: number; key: string; level: number; raw: unknown; keyed: boolean }
const headerRows = computed<HCell[][]>(() => {
  const out: HCell[][] = []
  const hs = props.model.columnHeaders
  for (let l = 0; l < levels.value - 1; l++) {
    const row: HCell[] = []
    let prev = ''
    hs.forEach((h, i) => {
      const ck = props.model.columnKeys?.[i]
      const path = JSON.stringify(ck ? ck.slice(0, l + 1) : h.slice(0, l + 1), (_, v) => (typeof v === 'bigint' ? `\u0000bigint:${v}` : v))
      if (row.length && path === prev) row[row.length - 1].span++
      else row.push({ text: h[l] ?? '', span: 1, key: `${l}-${i}`, level: l, raw: ck?.[l], keyed: !!ck })
      prev = path
    })
    out.push(row)
  }
  return out
})

const sortDir = (kind: 'name' | 'value', vi = 0): 'asc' | 'desc' | null => {
  const s = props.sort
  if (!s || s.by !== kind) return null
  if (kind === 'value' && (s.valueIndex ?? 0) !== vi) return null
  return s.dir
}
const ariaSort = (kind: 'name' | 'value', vi = 0) => { const d = sortDir(kind, vi); return d === 'asc' ? 'ascending' : d === 'desc' ? 'descending' : 'none' }
const arrow = (kind: 'name' | 'value', vi = 0) => { const d = sortDir(kind, vi); return d === 'asc' ? ' ▲' : d === 'desc' ? ' ▼' : '' }
function toggle(kind: 'name' | 'value', vi = 0) {
  const d = sortDir(kind, vi)
  if (d === 'asc') emit('update:sort', kind === 'name' ? { by: 'name', dir: 'desc' } : { by: 'value', valueIndex: vi, dir: 'desc' })
  else if (d === 'desc') emit('update:sort', null)
  else emit('update:sort', kind === 'name' ? { by: 'name', dir: 'asc' } : { by: 'value', valueIndex: vi, dir: 'asc' })
}

const total = computed(() => props.model.rowLabels.length)
const effTop = computed(() => Math.min(scrollTop.value, Math.max(0, total.value * ROW_H - props.viewportHeight)))
const start = computed(() => Math.max(0, Math.floor(effTop.value / ROW_H) - OVERSCAN))
const end = computed(() => Math.min(total.value, Math.ceil((effTop.value + props.viewportHeight) / ROW_H) + OVERSCAN))
const fmt = (v: number | null, m: number) => formatValue(v, props.model.measures[m % nm.value]?.format ?? { kind: 'thousands' })
const method = (k: number): Summary => props.model.measures[k % nm.value]?.summary ?? 'sum'
const how = (k: number) => {
  const s = method(k)
  return s !== 'none' ? t('pivot.summaryBy', { method: t('pivot.sm.' + s) }) : undefined
}
// Summary cells: "Method: number" (like Excel); double-click / Enter / F2 edits the method.
// The method belongs to the value (measure): changing it in any summary cell of that measure
// (row-summary column, column-summary row, grand cell) changes all of that measure's summaries.
interface SCell { key: string; k: number; txt: string; none: boolean; edit: boolean }
const sCell = (key: string, k: number, v: number | null, edit: boolean): SCell => {
  const m = method(k)
  const num = fmt(v, k)
  return { key, k, none: m === 'none', edit, txt: m === 'none' ? t('pivot.skipped') : t('pivot.summaryCell', { method: t('pivot.sm.' + m), value: num }) }
}
const editing = ref<string | null>(null)
watch(() => props.model, () => { editing.value = null })
watch([start, end], ([a, b]) => {
  const m = /^r:(\d+):/.exec(editing.value ?? '')
  if (m && (+m[1] < a || +m[1] >= b)) editing.value = null
})
const vFocus = { mounted: (el: HTMLElement) => el.focus() }
const hintId = 'pivot-sm-hint-' + Math.random().toString(36).slice(2, 8)
const cellTitle = (c: SCell) => t('pivot.summaryHint', { method: t('pivot.sm.' + method(c.k)) }) + '\n' + c.txt
const selAria = (k: number) => t('pivot.summarySelectAria', { measure: props.model.measures[k % nm.value]?.label ?? '' })
const open = (c: SCell) => { if (c.edit) editing.value = c.key }
// Focus goes back to the cell after change/Escape/Enter (not after a blur caused by clicking elsewhere).
function restoreFocus(key: string) {
  void nextTick(() => { void nextTick(() => { viewport.value?.querySelector<HTMLElement>(`[data-sm-key="${key}"]`)?.focus() }) })
}
const pick = (c: SCell, e: Event) => {
  const v = (e.target as HTMLSelectElement).value as Summary
  editing.value = null
  restoreFocus(c.key)
  if ((SUMMARIES as readonly string[]).includes(v)) emit('update:summary', { valueIndex: c.k % nm.value, summary: v })
}
function onCellKey(c: SCell, e: KeyboardEvent) {
  if (e.target !== e.currentTarget || e.isComposing) return
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); open(c) }
}
function onSelKey(c: SCell, e: KeyboardEvent) {
  if (e.key === 'Tab') return
  e.stopPropagation()
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); editing.value = null; restoreFocus(c.key) }
}
function close() { editing.value = null }
const visible = computed(() => {
  const m = props.model
  return m.cells.slice(start.value, end.value).map((cells, i) => {
    const idx = start.value + i
    const totals: SCell[] | undefined = m.rowTotals ? m.rowTotals[idx]?.map((v, k) => sCell(`r:${idx}:${k}`, k, v, true)) : m.grandTotal ? m.measures.map((_, k) => ({ ...sCell('', k, null, false), txt: '' })) : undefined
    return { idx, labels: m.rowLabels[idx], cells: cells.map((v, k) => ({ v, txt: fmt(v, k) })), totals }
  })
})
const footCells = computed(() => {
  const m = props.model
  const body: SCell[] = m.columnTotals ? m.columnTotals.map((v, k) => sCell(`f:${k}`, k, v, true)) : Array.from({ length: nBodyCols.value }, (_, k) => ({ ...sCell('', k, null, false), txt: '' }))
  const tot: SCell[] = hasRowTotals.value ? (m.grandTotal ? m.grandTotal.map((v, k) => sCell(`g:${k}`, k, v, true)) : m.measures.map((_, k) => ({ ...sCell('', k, null, false), txt: '' }))) : []
  return { body, tot }
})
const summaryText = computed(() => props.model.summaryLabel ?? t('pivot.summary'))
const catTarget = (axis: 'row' | 'column', index: number, raw: unknown): LabelTarget =>
  raw == null ? { kind: 'nullLabel', axis, index } : { kind: 'category', axis, index, key: String(raw) }
function editLabel(target: LabelTarget, e: Event) {
  const btn = e.currentTarget as HTMLElement
  emit('edit-label', { target, el: btn })
}
function onHeadKey(e: KeyboardEvent) {
  if (!props.editable || e.isComposing) return
  if (!(e.key === 'F2' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return
  const th = (e.target as HTMLElement).closest?.('th')
  const btn = th?.querySelector<HTMLElement>('.lbl-edit')
  const target = btn ? parseLabelTargetId(btn.getAttribute('data-label-target') ?? '') : null
  if (!btn || !target) return
  e.preventDefault()
  emit('edit-label', { target, el: btn })
}
const editAria = (name: string) => t('label.edit', { name })
const labelLeft = (i: number) => ({ left: i * LABEL_W + 'px', width: LABEL_W + 'px', minWidth: LABEL_W + 'px', maxWidth: LABEL_W + 'px' })

async function writeClipboard(txt: string) {
  let ok = false
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); ok = true }
  } catch { /* fall through */ }
  if (!ok) {
    try {
      if (typeof document.execCommand === 'function') {
        const ta = document.createElement('textarea')
        ta.value = txt
        document.body.appendChild(ta)
        ta.select()
        ok = !!document.execCommand('copy')
        ta.remove()
        viewport.value?.focus()
      }
    } catch { /* ignore */ }
  }
  if (ok) { copyFailed.value = false; emit('copied'); return }
  copyFailed.value = true
  emit('copyFailed')
  clearTimeout(failTimer)
  failTimer = setTimeout(() => { copyFailed.value = false }, 2000)
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.target !== e.currentTarget) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    void writeClipboard(toTsv(props.model))
  }
}
onBeforeUnmount(() => clearTimeout(failTimer))
</script>

<template>
  <div class="pivot-table">
    <div v-if="model.truncated.rows" class="banner">{{ t('pivot.truncRows') }}</div>
    <div v-if="model.truncated.columns" class="banner">{{ t('pivot.truncCols') }}</div>
    <div v-if="copyFailed" class="meta"><span class="copy-failed">{{ t('pivot.copyFailed') }}</span></div>
    <div v-if="empty" class="empty">{{ t('pivot.noData') }}</div>
    <span v-else :id="hintId" class="sm-hint">{{ t('pivot.summaryEditHint') }}</span>
    <div v-if="!empty" ref="viewport" class="viewport" tabindex="0" :style="{ maxHeight: viewportHeight + 'px' }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop" @keydown="onKey">
      <table role="table" @keydown="onHeadKey" :aria-label="t('pivot.aria')" :aria-rowcount="total + levels" :aria-colcount="nRowDims + nBodyCols + (hasRowTotals ? nm : 0)">
        <thead>
          <tr v-for="l in levels" :key="l" role="row">
            <template v-if="l === 1">
              <th v-for="(h, i) in model.rowHeaders.length ? model.rowHeaders : ['']" :key="'rh' + i" :rowspan="levels" scope="col" class="label-head" :data-sort-th="i === 0 ? 'name' : undefined" :aria-sort="i === 0 ? ariaSort('name') : undefined" :title="h" :style="{ ...labelLeft(i), top: 0 }">
                <button v-if="i === 0" type="button" data-sort="name" :aria-keyshortcuts="editable ? 'F2' : undefined" @click="toggle('name')">{{ h }}{{ arrow('name') }}</button>
                <template v-else>{{ h }}</template>
                <button v-if="editable" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId({ kind: 'rowName', index: i })" tabindex="-1" :aria-label="editAria(h)" @click.stop="editLabel({ kind: 'rowName', index: i }, $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button>
              </th>
            </template>
            <template v-if="l < levels">
              <th v-for="c in headerRows[l - 1]" :key="c.key" scope="col" :colspan="c.span" class="group" :title="c.text" :style="{ top: (l - 1) * HEAD_H + 'px' }"><span class="h-text">{{ c.text }}</span>
                <button v-if="editable && c.keyed" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId(catTarget('column', c.level, c.raw))" tabindex="-1" :aria-label="editAria(c.text)" @click.stop="editLabel(catTarget('column', c.level, c.raw), $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button></th>
              <th v-if="hasRowTotals && l === 1" scope="col" class="total-head" :colspan="nm" :rowspan="levels - 1" :title="summaryText" :style="{ top: 0 }"><span class="h-text">{{ summaryText }}</span>
                <button v-if="editable" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId({ kind: 'summary' })" tabindex="-1" :aria-label="editAria(summaryText)" @click.stop="editLabel({ kind: 'summary' }, $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button></th>
            </template>
            <template v-else>
              <th v-for="(h, i) in model.columnHeaders" :key="'m' + i" scope="col" class="measure" :title="h[levels - 1]" :data-sort-th="'value'" :aria-sort="ariaSort('value', i % nm)" :style="{ top: (levels - 1) * HEAD_H + 'px' }">
                <button type="button" data-sort="value" :aria-keyshortcuts="editable ? 'F2' : undefined" @click="toggle('value', i % nm)">{{ h[levels - 1] }}{{ arrow('value', i % nm) }}</button>
                <button v-if="editable" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId({ kind: 'measureName', index: i % nm })" tabindex="-1" :aria-label="editAria(h[levels - 1])" @click.stop="editLabel({ kind: 'measureName', index: i % nm }, $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button>
              </th>
              <template v-if="hasRowTotals">
                <th v-for="(m, i) in model.measures" :key="'t' + i" scope="col" class="measure total-head" :title="how(i)" :style="{ top: (levels - 1) * HEAD_H + 'px' }"><span class="h-text">{{ levels === 1 ? `${summaryText} ${m.label}` : m.label }}</span>
                  <button v-if="editable" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId(levels === 1 ? { kind: 'summary' } : { kind: 'measureName', index: i })" tabindex="-1" :aria-label="editAria(levels === 1 ? summaryText : m.label)" @click.stop="editLabel(levels === 1 ? { kind: 'summary' } : { kind: 'measureName', index: i }, $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button></th>
              </template>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-if="start > 0" class="spacer" aria-hidden="true" :style="{ height: start * ROW_H + 'px' }"><td :colspan="nRowDims + nBodyCols + (hasRowTotals ? nm : 0)" /></tr>
          <tr v-for="v in visible" :key="v.idx" data-row role="row" :aria-rowindex="v.idx + levels + 1" :class="{ odd: v.idx % 2 === 1 }" :style="{ height: ROW_H + 'px' }">
            <th v-for="(lab, i) in v.labels" :key="'l' + i" scope="row" class="label" :tabindex="editable && model.rowKeys ? -1 : undefined" :aria-keyshortcuts="editable && model.rowKeys ? 'F2' : undefined" :style="labelLeft(i)" :title="lab"><span class="h-text">{{ lab }}</span>
              <button v-if="editable && model.rowKeys" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId(catTarget('row', i, model.rowKeys[v.idx]?.[i]))" tabindex="-1" :aria-label="editAria(lab)" @click.stop="editLabel(catTarget('row', i, model.rowKeys[v.idx]?.[i]), $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button></th>
            <td v-for="(c, k) in v.cells" :key="k" role="cell" class="num" :class="{ 'cell-null': c.v == null }">{{ c.txt }}</td>
            <td v-for="(c, k) in v.totals ?? []" :key="'t' + k" role="cell" class="num total" :class="{ 'first-total': k === 0, skipped: c.none, 'sm-cell': c.edit }" v-bind="c.edit ? { tabindex: 0, title: cellTitle(c), 'aria-describedby': hintId, 'data-sm-key': c.key } : {}" @dblclick="open(c)" @keydown="onCellKey(c, $event)">
              <select v-if="editing === c.key" v-focus data-test="summary-select" class="sm-select" :aria-label="selAria(c.k)" :value="method(c.k)" @change="pick(c, $event)" @blur="close" @keydown="onSelKey(c, $event)" @click.stop @dblclick.stop>
                <option v-for="o in SUMMARIES" :key="o" :value="o">{{ t('pivot.sm.' + o) }}</option>
              </select>
              <span v-else :class="{ skipped: c.none }">{{ c.txt }}</span>
            </td>
          </tr>
          <tr v-if="end < total" class="spacer" aria-hidden="true" :style="{ height: (total - end) * ROW_H + 'px' }"><td :colspan="nRowDims + nBodyCols + (hasRowTotals ? nm : 0)" /></tr>
          <tr v-if="hasFoot" class="total-row" role="row" :style="{ height: ROW_H + 'px' }">
            <th scope="row" class="label" :colspan="1" :title="summaryText" :style="labelLeft(0)"><span class="h-text">{{ summaryText }}</span>
              <button v-if="editable" type="button" class="lbl-edit" data-test="label-edit" :data-label-target="labelTargetId({ kind: 'summary' })" tabindex="-1" :aria-label="editAria(summaryText)" @click.stop="editLabel({ kind: 'summary' }, $event)"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 1.7a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4 1.5 14.5l1.1-4.1z" fill="currentColor"/></svg></button></th>
            <th v-for="i in nRowDims - 1" :key="'f' + i" scope="row" class="label" :style="labelLeft(i)" />
            <td v-for="(c, k) in footCells.body" :key="k" role="cell" class="num total" :class="{ skipped: c.none, 'sm-cell': c.edit }" v-bind="c.edit ? { tabindex: 0, title: cellTitle(c), 'aria-describedby': hintId, 'data-sm-key': c.key } : {}" @dblclick="open(c)" @keydown="onCellKey(c, $event)">
              <select v-if="editing === c.key" v-focus data-test="summary-select" class="sm-select" :aria-label="selAria(c.k)" :value="method(c.k)" @change="pick(c, $event)" @blur="close" @keydown="onSelKey(c, $event)" @click.stop @dblclick.stop>
                <option v-for="o in SUMMARIES" :key="o" :value="o">{{ t('pivot.sm.' + o) }}</option>
              </select>
              <span v-else :class="{ skipped: c.none }">{{ c.txt }}</span>
            </td>
            <td v-for="(c, k) in footCells.tot" :key="'g' + k" role="cell" class="num total" :class="{ 'first-total': k === 0, skipped: c.none, 'sm-cell': c.edit }" v-bind="c.edit ? { tabindex: 0, title: cellTitle(c), 'aria-describedby': hintId, 'data-sm-key': c.key } : {}" @dblclick="open(c)" @keydown="onCellKey(c, $event)">
              <select v-if="editing === c.key" v-focus data-test="summary-select" class="sm-select" :aria-label="selAria(c.k)" :value="method(c.k)" @change="pick(c, $event)" @blur="close" @keydown="onSelKey(c, $event)" @click.stop @dblclick.stop>
                <option v-for="o in SUMMARIES" :key="o" :value="o">{{ t('pivot.sm.' + o) }}</option>
              </select>
              <span v-else :class="{ skipped: c.none }">{{ c.txt }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.banner { padding: 4px 8px; background: color-mix(in srgb, #f59e0b 22%, var(--color-background, #fff)); color: var(--color-foreground, #111); font-size: 12px; }
.meta { padding: 2px 8px; font-size: 12px; color: var(--color-muted-foreground, #888); }
.empty { padding: 8px; font-size: 12px; color: var(--color-muted-foreground, #888); }
.viewport { overflow: auto; border: 1px solid var(--color-border, #ddd); outline: none; }
.viewport:focus, .viewport:focus-visible { outline: 2px solid var(--color-primary, #4a90d9); outline-offset: -2px; }
table { border-collapse: separate; border-spacing: 0; font-size: 12px; }
th, td { box-sizing: border-box; height: 28px; padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--color-border, #ddd); color: var(--color-foreground, inherit); }
thead th { position: sticky; z-index: 2; background: var(--color-muted, #f5f5f5); text-align: center; font-weight: 600; }
thead th.label-head { left: 0; z-index: 4; text-align: left; box-shadow: 1px 0 0 var(--color-border, #ddd); }
thead th.measure { text-align: right; min-width: 90px; }
th { position: relative; }
th .h-text { display: block; overflow: hidden; text-overflow: ellipsis; }
th button { all: unset; cursor: pointer; display: block; width: 100%; font: inherit; color: var(--color-foreground, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
th button:focus-visible { outline: 2px solid var(--color-primary, #4a90d9); outline-offset: -2px; }
th button.lbl-edit { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; padding: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; border-radius: 3px; background: var(--color-muted, #f5f5f5); color: var(--color-muted-foreground, #888); opacity: 0; pointer-events: none; transition: opacity 0.12s; overflow: visible; }
th button.lbl-edit svg { display: block; pointer-events: none; }
th:hover button.lbl-edit, th:focus-within button.lbl-edit, th button.lbl-edit:focus-visible { opacity: 1; pointer-events: auto; }
th button.lbl-edit:hover { color: var(--color-foreground, inherit); }
th.total-head { border-left: 2px solid var(--color-border, #ddd); font-weight: 700; }
tbody th.label { position: sticky; z-index: 1; background-color: var(--color-background, #fff); text-align: left; font-weight: 500; box-shadow: 1px 0 0 var(--color-border, #ddd); }
tbody tr.odd { background: color-mix(in srgb, var(--color-muted, #f5f5f5) 50%, transparent); }
tbody tr[data-row]:hover { background: color-mix(in srgb, var(--color-foreground, #111) 6%, var(--color-background, #fff)); color: var(--color-foreground, inherit); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.total, tr.total-row th { font-weight: 700; }
td.skipped, td.total span.skipped { color: var(--color-muted-foreground, #888); font-weight: 400; font-style: italic; }
td.sm-cell { user-select: none; min-width: 96px; max-width: 240px; }
.sm-hint { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
td.total[tabindex]:focus-visible { outline: 2px solid var(--color-primary, #4a90d9); outline-offset: -2px; }
.sm-select { font: inherit; font-size: 11px; max-width: 100%; color: var(--color-foreground, inherit); background: var(--color-background, #fff); border: 1px solid var(--color-border, #ddd); }
td.first-total { border-left: 2px solid var(--color-border, #ddd); }
tr.total-row td, tr.total-row th { border-top: 2px solid var(--color-border, #ddd); background: var(--color-muted, #f5f5f5); }
tr.spacer td { padding: 0; border: 0; }
.copy-failed { color: var(--color-muted-foreground, #888); }
</style>
