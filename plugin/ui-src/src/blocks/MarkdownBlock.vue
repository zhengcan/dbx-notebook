<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { t } from '../i18n'
import { createImeGuard } from '../ui/imeEnter'
import { installMarkdownCss } from '../ui/markdownCss'
import { isHistoryRestoring } from '../shell/historyActions'
import { useComposingDraft } from '../ui/composing'
import { NOTICE_MS, ERROR_NOTICE_MS } from '../ui/noticeTiming'
import { BridgeKey, DropCandidateKey, DropGateKey, DropTargetsKey, FileTransferKey, StoreKey } from '../injection'
import { sanitizeMarkdownHtml } from '../markdown/sanitize'
import { imageLinkText } from '../markdown/assetLinks'
import { pointOffset } from './textareaPoint'
import { alignDown, alignUp } from '../markdown/codePoint'
import { relocateRange } from '../markdown/anchor'
import { createImageResolver } from '../markdown/imageResolver'
import { createImageClient, ImageError } from '../files/imageClient'
import { applyMarkdownAction, changedSpan, type MdAction, type Placeholders } from '../markdown/toolbarActions'
import MarkdownToolbar from './MarkdownToolbar.vue'
import { isMacPlatform } from './mdPlatform'
import { inspectTransfer, inspectFiles, inspectHandles, fileSource, summaryOf, MAX_IMAGE_BYTES, type DropSummary, type ImageSource } from './mdImagePaste'
import { createFileTransferClient } from '../files/fileTransferClient'

installMarkdownCss()

const props = defineProps<{ modelValue: string; blockId?: string; toolbarImage?: () => void }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const md = new MarkdownIt({ html: false, linkify: true })
const bridge = inject(BridgeKey, null)
const store = inject(StoreKey, null)
const notebookPath = () => store?.path.value ?? null
const ftClient = inject(FileTransferKey, null) ?? createFileTransferClient()
const gate = inject(DropGateKey, null)
const targets = inject(DropTargetsKey, null)
const candidate = inject(DropCandidateKey, null)
const imageClient = bridge ? createImageClient(bridge) : null
const resolver = createImageResolver({ notebookPath, client: imageClient?.readImage, shared: bridge ?? undefined, epoch: () => store?.generation?.value ?? 0 })

const html = computed(() => sanitizeMarkdownHtml(md.render(props.modelValue ?? ''), { allowRelative: true }))
const isEmpty = computed(() => (props.modelValue ?? '').trim() === '')
const editing = ref(isEmpty.value)
const root = ref<HTMLElement | null>(null)
const ta = ref<HTMLTextAreaElement | null>(null)
const pv = ref<HTMLElement | null>(null)
let first = true
let restoreFocus = false

const MIN_EDIT_PX = 32
let startHeight: number | null = null
let gen = 0
let lastWidth = -1
let ro: ResizeObserver | null = null

function edit() {
  const h = pv.value?.getBoundingClientRect().height
  startHeight = typeof h === 'number' && h > 0 ? h : null
  editing.value = true
}
function leave() {
  editing.value = false
}
function borderY(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
}
function scrollSnapshot(el: HTMLElement): Array<[Element, number]> {
  const out: Array<[Element, number]> = []
  for (let n: Element | null = el.parentElement; n; n = n.parentElement) if (n.scrollTop) out.push([n, n.scrollTop])
  const root = document.scrollingElement
  if (root && root.scrollTop && !out.some(([n]) => n === root)) out.push([root, root.scrollTop])
  return out
}
function fit() {
  const el = ta.value
  if (!el) return
  // Collapsing to auto to measure can clamp scrollTop on a tall page; restore it once the final height is set.
  const saved = scrollSnapshot(el)
  el.style.height = 'auto'
  const h = el.scrollHeight + borderY(el)
  el.style.height = `${Math.max(MIN_EDIT_PX, startHeight ?? 0, h)}px`
  for (const [n, top] of saved) if (n.scrollTop !== top) n.scrollTop = top
}
function refit() {
  fit()
}
const cmp = useComposingDraft()
function onInput(e: Event) {
  if (cmp.composing.value || (e as InputEvent).isComposing) cmp.track(e)
  else emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  refit()
}
function onCompositionEnd(e: Event) {
  cmp.end()
  ime.onCompositionEnd()
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}
function stopWatching() {
  window.removeEventListener('resize', onResize)
  ro?.disconnect()
  ro = null
}
function onResize() {
  if (editing.value) refit()
}
function startWatching(g: number) {
  window.addEventListener('resize', onResize)
  const el = ta.value
  if (el && typeof ResizeObserver !== 'undefined') {
    lastWidth = el.clientWidth
    ro = new ResizeObserver(() => {
      const w = ta.value?.clientWidth ?? -1
      if (w !== lastWidth) { lastWidth = w; refit() }
    })
    ro.observe(el)
  }
  document.fonts?.ready?.then(() => { if (g === gen && editing.value) fit() })
}
watch(editing, async (v) => {
  const initial = first
  first = false
  const g = ++gen
  stopWatching()
  await nextTick()
  if (v && g === gen) {
    fit()
    startWatching(g)
    if (!isHistoryRestoring()) ta.value?.focus({ preventScroll: true })
  } else if (!v && !initial && restoreFocus) pv.value?.focus()
  restoreFocus = false
}, { immediate: true, flush: 'post' })
watch(() => props.modelValue, async (next, prev) => {
  if (!editing.value) return
  const restoring = isHistoryRestoring()
  await nextTick()
  refit()
  // Undo/redo replaces the whole value, which would otherwise leave the caret wherever the browser puts it.
  const el = ta.value
  if (restoring && el && el.value === next) { const to = changedSpan(prev ?? '', next).to; el.setSelectionRange(to, to) }
})
let unmounted = false
let unregister: (() => void) | null = null
if (targets && props.blockId) {
  const id = props.blockId
  unregister = targets.register({
    id,
    get el() { return root.value },
    isEditing: () => editing.value,
    insert(sources, o) {
      const el = ta.value
      if (editing.value && el) {
        const { base, range } = selNow(el)
        return enqueue(() => insertImages(sources, o.summary, base, range, { signal: o.signal, viaRecent: o.viaRecent, skipOversize: true }))
      }
      return enqueue(() => insertImages(sources, o.summary, props.modelValue ?? '', { from: 0, to: 0 }, { append: true, signal: o.signal, viaRecent: o.viaRecent, skipOversize: true }))
    },
  })
}
const touch = () => { if (targets && props.blockId) targets.touch(props.blockId) }
watch(editing, (v) => { if (v) touch() })
onBeforeUnmount(() => { unregister?.(); stopFallback(); fileInput = null })
onBeforeUnmount(() => { unmounted = true; resetDrag(); gen++; stopWatching(); resolver.dispose(); clearTimeout(noticeTimer) })
const pathKey = computed(() => notebookPath() ?? '')
watch([pv, html, pathKey, editing], async () => {
  await nextTick()
  if (!editing.value && !isEmpty.value && pv.value) void resolver.resolve(pv.value)
}, { flush: 'post', immediate: true })

const notice = ref<{ kind: 'error' | 'info'; text: string } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined
function say(kind: 'error' | 'info', text: string, bound = false) {
  if (unmounted) return
  notice.value = { kind, text }
  noticeRevision = bound ? store?.revision?.value ?? null : null
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = null }, kind === 'error' ? ERROR_NOTICE_MS : NOTICE_MS)
}
// A notice tied to an insert is only accurate while the document is as the insert left it: undo, redo or any other edit bumps the revision.
let noticeRevision: number | null = null
watch(() => store?.revision?.value, (rev) => {
  if (noticeRevision !== null && rev !== noticeRevision) { notice.value = null; noticeRevision = null; clearTimeout(noticeTimer) }
})
function errorText(e: unknown): string {
  const code = e instanceof ImageError ? e.code : ''
  if (code === 'needsSave') return t('mdimg.saveFirst')
  if (code === 'tooLarge') return t('mdimg.tooLarge')
  if (code === 'unsupported') return t('mdimg.unsupported')
  return t('mdimg.pasteFailed')
}

let queue: Promise<void> = Promise.resolve()
// Text put in front of an image link appended after existing content, so it starts a new paragraph. Blank content is replaced by the link instead (see insertImages).
function appendPrefix(cur: string): string {
  if (cur.trim() === '') return ''
  if (cur.endsWith('\n\n')) return ''
  return cur.endsWith('\n') ? '\n' : '\n\n'
}
interface InsertOpts { append?: boolean; signal?: AbortSignal; viaRecent?: boolean; skipOversize?: boolean }
async function insertImages(sources: ImageSource[], summary: DropSummary, base: string, start: { from: number; to: number }, o: InsertOpts = {}) {
  const append = !!o.append
  const path = notebookPath()
  if (!path) { say('error', t('mdimg.saveFirst')); return }
  const rels: string[] = []
  let oversize = 0
  let failed = 0
  const notices = () => {
    const msgs: string[] = []
    if (summary.unsupported > 0) msgs.push(t('mdimg.unsupportedSkipped', { n: summary.unsupported }))
    if (summary.ignored + failed > 0) msgs.push(t('mddrop.notImages', { n: summary.ignored + failed }))
    if (summary.truncated > 0) msgs.push(t('mdimg.tooMany', { n: summary.truncated }))
    if (summary.hostTruncated) msgs.push(t('mddrop.truncated'))
    if (oversize > 0) msgs.push(t('mdimg.tooLarge'))
    return msgs
  }
  const stop = () => unmounted || !!o.signal?.aborted
  try {
    if (!imageClient) throw new ImageError('readFailed')
    if (!o.skipOversize && sources.some((s) => s.size > MAX_IMAGE_BYTES)) throw new ImageError('tooLarge')
    for (const s of sources) {
      if (stop()) return
      if (s.size > MAX_IMAGE_BYTES) { oversize++; continue }
      let data: Awaited<ReturnType<ImageSource['read']>>
      try { data = await s.read(o.signal) } catch (e) {
        if (!o.skipOversize || stop() || (e as { name?: string })?.name === 'AbortError') throw e
        failed++
        continue
      }
      if (stop()) return
      rels.push((await imageClient.saveImage(path, data)).relPath)
    }
  } catch (e) {
    if (stop() || (e as { name?: string })?.name === 'AbortError') return
    say('error', errorText(e))
    return
  }
  if (rels.length === 0) {
    const msgs = notices()
    if (msgs.length > 0) say(oversize > 0 && msgs.length === 1 ? 'error' : 'info', msgs.join(' '))
    return
  }
  if (unmounted) return
  const cur = props.modelValue ?? ''
  const el0 = ta.value
  const at = append ? { from: cur.length, to: cur.length, exact: true } : relocateRange(base, start, cur, el0 && editing.value ? el0.selectionStart : undefined)
  const blank = append && cur.trim() === ''
  const range = blank ? { from: 0, to: cur.length } : { from: alignDown(cur, at.from), to: at.to <= at.from ? alignDown(cur, at.from) : alignUp(cur, at.to) }
  const id = props.blockId
  const prefix = append ? appendPrefix(cur) : ''
  let caret: number | null = null
  if (id && store && typeof store.insertMarkdownImages === 'function') caret = store.insertMarkdownImages(id, rels, range, prefix)
  else {
    const text = prefix + rels.map(imageLinkText).join('\n')
    emit('update:modelValue', cur.slice(0, range.from) + text + cur.slice(range.to))
    caret = range.from + text.length
  }
  if (caret === null) return
  for (const r of rels) resolver.invalidate(r)
  const msgs = notices()
  if (o.viaRecent) msgs.push(t('mddrop.addedTo'))
  if (!at.exact) msgs.push(t('mdimg.movedWhileSaving'))
  if (msgs.length > 0) say('info', msgs.join(' '), true)
  else notice.value = null
  const pos = caret
  await nextTick()
  const el = ta.value
  if (el && editing.value) {
    el.focus({ preventScroll: true })
    el.setSelectionRange(pos, pos)
    refit()
  }
}

function dropOffset(e: DragEvent): number | null {
  const el = ta.value
  if (!el) return null
  const d = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  try {
    const cp = d.caretPositionFromPoint?.(e.clientX, e.clientY)
    if (cp && cp.offsetNode === el) return Math.min(cp.offset, el.value.length)
    const r = d.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (r && r.startContainer === el) return Math.min(r.startOffset, el.value.length)
  } catch { /* fall through to the measured position */ }
  return pointOffset(el, e.clientX, e.clientY)
}

function handleTransfer(e: Event, dt: DataTransfer | null, kind: 'paste' | 'drop') {
  const el = ta.value
  if (cmp.composing.value || (e as InputEvent).isComposing) return
  if (!el && kind === 'paste') return
  const ins = inspectTransfer(dt, kind)
  if (!ins.claimed) return
  e.preventDefault()
  if (kind === 'drop' && gate && gate.claim('html5', ins.signature) === 'duplicate') return
  if (!notebookPath()) { say('error', t('mdimg.saveFirst')); return }
  const sources = ins.files.map(fileSource)
  const summary = summaryOf(ins)
  if (!el) {
    if (ins.files.length === 0) { say('info', t('mdimg.unsupportedSkipped', { n: ins.unsupported })); return }
    queue = queue.then(() => insertImages(sources, summary, props.modelValue ?? '', { from: 0, to: 0 }, { append: true })).catch(() => say('error', t('mdimg.pasteFailed')))
    return
  }
  let range = { from: el.selectionStart ?? el.value.length, to: el.selectionEnd ?? el.value.length }
  if (kind === 'drop' && e.target === el) {
    const off = dropOffset(e as DragEvent)
    if (off !== null) range = { from: off, to: off }
  }
  const base = el.value
  range = { from: alignDown(base, range.from), to: range.to <= range.from ? alignDown(base, range.from) : alignUp(base, range.to) }
  if (ins.files.length === 0) {
    say('info', t('mdimg.unsupportedSkipped', { n: ins.unsupported }))
    return
  }
  queue = queue.then(() => insertImages(sources, summary, base, range)).catch(() => say('error', t('mdimg.pasteFailed')))
}
const onPaste = (e: ClipboardEvent) => handleTransfer(e, e.clipboardData, 'paste')
const dragging = ref(false)
const isCandidate = computed(() => !!props.blockId && candidate?.value === props.blockId)
let dragDepth = 0
let dragWatchdog: ReturnType<typeof setTimeout> | undefined
const WATCHDOG_MS = 1000
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
function resetDrag() {
  dragDepth = 0
  dragging.value = false
  clearTimeout(dragWatchdog)
  window.removeEventListener('dragend', resetDrag)
  window.removeEventListener('drop', resetDrag)
  document.removeEventListener('dragleave', onDocLeave)
}
// Leaving the window (relatedTarget null and the pointer outside the viewport) never balances the enter counter.
function onDocLeave(e: DragEvent) {
  if (e.relatedTarget) return
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) resetDrag()
}
function showDrag() {
  if (!dragging.value) {
    dragging.value = true
    window.addEventListener('dragend', resetDrag)
    window.addEventListener('drop', resetDrag)
    document.addEventListener('dragleave', onDocLeave)
  }
  // dragover keeps firing while a drag is over us; if it stops (Esc, drag cancelled) the hint must not stay.
  clearTimeout(dragWatchdog)
  dragWatchdog = setTimeout(resetDrag, WATCHDOG_MS)
}
const onDrop = (e: DragEvent) => {
  resetDrag()
  // Any file drop is ours to swallow: an unhandled one would navigate the webview to the file.
  if (hasFiles(e)) e.preventDefault()
  if (modalOpen()) return
  handleTransfer(e, e.dataTransfer, 'drop')
}
// Highlight and 'copy' only when the drag could hold an image; known non-image files get a not-allowed cursor.
function acceptsDrag(e: DragEvent): boolean {
  const dt = e.dataTransfer
  if (!dt || cmp.composing.value) return false
  const items = Array.from(dt.items ?? [])
  return !(items.length > 0 && items.every((i) => i.kind === 'file' && i.type !== '' && !i.type.startsWith('image/')))
}
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (modalOpen()) return
  if (!acceptsDrag(e)) return
  dragDepth++
  showDrag()
}
function onDragLeave() {
  if (!dragging.value) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) resetDrag()
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  const ok = !modalOpen() && acceptsDrag(e)
  e.dataTransfer!.dropEffect = ok ? 'copy' : 'none'
  if (ok) showDrag()
}
// A blur caused by the window losing activation keeps the focused element as document.activeElement; a real
// click elsewhere has already moved it. Only the latter leaves edit mode.
function onBlur(e: FocusEvent) {
  cmp.end(); ime.onReset()
  if (picking || inToolbar(e.relatedTarget)) return
  if (!e.relatedTarget && !document.hasFocus() && document.activeElement === ta.value) return
  leave()
}

const tb = ref<InstanceType<typeof MarkdownToolbar> | null>(null)
const inToolbar = (n: EventTarget | null): boolean => { const r = tb.value?.root; return !!r && n instanceof Node && r.contains(n) }
// Focus leaving the toolbar for anywhere but the textarea (or the toolbar itself) leaves edit mode, like a textarea blur;
// a window deactivation has no relatedTarget and no document focus and keeps it.
function onToolbarFocusOut(e: FocusEvent) {
  const to = e.relatedTarget
  if (picking || inToolbar(to) || (to && to === ta.value)) return
  if (!to && !document.hasFocus()) return
  leave()
}
function focusTextarea() {
  const el = ta.value
  if (el) el.focus({ preventScroll: true })
}
const placeholders = (): Placeholders => ({
  bold: t('mdtb.ph.bold'), italic: t('mdtb.ph.italic'), code: t('mdtb.ph.code'), linkText: t('mdtb.ph.linkText'), linkUrl: t('mdtb.ph.linkUrl'),
  cell: t('mdtb.ph.cell'), col1: t('mdtb.ph.col1'), col2: t('mdtb.ph.col2'),
})
async function runAction(a: MdAction) {
  const el = ta.value
  if (!el || cmp.composing.value) return
  const before = el.value
  const r = applyMarkdownAction(before, { from: el.selectionStart ?? before.length, to: el.selectionEnd ?? before.length }, a, { placeholders: placeholders() })
  const id = props.blockId
  const viaStore = !!id && !!store && typeof store.replaceMarkdown === 'function'
  if (r.text !== before) {
    if (viaStore) store!.replaceMarkdown(id!, r.text)
    else emit('update:modelValue', r.text)
  }
  await nextTick()
  const cur = ta.value
  if (!cur || !editing.value) return
  // The block may have been removed (or the write refused): the old selection no longer applies to whatever is shown.
  if (viaStore && store!.nb.value.blocks.find((x) => x.id === id)?.content !== r.text) return
  cur.focus({ preventScroll: true })
  cur.setSelectionRange(r.from, r.to)
  refit()
}
let picking = false
const PICK_FALLBACK_MS = 300
let fileInput: HTMLInputElement | null = null
let stopFallback: () => void = () => {}
const selNow = (el: HTMLTextAreaElement) => {
  const base = el.value
  const from = el.selectionStart ?? base.length
  const to = el.selectionEnd ?? base.length
  return { base, range: { from: alignDown(base, from), to: to <= from ? alignDown(base, from) : alignUp(base, to) } }
}
function enqueue(fn: () => Promise<void>): Promise<void> {
  const p = queue.then(fn).catch(() => say('error', t('mdimg.pasteFailed')))
  queue = p
  return p
}
function endPick() {
  picking = false
  if (!unmounted && editing.value) focusTextarea()
}
async function pickImages() {
  const el = ta.value
  if (!el || picking || cmp.composing.value) return
  if (!notebookPath()) { say('error', t('mdimg.saveFirst')); return }
  const { base, range } = selNow(el)
  picking = true
  if (!ftClient.caps().pick) { pickWithInput(base, range); return }
  try {
    const handles = await ftClient.pick()
    if (!handles) return
    try {
      const { sources, summary } = inspectHandles(handles, false, ftClient)
      await enqueue(() => insertImages(sources, summary, base, range, { skipOversize: true }))
    } finally {
      await Promise.all(handles.map((h) => ftClient.release(h)))
    }
  } catch {
    say('error', t('mdimg.pasteFailed'))
  } finally {
    endPick()
  }
}
function pickWithInput(base: string, range: { from: number; to: number }) {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = 'image/png,image/jpeg,image/gif,image/webp'
  inp.multiple = true
  fileInput = inp
  // Some webviews never fire `cancel`: when the window regains focus without a `change`, give up on the picker.
  let timer: ReturnType<typeof setTimeout> | undefined
  const onFocus = () => {
    window.removeEventListener('focus', onFocus)
    timer = setTimeout(() => { stopFallback(); if (fileInput === inp) { fileInput = null; endPick() } }, PICK_FALLBACK_MS)
  }
  stopFallback = () => { window.removeEventListener('focus', onFocus); clearTimeout(timer); stopFallback = () => {} }
  window.addEventListener('focus', onFocus)
  inp.addEventListener('cancel', () => { stopFallback(); fileInput = null; endPick() })
  inp.addEventListener('change', () => {
    stopFallback()
    fileInput = null
    const list = Array.from(inp.files ?? [])
    if (list.length === 0) { endPick(); return }
    const ins = inspectFiles(list)
    void enqueue(() => insertImages(ins.files.map(fileSource), summaryOf(ins), base, range)).finally(endPick)
  })
  inp.click()
}
function onToolbarImage() { if (props.toolbarImage) props.toolbarImage(); else void pickImages() }
const SHORTCUTS: Record<string, MdAction> = { KeyB: 'bold', KeyI: 'italic', KeyK: 'link' }
function shortcutAction(e: KeyboardEvent): MdAction | null {
  const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.shiftKey || e.altKey) return null
  return SHORTCUTS[e.code] ?? null
}

const ime = createImeGuard()
function onKey(e: KeyboardEvent) {
  const sc = shortcutAction(e)
  if (sc) {
    if (e.isComposing || cmp.composing.value || e.keyCode === 229) return
    e.preventDefault(); e.stopPropagation()
    if (!e.repeat) void runAction(sc)
    return
  }
  if (e.key === 'Enter' && ime.isImeEnter(e)) return
  if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Escape') { e.preventDefault(); restoreFocus = true; leave() }
}
</script>

<template>
  <div ref="root" class="md-block" :class="{ 'md-drop': dragging || isCandidate }" :data-drop-candidate="isCandidate ? 'true' : undefined" @pointerenter="touch" @focusin="touch" @dragenter="onDragEnter" @dragleave="onDragLeave" @dragover="onDragOver" @drop="onDrop">
    <MarkdownToolbar v-if="editing" ref="tb" :composing="cmp.composing.value" @action="runAction" @image="onToolbarImage" @escape="focusTextarea" @focusout="onToolbarFocusOut" />
    <textarea
      v-if="editing"
      ref="ta"
      class="md-editor"
      rows="1"
      :value="cmp.bound(modelValue)"
      :placeholder="t('md.placeholder')"
      @input="onInput"
      @compositionstart="cmp.start($event); ime.onCompositionStart()"
      @compositionend="onCompositionEnd" @compositioncancel="cmp.end(); ime.onReset()"
      @blur="onBlur"
      @keydown="onKey"
      @paste="onPaste"
    />
    <div
      v-else-if="isEmpty"
      ref="pv"
      class="md-preview md-empty"
      role="button"
      tabindex="0"
      :aria-label="t('md.emptyHint')"
      @click="edit"
      @dblclick="edit"
      @keydown.enter="edit"
      @keydown.space.prevent="edit"
    >{{ t('md.emptyHint') }}</div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else :key="pathKey" ref="pv" class="md-preview md-view" tabindex="-1" @dblclick="edit" v-html="html" />
    <div v-if="notice" class="md-notice" :class="notice.kind" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</div>
  </div>
</template>

<style scoped>
.md-editor { display: block; border-radius: 0 0 4px 4px; width: 100%; box-sizing: border-box; margin: 0; font-family: inherit; font-size: 14px; line-height: 1.7; letter-spacing: normal; padding: 4px 6px; border: 1px solid var(--color-border, #ddd); overflow: hidden; resize: none; background: var(--color-background, #fff); color: var(--color-foreground, inherit); }
.md-editor:focus, .md-editor:focus-visible { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: -2px; box-shadow: none; }
.md-preview { box-sizing: border-box; padding: 4px 6px; border: 1px solid transparent; font-size: 14px; line-height: 1.7; min-height: 32px; color: var(--color-foreground, inherit); }
.md-drop { outline: 2px dashed var(--color-primary, #3b82f6); outline-offset: -2px; background: var(--color-muted, #f4f4f5); }
.md-notice { margin-top: 4px; padding: 4px 8px; font-size: 12px; line-height: 1.5; color: var(--color-foreground, inherit); background: var(--color-muted, #f4f4f5); border-left: 3px solid var(--color-border, #ddd); }
.md-notice.error { border-left-color: var(--color-destructive, #dc2626); }
.md-empty { cursor: text; color: var(--color-muted-foreground, #888); font-style: italic; }
</style>
