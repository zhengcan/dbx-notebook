import { normalizeAnalysis, type Block } from '@sqlnb/format'
import type { useNotebookStore } from '../state/notebookStore'
import { baseName, splitPath } from './exportPath'
import { t } from '../i18n'
import { buildExportModel, type ChartSection } from './model'
import { renderExportHtml, type ExportLabels } from './html'
import { renderChartSvgs } from './chartSvg'
import type { ExportOptions } from './options'
import { renderMarkdownForExport, createImageBudget } from './markdown'
import type { ReadImageFn } from '../files/imageClient'
import { ExportCancelled, errorText, rawDetail, safeStringify, targetExistsBranch, type ExportClient } from './exportClient'
import type { ExportSettings } from './exportSettings'

type Store = ReturnType<typeof useNotebookStore>

export type ExportStage = 'prepare' | 'charts' | 'render' | 'save' | 'done'
export type ExportOutcome =
  | { ok: true; path: string; bytes: number; warnings: string[] }
  | { ok: false; code: 'cancelled' | 'target-exists' | 'no-content' | 'browser-missing' | 'render-failed' | 'write-failed'; message: string }
export interface ExportRun { promise: Promise<ExportOutcome>; abort(): void }

export interface ExportDeps {
  store: Store
  client: ExportClient
  settings: Pick<ExportSettings, 'browserPath'>
  labels: ExportLabels
  path: string
  /** Already resolved by the caller: null when the switch is off or unavailable. */
  exporter?: string | null
  overwrite?: boolean
  dataSourceName: (b: Block) => string | undefined
  onStage?: (s: ExportStage) => void
  /** Reads local Markdown images through the sidecar; without it (or for an unsaved notebook) images export as alt text. */
  readImage?: ReadImageFn
}

const BROWSER_MISSING = -32020
const rpcCode = (e: unknown) => (e as { rpcCode?: number } | null)?.rpcCode
const msg = errorText

// Charts and big numbers live only in memory; recompute the missing ones locally from saved SQL results (never queries a database).
export async function refreshMissing(store: Store): Promise<void> {
  for (const b of store.nb.value.blocks) {
    try {
      if (b.type === 'chart') {
        const meta = (b.metadata ?? {}) as Record<string, unknown>
        const legacy = normalizeAnalysis(meta).pivot === null && typeof meta.spec === 'object' && meta.spec !== null
        if (!legacy && !store.analysis.has(b.id)) await store.refreshAnalysis(b.id)
      } else if (b.type === 'big-number') {
        if (!store.bigNumbers.has(b.id)) await store.refreshBigNumber(b.id)
      }
    } catch { /* block is then skipped by the model */ }
  }
}

export function runExport(deps: ExportDeps, options: ExportOptions): ExportRun {
  const ac = new AbortController()
  const { store, client, labels } = deps
  const stage = (s: ExportStage) => deps.onStage?.(s)
  const fail = (code: Extract<ExportOutcome, { ok: false }>['code'], message: string): ExportOutcome => ({ ok: false, code, message })
  const cancelled = () => fail('cancelled', 'cancelled')

  async function run(): Promise<ExportOutcome> {
    stage('prepare')
    await refreshMissing(store)
    if (ac.signal.aborted) return cancelled()
    const now = new Date()
    const model = buildExportModel({ store, options, now, documentTitle: baseName(splitPath(deps.path).name) || t('exp.untitledName'), dataSourceName: deps.dataSourceName, labels: deps.labels, exporter: deps.exporter })
    if (!model.exportable) return fail('no-content', 'nothing to export')

    const ext = options.format
    const path = deps.path
    if (ac.signal.aborted) return cancelled()

    stage('charts')
    const warnings: string[] = model.skipped.map((s) => s.label)
    const chartSections = model.sections.filter((s): s is ChartSection => s.kind === 'chart')
    const { svgs } = await renderChartSvgs(chartSections, options.orientation)
    for (const s of chartSections) {
      const c = svgs[s.blockId]
      if (c && c.svg === null) warnings.push(`${s.title || s.blockId}: ${c.error === 'no-data' ? labels.noData : (c.error ?? labels.chartUnavailable)}`)
    }
    if (ac.signal.aborted) return cancelled()

    stage('render')
    const budget = createImageBudget()
    let imagesSkipped = 0
    for (const sec of model.sections) {
      if (sec.kind !== 'markdown') continue
      const r = await renderMarkdownForExport(sec.source, { notebookPath: store.path?.value ?? null, client: deps.readImage, budget })
      sec.html = r.html
      imagesSkipped += r.skipped
      if (ac.signal.aborted) return cancelled()
    }
    const html = renderExportHtml(model, options, svgs, labels, { imageNote: imagesSkipped > 0 ? t('mdimg.exportSkipped', { n: imagesSkipped }) : undefined })
    stage('save')
    try {
      let bytes: number
      if (ext === 'html') bytes = (await client.saveHtml(path, html, deps.overwrite)).bytes
      else {
        const manual = deps.settings.browserPath.value || undefined
        bytes = (await client.pdf({ html, path, orientation: options.orientation, manual, overwrite: deps.overwrite, signal: ac.signal })).bytes
      }
      stage('done')
      return { ok: true, path, bytes, warnings }
    } catch (e) {
      if (e instanceof ExportCancelled) return cancelled()
      const branch = targetExistsBranch(e)
      if (branch) { console.debug('[sqlnb export] target exists recognised via', branch); return fail('target-exists', msg(e)) }
      const code = rpcCode(e)
      if (code === BROWSER_MISSING) return fail('browser-missing', msg(e))
      console.error('[sqlnb export]', safeStringify(e))
      if (ext === 'html' || code === -32013) return fail('write-failed', rawDetail(e))
      return fail('render-failed', rawDetail(e))
    }
  }

  return { promise: run().catch((e) => { console.error('[sqlnb export]', safeStringify(e)); return fail('render-failed', rawDetail(e)) }), abort: () => ac.abort() }
}
