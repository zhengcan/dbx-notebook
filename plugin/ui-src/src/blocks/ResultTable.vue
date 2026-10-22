<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { QueryResult } from '../host/bridge'
import { currentLocale, t } from '../i18n'
import { cellKind, cellText } from './grid/format'
import { extendTo, move, normalize, selectAll, selectCell, selectColumn, selectRow, type Sel } from './grid/selection'
import { toTsv } from './grid/copy'
import { TRANSPOSE_MAX_ROWS } from './grid/transpose'
import { clampWidth, initialWidths, transposedColWidth } from './grid/columnWidths'

const ROW_H = 28
const OVERSCAN = 10
const props = withDefaults(defineProps<{ result: QueryResult; viewportHeight?: number; savedAt?: string; partial?: boolean; transposed?: boolean }>(), { viewportHeight: 320, transposed: undefined })
const emit = defineEmits<{ (e: 'visualize'): void; (e: 'update:transposed', v: boolean): void; (e: 'cell-detail', p: { row: number; col: number; value: unknown; column: string }): void }>()
const savedTime = computed(() => {
  const iso = props.savedAt ?? ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try { return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'medium' }).format(d) } catch { return iso }
})
const ROWNO_W = 48
const HEAD_H = 28

const scrollTop = ref(0)
const viewport = ref<HTMLElement | null>(null)
const sel = ref<Sel>(null)
const copyFailed = ref(false)
let failTimer: ReturnType<typeof setTimeout> | undefined
watch(sel, () => { copyFailed.value = false })
const localT = ref(false)
const transposed = computed(() => props.transposed ?? localT.value)
const canTranspose = computed(() => props.result.columns.length >= 1 && props.result.rows.length >= 1 && props.result.rows.length <= TRANSPOSE_MAX_ROWS)
const tOn = computed(() => transposed.value && canTranspose.value)
let otherSel: Sel = null
function flip() { const cur = sel.value; sel.value = otherSel; otherSel = cur; const v = !transposed.value; localT.value = v; emit('update:transposed', v) }
const TROWNO_MIN = 80
const TROWNO_MAX = 240
const rownoW = computed(() => {
  if (!tOn.value) return ROWNO_W
  const longest = props.result.columns.reduce((m, c) => Math.max(m, c.name.length), 0)
  return Math.min(TROWNO_MAX, Math.max(TROWNO_MIN, longest * 7 + 16))
})
const widths = ref<number[]>(initialWidths(props.result.columns, props.result.rows))
const tWidths = ref<number[]>([]) // user-resized widths; empty = automatic
const boxW = ref(0)
const autoTW = computed(() => transposedColWidth(boxW.value, rownoW.value, props.result.rows.length))
const initTWidths = () => props.result.rows.map(() => autoTW.value)
let ro: ResizeObserver | undefined
onMounted(() => {
  if (!viewport.value || typeof ResizeObserver === 'undefined') return
  boxW.value = viewport.value.clientWidth
  ro = new ResizeObserver((entries) => { boxW.value = entries[0]?.contentRect?.width ?? viewport.value?.clientWidth ?? 0 })
  ro.observe(viewport.value)
})
watch(() => props.result, () => {
  sel.value = null
  otherSel = null
  widths.value = initialWidths(props.result.columns, props.result.rows)
  tWidths.value = []
  scrollTop.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
})
const sortCol = ref(-1)
const sortDir = ref<'asc' | 'desc' | null>(null)

function cmp(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

const sorted = computed(() => {
  const rows = props.result.rows
  if (sortCol.value < 0 || !sortDir.value) return rows
  const c = sortCol.value
  const sign = sortDir.value === 'asc' ? 1 : -1
  return [...rows].sort((x, y) => {
    const a = x[c], b = y[c]
    const an = a === null || a === undefined, bn = b === null || b === undefined
    if (an || bn) return an === bn ? 0 : an ? 1 : -1
    return sign * cmp(a, b)
  })
})

const dRows = computed<unknown[][]>(() => (tOn.value ? props.result.columns.map((_, ci) => props.result.rows.map((row) => row[ci])) : sorted.value))
const dCols = computed(() => (tOn.value ? props.result.rows.map((_, i) => ({ name: `#${i + 1}`, dataType: undefined as string | undefined })) : props.result.columns))
const dWidths = computed(() => (tOn.value ? (tWidths.value.length === dCols.value.length ? tWidths.value : initTWidths()) : widths.value))
const rowLabel = (i: number) => (tOn.value ? props.result.columns[i]?.name : String(i + 1))
const rowTitle = (i: number) => { const c = props.result.columns[i]; return c ? (c.dataType ? `${c.name} (${c.dataType})` : c.name) : undefined }

const effTop = computed(() => tOn.value ? 0 : Math.min(scrollTop.value, Math.max(0, dRows.value.length * ROW_H - props.viewportHeight)))
const start = computed(() => Math.max(0, Math.floor(effTop.value / ROW_H) - OVERSCAN))
const end = computed(() => tOn.value ? dRows.value.length : Math.min(dRows.value.length, Math.ceil((effTop.value + props.viewportHeight) / ROW_H) + OVERSCAN))
const visible = computed(() => dRows.value.slice(start.value, end.value).map((row, i) => ({ row, idx: start.value + i, txt: dCols.value.map((_, c) => cellText(row[c])) })))

let sortSnap = { col: -1, dir: null as 'asc' | 'desc' | null }
function onHeadClick(e: MouseEvent, i: number) {
  if (tOn.value) return
  if (e.detail <= 1) sortSnap = { col: sortCol.value, dir: sortDir.value }
  toggle(i)
}
function onHeadDbl(i: number) {
  if (tOn.value) { sel.value = selectColumn(i, dRows.value.length); return }
  sortCol.value = sortSnap.col
  sortDir.value = sortSnap.dir
  sel.value = selectColumn(i, sorted.value.length)
}
function toggle(i: number) {
  if (tOn.value) return
  sel.value = null
  if (sortCol.value !== i) { sortCol.value = i; sortDir.value = 'asc' }
  else if (sortDir.value === 'asc') sortDir.value = 'desc'
  else if (sortDir.value === 'desc') { sortDir.value = null; sortCol.value = -1 }
  else sortDir.value = 'asc'
}
const arrow = (i: number) => (tOn.value ? '' : sortCol.value === i ? (sortDir.value === 'asc' ? ' ▲' : ' ▼') : '')
const ariaSort = (i: number) => (tOn.value ? undefined : sortCol.value === i ? (sortDir.value === 'asc' ? 'ascending' : 'descending') : 'none')
const isNull = (v: unknown) => v === null || v === undefined
const nCols = computed(() => dCols.value.length)
const numCols = computed(() => tOn.value ? [] : props.result.columns.map((_, c) => {
  let n = 0, tot = 0
  for (const row of props.result.rows.slice(0, 50)) { tot++; if (cellKind(row[c]) === 'number') n++ }
  return tot > 0 && n * 2 > tot
}))
const tableWidth = computed(() => rownoW.value + dWidths.value.reduce((a, b) => a + b, 0))
const norm = computed(() => normalize(sel.value))
const inSel = (r: number, c: number) => { const n = norm.value; return !!n && r >= n.r0 && r <= n.r1 && c >= n.c0 && c <= n.c1 }
const selLabel = computed(() => { const n = norm.value; return n ? t('result.selected', { r: n.r1 - n.r0 + 1, c: n.c1 - n.c0 + 1 }) : '' })
const cls = (v: unknown, txt: string, r: number, c: number) => ({
  'cell-null': isNull(v), num: (tOn.value ? cellKind(v) === 'number' : numCols.value[c]) && !isNull(v), bool: typeof v === 'boolean',
  'cell-empty': v === '', selected: inSel(r, c), odd: r % 2 === 1, long: cellKind(v) === 'json' || txt.length > 200 || txt.includes('\n'),
})

let dragging = false
const endDrag = () => { dragging = false }
function onCellDown(e: MouseEvent, r: number, c: number) {
  if (e.button !== 0) return
  sel.value = e.shiftKey ? extendTo(sel.value, r, c) : selectCell(r, c)
  dragging = true
  window.addEventListener('mouseup', endDrag, { once: true })
}
function onCellEnter(r: number, c: number) { if (dragging) sel.value = extendTo(sel.value, r, c) }
function onRowDown(r: number) { viewport.value?.focus(); sel.value = selectRow(r, nCols.value) }
function detail(r: number, c: number) {
  if (tOn.value) emit('cell-detail', { row: c, col: r, value: props.result.rows[c]?.[r], column: props.result.columns[r]?.name })
  else emit('cell-detail', { row: r, col: c, value: sorted.value[r]?.[c], column: props.result.columns[c]?.name })
}

function reveal(r: number) {
  const el = viewport.value
  if (!el) return
  const top = r * ROW_H
  let st = el.scrollTop
  if (top < st) st = top
  else if (top + ROW_H > st + props.viewportHeight - HEAD_H) st = top + ROW_H - props.viewportHeight + HEAD_H
  if (st !== el.scrollTop) { el.scrollTop = st; scrollTop.value = st }
}

async function writeClipboard(txt: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); return }
  } catch { /* fall through */ }
  let ok = false
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
  if (!ok) {
    copyFailed.value = true
    clearTimeout(failTimer)
    failTimer = setTimeout(() => { copyFailed.value = false }, 2000)
  }
}

function copySelection(withHeader: boolean) {
  if (!sel.value) return
  const header = withHeader ? dCols.value.map((c) => c.name) : undefined
  void writeClipboard(toTsv(dRows.value, sel.value, header ? { withHeader: header, ...(tOn.value ? { rowLabels: props.result.columns.map((c) => c.name) } : {}) } : undefined))
}

const menu = ref<{ x: number; y: number } | null>(null)
const menuEl = ref<HTMLElement | null>(null)
function closeMenu() {
  if (!menu.value) return
  menu.value = null
  window.removeEventListener('keydown', onMenuKey, true)
  window.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('scroll', closeMenu, true)
  window.removeEventListener('blur', closeMenu)
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); viewport.value?.focus(); return }
  const items = [...(menuEl.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
}
function onOutside(e: MouseEvent) { if (!menuEl.value?.contains(e.target as Node)) closeMenu() }
async function onCellContext(e: MouseEvent, r: number, c: number) {
  e.preventDefault()
  if (!inSel(r, c)) sel.value = selectCell(r, c)
  closeMenu()
  menu.value = { x: e.clientX, y: e.clientY }
  window.addEventListener('keydown', onMenuKey, true)
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('scroll', closeMenu, true)
  window.addEventListener('blur', closeMenu)
  await nextTick()
  const el = menuEl.value
  if (el && menu.value) {
    const w = el.offsetWidth || 160, h = el.offsetHeight || 64
    menu.value = { x: Math.max(4, Math.min(menu.value.x, window.innerWidth - w - 4)), y: Math.max(4, Math.min(menu.value.y, window.innerHeight - h - 4)) }
  }
  el?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
}
function menuCopy(withHeader: boolean) { closeMenu(); copySelection(withHeader); viewport.value?.focus() }

function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.target !== e.currentTarget) return
  const mod = e.ctrlKey || e.metaKey
  const k = e.key
  const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
  if (arrows[k]) {
    e.preventDefault()
    const next = move(sel.value, arrows[k][0], arrows[k][1], dRows.value.length, nCols.value, e.shiftKey)
    sel.value = next
    if (next) reveal(next.r1)
  } else if (mod && k.toLowerCase() === 'a') {
    e.preventDefault()
    sel.value = selectAll(dRows.value.length, nCols.value)
  } else if (mod && k.toLowerCase() === 'c') {
    if (!sel.value) return
    e.preventDefault()
    copySelection(e.shiftKey)
  } else if (k === 'Escape') {
    sel.value = null
  } else if (k === ' ' && sel.value) {
    e.preventDefault()
    detail(sel.value.r1, sel.value.c1)
  }
}

let resizing: { c: number; x: number; w: number } | null = null
function onMove(e: MouseEvent) {
  if (!resizing) return
  const nw = (ws: number[]) => ws.map((w, i) => (i === resizing!.c ? clampWidth(resizing!.w + e.clientX - resizing!.x) : w))
  if (tOn.value) tWidths.value = nw(dWidths.value)
  else widths.value = nw(widths.value)
}
function onUp() {
  resizing = null
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
}
function startResize(e: MouseEvent, c: number) {
  resizing = { c, x: e.clientX, w: dWidths.value[c] }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
function resetWidth(c: number) {
  if (tOn.value) { tWidths.value = dWidths.value.map((w, i) => (i === c ? autoTW.value : w)); return }
  const init = initialWidths(props.result.columns, props.result.rows)
  widths.value = widths.value.map((w, i) => (i === c ? init[c] : w))
}
onBeforeUnmount(() => { ro?.disconnect(); closeMenu(); onUp(); window.removeEventListener('mouseup', endDrag); clearTimeout(failTimer) })
</script>

<template>
  <div class="result-table">
    <div v-if="savedAt" class="saved-label" data-test="saved-label">{{ t('out.saved', { time: savedTime }) }}</div>
    <div v-if="partial" class="banner" data-test="partial-banner">{{ t('result.partial') }}</div>
    <div v-if="result.truncated" class="banner">{{ t('result.truncated') }}</div>
    <div class="meta"><button v-if="canTranspose" type="button" class="viz-btn" data-test="transpose" :aria-pressed="tOn ? 'true' : 'false'" :aria-label="t('result.transposeAria')" @click="flip">{{ t('result.transpose') }}</button> <button type="button" class="viz-btn" data-test="visualize" :disabled="!result.columns.length" :aria-label="t('result.visualize')" @click="emit('visualize')">{{ t('result.visualize') }}</button> {{ t('result.rows', { n: result.rows.length }) }} · {{ t('result.elapsed', { ms: result.elapsedMs }) }}<template v-if="selLabel"> · {{ selLabel }}</template><template v-if="copyFailed"> · <span class="copy-failed">{{ t('result.copyFailed') }}</span></template></div>
    <div v-if="!result.rows.length" class="empty">{{ t('result.empty') }}</div>
    <div class="vp-wrap"><div ref="viewport" class="viewport" :class="{ transposed: tOn }" role="grid" :aria-rowcount="dRows.length + 1" :aria-colcount="nCols + 1" tabindex="0" :style="tOn ? undefined : { maxHeight: viewportHeight + 'px' }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop" @keydown="onKey">
      <table :style="{ width: tableWidth + 'px' }">
        <colgroup>
          <col :style="{ width: rownoW + 'px' }" />
          <col v-for="(_, i) in dCols" :key="i" :style="{ width: (dWidths[i] ?? 80) + 'px' }" />
        </colgroup>
        <thead>
          <tr>
            <th class="rowno" scope="col" aria-colindex="1" :title="t('result.rowNo')">#</th>
            <th v-for="(c, i) in dCols" :key="i" scope="col" tabindex="0" :aria-colindex="i + 2" :aria-sort="ariaSort(i)" :title="c.dataType" :class="{ nosort: tOn }" @click="onHeadClick($event, i)" @dblclick="onHeadDbl(i)" @keydown.enter.prevent="toggle(i)" @keydown.space.prevent="toggle(i)">{{ c.name }}{{ arrow(i) }}<span class="resize" @mousedown.stop.prevent="startResize($event, i)" @click.stop @dblclick.stop="resetWidth(i)" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="start > 0" class="spacer" aria-hidden="true" :style="{ height: start * ROW_H + 'px' }"><td :colspan="nCols + 1" /></tr>
          <tr v-for="v in visible" :key="v.idx" data-row role="row" :aria-rowindex="v.idx + 2" :class="{ odd: v.idx % 2 === 1 }" :style="{ height: ROW_H + 'px' }">
            <td class="rowno" :title="tOn ? rowTitle(v.idx) : undefined" @mousedown.prevent="onRowDown(v.idx)">{{ rowLabel(v.idx) }}</td>
            <td v-for="(_, ci) in dCols" :key="ci" data-c role="gridcell" :aria-colindex="ci + 2" :aria-selected="inSel(v.idx, ci)" :class="cls(v.row[ci], v.txt[ci], v.idx, ci)" :title="isNull(v.row[ci]) ? undefined : v.txt[ci]" @mousedown="onCellDown($event, v.idx, ci)" @mouseenter="onCellEnter(v.idx, ci)" @contextmenu="onCellContext($event, v.idx, ci)" @dblclick="detail(v.idx, ci)">{{ isNull(v.row[ci]) ? 'NULL' : v.txt[ci] }}<span v-if="cls(v.row[ci], v.txt[ci], v.idx, ci).long" class="expand" :title="t('result.expand')">⤢</span></td>
          </tr>
          <tr v-if="end < dRows.length" class="spacer" aria-hidden="true" :style="{ height: (dRows.length - end) * ROW_H + 'px' }"><td :colspan="nCols + 1" /></tr>
        </tbody>
      </table>
    </div></div>
    <div v-if="menu" ref="menuEl" class="ctx-menu" role="menu" :aria-label="t('result.ctxMenu')" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button type="button" role="menuitem" data-test="ctx-copy" @click="menuCopy(false)">{{ t('result.ctxCopy') }}</button>
      <button type="button" role="menuitem" data-test="ctx-copy-header" @click="menuCopy(true)">{{ t('result.ctxCopyHeader') }}</button>
    </div>
  </div>
</template>

<style scoped>
.banner { padding: 4px 8px; background: color-mix(in srgb, #f59e0b 22%, var(--color-background, #fff)); color: var(--color-foreground, #111); font-size: 12px; }
.saved-label { padding: 2px 8px; font-size: 12px; color: var(--color-muted-foreground, #888); }
.meta { padding: 2px 8px; font-size: 12px; color: var(--color-muted-foreground, #888); }
.empty { padding: 8px; font-size: 12px; color: var(--color-muted-foreground, #888); }
.vp-wrap { border: 1px solid var(--color-border, #ddd); }
.viewport { overflow: auto; outline: none; isolation: isolate; }
.viewport:focus, .viewport:focus-visible { outline: 2px solid var(--color-primary, #4a90d9); outline-offset: -2px; }
.copy-failed { color: var(--color-muted-foreground, #888); }
table { border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 12px; }
th { position: sticky; top: 0; z-index: 2; background: var(--color-muted, #f5f5f5); color: var(--color-foreground, inherit); cursor: pointer; user-select: none; text-align: left; padding: 0 8px; height: 28px; border-bottom: 1px solid var(--color-border, #ddd); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
th.nosort { cursor: default; }
th .resize { position: absolute; right: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; }
th .resize:hover { background: var(--color-primary, #4a90d9); }
td { position: relative; padding: 0 8px; box-sizing: border-box; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--color-border, #eee); color: var(--color-foreground, inherit); user-select: none; }
td.rowno, th.rowno { text-align: right; color: var(--color-muted-foreground, #999); cursor: default; padding: 0 6px; }
th.rowno { position: sticky; left: 0; top: 0; z-index: 4; background: var(--color-muted, #f5f5f5); border-right: 1px solid var(--color-border, #ddd); }
td.rowno { position: sticky; left: 0; z-index: 1; background-color: var(--color-background, #fff); border-right: 1px solid var(--color-border, #ddd); }
tbody tr.odd { background: color-mix(in srgb, var(--color-muted, #f5f5f5) 50%, transparent); }
tbody tr.odd td.rowno { background-image: linear-gradient(color-mix(in srgb, var(--color-muted, #f5f5f5) 50%, transparent), color-mix(in srgb, var(--color-muted, #f5f5f5) 50%, transparent)); }
tbody tr[data-row]:hover { background: color-mix(in srgb, var(--color-foreground, #111) 6%, var(--color-background, #fff)); color: var(--color-foreground, inherit); }
tbody tr[data-row]:hover td:not(.rowno):not(.cell-null):not(.bool) { color: var(--color-foreground, inherit); }
tbody tr[data-row]:hover td.rowno { background-image: linear-gradient(color-mix(in srgb, var(--color-foreground, #111) 6%, var(--color-background, #fff)), color-mix(in srgb, var(--color-foreground, #111) 6%, var(--color-background, #fff))); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.transposed td.num { text-align: left; }
td.bool { color: var(--color-primary, #4a90d9); }
td.cell-null { color: var(--color-muted-foreground, #999); font-style: italic; }
td.selected { background: color-mix(in srgb, var(--color-primary, #4a90d9) 24%, var(--color-background, #fff)); color: var(--color-foreground, inherit); box-shadow: inset 0 0 0 1px var(--color-primary, #4a90d9); }
td .expand { position: absolute; right: 2px; top: 0; font-size: 10px; color: var(--color-muted-foreground, #999); background: inherit; }
.ctx-menu { position: fixed; z-index: 1000; min-width: 140px; padding: 4px; display: flex; flex-direction: column; background: var(--color-background, #fff); color: var(--color-foreground, #111); border: 1px solid var(--color-border, #ddd); border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); font-size: 12px; }
.ctx-menu button { all: unset; box-sizing: border-box; padding: 5px 10px; border-radius: 4px; cursor: pointer; color: var(--color-foreground, #111); white-space: nowrap; }
.ctx-menu button:hover, .ctx-menu button:focus-visible { background: color-mix(in srgb, var(--color-foreground, #111) 12%, transparent); outline: none; }
tr.spacer td { padding: 0; border: 0; }
</style>
