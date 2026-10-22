<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { StoreKey } from '../injection'
import { isValidVariableName } from '../state/inputVars'
import { t } from '../i18n'
import { useComposingDraft } from '../ui/composing'

const props = defineProps<{ blockId: string }>()
const store = inject(StoreKey)!

type Opt = string | number | boolean
const TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const meta = computed(() => (store.nb.value.blocks.find((b) => b.id === props.blockId)?.metadata ?? {}) as Record<string, any>)
const variable = computed(() => (typeof meta.value.variable === 'string' ? meta.value.variable : ''))
const inputType = computed<(typeof TYPES)[number]>(() => (TYPES as readonly string[]).includes(meta.value.inputType) ? meta.value.inputType : 'text')
const value = computed(() => meta.value.value)
const options = computed<Opt[]>(() => (Array.isArray(meta.value.options) ? meta.value.options : []))
const multiple = computed(() => meta.value.multiple === true)

const chipText = computed(() => `{{ ${variable.value} }}`)
const chipLabel = computed(() => t('in.copyChip', { ref: chipText.value }))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
function flashCopied() {
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))
const copyFailed = ref(false)
async function copyChip() {
  copyFailed.value = !(await doCopy())
  flashCopied()
}
async function doCopy(): Promise<boolean> {
  const txt = chipText.value
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); return true }
  } catch { /* fall through to execCommand */ }
  try {
    if (typeof document.execCommand === 'function') {
      const ta = document.createElement('textarea')
      ta.value = txt
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok === true
    }
  } catch { /* best effort */ }
  return false
}
const nameDraft = ref<string | null>(null)
const nameText = computed(() => nameDraft.value ?? variable.value)
const nameInvalid = computed(() => nameDraft.value !== null && !isValidVariableName(nameDraft.value))
const nameDup = computed(() => {
  const v = variable.value
  return v !== '' && store.nb.value.blocks.some((b) => b.id !== props.blockId && b.type === 'input' && b.metadata?.variable === v)
})
const cmp = useComposingDraft()
const typing = (e: Event) => { const on = cmp.composing.value || (e as InputEvent).isComposing === true; if (on) cmp.track(e); return on }
const onEnd = (fn: (e: Event) => void) => (e: Event) => { cmp.end(); fn(e) }
function onName(e: Event) {
  if (typing(e)) return
  const v = (e.target as HTMLInputElement).value
  if (isValidVariableName(v)) { nameDraft.value = null; store.updateMeta(props.blockId, { variable: v }, { coalesce: 'variable' }) }
  else nameDraft.value = v
}
function onNameBlur() { nameDraft.value = null }

function typeLabel(ty: (typeof TYPES)[number]) {
  return t(({ text: 'in.type.text', number: 'in.type.number', date: 'in.type.date', boolean: 'in.type.boolean', select: 'in.type.select' } as const)[ty])
}
function setValue(v: unknown, coalesce?: string) {
  if (v === undefined) store.removeMetaKey(props.blockId, 'value', { coalesce })
  else store.updateMeta(props.blockId, { value: v }, { coalesce })
}

function onType(e: Event) {
  const next = (e.target as HTMLSelectElement).value as (typeof TYPES)[number]
  const prev = inputType.value
  const cur = value.value
  store.editBlock(props.blockId, () => {
  store.updateMeta(props.blockId, { inputType: next })
  if (prev === 'select') { store.removeMetaKey(props.blockId, 'options'); store.removeMetaKey(props.blockId, 'multiple') }
  let nv: unknown
  if (next === 'select') { store.updateMeta(props.blockId, { options: [] }) }
  else if ((prev === 'text' || prev === 'number') && next === 'number') {
    const n = typeof cur === 'number' ? cur : typeof cur === 'string' && cur.trim() !== '' ? Number(cur) : NaN
    nv = Number.isFinite(n) ? n : undefined
  } else if (prev === 'number' && next === 'text') nv = typeof cur === 'number' ? String(cur) : undefined
  else if ((prev === 'text' || prev === 'date') && next === 'date') nv = typeof cur === 'string' && DATE_RE.test(cur) ? cur : undefined
  else if (prev === 'date' && next === 'text') nv = typeof cur === 'string' ? cur : undefined
  else if (prev === 'text' && next === 'text') nv = cur
  setValue(nv)
  })
}

function onDate(e: Event) {
  if (typing(e)) return
  const v = (e.target as HTMLInputElement).value
  setValue(DATE_RE.test(v) ? v : undefined, 'value')
}
function onText(e: Event) { if (typing(e)) return; setValue((e.target as HTMLInputElement).value, 'value') }
function onNumber(e: Event) {
  if (typing(e)) return
  const raw = (e.target as HTMLInputElement).value
  const n = raw.trim() === '' ? NaN : Number(raw)
  setValue(Number.isFinite(n) ? n : undefined, 'value')
}
function onBool(e: Event) { setValue((e.target as HTMLInputElement).checked) }

// A line becomes a number only if it round-trips exactly (so 007, 1.0, +1, .5, 1e3 and
// unsafe-large integers stay strings); only exact `true`/`false` become booleans.
// Quoting is not supported. Surrounding whitespace is trimmed; blank lines are ignored.
function parseOpt(raw: string): Opt {
  const line = raw.trim()
  const n = Number(line)
  if (line !== '' && Number.isFinite(n) && String(n) === line) return n
  if (line === 'true') return true
  if (line === 'false') return false
  return line
}
function parseLines(raw: string): Opt[] {
  return raw.split('\n').map((l) => l.trim()).filter((l) => l !== '').map(parseOpt)
}
function dedupe(list: Opt[]): Opt[] {
  const seen = new Set<string>()
  return list.filter((o) => { const k = `${typeof o}:${String(o)}`; if (seen.has(k)) return false; seen.add(k); return true })
}
const optText = ref(options.value.map(String).join('\n'))
const dupDropped = computed(() => { const all = parseLines(optText.value); return dedupe(all).length < all.length })
watch(() => JSON.stringify(options.value), () => {
  if (JSON.stringify(dedupe(parseLines(optText.value))) !== JSON.stringify(options.value)) optText.value = options.value.map(String).join('\n')
})
function onOptions(e: Event) {
  if (typing(e)) return
  const raw = (e.target as HTMLTextAreaElement).value
  optText.value = raw
  const next = dedupe(parseLines(raw))
  store.editBlock(props.blockId, () => {
    store.updateMeta(props.blockId, { options: next })
    const cur = value.value
    if (multiple.value) {
      if (Array.isArray(cur)) setValue(cur.filter((x) => next.includes(x)))
    } else if (cur !== undefined && !next.includes(cur)) setValue(undefined)
  }, { key: `${props.blockId}:options` })
}
function onMultiple(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const cur = value.value
  store.editBlock(props.blockId, () => {
    if (on) {
      store.updateMeta(props.blockId, { multiple: true })
      setValue(cur === undefined ? [] : Array.isArray(cur) ? cur : [cur])
    } else {
      store.removeMetaKey(props.blockId, 'multiple')
      setValue(Array.isArray(cur) ? cur[0] : cur)
    }
  })
}
function onSingle(e: Event) {
  const idx = (e.target as HTMLSelectElement).selectedIndex - 1
  setValue(idx < 0 ? undefined : options.value[idx])
}
const singleIdx = computed(() => options.value.findIndex((o) => o === value.value))
function checked(o: Opt) { return Array.isArray(value.value) && value.value.includes(o) }
function onCheck(o: Opt, e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const cur: Opt[] = Array.isArray(value.value) ? value.value : []
  const next = options.value.filter((x) => (x === o ? on : cur.includes(x)))
  setValue(next)
}
</script>

<template>
  <div class="in-block" data-test="input-block">
    <div class="in-head">
      <label class="in-namebox">
        <span class="in-label in-namelabel" data-test="var-label">{{ t('in.varName') }}</span>
        <input
          class="in-field in-name"
          data-test="var-name"
          type="text"
          spellcheck="false"
          :value="cmp.bound(nameText)"
          :aria-label="t('in.varName')"
          :aria-invalid="nameInvalid"
          :placeholder="t('in.varName')"
          @input="onName" @compositionstart="cmp.start($event)" @compositionend="onEnd(onName)($event)"
          @blur="onNameBlur"
        />
      </label>
      <select class="in-field" data-test="type" :value="inputType" :aria-label="t('in.type')" @change="onType">
        <option v-for="ty in TYPES" :key="ty" :value="ty">{{ typeLabel(ty) }}</option>
      </select>
      <code class="in-chip" data-test="chip" :data-empty="variable === '' ? 'true' : undefined" aria-hidden="true" @click="copyChip">{{ variable === '' ? t('in.chipEmpty') : chipText }}</code>
      <button type="button" class="in-copy" data-test="copy-var" :title="chipLabel" :aria-label="chipLabel" @click="copyChip"><span aria-hidden="true">⧉</span> {{ t('in.copyBtn') }}</button>
      <span class="in-copied" data-test="copied" role="status" aria-live="polite">{{ copied ? t(copyFailed ? 'in.copyFailed' : 'in.copied') : '' }}</span>
    </div>
    <div v-if="nameInvalid" class="in-msg in-error" data-test="var-error" role="alert">{{ t('in.varInvalid') }}</div>
    <div v-else-if="nameDup" class="in-msg in-warn" data-test="var-warning" role="status">{{ t('in.varDup') }}</div>
    <div class="in-body">
      <input v-if="inputType === 'text'" class="in-field in-value" data-test="value" type="text" :value="cmp.bound(typeof value === 'string' ? value : '')" :aria-label="t('in.value')" @input="onText" @compositionstart="cmp.start($event)" @compositionend="onEnd(onText)($event)" />
      <input v-else-if="inputType === 'number'" class="in-field in-value" data-test="value" type="number" step="any" :value="typeof value === 'number' ? value : ''" :aria-label="t('in.value')" @input="onNumber" @compositionstart="cmp.start($event)" @compositionend="onEnd(onNumber)($event)" />
      <input v-else-if="inputType === 'date'" class="in-field in-value" data-test="value" type="date" :value="typeof value === 'string' ? value : ''" :aria-label="t('in.value')" @input="onDate" @compositionstart="cmp.start($event)" @compositionend="onEnd(onDate)($event)" />
      <input v-else-if="inputType === 'boolean'" class="in-check" data-test="value" type="checkbox" :checked="value === true" :indeterminate.prop="typeof value !== 'boolean'" :aria-label="t('in.value')" @change="onBool" />
      <div v-else class="in-select">
        <label class="in-opts">
          <span class="in-label">{{ t('in.options') }}</span>
          <textarea class="in-field in-textarea" data-test="options" rows="4" spellcheck="false" :value="cmp.bound(optText)" :aria-label="t('in.options')" @input="onOptions" @compositionstart="cmp.start($event)" @compositionend="onEnd(onOptions)($event)" />
        </label>
        <div v-if="dupDropped" class="in-msg in-note" data-test="dup-note">{{ t('in.dupDropped') }}</div>
        <label class="in-mult"><input type="checkbox" data-test="multiple" :checked="multiple" @change="onMultiple" /> {{ t('in.multiple') }}</label>
        <div v-if="multiple" class="in-group" role="group" :aria-label="t('in.value')" data-test="value">
          <label v-for="(o, i) in options" :key="i" class="in-mult">
            <input type="checkbox" data-test="opt-check" :checked="checked(o)" @change="onCheck(o, $event)" /> {{ String(o) }}
          </label>
        </div>
        <select v-else class="in-field" data-test="value" :aria-label="t('in.value')" :value="singleIdx" @change="onSingle">
          <option :value="-1">{{ t('in.noValue') }}</option>
          <option v-for="(o, i) in options" :key="i" :value="i">{{ String(o) }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.in-block { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border: 1px solid var(--color-border, #ddd); border-radius: 4px; background: var(--color-muted, transparent); color: var(--color-foreground, inherit); }
.in-head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
.in-field { box-sizing: border-box; font: inherit; font-size: 13px; padding: 3px 6px; background: var(--color-background, #fff); color: var(--color-foreground, inherit); border: 1px solid var(--color-border, #ddd); border-radius: 3px; max-width: 100%; }
.in-field:focus-visible, .in-check:focus-visible { outline: 2px solid var(--color-primary, #2563eb); outline-offset: 1px; }
.in-name { width: 160px; font-family: ui-monospace, monospace; }
.in-name[aria-invalid="true"] { border-color: var(--color-destructive, #dc2626); }
.in-chip { font-family: ui-monospace, monospace; font-size: 12px; padding: 2px 6px; border-radius: 3px; background: var(--color-background, #fff); color: var(--color-foreground, inherit); border: 1px solid var(--color-muted-foreground, #71717a); border-color: color-mix(in srgb, var(--color-foreground, #000) 50%, var(--color-background, #fff)); user-select: all; }
.in-chip[data-empty='true'] { font-family: inherit; font-style: italic; border-style: dashed; color: var(--color-muted-foreground, #555); user-select: none; }
.in-namebox { display: flex; flex-direction: column; gap: 2px; }
.in-label.in-namelabel { font-weight: 600; color: var(--color-foreground, inherit); }
.in-copy { font: inherit; font-size: 12px; display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px; border-radius: 3px; cursor: pointer; background: transparent; color: var(--color-foreground, currentColor); border: 1px solid var(--color-muted-foreground, color-mix(in srgb, currentColor 55%, transparent)); }
.in-copy:hover { background: color-mix(in srgb, var(--color-foreground, currentColor) 12%, transparent); border-color: var(--color-foreground, currentColor); }
.in-copy:active { background: color-mix(in srgb, var(--color-foreground, currentColor) 22%, transparent); }
.in-copy:focus-visible, .in-chip:focus-visible { outline: 2px solid var(--color-primary, #2563eb); outline-offset: 1px; }
.in-copied { font-size: 12px; color: var(--color-foreground, inherit); min-width: 3em; }
.in-msg { font-size: 12px; }
.in-note { color: var(--color-muted-foreground, #777); }
.in-chip { cursor: pointer; display: inline-block; }
.in-error { color: var(--color-destructive, #dc2626); }
.in-warn { color: var(--color-muted-foreground, #777); font-style: italic; }
.in-body { min-width: 0; }
.in-value { width: 240px; }
.in-select { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.in-opts { display: flex; flex-direction: column; gap: 2px; max-width: 100%; }
.in-label { font-size: 12px; color: var(--color-muted-foreground, #777); }
.in-textarea { width: 240px; resize: vertical; font-family: ui-monospace, monospace; }
.in-mult { display: flex; align-items: center; gap: 4px; font-size: 13px; }
.in-group { display: flex; flex-wrap: wrap; gap: 4px 12px; }
</style>
