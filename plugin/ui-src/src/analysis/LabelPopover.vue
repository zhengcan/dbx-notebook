<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChartOptions, PivotConfig } from '@sqlnb/format'
import { t } from '../i18n'
import { autoLabels, isOverridden, resolveLabels, type LabelCtx, type LabelTarget } from './labelResolve'
import { isValidScale, patchLabel } from './labelPatch'
import { labelTargetId } from './labelTargetId'

type Cfg = { pivot: PivotConfig; chart: ChartOptions }
type Patch = ReturnType<typeof patchLabel>
const props = defineProps<{ target: LabelTarget; anchor: HTMLElement | DOMRect; cfg: Cfg; ctx: LabelCtx; container: HTMLElement }>()
const emit = defineEmits<{ (e: 'commit', patch: Patch): void; (e: 'close', reason: 'commit' | 'cancel' | 'outside'): void }>()

const uid = Math.random().toString(36).slice(2, 8)
const resolved = resolveLabels(props.cfg, props.ctx)
const auto = autoLabels(props.cfg, props.ctx)

interface Field { key: string; target: LabelTarget; label: string; placeholder: string; initial: string; maxlength: number; scale?: boolean }
const kindLabel: Record<string, string> = { rowName: 'label.rowName', columnName: 'label.columnName', summary: 'label.summary', title: 'label.title', category: 'label.values', nullLabel: 'label.null' }
const axisLabel = { x: 'label.axisX', y: 'label.axisY', legend: 'label.axisLegend' } as const

function textOf(tg: LabelTarget, r: typeof resolved): string {
  switch (tg.kind) {
    case 'rowName': return r.rowNames[tg.index] ?? ''
    case 'columnName': return r.columnNames[tg.index] ?? ''
    case 'measureName': return r.measureNames[tg.index] ?? ''
    case 'summary': return r.summary
    case 'title': return r.title
    case 'axis': return r.axis[tg.axis]
    case 'unit': return r.format(tg.index).unit ?? ''
    case 'scale': { const s = r.format(tg.index).scale; return s === undefined ? '' : String(s) }
    case 'category': return r.category(tg.axis, tg.index, tg.key)
    case 'nullLabel': return r.category(tg.axis, tg.index, null)
  }
}
function field(tg: LabelTarget, label: string, extra: Partial<Field> = {}): Field {
  return { key: labelTargetId(tg), target: tg, label, placeholder: textOf(tg, auto), initial: isOverridden(props.cfg, tg) ? textOf(tg, resolved) : '', maxlength: 200, ...extra }
}
const fields: Field[] = (() => {
  const tg = props.target
  if (tg.kind === 'measureName') {
    const u: LabelTarget = { kind: 'unit', index: tg.index }, s: LabelTarget = { kind: 'scale', index: tg.index }
    const pct = props.cfg.pivot.values[tg.index]?.format?.kind === 'percent'
    return [
      field(tg, t('label.measureName')),
      field(u, t('label.unit'), { maxlength: 20, placeholder: '' }),
      ...(pct ? [] : [field(s, t('label.scale'), { maxlength: 20, scale: true, placeholder: '1' })]),
    ]
  }
  if (tg.kind === 'axis') return [field(tg, t(axisLabel[tg.axis]))]
  return [field(tg, t(kindLabel[tg.kind] ?? 'label.title'))]
})()
const values = ref<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.initial])))
const invalid = ref<Record<string, boolean>>({})
const name = textOf(props.target, resolved)
const ariaLabel = t('label.edit', { name: name || fields[0].label })

const dlg = ref<HTMLElement | null>(null)
let done = false

function applyPatch(cfg: Cfg, p: Patch): Cfg {
  return { pivot: { ...cfg.pivot, ...(p.pivot ?? {}) } as PivotConfig, chart: { ...cfg.chart, ...(p.chartOptions ?? {}) } as ChartOptions }
}
function build(): { patch: Patch | null; ok: boolean } {
  let c = props.cfg
  const out: Patch = {}
  const bad: Record<string, boolean> = {}
  for (const f of fields) {
    const v = values.value[f.key]
    if (v === f.initial) continue
    if (f.scale && v.trim() !== '' && !isValidScale(v)) { bad[f.key] = true; continue }
    const p = patchLabel(c, f.target, v)
    if (!p.pivot && !p.chartOptions) continue
    c = applyPatch(c, p)
    if (p.pivot) out.pivot = { ...(out.pivot ?? {}), ...p.pivot }
    if (p.chartOptions) out.chartOptions = { ...(out.chartOptions ?? {}), ...p.chartOptions }
  }
  invalid.value = bad
  if (Object.keys(bad).length) return { patch: null, ok: false }
  return { patch: out.pivot || out.chartOptions ? out : null, ok: true }
}

function restoreFocus() {
  const a = props.anchor
  if (typeof HTMLElement !== 'undefined' && a instanceof HTMLElement && a.isConnected) { a.focus(); return }
  const id = labelTargetId(props.target)
  const el = Array.from(props.container.querySelectorAll<HTMLElement>('.lbl-edit[data-label-target]')).find((e) => e.getAttribute('data-label-target') === id)
  ;(el ?? props.container).focus()
}
function finish(reason: 'commit' | 'cancel' | 'outside', patch: Patch | null) {
  if (done) return
  done = true
  if (patch) emit('commit', patch)
  emit('close', reason)
  void nextTick(restoreFocus)
}
function commit(reason: 'commit' | 'outside' = 'commit') {
  const r = build()
  if (!r.ok) return
  finish(reason, r.patch)
}
function reset() {
  let c = props.cfg
  const out: Patch = {}
  for (const f of fields) {
    if (!isOverridden(c, f.target)) continue
    const p = patchLabel(c, f.target, null)
    c = applyPatch(c, p)
    if (p.pivot) out.pivot = { ...(out.pivot ?? {}), ...p.pivot }
    if (p.chartOptions) out.chartOptions = { ...(out.chartOptions ?? {}), ...p.chartOptions }
  }
  finish('commit', out.pivot || out.chartOptions ? out : null)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel', null); return }
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !e.isComposing) { e.preventDefault(); commit(); return }
  if (e.key !== 'Tab' || !dlg.value) return
  const items = Array.from(dlg.value.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'))
  if (!items.length) return
  const first = items[0], last = items[items.length - 1]
  const cur = document.activeElement
  if (e.shiftKey && (cur === first || !dlg.value.contains(cur))) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (cur === last || !dlg.value.contains(cur))) { e.preventDefault(); first.focus() }
}
function onOutside(e: MouseEvent) {
  if (done || !dlg.value || dlg.value.contains(e.target as Node)) return
  commit('outside')
}
function place() {
  const d = dlg.value
  if (!d) return
  const a = props.anchor instanceof DOMRect || !('getBoundingClientRect' in props.anchor) ? (props.anchor as DOMRect) : props.anchor.getBoundingClientRect()
  const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight
  const width = Math.max(160, Math.min(300, vw - 16))
  d.style.width = `${width}px`
  const h = d.offsetHeight
  let left = Math.min(Math.max(8, a.left), vw - width - 8)
  left = Math.max(8, left)
  let top = a.bottom + 4
  if (top + h > vh - 8) top = a.top - h - 4
  top = Math.max(8, Math.min(top, vh - h - 8))
  const c = props.container.getBoundingClientRect()
  d.style.left = `${left - c.left - props.container.clientLeft}px`
  d.style.top = `${top - c.top - props.container.clientTop}px`
}
onMounted(() => {
  place()
  document.addEventListener('mousedown', onOutside, true)
  const inp = dlg.value?.querySelector<HTMLInputElement>('input')
  inp?.focus({ preventScroll: true }); inp?.select()
})
defineExpose({ commitOutside: () => { if (!done) commit('outside') } })
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside, true))
const iid = (f: Field) => `lpo-${uid}-${f.key}`
</script>

<template>
  <Teleport :to="container">
    <div ref="dlg" class="lpo" role="dialog" :aria-label="ariaLabel" data-test="label-popover" @keydown="onKey">
      <div v-for="f in fields" :key="f.key" class="lpo-f">
        <label :for="iid(f)">{{ f.label }}</label>
        <input
          :id="iid(f)" v-model="values[f.key]" type="text" data-test="label-popover-input" :data-field="f.target.kind"
          :placeholder="f.placeholder" :maxlength="f.maxlength" :inputmode="f.scale ? 'decimal' : undefined"
          :aria-invalid="invalid[f.key] ? 'true' : undefined" :aria-describedby="invalid[f.key] ? `${iid(f)}-err` : undefined"
        />
        <span v-if="invalid[f.key]" :id="`${iid(f)}-err`" class="lpo-err" role="alert">{{ t('label.invalidScale') }}</span>
      </div>
      <div class="lpo-btns">
        <button type="button" data-test="label-popover-reset" @click="reset">{{ t('label.popReset') }}</button>
        <button type="button" class="primary" data-test="label-popover-done" @click="commit()">{{ t('label.popDone') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lpo { position: absolute; left: 0; top: 0; width: 300px; z-index: 20; box-sizing: border-box; padding: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; background: var(--color-background, #fff); color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ccc); border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
.lpo-f { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lpo-f label { color: var(--color-muted-foreground, #777); }
.lpo input { box-sizing: border-box; width: 100%; font-size: 13px; padding: 3px 6px; background: var(--color-background, transparent); color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ccc); border-radius: 3px; }
.lpo input::placeholder { color: var(--color-muted-foreground, #777); opacity: 1; }
.lpo input[aria-invalid='true'] { border-color: var(--color-destructive, #c00); }
.lpo-err { color: var(--color-destructive, #c00); }
.lpo-btns { display: flex; justify-content: flex-end; gap: 6px; }
.lpo-btns button { cursor: pointer; padding: 2px 10px; background: transparent; color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ccc); border-radius: 3px; }
.lpo-btns button.primary { background: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #fff); border-color: transparent; }
</style>
