<script setup lang="ts">
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { computed, nextTick, type Component, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { createHostBridge, type HostBridge } from './host/bridge'
import { createImageClient } from './files/imageClient'
import { createConnectionsStore } from './connections/hostConnections'
import { createTabTitleController, fileNameOf } from './shell/tabTitle'
import { createPluginSettings } from './state/pluginSettings'
import { useNotebookStore } from './state/notebookStore'
import { createCatalogCache } from './run/catalog'
import { createAiClient } from './ai/aiClient'
import { createAiSettings } from './ai/aiSettings'
import { createChatStore } from './ai/chatStore'
import { watchDeletedBlocks } from './ai/useChatSession'
import { createDrawerManager, type DrawerSpec } from './ai/drawerState'
import SqlDrawer from './ai/SqlDrawer.vue'
import InterpretDrawer from './ai/InterpretDrawer.vue'
import ChartDrawer from './ai/ChartDrawer.vue'
import MetricsDrawer from './ai/MetricsDrawer.vue'
import { HistoryActionsKey, AiClientKey, AiSettingsKey, BridgeKey, ConnectionsKey, ChatStoreKey, DrawerKey, CanRunKey, ExportClientKey, ExportSettingsKey, CatalogKey, EngineKey, PluginSettingsKey, RunningAllKey, SelectedKey, StoreKey } from './injection'
import { createFileActions, type RecentItem } from './shell/fileActions'
import { createEngineClient } from './run/engineClient'
import { runAnalysis } from './analysis/runAnalysis'
import { runBigNumber } from './analysis/runBigNumber'
import { runAll } from './run/runMany'
import { setLocale, t } from './i18n'
import { useHistoryShortcuts } from './shell/useHistoryShortcuts'
import { createHistoryActions } from './shell/historyActions'
import HistoryLive from './shell/HistoryLive.vue'
import { allowNativeContextMenu } from './shell/contextMenu'
import { installFileDropGuard } from './shell/fileDropGuard'
import Toolbar from './shell/Toolbar.vue'
import NotebookView from './shell/NotebookView.vue'
import StartPage from './shell/StartPage.vue'
import { createDialogHost, buildExportDoneDialog, type DialogGuard } from './shell/dialogHost'
import type { DialogButton } from './shell/dialogTypes'
import ConfirmDialog from './shell/ConfirmDialog.vue'
import PathPrompt from './shell/PathPrompt.vue'
import ExportDialog from './export/ExportDialog.vue'
import { createExportSettings } from './export/exportSettings'
import { createExportClient, errorText, rawDetail, safeStringify } from './export/exportClient'
import { buildExportModel } from './export/model'
import { buildExportLabels } from './export/labels'
import { refreshMissing, runExport, type ExportRun } from './export/runExport'
import type { ExportOptions } from './export/options'
import { baseName, splitPath, suggestFileName } from './export/exportPath'
import type { SqlEditorHandle, SqlEditorOpts } from './editor/sqlEditor'

const props = defineProps<{
  bridgeFactory?: () => HostBridge
  editorFactory?: (parent: HTMLElement, opts: SqlEditorOpts) => SqlEditorHandle
  /** Purpose bodies for the AI drawer. Each receives prop `spec` and should emit `close`; the host also closes on that event. */
  drawerBodies?: Partial<Record<DrawerSpec['purpose'], Component>>
  /** Test seam for the export default file name. */
  clock?: () => Date
}>()

const bridge = (props.bridgeFactory ?? createHostBridge)()
const connections = createConnectionsStore(bridge)
const pluginSettings = createPluginSettings(bridge)
const store = useNotebookStore({ maxRows: () => pluginSettings.maxRows.value })
const tabTitle = createTabTitleController(bridge, {
  name: () => fileNameOf(store.path.value),
  dirty: () => store.dirty.value,
  untitled: () => t('shell.untitled'),
})
watch([store.path, store.dirty, () => t('shell.untitled')], () => tabTitle.update())
const selected = ref<string | null>(null)
const dataApi = ref(true)
const canRun = computed(() => dataApi.value)
provide(BridgeKey, bridge)
provide(CatalogKey, createCatalogCache(bridge))
const engine = createEngineClient(bridge)
provide(EngineKey, engine)
store.setAnalysisRunner((id) => runAnalysis({ store, engine }, id))
store.setBigNumberRunner((id) => runBigNumber({ store, engine }, id))
provide(ConnectionsKey, connections)
provide(StoreKey, store)
const historyActions = createHistoryActions(store, { fallbackFocus: () => document.querySelector<HTMLElement>('[data-test=notebook-view]') })
provide(HistoryActionsKey, historyActions)
useHistoryShortcuts(store, document, historyActions)
provide(PluginSettingsKey, pluginSettings)
provide(CanRunKey, canRun)
provide(SelectedKey, selected)
const exportSettings = createExportSettings(bridge)
const exportClient = createExportClient(bridge)
provide(ExportSettingsKey, exportSettings)
provide(ExportClientKey, exportClient)
const aiClient = createAiClient(bridge)
const aiSettings = createAiSettings(bridge, aiClient)
provide(AiClientKey, aiClient)
provide(AiSettingsKey, aiSettings)
const drawerBodies: Partial<Record<DrawerSpec['purpose'], Component>> = props.drawerBodies ?? { sql: SqlDrawer, interpret: InterpretDrawer, chart: ChartDrawer, bignumber: MetricsDrawer }
const drawer = createDrawerManager(store, (p) => !!drawerBodies[p])
provide(DrawerKey, drawer)
const chatStore = createChatStore(bridge)
provide(ChatStoreKey, chatStore)
watchDeletedBlocks(store, chatStore)
// open() is refused for purposes without a registered body.
const drawerBody = computed(() => (drawer.current.value ? drawerBodies[drawer.current.value.purpose] ?? null : null))
const drawerOpen = computed(() => drawerBody.value !== null)
const running = ref(false)
const stopping = ref(false)
provide(RunningAllKey, running)

const ready = ref(false)
const opened = ref(false)
const recent = ref<RecentItem[]>([])
const appearance = ref<'light' | 'dark'>('light')
const appEl = ref<HTMLElement | null>(null)
let tbObserver: ResizeObserver | null = null
function clearToolbarH() {
  for (const el of [appEl.value, document.documentElement]) el?.style.removeProperty('--toolbar-h')
}
function watchToolbar() {
  tbObserver?.disconnect()
  tbObserver = null
  const tb = appEl.value?.querySelector<HTMLElement>('[data-test=toolbar]')
  if (!tb || typeof ResizeObserver === 'undefined') { clearToolbarH(); return }
  tbObserver = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1]
    const h = e?.borderBoxSize?.[0]?.blockSize ?? e?.contentRect.height ?? 0
    if (h > 0) for (const el of [appEl.value, document.documentElement]) el?.style.setProperty('--toolbar-h', `${Math.ceil(h)}px`)
  })
  tbObserver.observe(tb)
}
watch([ready, opened], () => { void nextTick(watchToolbar) }, { flush: 'post' })
let abort: AbortController | null = null
let autoDone = false

interface Toast { id: number; msg: string; kind: 'error' | 'info' }
const toasts = ref<Toast[]>([])
let toastId = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()
function dismiss(id: number) {
  const tm = timers.get(id)
  if (tm) { clearTimeout(tm); timers.delete(id) }
  toasts.value = toasts.value.filter((x) => x.id !== id)
}
function notify(msg: string, kind: 'error' | 'info') {
  const last = toasts.value[toasts.value.length - 1]
  if (last && last.msg === msg && last.kind === kind) return
  const id = ++toastId
  toasts.value.push({ id, msg, kind })
  if (kind === 'info') timers.set(id, setTimeout(() => dismiss(id), 6000))
  else {
    const errs = toasts.value.filter((x) => x.kind === 'error')
    if (errs.length > 5) dismiss(errs[0].id)
  }
}

watch(() => store.generation.value, () => {
  if (store.loadNotices.value.length > 0) notify(t('analysis.normalized'), 'info')
})

const { dlg, error: dlgError, ask, choose: onChoose } = createDialogHost()

const pathPrompt = ref<{ resolve: (p: string | null) => void; title?: string; placeholder?: string } | null>(null)
function pickPath(titleKey?: string, placeholderKey?: string): Promise<string | null> {
  return new Promise((resolve) => { pathPrompt.value = { resolve, title: titleKey ? t(titleKey as any) : undefined, placeholder: placeholderKey ? t(placeholderKey as any) : undefined } })
}
function closePath(p: string | null) {
  const r = pathPrompt.value
  pathPrompt.value = null
  r?.resolve(p)
}

const exportOpen = ref(false)
const exportBusy = ref(false)
const exportProgress = ref('')
const exportError = ref('')
const exportBrowser = ref<{ found: boolean; path?: string; checking: boolean }>({ found: false, checking: true })
const exportLive = ref<ExportOptions | null>(null)
const exportInitial = ref<ExportOptions | undefined>(undefined)
const exportModelTick = ref(0)
const exportUser = ref<string | null | undefined>(undefined)
let exportUserToken = 0
const EXPORTER_WAIT_MS = 30_000
const exportFolderInit = ref('')
const exportNameInit = ref('')
let rememberedPath = ''
const exportedPaths = new Set<string>()
let opening = false
// The model ignores note/format: keep the options object stable for those so typing never rebuilds it.
const exportModelOpts = computed<ExportOptions>((prev) => {
  const o = exportLive.value ?? exportSettings.options.value
  const key = JSON.stringify([o.includeSql, o.header, o.rowLimit, o.repeatCols, o.filtersLine, o.columnBreaks, o.blocks, o.orientation])
  if (prev && (prev as any).__key === key) return prev
  return Object.defineProperty({ ...o }, '__key', { value: key, enumerable: false }) as ExportOptions
})
let exportRun: ExportRun | null = null
const connName = (b: { metadata?: unknown }) => {
  const c = (b.metadata as { connection?: unknown } | undefined)?.connection
  return typeof c === 'string' && c ? c : store.nb.value.settings.defaultConnection
}
const exportModel = computed(() => {
  void exportModelTick.value
  return buildExportModel({ store, options: exportModelOpts.value, now: new Date(), dataSourceName: connName })
})
async function checkExportBrowser() {
  exportBrowser.value = { ...exportBrowser.value, checking: true }
  try {
    const s = await exportClient.browserStatus(exportSettings.browserPath.value || undefined)
    exportBrowser.value = { found: s.found, path: s.path, checking: false }
  } catch { exportBrowser.value = { found: false, checking: false } }
}
let exportUserPending: Promise<void> | null = null
function fetchExporter(): Promise<void> {
  if (exportUser.value !== undefined) return Promise.resolve()
  if (exportUserFetching && exportUserPending) return exportUserPending
  exportUserFetching = true
  const token = exportUserToken
  const p = exportClient.exporterName().then((n) => {
    if (token !== exportUserToken) return
    exportUserFetching = false
    exportUserPending = null
    exportUser.value = n
  }, () => {})
  exportUserPending = p
  return p
}
let exportUserFetching = false
function onExportOptions(o: ExportOptions) {
  exportLive.value = o
  if (o.header.exporter) fetchExporter()
}
async function openExport() {
  if (exportOpen.value || opening) return
  opening = true
  exportError.value = ''
  exportProgress.value = ''
  exportBrowser.value = { found: false, checking: true }
  try {
    await exportSettings.load(store.path.value, store.nb.value.blocks.map((b) => b.id))
    await refreshMissing(store)
  } finally { opening = false }
  exportInitial.value = exportSettings.options.value
  const nbPath = store.path.value
  const folder = exportSettings.folder.value || (nbPath ? splitPath(nbPath).folder : '')
  const name = suggestFileName((nbPath ?? '').split(/[\\/]/).pop() ?? '', (props.clock ?? (() => new Date()))(), exportSettings.options.value.format, t('exp.untitledName'))
  exportFolderInit.value = folder
  exportNameInit.value = baseName(name)
  rememberedPath = ''
  exportLive.value = exportSettings.options.value
  exportModelTick.value++
  exportUserToken++
  exportUserFetching = false
  exportUserPending = null
  exportUser.value = undefined
  exportOpen.value = true
  if (exportLive.value.header.exporter) fetchExporter()
  void checkExportBrowser()
}
function closeExport() { if (!exportBusy.value) { exportOpen.value = false; exportUserToken++; exportUserFetching = false } }
async function setBrowser(p: string) {
  await exportSettings.setBrowserPath(p)
  await checkExportBrowser()
}
// Modals over the export dialog hand focus back to its Export button when they close.
async function askOverExport(title: string, message: string, buttons: DialogButton[], initialFocus?: string, guard?: DialogGuard): Promise<string> {
  const r = await ask(title, message, buttons, initialFocus, guard)
  await nextTick()
  if (exportOpen.value) document.querySelector<HTMLElement>('[data-test=go]')?.focus()
  return r
}
async function confirmOverwrite(path: string) {
  return (await askOverExport(t('dlg.overwriteTitle'), t('dlg.overwriteMsg', { path }), [
    { id: 'overwrite', label: t('dlg.overwrite'), variant: 'danger' },
    { id: 'cancel', label: t('dlg.cancel') },
  ], 'cancel')) === 'overwrite'
}
// The sidecar refuses to replace an existing file unless told to; known paths are only confirmed up front as an optimisation.
function startExport(o: ExportOptions, path: string, overwrite = false): Promise<void> {
  return doExport(o, path, overwrite).catch((e) => {
    exportBusy.value = false
    exportProgress.value = ''
    console.error('[sqlnb export]', safeStringify(e))
    exportError.value = t('exp.err.unexpected', { message: rawDetail(e) })
  })
}
async function doExport(o: ExportOptions, path: string, overwrite: boolean) {
  if (exportBusy.value) return
  if (!overwrite && (exportedPaths.has(path) || path === rememberedPath)) {
    if (!(await confirmOverwrite(path))) { exportError.value = t('exp.err.exists'); return }
    overwrite = true
  }
  if (o.header.exporter && exportUser.value === undefined) {
    const token = exportUserToken
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([fetchExporter(), new Promise<void>((r) => { timer = setTimeout(r, EXPORTER_WAIT_MS) })])
    clearTimeout(timer)
    if (token !== exportUserToken || !exportOpen.value || exportBusy.value) return
  }
  exportBusy.value = true
  exportError.value = ''
  const run = (exportRun = runExport({
    store, client: exportClient, settings: exportSettings, labels: buildExportLabels((k, p) => t(k as any, p as any)),
    path, overwrite,
    exporter: o.header.exporter ? exportUser.value ?? null : null,
    dataSourceName: connName,
    readImage: createImageClient(bridge).readImage,
    onStage: (s) => { exportProgress.value = t(`exp.stage.${s === 'done' ? 'save' : s}` as any) },
  }, o))
  void run.promise.then(async (r) => {
    if (exportRun === run) exportRun = null
    exportBusy.value = false
    exportProgress.value = ''
    if (r.ok) {
      exportedPaths.add(r.path)
      const { folder } = splitPath(r.path)
      try {
        await exportSettings.save(store.path.value, { options: o, folder }, store.nb.value.blocks.map((b) => b.id))
      } catch (e) { console.error('[sqlnb export] could not remember export settings', errorText(e)) }
      const warn = r.warnings.length ? `\n\n${t('exp.warnTitle', { n: r.warnings.length })}\n${r.warnings.map((x) => `• ${x}`).join('\n')}` : ''
      const done = buildExportDoneDialog({
        path: r.path, client: exportClient, onError: (e) => console.error('[sqlnb export open]', safeStringify(e)),
        labels: { ok: t('dlg.ok'), open: t('exp.openFile'), openFailed: t('exp.openFailed'), openUnsupported: t('exp.openNetwork') },
      })
      await askOverExport(t('exp.doneTitle'), t('exp.doneMsg', { path: r.path }) + warn, done.buttons, done.initialFocus, done.guard)
    } else if (r.code === 'target-exists') {
      if (await confirmOverwrite(path)) await startExport(o, path, true)
      else exportError.value = t('exp.err.exists')
    } else if (r.code === 'no-content') exportError.value = t('exp.err.noContent')
    else if (r.code === 'browser-missing') { exportError.value = t('exp.err.browserMissing', { message: r.message }); void checkExportBrowser() }
    else if (r.code === 'write-failed') exportError.value = t('exp.err.write', { message: r.message })
    else if (r.code === 'render-failed') exportError.value = t('exp.err.render', { message: r.message })
  }).catch((e) => {
    exportBusy.value = false
    exportProgress.value = ''
    console.error('[sqlnb export]', safeStringify(e))
    exportError.value = t('exp.err.unexpected', { message: rawDetail(e) })
  })
}
const pickExportFolder = (defaultPath?: string) => exportClient.pickFolder(defaultPath)
function cancelExport() { exportRun?.abort() }

const actions = createFileActions({
  bridge, store, notify, pickPath: () => pickPath(),
  confirm: async () => (await ask(t('dlg.unsavedTitle'), t('dlg.unsaved'), [
    { id: 'save', label: t('dlg.save'), variant: 'primary' },
    { id: 'discard', label: t('dlg.discard'), variant: 'danger' },
    { id: 'cancel', label: t('dlg.cancel') },
  ])) as 'save' | 'discard' | 'cancel',
  confirmOverwrite: async (path) => (await ask(t('dlg.overwriteTitle'), t('dlg.overwriteMsg', { path }), [
    { id: 'overwrite', label: t('dlg.overwrite'), variant: 'danger' },
    { id: 'cancel', label: t('dlg.cancel') },
  ])) === 'overwrite',
  askExternalChange: async () => (await ask(t('dlg.externalTitle'), t('dlg.externalMsg'), [
    { id: 'overwrite', label: t('dlg.overwrite'), variant: 'danger' },
    { id: 'reload', label: t('dlg.reload') },
    { id: 'cancel', label: t('dlg.cancel') },
  ])) as 'overwrite' | 'reload' | 'cancel',
})

async function refreshRecent() { recent.value = await actions.recent() }

async function replacing(fn: () => Promise<void>) {
  const before = store.nb.value
  await fn()
  const changed = store.nb.value !== before
  if (changed) abort?.abort()
  return changed
}
// `auto` carries the connection of the one-shot startup auto-create. A user-initiated New
// never applies a context connection (it only consumes the one-shot flag).
async function doNew(auto?: { name: string; dbType: string }) {
  if (!auto) autoDone = true
  if (await replacing(() => actions.newNotebook())) {
    if (auto) {
      store.setDefaultConnection(auto.name, auto.dbType || undefined)
      store.markClean()
    }
    selected.value = null
    opened.value = true
    autoDone = true
  }
}
async function doOpen(path?: string) {
  void connections.refreshIfStale()
  autoDone = true
  if (await replacing(() => actions.open(path))) { selected.value = null; opened.value = true; autoDone = true }
}
async function goHome() {
  if (!(await actions.confirmLeave())) return
  abort?.abort()
  store.load(serializeNotebook(createEmptyNotebook()), null, null)
  selected.value = null
  opened.value = false
  autoDone = true
  await refreshRecent()
}

// The in-flight block cannot be cancelled (queryData has no cancel API); Stop only
// prevents later blocks from starting.
function stopRun() {
  if (!running.value) return
  stopping.value = true
  abort?.abort()
}

async function startRun(mode: Parameters<typeof runAll>[1]) {
  if (running.value || !canRun.value) return
  running.value = true
  const ac = (abort = new AbortController())
  try { await runAll({ bridge, connections, store, engine, signal: ac.signal }, mode) } finally {
    running.value = false
    stopping.value = false
    if (abort === ac) abort = null
  }
}

async function maybeAutoNew(conn: { name: string; dbType: string } | null) {
  if (!conn || autoDone || opened.value || disposed) return
  autoDone = true
  await doNew(conn)
}

async function onContext(ctx: Record<string, unknown>): Promise<{ name: string; dbType: string } | null> {
  try {
    const conn = connections.seedFromContext(ctx)
    if (conn) return { name: conn.name, dbType: conn.dbType }
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), 'error')
  }
  return null
}

function applyEnv() {
  setLocale(bridge.locale())
  appearance.value = bridge.theme().appearance
  document.documentElement.setAttribute('data-theme', appearance.value)
}

let offCtx: (() => void) | null = null
let offEnv: (() => void) | null = null
let disposed = false
const initError = ref<string | null>(null)

async function init() {
  initError.value = null
  try {
    await bridge.ready()
    if (disposed) return
    applyEnv()
    dataApi.value = bridge.capabilities().dataApi
    offEnv ??= bridge.onEnv(applyEnv)
    void connections.refresh({ force: true })
    tabTitle.update()
    // Non-blocking: a slow storage must never delay startup. Runs started before it resolves use the current ref (default 5000).
    void pluginSettings.load().catch(() => {})
    // Privacy: saved AI opt-outs must apply even when a notebook opens directly (no start page).
    void aiSettings.load().then(() => { if (bridge.capabilities().aiCompletion === true) return aiSettings.refreshModels() }).catch(() => {})
    if (disposed) return
    offCtx ??= bridge.onContext((c) => { void onContext(c).then(maybeAutoNew) })
    await maybeAutoNew(await onContext(bridge.context()))
    if (disposed) return
    await refreshRecent()
    ready.value = true
  } catch (e) {
    if (!disposed) initError.value = e instanceof Error ? e.message : String(e)
  }
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!store.dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}
function refreshConns() { if (ready.value) { void connections.refreshIfStale(); void pluginSettings.refreshIfStale() } }
function onVisibleConns() { if (document.visibilityState === 'visible') refreshConns() }
let removeDropGuard: (() => void) | null = null
onMounted(() => {
  removeDropGuard = installFileDropGuard(document)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('focus', refreshConns)
  document.addEventListener('visibilitychange', onVisibleConns)
  void init()
})
onBeforeUnmount(() => {
  removeDropGuard?.(); removeDropGuard = null
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('focus', refreshConns)
  document.removeEventListener('visibilitychange', onVisibleConns)
  disposed = true
  tabTitle.dispose()
  tbObserver?.disconnect()
  tbObserver = null
  clearToolbarH()
  abort?.abort()
  exportRun?.abort()
  void engine.close().catch(() => {})
  offCtx?.(); offEnv?.()
  offCtx = offEnv = null
  timers.forEach((tm) => clearTimeout(tm))
  timers.clear()
})
function onContextMenu(e: MouseEvent) {
  if (!allowNativeContextMenu(e.target, window.getSelection())) e.preventDefault()
}
</script>

<template>
  <div ref="appEl" class="app" :data-theme="appearance" @contextmenu="onContextMenu">
    <div v-if="initError" class="init-error" data-test="init-error" role="alert">
      <p>{{ t('init.error', { message: initError }) }}</p>
      <button type="button" data-test="retry" @click="init">{{ t('init.retry') }}</button>
    </div>
    <p v-else-if="!ready" class="app-loading">{{ t('app.loading') }}</p>
    <div v-else class="app-content" data-test="app-content" :inert="drawerOpen || undefined">
      <div v-if="!dataApi" class="banner" data-test="banner" role="alert">{{ t('banner.noData') }}</div>
      <StartPage v-if="!opened" :recent="recent" :has-sidecar="true" @new="doNew()" @open="doOpen()" @open-recent="doOpen" @open-path="doOpen" />
      <template v-else>
        <Toolbar
          :running="running" :stopping="stopping"
          @home="goHome" @new="doNew()" @open="doOpen()" @save="actions.save()" @save-as="actions.saveAs()"
          @run-all="startRun({ kind: 'all' })"
          @run-from="selected && startRun({ kind: 'from', blockId: selected })"
          @stop="stopRun" @export="openExport"
        />
        <NotebookView :editor-factory="editorFactory" />
      </template>
    </div>
    <HistoryLive :actions="historyActions" />
    <component :is="drawerBody" v-if="drawerBody && drawer.current.value" :spec="drawer.current.value" @close="drawer.close()" />
    <ExportDialog
      v-if="exportOpen"
      :model="exportModel" :browser="exportBrowser" :busy="exportBusy" :progress="exportProgress" :error="exportError" :initial="exportInitial" :manual-path="exportSettings.browserPath.value" :exporter-name="exportUser" :running="running" :initial-folder="exportFolderInit" :initial-name="exportNameInit" :pick-folder="pickExportFolder"
      @export="startExport" @cancel="cancelExport" @close="closeExport" @set-browser="setBrowser"
      @options-change="onExportOptions"
    />
    <ConfirmDialog :open="dlg !== null" :title="dlg?.title ?? ''" :message="dlg?.message ?? ''" :buttons="dlg?.buttons ?? []" :initial-focus="dlg?.initialFocus" :error="dlgError" @choose="onChoose" />
    <PathPrompt :open="pathPrompt !== null" :title="pathPrompt?.title" :placeholder="pathPrompt?.placeholder" @submit="closePath" @cancel="closePath(null)" />
    <div class="toasts" data-test="toasts" role="status" aria-live="polite">
      <div v-for="x in toasts" :key="x.id" class="toast" :class="x.kind" data-test="toast" :role="x.kind === 'error' ? 'alert' : undefined">
        <span>{{ x.msg }}</span>
        <button type="button" :title="t('toast.dismiss')" @click="dismiss(x.id)">✕</button>
      </div>
    </div>
  </div>
</template>

<style>
html { scroll-padding-top: var(--toolbar-h, 56px); }
.app { --nb-bg: var(--color-background, #fff); --nb-fg: var(--color-foreground, #111); --nb-border: var(--color-border, #ddd); --nb-muted: var(--color-muted, #f3f3f3);
  min-height: 100vh; background: var(--nb-bg); color: var(--nb-fg); font-family: system-ui, sans-serif; font-size: 14px; }
.app[data-theme='dark'] { --nb-bg: var(--color-background, #1a1a1a); --nb-fg: var(--color-foreground, #eee); --nb-border: var(--color-border, #444); --nb-muted: var(--color-muted, #2a2a2a); }
.app-content { display: contents; }
.banner { background: var(--color-warning, #b80); color: #fff; padding: 6px 12px; }
.init-error { padding: 24px; text-align: center; }
.toasts { position: fixed; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 6px; z-index: 1100; }
.toast { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 6px; background: var(--nb-muted); color: var(--nb-fg); border: 1px solid var(--nb-border); }
.toast.error { border-color: var(--color-destructive, #d33); }
</style>
