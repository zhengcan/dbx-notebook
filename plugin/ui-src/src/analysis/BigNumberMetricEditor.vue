<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue'
import { StoreKey } from '../injection'
import { t } from '../i18n'
import {
  BIG_AGGS, NUMERIC_ONLY_AGGS, FILTER_OPS, MAX_FILTERS, MAX_IN_VALUES, isKnownAggregate, isKnownOp, isKnownCompare,
  type Metric, type MetricFilter, type FilterValue,
} from './bigNumberConfig'

interface Col { name: string; kind: string }
const props = defineProps<{ blockId: string; index: number; metric: Metric; columns: Col[]; count: number; name: string }>()
const emit = defineEmits<{ remove: []; move: [delta: -1 | 1] }>()
const store = inject(StoreKey)!

const n = computed(() => props.index + 1)
const m = computed(() => props.metric)
const colByName = (name: string) => props.columns.find((c) => c.name === name)
const colOf = computed(() => colByName(m.value.field))
const aggOf = computed(() => m.value.aggregate ?? (m.value.field === '' ? 'count' : undefined))
const badAgg = computed(() => aggOf.value !== undefined && !isKnownAggregate(aggOf.value))
const effAgg = computed(() => aggOf.value ?? (colOf.value?.kind === 'number' ? 'sum' : 'count'))

const aggOptions = computed(() => {
  const a0 = aggOf.value
  const col = colOf.value
  const list: string[] = BIG_AGGS.filter((a) => a !== 'average' || a0 === 'average')
  if (badAgg.value) list.unshift(a0!)
  return list.map((a) => ({
    a,
    disabled: badAgg.value && a === a0 ? false
      : (a === 'distinct' && m.value.field === '') || (!!col && ((NUMERIC_ONLY_AGGS.includes(a) && col.kind !== 'number') || ((a === 'min' || a === 'max') && col.kind === 'boolean'))),
  }))
})

const on = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
function setFormat(kind: string, decimals: string) {
  const f: { kind: string; decimals?: number } = { kind }
  if (decimals !== '' && Number.isFinite(Number(decimals))) f.decimals = Number(decimals)
  store.setBigNumber(props.blockId, { index: props.index, format: f })
}

// ---- filters
const NO_VALUE = ['isNull', 'notNull']
const LIST = ['in', 'notIn']
function opsFor(kind: string | undefined): string[] {
  if (kind === 'boolean') return ['=', '!=', 'isNull', 'notNull']
  if (kind === 'text') return [...FILTER_OPS]
  return FILTER_OPS.filter((o) => o !== 'contains')
}
const stored = computed(() => m.value.filter ?? [])
const draft = ref<{ field: string; op: string; value: string } | null>(null)
const rowErr = ref<Record<number, string>>({})
const draftErr = ref<string | null>(null)
const group = ref<HTMLElement | null>(null)
const canAdd = computed(() => !draft.value && stored.value.length < MAX_FILTERS && props.columns.length > 0)

const atCap = computed(() => stored.value.length >= MAX_FILTERS)
const capId = computed(() => `bn-filter-max-${props.blockId}-${props.index}`)
const capMsg = computed(() => t('bn.filter.max', { max: MAX_FILTERS }))

const valueText = (v: MetricFilter['value']) => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))

function parseOne(text: string, kind: string | undefined): { v: FilterValue } | { err: string } {
  if (kind === 'number') {
    const x = Number(text)
    return text.trim() !== '' && Number.isFinite(x) ? { v: x } : { err: t('bn.filter.needNumber') }
  }
  if (kind === 'boolean') {
    const s = text.trim().toLowerCase()
    return s === 'true' || s === 'false' ? { v: s === 'true' } : { err: t('bn.filter.needBool') }
  }
  return { v: text.trim() }
}

function parseValue(op: string, kind: string | undefined, text: string): { value?: MetricFilter['value'] } | { err: string } {
  if (NO_VALUE.includes(op)) return {}
  if (LIST.includes(op)) {
    const parts = text.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (parts.length === 0) return { err: t('bn.filter.needValue') }
    if (parts.length > MAX_IN_VALUES) return { err: t('bn.filter.tooMany', { max: MAX_IN_VALUES }) }
    const out: FilterValue[] = []
    for (const p of parts) { const r = parseOne(p, kind); if ('err' in r) return r; out.push(r.v) }
    return { value: out }
  }
  if (text.trim() === '') return { err: t('bn.filter.needValue') }
  const r = parseOne(text, kind)
  return 'err' in r ? r : { value: r.v }
}

function build(base: MetricFilter | null, field: string, op: string, text: string): MetricFilter | { err: string } {
  const r = parseValue(op, colByName(field)?.kind, text)
  if ('err' in r) return r
  const f: MetricFilter = { ...(base ?? {}), field, op }
  if (r.value === undefined) delete f.value; else f.value = r.value
  return f
}

function writeFilters(list: MetricFilter[]) {
  store.setBigNumber(props.blockId, { index: props.index, filter: list })
}

function addRow() {
  draftErr.value = null
  draft.value = { field: props.columns[0].name, op: '=', value: '' }
}
function editDraft(patch: Partial<{ field: string; op: string; value: string }>, commit: boolean) {
  const d = draft.value
  if (!d) return
  Object.assign(d, patch)
  if (patch.field !== undefined && !opsFor(colByName(d.field)?.kind).includes(d.op)) d.op = '='
  if (!commit) return
  const f = build(null, d.field, d.op, d.value)
  if ('err' in f) { draftErr.value = f.err; return }
  draft.value = null
  draftErr.value = null
  writeFilters([...stored.value, f])
}
function editStored(i: number, patch: Partial<{ field: string; op: string; value: string }>) {
  const cur = stored.value[i]
  let field = patch.field ?? cur.field
  let op = patch.op ?? cur.op
  if (patch.field !== undefined && !opsFor(colByName(field)?.kind).includes(op)) op = '='
  const f = build(cur, field, op, patch.value ?? valueText(cur.value))
  if ('err' in f) {
    rowErr.value = { ...rowErr.value, [i]: f.err }
    return
  }
  const { [i]: _drop, ...rest } = rowErr.value
  rowErr.value = rest
  writeFilters(stored.value.map((x, k) => (k === i ? f : x)))
}

async function focusAfterRemove(i: number) {
  await nextTick()
  const rows = group.value?.querySelectorAll<HTMLElement>('[data-test=bn-filter-row]') ?? []
  const row = rows[i] ?? rows[i - 1]
  const target = row?.querySelector<HTMLElement>('[data-test=bn-filter-remove]') ?? group.value?.querySelector<HTMLElement>('[data-test=bn-filter-add]')
  target?.focus()
}
function removeStored(i: number) {
  rowErr.value = {}
  writeFilters(stored.value.filter((_, k) => k !== i))
  focusAfterRemove(i)
}
function removeDraft() {
  draft.value = null
  draftErr.value = null
  focusAfterRemove(stored.value.length)
}

const rowMsg = (k: number) => rowErr.value[k] ?? (isKnownOp(stored.value[k].op) ? null : t('bn.filter.badOp', { op: stored.value[k].op }))
const opLabel = (o: string) => (isKnownOp(o) ? t('bn.filter.op.' + o) : o)
const fieldOptions = (f: string) => (f && !colByName(f) ? [f] : [])

// ---- compare
const temporal = computed(() => props.columns.filter((c) => c.kind === 'temporal'))
const cmp = computed(() => m.value.compare)
const cmpErr = computed(() => (cmp.value && !isKnownCompare(cmp.value.kind) ? t('bn.cmp.badKind', { kind: cmp.value.kind }) : null))
function setKind(kind: string) {
  if (kind === 'none') { store.setBigNumber(props.blockId, { index: props.index, compare: null }); return }
  const date = cmp.value?.dateField || temporal.value[0]?.name
  if (!date) return
  store.setBigNumber(props.blockId, { index: props.index, compare: { ...(cmp.value ?? {}), kind, dateField: date } })
}
function setDate(dateField: string) {
  if (!cmp.value) return
  store.setBigNumber(props.blockId, { index: props.index, compare: { ...cmp.value, dateField } })
}
</script>

<template>
  <div class="bn-head bn-metric" :class="{ 'bn-sep': index > 0 }" role="group" :aria-label="t('bn.metric', { n, label: name })" data-test="bn-metric">
    <label class="bn-f">{{ t('bn.field') }}
      <select data-test="bn-field" :aria-label="t('bn.metricField', { n })" :value="m.field" @change="store.setBigNumber(blockId, { index, field: on($event) })">
        <option value="">{{ t('bn.rows') }}</option>
        <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        <option v-if="m.field && !colOf" :value="m.field">{{ m.field }}</option>
      </select>
    </label>
    <label class="bn-f">{{ t('bn.agg') }}
      <select data-test="bn-agg" :aria-label="t('bn.metricAgg', { n })" :value="effAgg" @change="store.setBigNumber(blockId, { index, aggregate: on($event) })">
        <option v-for="o in aggOptions" :key="o.a" :value="o.a" :disabled="o.disabled">{{ badAgg && o.a === aggOf ? o.a : t('bn.agg.' + o.a) }}</option>
      </select>
    </label>
    <label class="bn-f">{{ t('bn.label') }}
      <input type="text" data-test="bn-label" :aria-label="t('bn.metricLabel', { n })" maxlength="200" :value="m.label ?? ''" @change="store.setBigNumber(blockId, { index, label: on($event) })" />
    </label>
    <label class="bn-f">{{ t('bn.format') }}
      <select data-test="bn-format" :aria-label="t('bn.metricFormat', { n })" :value="m.format?.kind ?? 'plain'" @change="setFormat(on($event), m.format?.decimals?.toString() ?? '')">
        <option v-for="k in ['plain', 'thousands', 'percent']" :key="k" :value="k">{{ t('bn.fmt.' + k) }}</option>
      </select>
    </label>
    <label class="bn-f">{{ t('bn.decimals') }}
      <input type="number" min="0" max="6" data-test="bn-decimals" :aria-label="t('bn.metricDecimals', { n })" :value="m.format?.decimals ?? ''" @change="setFormat(m.format?.kind ?? 'plain', on($event))" />
    </label>

    <label class="bn-f">{{ t('bn.cmp.title') }}
      <select data-test="bn-compare-kind" :aria-label="t('bn.cmp.kindAria', { n })" :value="cmp?.kind ?? 'none'" :disabled="temporal.length === 0 && !cmp" @change="setKind(on($event))">
        <option value="none">{{ t('bn.cmp.none') }}</option>
        <option value="mom">{{ t('bn.cmp.mom') }}</option>
        <option value="yoy">{{ t('bn.cmp.yoy') }}</option>
        <option v-if="cmp && !isKnownCompare(cmp.kind)" :value="cmp.kind">{{ cmp.kind }}</option>
      </select>
    </label>
    <label v-if="cmp" class="bn-f">{{ t('bn.cmp.date') }}
      <select data-test="bn-compare-date" :aria-label="t('bn.cmp.dateAria', { n })" :value="cmp.dateField" @change="setDate(on($event))">
        <option v-for="c in temporal" :key="c.name" :value="c.name">{{ c.name }}</option>
        <option v-if="!temporal.some((c) => c.name === cmp!.dateField)" :value="cmp.dateField">{{ cmp.dateField }}</option>
      </select>
    </label>
    <span v-if="temporal.length === 0" class="bn-f" data-test="bn-compare-hint">{{ t('bn.cmp.noDate') }}</span>
    <button type="button" data-test="bn-up" :aria-label="t('bn.metricUp', { n })" :title="t('bn.metricUp', { n })" :disabled="index === 0" @click="emit('move', -1)">↑</button>
    <button type="button" data-test="bn-down" :aria-label="t('bn.metricDown', { n })" :title="t('bn.metricDown', { n })" :disabled="index === count - 1" @click="emit('move', 1)">↓</button>
    <button type="button" data-test="bn-remove" :aria-label="t('bn.removeMetric', { n, label: name })" :title="t('bn.removeMetric', { n, label: name })" :disabled="count <= 1" @click="emit('remove')">✕</button>

    <p v-if="cmpErr" class="bn-sub-err bn-full" data-test="bn-compare-error" role="status">{{ cmpErr }}</p>

    <div ref="group" class="bn-sub" data-test="bn-filter-group">
      <div class="bn-filter-head">
        <span>{{ t('bn.filter.header') }}</span>
        <button type="button" data-test="bn-filter-add" :disabled="!canAdd" :title="atCap ? capMsg : undefined" :aria-describedby="atCap ? capId : undefined" @click="addRow">{{ t('bn.filter.add') }}</button>
        <span v-if="atCap" :id="capId" class="sr-only" data-test="bn-filter-max">{{ capMsg }}</span>
      </div>
      <div v-for="(f, k) in stored" :key="k" class="bn-head bn-filter" role="group" :aria-label="t('bn.filter.row', { n, k: k + 1 })" data-test="bn-filter-row">
        <select data-test="bn-filter-field" :aria-label="t('bn.filter.field', { n, k: k + 1 })" :value="f.field" @change="editStored(k, { field: on($event) })">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
          <option v-for="x in fieldOptions(f.field)" :key="x" :value="x">{{ x }}</option>
        </select>
        <select data-test="bn-filter-op" :aria-label="t('bn.filter.op', { n, k: k + 1 })" :value="f.op" @change="editStored(k, { op: on($event) })">
          <option v-for="o in opsFor(colByName(f.field)?.kind)" :key="o" :value="o">{{ opLabel(o) }}</option>
          <option v-if="!opsFor(colByName(f.field)?.kind).includes(f.op)" :value="f.op">{{ opLabel(f.op) }}</option>
        </select>
        <input v-if="!NO_VALUE.includes(f.op)" type="text" data-test="bn-filter-value" :aria-label="t('bn.filter.value', { n, k: k + 1 })" :placeholder="LIST.includes(f.op) ? t('bn.filter.listHint') : ''" :value="valueText(f.value)" @change="editStored(k, { value: on($event) })" />
        <button type="button" data-test="bn-filter-remove" :aria-label="t('bn.filter.remove', { n, k: k + 1 })" :title="t('bn.filter.remove', { n, k: k + 1 })" @click="removeStored(k)">✕</button>
        <span v-if="rowMsg(k)" class="bn-sub-err" data-test="bn-filter-error" role="status">{{ rowMsg(k) }}</span>
      </div>
      <div v-if="draft" class="bn-head bn-filter" role="group" :aria-label="t('bn.filter.row', { n, k: stored.length + 1 })" data-test="bn-filter-row">
        <select data-test="bn-filter-field" :aria-label="t('bn.filter.field', { n, k: stored.length + 1 })" :value="draft.field" @change="editDraft({ field: on($event) }, false)">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
        <select data-test="bn-filter-op" :aria-label="t('bn.filter.op', { n, k: stored.length + 1 })" :value="draft.op" @change="editDraft({ op: on($event) }, NO_VALUE.includes(on($event)))">
          <option v-for="o in opsFor(colByName(draft.field)?.kind)" :key="o" :value="o">{{ opLabel(o) }}</option>
        </select>
        <input v-if="!NO_VALUE.includes(draft.op)" type="text" data-test="bn-filter-value" :aria-label="t('bn.filter.value', { n, k: stored.length + 1 })" :placeholder="LIST.includes(draft.op) ? t('bn.filter.listHint') : ''" :value="draft.value" @change="editDraft({ value: on($event) }, true)" />
        <button type="button" data-test="bn-filter-remove" :aria-label="t('bn.filter.remove', { n, k: stored.length + 1 })" :title="t('bn.filter.remove', { n, k: stored.length + 1 })" @click="removeDraft">✕</button>
        <span class="bn-sub-err" data-test="bn-filter-draft-hint" role="status">{{ t('bn.filter.draft') }}</span>
        <span v-if="draftErr" class="bn-sub-err" data-test="bn-filter-error" role="status">{{ draftErr }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bn-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.bn-f { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--color-muted-foreground, #777); }
.bn-metric { padding-left: 8px; border-left: 2px solid var(--color-border, #ccc); }
.bn-sub { flex-basis: 100%; font-size: 12px; color: var(--color-muted-foreground, #777); }
.bn-filter-head { display: flex; flex-wrap: nowrap; gap: 8px; align-items: center; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.bn-full { flex-basis: 100%; }
.bn-sep { border-top: 1px solid var(--color-border, #ccc); padding-top: 10px; margin-top: 4px; }
.bn-filter { margin: 2px 0; }
.bn-sub-err { margin: 2px 0; color: var(--color-destructive, #c00); user-select: text; }
</style>
