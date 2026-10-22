<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { createImeGuard } from '../ui/imeEnter'
import { AiSettingsKey, BridgeKey, ExportClientKey, ExportSettingsKey, PluginSettingsKey } from '../injection'
import { clampMaxRows, DEFAULT_MAX_ROWS } from '@sqlnb/format'
import type { PluginSettings } from '../state/pluginSettings'
import type { RecentItem } from './fileActions'

defineProps<{ recent: RecentItem[]; hasSidecar: boolean }>()
const emit = defineEmits<{ (e: 'new'): void; (e: 'open'): void; (e: 'openRecent', path: string): void; (e: 'openPath', path: string): void }>()
const pathInput = ref('')
const settings: PluginSettings = inject(PluginSettingsKey, null) ?? {
  maxRows: ref(DEFAULT_MAX_ROWS),
  load: async () => {},
  refreshIfStale: async () => {},
  async setMaxRows(n: unknown) { const v = clampMaxRows(n); settings.maxRows.value = v; return v },
}
const maxRowsText = ref(String(settings.maxRows.value))
const maxRowsBad = ref(false)
watch(() => settings.maxRows.value, (v) => { maxRowsText.value = String(v) })
function onMaxRowsInput(e: Event) {
  maxRowsText.value = (e.target as HTMLInputElement).value
  maxRowsBad.value = false
}
function onMaxRows(e: Event) {
  const el = e.target as HTMLInputElement
  const raw = el.value.trim()
  const n = Number(raw)
  if (raw === '' || !Number.isInteger(n) || n < 1 || n > 5000) {
    maxRowsBad.value = true
    maxRowsText.value = String(settings.maxRows.value)
    el.value = maxRowsText.value
    return
  }
  maxRowsBad.value = false
  void settings.setMaxRows(n)
  maxRowsText.value = String(settings.maxRows.value)
  el.value = maxRowsText.value
}

const aiSettings = inject(AiSettingsKey, null)
const bridge = inject(BridgeKey, null)
const aiSupported = computed(() => bridge?.capabilities().aiCompletion === true)
function onAiSend(k: 'schema' | 'sql' | 'data', e: Event) { void aiSettings?.setSend({ [k]: (e.target as HTMLInputElement).checked }) }
function onAiModel(e: Event) { void aiSettings?.setModel((e.target as HTMLSelectElement).value || null) }

const exportSettings = inject(ExportSettingsKey, null)
const exportClient = inject(ExportClientKey, null)
const browserText = ref(exportSettings?.browserPath.value ?? '')
const browserLine = ref('')
const browserState = ref<'' | 'found' | 'none' | 'notFound' | 'notExecutable'>('')
const browserProblem = ref(false)
const pickBusy = ref(false)
const pickError = ref('')
const settingsOpen = ref(false)
let userToggled = false
function toggleSettings() { userToggled = true; settingsOpen.value = !settingsOpen.value }
async function checkBrowser() {
  if (!exportClient || !exportSettings) return
  const manual = exportSettings.browserPath.value
  let s: Awaited<ReturnType<typeof exportClient.browserStatus>> | null = null
  try { s = await exportClient.browserStatus(manual || undefined) } catch { /* shown as unavailable */ }
  const bad = !!manual && !s?.found
  if (s?.found) { browserState.value = 'found'; browserLine.value = t('set.exportBrowserFound', { path: s.path ?? '' }) }
  else if (bad && s?.code === 'notExecutable') { browserState.value = 'notExecutable'; browserLine.value = t('set.exportBrowserNotExec', { path: manual }) }
  else if (bad) { browserState.value = 'notFound'; browserLine.value = t('set.exportBrowserBadPath', { path: manual }) }
  else { browserState.value = 'none'; browserLine.value = t('set.exportBrowserNone') }
  browserProblem.value = bad
  if (bad && !userToggled) settingsOpen.value = true
}
async function onBrowserPath(e: Event) {
  if (!exportSettings) return
  const el = e.target as HTMLInputElement
  await exportSettings.setBrowserPath(el.value)
  browserText.value = exportSettings.browserPath.value
  await checkBrowser()
}
async function pickBrowser(kind: 'file' | 'dir') {
  if (!exportSettings || !exportClient?.pickBrowser || pickBusy.value) return
  pickBusy.value = true
  pickError.value = ''
  try {
    const r = await exportClient.pickBrowser(kind)
    if ('path' in r && r.path) {
      await exportSettings.setBrowserPath(r.path)
      browserText.value = exportSettings.browserPath.value
      await checkBrowser()
    }
  } catch (e) {
    pickError.value = t('set.exportBrowserPickFailed', { message: e instanceof Error ? e.message : String(e) })
  } finally { pickBusy.value = false }
}
if (exportSettings) watch(() => exportSettings.browserPath.value, (v) => { browserText.value = v })
onMounted(() => { void exportSettings?.load().then(checkBrowser) })

const fileName = (p: string) => p.split(/[\\/]/).pop() || p
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || (/^[\\/]/.test(p) ? p[0] : '')
function ago(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutes', { n: m })
  if (m < 1440) return t('time.hours', { n: Math.floor(m / 60) })
  return t('time.days', { n: Math.floor(m / 1440) })
}
const ime = createImeGuard()
function onPathEnter(e: KeyboardEvent) { if (ime.isImeEnter(e)) e.preventDefault() }
function submit() {
  const p = pathInput.value.trim()
  if (p) emit('openPath', p)
}
</script>

<template>
  <div class="sp">
    <h2>{{ t('app.title') }}</h2>
    <div class="sp-actions">
      <button type="button" data-test="new" @click="emit('new')">{{ t('start.new') }}</button>
      <button type="button" data-test="open" @click="emit('open')">{{ t('start.open') }}</button>
    </div>
    <h3>{{ t('start.recent') }}</h3>
    <p v-if="!recent.length" data-test="empty" class="sp-muted">{{ t('start.empty') }}</p>
    <ul v-else class="sp-list">
      <li v-for="r in recent" :key="r.path" data-test="recent-item" class="sp-item" @click="emit('openRecent', r.path)">
        <span class="sp-name">{{ fileName(r.path) }}</span>
        <span class="sp-muted sp-dir">{{ dirName(r.path) }}</span>
        <span class="sp-muted">{{ ago(r.openedAt) }}</span>
      </li>
    </ul>
    <form class="sp-path" @submit.prevent="submit">
      <input v-model="pathInput" type="text" :placeholder="t('start.pathPlaceholder')" @keydown.enter="onPathEnter" @compositionstart="ime.onCompositionStart()" @compositionend="ime.onCompositionEnd()" @compositioncancel="ime.onReset()" @blur="ime.onReset()" />
      <button type="button" data-test="open-path" @click="submit">{{ t('start.openPath') }}</button>
    </form>
    <h3 class="sp-set-h">
      <button type="button" class="sp-disc" data-test="settings-toggle" aria-controls="sp-settings-body" :aria-expanded="settingsOpen" :aria-label="browserProblem ? t('start.settingsProblem') : undefined" @click="toggleSettings">
        <svg class="sp-chev" :class="{ open: settingsOpen }" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>{{ t('start.settings') }}</span>
        <span v-if="browserProblem" class="sp-warn" data-test="settings-warning" aria-hidden="true">!</span>
      </button>
    </h3>
    <div v-show="settingsOpen" id="sp-settings-body" class="sp-settings" data-test="start-settings">
      <label class="sp-set">{{ t('set.maxRows') }}
        <input type="number" min="1" max="5000" step="1" data-test="max-rows" class="sp-num" :value="maxRowsText" :aria-describedby="maxRowsBad ? 'max-rows-hint' : undefined" @input="onMaxRowsInput" @change="onMaxRows" />
      </label>
      <span v-if="maxRowsBad" id="max-rows-hint" aria-live="polite" class="sp-muted" data-test="max-rows-hint">{{ t('set.maxRowsHint') }}</span>
      <p class="sp-muted">{{ t('set.maxRowsHelp') }}</p>
      <template v-if="exportSettings">
        <div class="sp-set sp-browser">
          <label class="sp-set sp-grow">{{ t('set.exportBrowser') }}
            <input v-model="browserText" type="text" data-test="browser-path" class="sp-wide" :placeholder="t('exp.browserPathPlaceholder')" :aria-describedby="'browser-status-line'" @change="onBrowserPath" />
          </label>
          <button type="button" data-test="browser-pick-file" :disabled="pickBusy" :aria-label="t('set.exportBrowserPickFileAria')" @click="pickBrowser('file')">{{ t('set.exportBrowserPickFile') }}</button>
          <button type="button" data-test="browser-pick-dir" :disabled="pickBusy" :aria-label="t('set.exportBrowserPickDirAria')" @click="pickBrowser('dir')">{{ t('set.exportBrowserPickDir') }}</button>
        </div>
        <p v-if="pickError" role="alert" class="sp-err" data-test="browser-pick-error">{{ pickError }}</p>
        <p id="browser-status-line" role="status" class="sp-muted" :class="{ 'sp-err': browserProblem }" data-test="browser-status" :data-state="browserState">{{ browserLine }} {{ t('set.exportBrowserHelp') }}</p>
      </template>
      <section v-if="aiSettings" class="sp-ai" data-test="ai-settings" aria-labelledby="ai-set-title">
        <h4 id="ai-set-title">{{ t('ai.set.title') }}</h4>
        <p v-if="!aiSupported" class="sp-muted" data-test="ai-unsupported">{{ t('ai.set.unsupported') }}</p>
        <template v-else>
          <fieldset class="sp-ai-group" data-test="ai-send-group" aria-describedby="ai-confirm-note">
            <legend>{{ t('ai.set.help') }}</legend>
            <label v-for="k in (['schema', 'sql', 'data'] as const)" :key="k" class="sp-set">
              <input type="checkbox" :data-test="`ai-send-${k}`" :checked="aiSettings.send.value[k]" aria-describedby="ai-confirm-note" @change="onAiSend(k, $event)" />
              {{ t(`ai.set.${k}`) }}
            </label>
          </fieldset>
          <p id="ai-confirm-note" class="sp-muted">{{ t('ai.set.confirmNote') }}</p>
          <label class="sp-set">{{ t('ai.set.model') }}
            <select data-test="ai-model" class="sp-wide" :disabled="!aiSettings.models.value.length" :value="aiSettings.effectiveModel() ?? ''" @change="onAiModel">
              <option v-for="m in aiSettings.models.value" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </label>
          <p v-if="aiSettings.modelNotice.value === 'fallback'" class="sp-muted" role="status" data-test="ai-model-fallback">{{ t('ai.set.fallback') }}</p>
          <p v-else-if="aiSettings.modelNotice.value === 'no-models'" class="sp-muted" role="status" data-test="ai-no-models">{{ t('ai.set.noModels') }}</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sp { max-width: 640px; margin: 32px auto; padding: 0 16px; color: var(--color-foreground, #111); }
.sp-actions { display: flex; gap: 8px; margin-bottom: 16px; }
.sp-list { list-style: none; padding: 0; margin: 0 0 16px; }
.sp-item { display: flex; gap: 12px; align-items: baseline; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.sp-item:hover { background: var(--color-muted, #f3f3f3); }
.sp-dir { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-muted { color: var(--color-muted-foreground, #777); font-size: 12px; }
.sp-path { display: flex; gap: 8px; }
.sp-path input { flex: 1; padding: 4px 8px; border: 1px solid var(--color-border, #ccc); border-radius: 4px; background: var(--color-background, #fff); color: inherit; }
.sp-settings { margin-top: 8px; }
.sp-ai { margin-top: 12px; }
.sp-ai-group { border: 0; padding: 0; margin: 0 0 6px; }
.sp-ai-group legend { padding: 0; }
.sp-set { display: flex; gap: 8px; align-items: center; }
.sp-browser { flex-wrap: wrap; }
.sp-grow { flex: 1 1 240px; min-width: 0; }
.sp-set-h { margin: 16px 0 0; font-size: inherit; }
.sp-disc { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; border-color: transparent; background: transparent; font-weight: 600; font-size: 1.1em; }
.sp-disc:hover { background: var(--color-muted, #f3f3f3); }
.sp-disc:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }
.sp-chev { transition: transform .12s; flex: none; }
.sp-chev.open { transform: rotate(90deg); }
.sp-warn { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; font-size: 11px; font-weight: 700; background: var(--color-destructive, #dc2626); color: var(--color-background, #fff); }
.sp-err { color: var(--color-destructive, #dc2626); font-size: 12px; }
button:disabled { opacity: .5; cursor: default; }
@media (prefers-reduced-motion: reduce) { .sp-chev { transition: none; } }
.sp-wide { flex: 1; padding: 4px 8px; border: 1px solid var(--color-border, #ccc); border-radius: 4px; background: var(--color-background, #fff); color: inherit; }
.sp-num { width: 80px; padding: 4px 8px; border: 1px solid var(--color-border, #ccc); border-radius: 4px; background: var(--color-background, #fff); color: inherit; }
button { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border, #ccc); background: var(--color-muted, #f3f3f3); color: inherit; cursor: pointer; }
</style>
