<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { loadVega, type RenderedChart } from './vegaRuntime'
import { readTokens, vegaConfig } from './theme'
import type { LabelTarget } from './labelResolve'

const CHART_HEIGHT = 280
// Chart label editing is pointer-only (keyboard/touch use the panel). `editable` defaults to false so there are no dead affordances.
// The vega title/axis-title/legend marks are non-interactive, so clicks are resolved from the SVG DOM (CSS re-enables pointer events on those text nodes only).
const props = defineProps<{ spec: object; rows: unknown[]; title?: string; description?: string; editable?: boolean; horizontal?: boolean; legendAxis?: 'legend' | 'x'; measureNames?: string[] }>()
const emit = defineEmits<{ (e: 'error', err: unknown): void; (e: 'edit-label', p: { target: LabelTarget; el: HTMLElement }): void }>()

const host = ref<HTMLElement | null>(null)
const failed = ref(false)
const width = ref(0)
let chart: RenderedChart | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
let alive = true
let ro: ResizeObserver | undefined
let mo: MutationObserver | undefined

// Exact match wins; otherwise a `col · measure` suffix match, longest measure name first.
function matchMeasure(text: string, names: string[]): number {
  const exact = names.indexOf(text)
  if (exact >= 0) return exact
  let best = -1
  names.forEach((n, i) => { if (text.endsWith(` · ${n}`) && (best < 0 || n.length > names[best].length)) best = i })
  return best
}

function targetFor(node: Element): LabelTarget | null {
  if (node.closest('g.role-title')) return { kind: 'title' }
  const axisTitle = node.closest('g.role-axis-title')
  if (axisTitle) {
    const label = axisTitle.closest('g.role-axis')?.getAttribute('aria-label') ?? ''
    const isX = /^x-axis/i.test(label)
    if (!isX && !/^y-axis/i.test(label)) return null
    return { kind: 'axis', axis: isX !== !!props.horizontal ? 'x' : 'y' }
  }
  if (node.closest('g.role-legend-title')) return { kind: 'axis', axis: props.legendAxis ?? 'legend' }
  if (node.closest('g.role-legend-label')) {
    const text = (node.closest('text') ?? node).textContent ?? ''
    const names = props.measureNames ?? []
    const i = matchMeasure(text, names)
    return i >= 0 ? { kind: 'measureName', index: i } : null
  }
  return null
}

function onClick(ev: MouseEvent) {
  if (!props.editable || !(ev.target instanceof Element)) return
  const target = targetFor(ev.target)
  if (target && host.value) emit('edit-label', { target, el: (ev.target.closest('text') as unknown as HTMLElement | null) ?? host.value })
}

function disposeChart() { chart?.destroy(); chart = null }

async function draw() {
  const el = host.value
  if (!el || !alive || !width.value) return
  const my = ++seq
  let rt
  try { rt = await loadVega() } catch (e) {
    if (!alive || my !== seq) return
    failed.value = true
    emit('error', e)
    return
  }
  if (!alive || my !== seq) return
  failed.value = false
  const dark = !!el.closest('[data-theme="dark"]')
  const config = vegaConfig(readTokens(el), dark ? 'dark' : 'light', width.value)
  try {
    const next = await rt.render(el, props.spec, props.rows, { width: width.value || undefined, height: CHART_HEIGHT, config, hover: { more: (n) => t('chart.hoverMore', { n }) } })
    if (!alive || my !== seq) { next.destroy(); return }
    disposeChart()
    chart = next
  } catch (e) {
    if (alive && my === seq) { failed.value = true; emit('error', e) }
  }
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(draw, 50)
}

function retry() { failed.value = false; void draw() }

onMounted(() => {
  if (host.value && typeof ResizeObserver !== 'undefined') {
    const w0 = Math.floor(host.value.getBoundingClientRect().width)
    if (w0 > 0) { width.value = w0; void draw() }
    ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (w && w !== width.value) { width.value = w; schedule() }
    })
    ro.observe(host.value)
  } else {
    width.value = 480
    void draw()
  }
  const root = host.value?.closest('[data-theme]') ?? document.documentElement
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(schedule)
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  }
})
watch(() => [props.spec, props.rows], schedule)
onBeforeUnmount(() => {
  alive = false
  clearTimeout(timer)
  ro?.disconnect()
  mo?.disconnect()
  disposeChart()
})

defineExpose({ svg: async (): Promise<string> => (chart ? chart.svg() : '') })
</script>

<template>
  <div class="chart-view" role="img" :aria-label="description || title || t('chart.aria')">
    <div v-show="!failed" ref="host" class="chart-host" :class="{ editable }" @click="onClick"></div>
    <div v-if="failed" class="chart-fail">
      <span>{{ t('chart.loadFailed') }}</span>
      <button type="button" @click="retry">{{ t('chart.retry') }}</button>
    </div>
  </div>
</template>

<style scoped>
.chart-view { width: 100%; min-height: 40px; }
.chart-host { width: 100%; overflow: hidden; }
.chart-host :deep(svg) { display: block; }
.chart-host.editable :deep(g.role-title text),
.chart-host.editable :deep(g.role-axis-title text),
.chart-host.editable :deep(g.role-legend-title text),
.chart-host.editable :deep(g.role-legend-label text) { pointer-events: all; cursor: pointer; }
.chart-host.editable :deep(g.role-title text:hover),
.chart-host.editable :deep(g.role-axis-title text:hover),
.chart-host.editable :deep(g.role-legend-title text:hover),
.chart-host.editable :deep(g.role-legend-label text:hover) { text-decoration: underline; }
.chart-fail { display: flex; gap: 8px; align-items: center; color: var(--color-destructive, #c62828); font-size: 12px; }
</style>
