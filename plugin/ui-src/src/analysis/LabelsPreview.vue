<script setup lang="ts">
import { computed } from 'vue'
import type { ChartOptions, PivotConfig } from '@sqlnb/format'
import type { LabelCtx, LabelTarget } from './labelResolve'
import { buildPreviewModel, type SampleCategories } from './labelPreviewModel'

const props = defineProps<{
  cfg: { pivot: PivotConfig; chart: ChartOptions }
  ctx: LabelCtx
  categories?: SampleCategories
  active: LabelTarget | null
  numbers?: Map<string, number>
}>()
const m = computed(() => buildPreviewModel(props.cfg, props.ctx, props.active, props.categories ?? {}, props.numbers))
const names = (role: string) => m.value.header.cells.filter((c) => c.role === role)
const nRow = computed(() => Math.max(1, names('rowName').length))
const nMeas = computed(() => names('measureName').length)
const levels = computed(() => names('columnName').length && m.value.table.groups.length ? names('columnName').length : 0)
const groupsOrOne = computed(() => (m.value.table.groups.length ? m.value.table.groups : [null]))
const cols = computed(() => `repeat(${nRow.value}, minmax(0, 1.3fr)) repeat(${m.value.table.groups.length ? m.value.table.groups.length * nMeas.value : nMeas.value}, minmax(0, 1fr))`)
const flag = (a: boolean) => (a ? 'true' : undefined)
</script>

<template>
  <div class="lpv" aria-hidden="true" data-test="labels-preview">
    <div class="lpv-table lpv-grid" data-test="lpv-table" :style="{ gridTemplateColumns: cols }">
      <template v-for="l in levels" :key="'lv' + l">
        <span class="lpv-c lpv-name" :style="{ gridColumn: 'span ' + nRow }" :data-active="flag(names('columnName')[l - 1]?.active ?? false)" :title="names('columnName')[l - 1]?.text"><span class="lpv-t">{{ names('columnName')[l - 1]?.text }}</span><span v-for="n in names('columnName')[l - 1]?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
        <span v-for="(g, gi) in m.table.groups" :key="'g' + l + '-' + gi" class="lpv-c lpv-grp" :style="{ gridColumn: 'span ' + Math.max(1, nMeas) }" :data-active="flag(g.parts[l - 1]?.active ?? false)" :title="g.parts[l - 1]?.text"><span class="lpv-t">{{ g.parts[l - 1]?.text }}</span><span v-for="n in g.parts[l - 1]?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      </template>
      <span v-for="i in nRow" :key="'rn' + i" class="lpv-c lpv-name lpv-hd" :data-active="flag(names('rowName')[i - 1]?.active ?? false)" :title="names('rowName')[i - 1]?.text"><span class="lpv-t">{{ names('rowName')[i - 1]?.text }}</span><span v-for="n in names('rowName')[i - 1]?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      <template v-for="(g, gi) in groupsOrOne" :key="'mh' + gi">
        <span v-for="c in names('measureName')" :key="'m' + gi + '-' + c.index" class="lpv-c lpv-meas lpv-hd" :data-active="flag(c.active)" :title="c.text"><span class="lpv-t">{{ c.text }}</span><span v-for="n in (gi === 0 ? c.ns : undefined)" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      </template>
      <template v-for="(row, ri) in m.table.rows" :key="'row' + ri">
        <span v-for="(h, hi) in row.heads" :key="'h' + hi" class="lpv-c lpv-rh" :data-active="flag(h.active)" :title="h.text"><span class="lpv-t">{{ h.text }}</span><span v-for="n in h?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
        <span v-for="(c, ci) in row.cells" :key="ci" class="lpv-c lpv-num" :data-active="flag(c.active)"><span class="lpv-t">{{ c.text }}</span><span v-for="n in c?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      </template>
      <span class="lpv-c lpv-rh lpv-total" :style="{ gridColumn: 'span ' + nRow }" :data-active="flag(m.table.totals.label.active)" :title="m.table.totals.label.text"><span class="lpv-t">{{ m.table.totals.label.text }}</span><span v-for="n in m.table.totals.label?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      <span v-for="(c, ci) in m.table.totals.cells" :key="'t' + ci" class="lpv-c lpv-num lpv-total" :data-active="flag(c.active)"><span class="lpv-t">{{ c.text }}</span><span v-for="n in c?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
    </div>
    <div class="lpv-chart" data-test="lpv-chart">
      <div class="lpv-title" :data-active="flag(m.chart.title.active)" :title="m.chart.title.text"><span class="lpv-t">{{ m.chart.title.text }}</span><span v-for="n in m.chart.title?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></div>
      <div class="lpv-plot">
        <div class="lpv-y">
          <span v-for="(t, i) in m.chart.yTicks" :key="i" class="lpv-c lpv-tick" :data-active="flag(t.active)"><span class="lpv-t">{{ t.text }}</span></span>
        </div>
        <div class="lpv-bars"><i v-for="(t, i) in m.chart.ticks" :key="i" :style="{ height: 70 - i * 15 + '%' }" /></div>
      </div>
      <div class="lpv-x">
        <span v-for="(t, i) in m.chart.ticks" :key="i" class="lpv-c lpv-tick" :data-active="flag(t.active)" :title="t.text">{{ t.text }}</span>
      </div>
      <div class="lpv-x lpv-series">
        <span v-for="(t, i) in m.chart.series" :key="'s' + i" class="lpv-c" :data-active="flag(t.active)" :title="t.text">▪ {{ t.text }}</span>
      </div>
      <div class="lpv-axes">
        <span class="lpv-c" :data-active="flag(m.chart.axisX.active)" :title="m.chart.axisX.text"><span class="lpv-t">X: {{ m.chart.axisX.text }}</span><span v-for="n in m.chart.axisX?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
        <span class="lpv-c" :data-active="flag(m.chart.axisY.active)" :title="m.chart.axisY.text"><span class="lpv-t">Y: {{ m.chart.axisY.text }}</span><span v-for="n in m.chart.axisY?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
        <span class="lpv-c" :data-active="flag(m.chart.legend.active)" :title="m.chart.legend.text"><span class="lpv-t">▪ {{ m.chart.legend.text }}</span><span v-for="n in m.chart.legend?.ns" :key="n" class="lp-badge" aria-hidden="true">{{ n }}</span></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lpv { display: flex; flex-direction: column; gap: 10px; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 6px; font-size: 11px; line-height: 1.4; color: var(--color-foreground, #222); pointer-events: none; user-select: none; overflow: hidden }
.lpv-table, .lpv-chart { border: 1px solid var(--color-border, #8884); border-radius: 4px; padding: 6px; min-width: 0; background: var(--color-muted, #8881) }
.lpv-grid { display: grid; gap: 2px 4px; align-items: center }
.lpv-grp, .lpv-name, .lpv-hd { color: var(--color-muted-foreground, #777) }
.lpv-grp { text-align: center; border-bottom: 1px solid var(--color-border, #8884) }
.lpv-meas { text-align: right }
.lpv-total { border-top: 1px solid var(--color-border, #8884); font-weight: 600 }
.lpv-c { display: block; position: relative; min-width: 0; flex: 1 1 0; padding: 1px 3px; border-radius: 2px }
.lpv-t { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.lpv-num { text-align: right; font-variant-numeric: tabular-nums }
.lpv-title { position: relative; font-weight: 600; text-align: center; min-height: 1.4em; padding: 1px 3px; border-radius: 2px }
.lpv-plot { display: flex; gap: 4px; height: 56px; margin: 4px 0 }
.lpv-y { display: flex; flex-direction: column; justify-content: space-between; width: 30%; min-width: 0; text-align: right }
.lpv-bars { flex: 1; display: flex; align-items: flex-end; gap: 6px; border-left: 1px solid var(--color-border, #8884); border-bottom: 1px solid var(--color-border, #8884); padding: 0 4px }
.lpv-bars i { flex: 1; background: var(--color-primary, #2563eb); opacity: .55; border-radius: 2px 2px 0 0 }
.lpv-x { display: flex; gap: 6px; padding-left: calc(30% + 4px) }
.lpv-axes { display: flex; gap: 6px; margin-top: 4px; color: var(--color-muted-foreground, #777) }
.lpv-c:has(> .lp-badge), .lpv-title:has(> .lp-badge) { padding-inline-start: 19px }
.lpv-c:has(> .lp-badge + .lp-badge), .lpv-title:has(> .lp-badge + .lp-badge) { padding-inline-start: 36px }
.lp-badge { position: absolute; top: calc(50% - 7px); inset-inline-start: 2px; z-index: 1; box-sizing: border-box; min-width: 14px; height: 14px; padding: 0 3px; border: 1.5px solid var(--color-primary, #2563eb); border-radius: 7px; background: var(--color-background, #fff); color: var(--color-foreground, #222); font: 700 9px/11px system-ui, sans-serif; text-align: center; font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap }
.lp-badge + .lp-badge { inset-inline-start: 19px }
.lpv [data-active='true'] { outline: 2px solid var(--color-primary, #2563eb); outline-offset: 1px; text-decoration: underline; text-underline-offset: 2px }
</style>
