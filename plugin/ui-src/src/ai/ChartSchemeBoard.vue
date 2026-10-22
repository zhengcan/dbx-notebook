<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import type { ChartCandidate } from './parse'
import { describeChart, fallbackSummary, renderCandidatePreview } from './chartAiGate'
import { chartDrawWidth, previewSize } from './chartSizing'
import { readTokens } from '../analysis/theme'
import { t } from '../i18n'

type Source = { columns: { name: string; dataType?: string }[]; rows: unknown[][] }
const props = defineProps<{ source: Source; candidates: ChartCandidate[]; selected: number }>()
const emit = defineEmits<{ select: [i: number]; apply: [i: number] }>()

const purify = DOMPurify(window)
const root = ref<HTMLElement | null>(null)
const largeEl = ref<HTMLElement | null>(null)
const width = ref(480)
const svg = ref<string | null>(null)
const failed = ref(false)
let alive = true
let seq = 0
let ro: ResizeObserver | null = null
let observed: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined
const cardEls = ref<HTMLButtonElement[]>([])

const cand = computed(() => props.candidates[props.selected])
const title = (c: ChartCandidate, i: number) => c.title || t('ai.chart.untitled', { n: i + 1 })
const blurb = (c: ChartCandidate) => c.summary || fallbackSummary(c.config)

const size = computed(() => {
  const c = cand.value
  if (!c) return { width: width.value, height: 340, scroll: false }
  const { pivot, chartOptions } = c.config
  // distinct raw values of the first row field (not grain-aware: a time grain can only lower the real count, so this over-estimates height)
  const ci = props.source.columns.findIndex((x) => x.name === pivot.rows[0]?.field)
  const cats = new Set(props.source.rows.map((r) => String(r[ci] ?? ''))).size
  return previewSize({
    type: chartOptions.type ?? 'bar',
    categories: pivot.rows.length ? cats : 1,
    series: pivot.columns.length || pivot.values.length,
    hasLegend: pivot.columns.length > 0 || pivot.values.length > 1,
    hasTitle: !!chartOptions.title,
  }, { width: width.value })
})
const drawWidth = computed(() => {
  const c = cand.value
  const o = c?.config.chartOptions
  const p = c?.config.pivot
  return chartDrawWidth(size.value.width, { type: o?.type ?? 'bar', hasLegend: !!p && (p.columns.length > 0 || p.values.length > 1) })
})
const summary = computed(() => (cand.value ? describeChart({ pivot: cand.value.config.pivot, chartOptions: cand.value.config.chartOptions }).filter((r) => r.text !== '') : []))

async function draw() {
  const my = ++seq
  const c = cand.value
  if (!c) { svg.value = null; return }
  const el = root.value
  const dark = !!el?.closest('[data-theme="dark"]')
  const s = size.value
  const r = await renderCandidatePreview(props.source, c, { tokens: el ? readTokens(el) : undefined, dark, width: drawWidth.value, height: s.height, large: true })
  if (!alive || my !== seq) return
  failed.value = r.svg === null
  svg.value = r.svg === null ? null : purify.sanitize(r.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
}
function measure() {
  const w = largeEl.value?.clientWidth
  if (w && w > 0 && w !== width.value) width.value = w
}
function observe() {
  if (typeof ResizeObserver === 'undefined' || !largeEl.value || observed === largeEl.value) return
  ro?.disconnect()
  observed = largeEl.value
  ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(measure, 100) })
  ro.observe(observed)
}
onMounted(() => {
  measure()
  observe()
  void draw()
})
watch(largeEl, () => { measure(); observe() })
async function onKey(e: KeyboardEvent, i: number) {
  const n = props.candidates.length
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d || !n) return
  e.preventDefault()
  const j = (i + d + n) % n
  emit('select', j)
  await nextTick()
  cardEls.value[j]?.focus()
}
watch([() => props.selected, () => props.candidates, () => props.source, () => drawWidth.value, () => size.value.height], () => { void draw() })
onBeforeUnmount(() => { alive = false; seq++; clearTimeout(timer); ro?.disconnect(); ro = null })
</script>

<template>
  <div ref="root" class="board" data-test="scheme-board">
    <div class="cards" role="radiogroup" :aria-label="t('ai.chart.candidates')">
      <button
        v-for="(c, i) in candidates" :key="i" :ref="(el) => { if (el) cardEls[i] = el as HTMLButtonElement }" type="button" class="card" data-test="scheme-card" role="radio"
        :class="{ on: i === selected }" :aria-checked="i === selected ? 'true' : 'false'" :tabindex="i === selected ? 0 : -1"
        @click="emit('select', i)" @keydown="onKey($event, i)"
      >
        <span class="tn">{{ i + 1 }}. {{ title(c, i) }}</span>
        <span class="ts">{{ blurb(c) }}</span>
      </button>
    </div>
    <div v-if="cand" ref="largeEl" class="large" data-test="scheme-large" tabindex="0" role="region" :aria-label="t('ai.chart.preview')"
      :style="size.scroll ? { maxHeight: '520px' } : undefined">
      <div v-if="svg" class="svg" v-html="svg" />
      <div v-else-if="failed" class="ph">{{ t('ai.chart.previewFailed') }}</div>
      <div v-else class="ph" aria-hidden="true">…</div>
    </div>
    <p v-if="cand" class="cap" data-test="scheme-caption">{{ t('ai.chart.preview') }}</p>
    <dl v-if="cand" class="sum">
      <template v-for="r in summary" :key="r.key"><dt>{{ t('ai.chart.f.' + r.key) }}</dt><dd>{{ r.text }}</dd></template>
    </dl>
    <button
      v-if="cand" type="button" class="apply" data-test="scheme-apply"
      :aria-label="`${t('ai.chart.applyCandidate')}: ${title(cand, selected)}`" @click="emit('apply', selected)"
    >{{ t('ai.chart.applyCandidate') }}</button>
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 8px; }
.cards { display: flex; gap: 8px; }
.card { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-background); color: inherit; font: inherit; cursor: pointer; text-align: left; }
.card:focus-visible, .large:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
.card.on { border-color: var(--color-primary); box-shadow: 0 0 0 1px var(--color-primary); }
.tn { display: block; font-size: 12px; font-weight: 600; margin-bottom: 2px; overflow-wrap: anywhere; }
.ts { display: block; font-size: 12px; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
.large { overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-background); }
.svg :deep(svg) { display: block; max-width: none; }
.ph { padding: 16px 8px; font-size: 12px; color: var(--color-muted-foreground); text-align: center; }
.cap { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
.sum { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; font-size: 12px; }
.sum dt { color: var(--color-muted-foreground); }
.sum dd { margin: 0; }
.apply { align-self: flex-start; }
</style>
