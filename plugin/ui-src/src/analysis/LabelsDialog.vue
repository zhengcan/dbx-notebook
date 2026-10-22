<script lang="ts">
type Closer = { close: () => void }
let current: Closer | null = null

interface Saved { el: HTMLElement; overflow: string; paddingRight: string; top: number; left: number }
let lockCount = 0
let saved: Saved[] = []

function scrollables(from: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let e = from.parentElement; e; e = e.parentElement) {
    const cs = getComputedStyle(e)
    if (e === document.body || e === document.documentElement) continue
    if (/(auto|scroll|overlay)/.test(`${cs.overflow} ${cs.overflowY} ${cs.overflowX}`)) out.push(e)
  }
  out.push(document.body, document.documentElement)
  return out
}
function acquireScrollLock(from: HTMLElement) {
  if (lockCount++ > 0) return
  saved = scrollables(from).map((el) => ({ el, overflow: el.style.overflow, paddingRight: el.style.paddingRight, top: el.scrollTop, left: el.scrollLeft }))
  for (const s of saved) {
    const bar = s.el === document.documentElement ? window.innerWidth - document.documentElement.clientWidth : s.el.offsetWidth - s.el.clientWidth - (s.el.clientLeft * 2)
    const pad = parseFloat(getComputedStyle(s.el).paddingRight) || 0
    s.el.style.overflow = 'hidden'
    if (bar > 0) s.el.style.paddingRight = `${pad + bar}px`
  }
}
function releaseScrollLock() {
  if (lockCount === 0 || --lockCount > 0) return
  for (const s of saved) {
    s.el.style.overflow = s.overflow
    s.el.style.paddingRight = s.paddingRight
    s.el.scrollTop = s.top
    s.el.scrollLeft = s.left
  }
  saved = []
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue'
import { t } from '../i18n'
import type { LabelCtx, LabelTarget } from './labelResolve'
import { countOverrides, resetLabels } from './labelPatch'
import { numberRows, tabAffectText, TAB_KEYS, type TabKey } from './labelTabs'
import { useLabelRows, type Cfg, type Patch, type Row } from './labels/useLabelRows'
import LabelsGroupNames from './labels/LabelsGroupNames.vue'
import LabelsGroupMeasures from './labels/LabelsGroupMeasures.vue'
import LabelsGroupChart from './labels/LabelsGroupChart.vue'
import LabelsGroupCategories from './labels/LabelsGroupCategories.vue'

const props = defineProps<{ cfg: Cfg; categories: { row: string[][]; column: string[][] }; ctx: LabelCtx; container: HTMLElement; returnFocus: HTMLElement | null }>()
const emit = defineEmits<{ (e: 'commit', patch: Patch): void; (e: 'close'): void }>()

const uid = Math.random().toString(36).slice(2, 8)
const hid = `ld-${uid}-title`
const scalesId = `ld-${uid}-scales`
// All four tabs aria-control the single tabpanel by design (its aria-labelledby follows the active tab).
const panelId = `ld-${uid}-panel`
const tabId = (k: TabKey) => `ld-${uid}-tab-${k}`
const hasPreview = !!useSlots().preview

const cfg = computed(() => ({ pivot: props.cfg.pivot, chart: props.cfg.chart }))
const L = useLabelRows(cfg, computed(() => props.ctx), computed(() => props.categories), (p) => emit('commit', p))
const { groups, invalid } = L

const active = ref<TabKey>('table')
const activeTarget = ref<LabelTarget | null>(null)
const dlg = ref<HTMLElement | null>(null)
const navBtns = ref<HTMLElement[]>([])

const counts = computed(() => {
  const c = {} as Record<TabKey, number>
  for (const k of TAB_KEYS) c[k] = countOverrides(cfg.value, k)
  return c
})
const total = computed(() => countOverrides(cfg.value, 'all'))
const shown = computed(() => groups.value.filter((g) => g.tab === active.value))
const tname = (k: TabKey) => t(`label.dialog.tab.${k}`)
const taria = (k: TabKey) => (counts.value[k] ? t('label.dialog.tabAria', { name: tname(k), n: counts.value[k] }) : tname(k))
// Single numbering source: the rows rendered as editable items of the active tab (unused mappings have no heading number).
const visibleRows = computed(() => shown.value.flatMap((g) => g.rows).filter((r) => !r.unused))
const numbers = computed(() => numberRows(visibleRows.value))
const banner = computed(() => tabAffectText(shown.value.flatMap((g) => g.rows)))

const onFocus = (r: Row) => { activeTarget.value = r.target }
const resetTab = () => { if (counts.value[active.value]) emit('commit', resetLabels(cfg.value, active.value)) }
const resetAll = () => { if (total.value) emit('commit', resetLabels(cfg.value, 'all')) }

function selectTab(k: TabKey) { active.value = k; activeTarget.value = null }
function onTabKey(e: KeyboardEvent) {
  const idx = navBtns.value.findIndex((b) => b === (e.target as HTMLElement))
  const cur = idx >= 0 ? idx : TAB_KEYS.indexOf(active.value)
  let n = -1
  if (e.key === 'ArrowRight') n = (cur + 1) % TAB_KEYS.length
  else if (e.key === 'ArrowLeft') n = (cur - 1 + TAB_KEYS.length) % TAB_KEYS.length
  else if (e.key === 'Home') n = 0
  else if (e.key === 'End') n = TAB_KEYS.length - 1
  if (n < 0) return
  e.preventDefault()
  selectTab(TAB_KEYS[n])
  navBtns.value[n]?.focus()
}

function focusables(): HTMLElement[] {
  const d = dlg.value
  if (!d) return []
  return Array.from(d.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('tabindex') === '-1' || el.closest('[hidden],[inert]')) return false
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true
  })
}
function storedValue(id: string | null): string {
  const r = groups.value.flatMap((g) => g.rows).find((x) => x.id === id)
  return r && r.overridden ? r.value : ''
}
// Any change of the stored labels (undo/redo, the config panel's title) resets every input to the store value, so a
// half-typed value is neither shown over newer data nor written back by a later blur.
watch(() => JSON.stringify([props.cfg.pivot, props.cfg.chart]), () => {
  void nextTick(() => {
    for (const row of dlg.value?.querySelectorAll<HTMLElement>('[data-label-target]') ?? []) {
      const i = row.querySelector<HTMLInputElement>('input[data-test=label-input]')
      const want = storedValue(row.getAttribute('data-label-target'))
      if (i && i.value !== want) i.value = want
    }
  })
})
function onKey(e: KeyboardEvent) {
  const composing = e.isComposing || e.keyCode === 229
  if (e.key === 'Escape') {
    if (composing) { e.stopPropagation(); return }
    e.preventDefault(); e.stopPropagation()
    const el = e.target as HTMLElement
    if (el instanceof HTMLInputElement) {
      const id = el.closest('[data-label-target]')?.getAttribute('data-label-target') ?? null
      if (el.value !== storedValue(id)) {
        el.value = storedValue(id)
        if (id) L.escapeRow({ id } as Row)
        return
      }
    }
    emit('close')
    return
  }
  if (e.key === 'Enter' && composing) { e.stopPropagation(); return }
  if (e.key !== 'Tab') return
  const items = focusables()
  const d = dlg.value!
  if (!items.length) { e.preventDefault(); d.focus(); return }
  const first = items[0], last = items[items.length - 1]
  const cur = document.activeElement
  const inside = !!cur && d.contains(cur) && items.includes(cur as HTMLElement)
  if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (!inside || cur === last)) { e.preventDefault(); first.focus() }
}

// Modal guard: focus that lands outside the dialog (a popover/AI drawer opened underneath, programmatic focus) is returned to the
// last focused control inside. Only the current (singleton) dialog acts, and our own refocus lands inside, so it cannot loop.
let lastInside: HTMLElement | null = null
function onFocusIn(e: FocusEvent) {
  const d = dlg.value
  if (!d || current !== self) return
  const el = e.target as Node
  if (d.contains(el)) { lastInside = el as HTMLElement; return }
  const f = lastInside && d.contains(lastInside) ? lastInside : focusables()[0] ?? d
  f.focus({ preventScroll: true })
}

const self: Closer = { close: () => emit('close') }
if (current && current !== self) current.close()
current = self

onMounted(() => {
  acquireScrollLock(props.container)
  document.addEventListener('focusin', onFocusIn)
  const d = dlg.value
  const first = d?.querySelector<HTMLElement>('.ld-content input:not(:disabled)')
  ;(first ?? d)?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn)
  releaseScrollLock()
  const wasCurrent = current === self
  if (wasCurrent) current = null
  if (!wasCurrent) return
  const rf = props.returnFocus
  if (rf && rf.isConnected) rf.focus({ preventScroll: true })
  else if (props.container.isConnected) props.container.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport :to="container">
    <div class="ld-overlay" data-test="labels-backdrop" @mousedown.self.prevent>
      <div ref="dlg" class="ld-panel" role="dialog" aria-modal="true" :aria-labelledby="hid" tabindex="-1" data-test="labels-dialog" @keydown.capture="onKey">
        <header class="ld-head">
          <h2 :id="hid" class="ld-title">{{ t('label.dialog.title') }}</h2>
          <p class="ld-lead">{{ t('label.dialog.lead') }}</p>
        </header>
        <div class="ld-tabs" role="tablist" data-test="labels-tabs" :aria-label="t('label.dialog.tabs')" @keydown="onTabKey">
          <button
            v-for="k in TAB_KEYS" :id="tabId(k)" :key="k" :ref="(el) => { if (el) navBtns[TAB_KEYS.indexOf(k)] = el as HTMLElement }" type="button" role="tab" class="ld-tab" :data-tab="k"
            :aria-selected="active === k ? 'true' : 'false'" :aria-controls="panelId" :tabindex="active === k ? 0 : -1" :aria-label="taria(k)" @click="selectTab(k)"
          ><span class="ld-t">{{ tname(k) }}</span><span v-if="counts[k]" class="ld-n" aria-hidden="true">● {{ counts[k] }}</span></button>
        </div>
        <div class="ld-banner">
          <p class="ld-aff" data-test="labels-banner">{{ banner }}</p>
          <button type="button" class="ld-btn" data-test="labels-reset-tab" :disabled="!counts[active]" @click="resetTab">{{ t('label.dialog.resetTab', { n: counts[active] }) }}</button>
        </div>
        <div class="ld-split" :class="{ 'has-preview': hasPreview }">
          <aside v-if="hasPreview" class="ld-preview" data-test="labels-preview-slot"><slot name="preview" :active="activeTarget" :numbers="numbers" /></aside>
          <div :id="panelId" class="ld-content" role="tabpanel" :aria-labelledby="tabId(active)" data-test="labels-panel">
            <p v-if="!shown.length" class="ld-empty">{{ t('label.dialog.empty') }}</p>
            <template v-for="g in shown" :key="g.key">
              <LabelsGroupNames v-if="g.key === 'names'" :group="g" :uid="uid" :invalid="invalid" :numbers="numbers" @commit="L.commitRow" @reset="L.resetRow" @escape="L.escapeRow" @focus="onFocus" />
              <LabelsGroupMeasures v-else-if="g.key === 'measures' || g.key === 'units'" :group="g" :uid="uid" :invalid="invalid" :numbers="numbers" :scales-id="scalesId" @commit="L.commitRow" @reset="L.resetRow" @escape="L.escapeRow" @focus="onFocus" />
              <LabelsGroupChart v-else-if="g.key === 'chart'" :group="g" :uid="uid" :invalid="invalid" :numbers="numbers" @commit="L.commitRow" @reset="L.resetRow" @escape="L.escapeRow" @focus="onFocus" />
              <LabelsGroupCategories v-else :group="g" :uid="uid" :invalid="invalid" :numbers="numbers" @commit="L.commitRow" @reset="L.resetRow" @escape="L.escapeRow" @focus="onFocus" @toggle="L.toggleExpanded" @search="L.setQuery" />
            </template>
            <datalist :id="scalesId"><option v-for="s in ['100', '1000', '10000', '1000000', '100000000']" :key="s" :value="s" /></datalist>
          </div>
        </div>
        <footer class="ld-foot" data-test="labels-footer">
          <span class="ld-total" data-test="labels-total">{{ t('label.dialog.total', { n: total }) }}</span>
          <span class="ld-acts">
            <button type="button" class="ld-btn" data-test="labels-reset-all" :disabled="!total" @click="resetAll">{{ t('label.dialog.resetAllN', { n: total }) }}</button>
            <button type="button" class="ld-btn primary" data-test="labels-close" @click="emit('close')">{{ t('label.dialog.done') }}</button>
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ld-overlay { position: fixed; inset: 0; z-index: 1000; box-sizing: border-box; padding: 8px; display: flex; align-items: center; justify-content: center; background: var(--color-overlay, rgba(0, 0, 0, 0.55)); font-size: 13px; }
.ld-panel { container-type: inline-size; container-name: lbl; width: min(960px, 100%); height: min(720px, 100%); box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; background: var(--color-background, #fff); color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ccc); border-radius: 8px; box-shadow: 0 10px 30px var(--color-overlay, rgba(0, 0, 0, 0.4)); outline: none; overflow: hidden; }
.ld-head { padding: 8px 10px; border-bottom: 1px solid var(--color-border, #ccc); min-width: 0; }
.ld-title { margin: 0; font-size: 14px; }
.ld-lead { margin: 2px 0 0; font-size: 12px; color: var(--color-muted-foreground, #777); }
.ld-tabs { display: flex; flex-wrap: wrap; gap: 2px 4px; padding: 6px 10px 0; border-bottom: 1px solid var(--color-border, #ccc); min-width: 0; }
.ld-tab { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; border: 1px solid transparent; border-bottom: 0; background: transparent; color: var(--color-foreground, inherit); border-radius: 4px 4px 0 0; padding: 4px 10px; cursor: pointer; font: inherit; }
.ld-tab[aria-selected='true'] { background: var(--color-muted, rgba(128, 128, 128, 0.15)); border-color: var(--color-border, #ccc); font-weight: 600; box-shadow: inset 0 3px var(--color-primary, #2563eb); }
.ld-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ld-n { color: var(--color-warning, #b80); font-size: 11px; flex: 0 0 auto; }
.ld-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 8px 10px 0; padding: 4px 8px; border: 1px solid var(--color-border, #ccc); border-inline-start: 3px solid var(--color-primary, #2563eb); border-radius: 4px; background: var(--color-muted, rgba(128, 128, 128, 0.1)); min-width: 0; }
.ld-aff { margin: 0; flex: 1 1 12em; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.ld-aff:empty { display: none; }
.ld-split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 8px 10px; overflow: hidden; }
.ld-split.has-preview { grid-template-columns: minmax(220px, 38%) minmax(0, 1fr); }
.ld-content { min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 6px; }
.ld-empty { margin: 0; color: var(--color-muted-foreground, #777); }
.ld-preview { min-width: 0; align-self: start; max-height: 100%; overflow: auto; border: 1px solid var(--color-border, #ccc); border-radius: 6px; padding: 6px; background: var(--color-muted, rgba(128, 128, 128, 0.1)); }
.ld-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px; padding: 6px 10px; border-top: 1px solid var(--color-border, #ccc); }
.ld-total { color: var(--color-muted-foreground, #777); min-width: 0; overflow-wrap: anywhere; }
.ld-acts { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-inline-start: auto; }
.ld-btn { border: 1px solid var(--color-border, #ccc); background: transparent; color: var(--color-foreground, inherit); border-radius: 4px; padding: 2px 10px; cursor: pointer; font: inherit; }
.ld-btn:disabled { opacity: 0.4; cursor: default; }
.ld-btn.primary { background: var(--color-primary, #2563eb); color: var(--color-primary-foreground, #fff); border-color: transparent; }
.ld-panel :focus-visible { outline: 2px solid var(--color-primary, #2563eb); outline-offset: 1px; }
@container lbl (max-width: 640px) {
  .ld-split, .ld-split.has-preview { grid-template-columns: minmax(0, 1fr); }
  .ld-preview { display: none; }
}
</style>
