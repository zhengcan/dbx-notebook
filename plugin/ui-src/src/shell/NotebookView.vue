<script setup lang="ts">
import { computed, inject, onBeforeUnmount, provide, ref, watch } from 'vue'
import MarkdownBlock from '../blocks/MarkdownBlock.vue'
import InputBlock from '../blocks/InputBlock.vue'
import SqlBlock from '../blocks/SqlBlock.vue'
import AnalysisBlock from '../analysis/AnalysisBlock.vue'
import BigNumberBlock from '../analysis/BigNumberBlock.vue'
import UnsupportedBlock from '../blocks/UnsupportedBlock.vue'
import AppliedBar from '../ai/AppliedBar.vue'
import { NOTICE_MS } from '../ui/noticeTiming'
import UndoConflictNotice from '../ai/UndoConflictNotice.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { ConnectionsKey, DropCandidateKey, DropGateKey, DropTargetsKey, FileTransferKey, SelectedKey, StoreKey } from '../injection'
import { createFileTransferClient } from '../files/fileTransferClient'
import { createDropGate } from '../blocks/dropGate'
import { createDropTargets } from '../blocks/mdDropTargets'
import { useDesktopDrop } from '../blocks/useDesktopDrop'
import { missingConnections } from '../connections/missing'
import { t } from '../i18n'
import type { SqlEditorHandle, SqlEditorOpts } from '../editor/sqlEditor'

defineProps<{ editorFactory?: (parent: HTMLElement, opts: SqlEditorOpts) => SqlEditorHandle }>()
const store = inject(StoreKey)!
const selected = inject(SelectedKey, ref<string | null>(null))
const connections = inject(ConnectionsKey, null)
const missingNames = computed(() => (connections ? missingConnections(connections, store.nb.value).names : []))
const pendingDelete = ref<string | null>(null)

const injectedClient = inject(FileTransferKey, null)
const ftClient = injectedClient ?? createFileTransferClient()
const dropTargets = createDropTargets()
const dropGate = createDropGate()
const dropNotice = ref('')
let dropNoticeTimer: ReturnType<typeof setTimeout> | undefined
const desktopDrop = useDesktopDrop({
  client: ftClient,
  targets: dropTargets,
  gate: dropGate,
  ready: injectedClient ? undefined : () => {
    const h = typeof window !== 'undefined' ? (window as any).dbxPlugin : undefined
    return h ? h.ready : null
  },
  say: (_kind, text) => { dropNotice.value = text; clearTimeout(dropNoticeTimer); dropNoticeTimer = setTimeout(() => { dropNotice.value = '' }, NOTICE_MS) },
})
provide(FileTransferKey, ftClient)
provide(DropGateKey, dropGate)
provide(DropTargetsKey, dropTargets)
provide(DropCandidateKey, desktopDrop.candidateId)
onBeforeUnmount(() => { desktopDrop.dispose(); clearTimeout(dropNoticeTimer) })

// A block can vanish through undo/redo or delete: drop references to it instead of acting on a stale id.
watch(() => store.nb.value.blocks.map((b) => b.id), (idsNow) => {
  if (selected.value && !idsNow.includes(selected.value)) selected.value = null
  if (pendingDelete.value && !idsNow.includes(pendingDelete.value)) pendingDelete.value = null
}, { flush: 'sync' })

function select(id: string) { selected.value = id }
function remove(id: string) {
  const b = store.nb.value.blocks.find((x) => x.id === id)
  if (b && (b.content ?? '') !== '') pendingDelete.value = id
  else doRemove(id)
}
function doRemove(id: string) {
  store.removeBlock(id)
  if (selected.value === id) selected.value = null
}
function onChoose(choice: string) {
  const id = pendingDelete.value
  pendingDelete.value = null
  if (choice === 'delete' && id) doRemove(id)
}
function onEnterSeal(e: KeyboardEvent) { if ((e.target as HTMLElement)?.tagName === 'INPUT') store.sealHistory() }
</script>

<template>
  <div class="nv" data-test="notebook-view" tabindex="-1">
    <UndoConflictNotice />
    <div v-if="desktopDrop.hint.value" class="nv-drop-hint" data-test="drop-hint" role="status">{{ t('mddrop.hint') }}</div>
    <div v-if="dropNotice" class="nv-drop-notice" data-test="drop-notice" role="status">{{ dropNotice }}</div>
    <div v-if="missingNames.length" class="nv-missing" data-test="notebook-conn-missing" role="status">
      ⚠ {{ t('conn.missingNotebook', { names: missingNames.join(', ') }) }}
    </div>
    <div v-if="!store.nb.value.blocks.length" class="nv-empty" data-test="empty">
      <p>{{ t('nb.empty') }}</p>
      <button type="button" data-test="empty-add-md" @click="store.addBlock('markdown', null)">{{ t('nb.addMarkdown') }}</button>
      <button type="button" data-test="empty-add-sql" @click="store.addBlock('sql', null)">{{ t('nb.addSql') }}</button>
      <button type="button" data-test="empty-add-results" @click="store.addBlock('results', null)">{{ t('nb.addResults') }}</button>
      <button type="button" data-test="empty-add-input" @click="store.addBlock('input', null)">{{ t('nb.addInput') }}</button>
      <button type="button" data-test="empty-add-chart" @click="store.addBlock('chart', null)">{{ t('nb.addChart') }}</button>
      <button type="button" data-test="empty-add-big-number" @click="store.addBlock('big-number', null)">{{ t('nb.addBigNumber') }}</button>
    </div>
    <template v-for="(block, i) in store.nb.value.blocks" :key="block.id">
      <div class="nv-block" :class="{ selected: selected === block.id }" data-test="block" :data-block-id="block.id" @focusin="select(block.id)" @mousedown="select(block.id)" @focusout="store.sealHistory()" @keydown.enter="onEnterSeal">
        <div class="nv-controls" data-test="controls">
          <button type="button" data-test="up" :title="t('blk.up')" :aria-label="t('blk.up')" :disabled="i === 0" @click="store.moveBlock(block.id, -1)">↑</button>
          <button type="button" data-test="down" :title="t('blk.down')" :aria-label="t('blk.down')" :disabled="i === store.nb.value.blocks.length - 1" @click="store.moveBlock(block.id, 1)">↓</button>
          <button type="button" data-test="dup" :title="t('blk.dup')" :aria-label="t('blk.dup')" @click="store.duplicateBlock(block.id)">⧉</button>
          <button type="button" data-test="del" :title="t('blk.del')" :aria-label="t('blk.del')" @click="remove(block.id)">✕</button>
        </div>
        <div class="nv-body">
          <MarkdownBlock v-if="block.type === 'markdown'" :block-id="block.id" :model-value="block.content ?? ''" @update:model-value="store.updateContent(block.id, $event, { coalesce: true })" />
          <SqlBlock v-else-if="block.type === 'sql'" :block-id="block.id" :editor-factory="editorFactory" />
          <InputBlock v-else-if="block.type === 'input'" :block-id="block.id" />
          <AnalysisBlock v-else-if="block.type === 'chart'" :block-id="block.id" />
          <BigNumberBlock v-else-if="block.type === 'big-number'" :block-id="block.id" />
          <UnsupportedBlock v-else :block-id="block.id" />
        </div>
      </div>
      <AppliedBar :block-id="block.id" />
      <div class="nv-insert" data-test="insert">
        <button type="button" data-test="add-md" @click="store.addBlock('markdown', block.id)">{{ t('nb.addMarkdown') }}</button>
        <button type="button" data-test="add-sql" @click="store.addBlock('sql', block.id)">{{ t('nb.addSql') }}</button>
        <button type="button" data-test="add-results" @click="store.addBlock('results', block.id)">{{ t('nb.addResults') }}</button>
        <button type="button" data-test="add-input" @click="store.addBlock('input', block.id)">{{ t('nb.addInput') }}</button>
        <button type="button" data-test="add-chart" @click="store.addBlock('chart', block.id)">{{ t('nb.addChart') }}</button>
        <button type="button" data-test="add-big-number" @click="store.addBlock('big-number', block.id)">{{ t('nb.addBigNumber') }}</button>
      </div>
    </template>
    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('blk.delTitle')"
      :message="t('blk.delConfirm')"
      :buttons="[{ id: 'cancel', label: t('dlg.cancel') }, { id: 'delete', label: t('blk.del'), variant: 'danger' }]"
      @choose="onChoose"
    />
  </div>
</template>

<style scoped>
.nv-missing { font-size: 12px; padding: 4px 8px; color: var(--color-warning, #b80); }
.nv { padding: 8px 12px; }
.nv-drop-hint, .nv-drop-notice { font-size: 12px; padding: 4px 8px; margin-bottom: 6px; color: var(--color-foreground, inherit); background: var(--color-muted, #f4f4f5); border-left: 3px solid var(--color-primary, #2563eb); }
.nv-drop-hint { border: 1px dashed var(--color-primary, #2563eb); }
.nv:focus { outline: none; }
.nv-block { scroll-margin-top: var(--toolbar-h, 56px); display: flex; gap: 6px; border-left: 2px solid transparent; padding-left: 4px; }
.nv-block.selected { border-left-color: var(--color-primary, #2563eb); }
.nv-controls { display: flex; flex-direction: column; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .1s; }
.nv-block:hover .nv-controls, .nv-block:focus-within .nv-controls, .nv-block.selected .nv-controls { opacity: 1; pointer-events: auto; }
@media (hover: none) { .nv-controls { opacity: .6; pointer-events: auto; } }
.nv-controls button { font-size: 11px; padding: 0 4px; cursor: pointer; }
.nv-body { flex: 1; min-width: 0; }
.nv-insert { height: 20px; display: flex; gap: 8px; justify-content: center; opacity: 0; transition: opacity .1s; }
.nv-insert:hover, .nv-insert:focus-within { opacity: 1; }
.nv-insert button { font-size: 11px; padding: 0 8px; cursor: pointer; }
.nv-empty { text-align: center; padding: 32px; color: var(--color-muted-foreground, #777); }
</style>
