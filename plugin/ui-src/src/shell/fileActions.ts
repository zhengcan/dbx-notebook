import { createEmptyNotebook, parseOutFile, serializeNotebook, serializeOutFile, SqlnbParseError } from '@sqlnb/format'
import { HostError, type HostBridge } from '../host/bridge'
import { NotebookInvalidError, type useNotebookStore } from '../state/notebookStore'
import { t } from '../i18n'
import { collectRelImageLinks } from '../markdown/assetLinks'

export interface RecentItem { path: string; /** @deprecated legacy recents may carry it; never shown */ title?: string; openedAt: number }

export interface FileActionDeps {
  bridge: HostBridge
  store: ReturnType<typeof useNotebookStore>
  confirm: (reason: 'new' | 'open') => Promise<'save' | 'discard' | 'cancel'>
  askExternalChange: () => Promise<'overwrite' | 'reload' | 'cancel'>
  confirmOverwrite?: (path: string) => Promise<boolean>
  notify: (msg: string, kind: 'error' | 'info') => void
  pickPath?: (kind: 'open' | 'save', suggested?: string) => Promise<string | null>
}

type Pick = { path?: string; cancelled?: boolean }

const rpcOf = (e: unknown) => (e instanceof HostError ? e.rpcCode : undefined)
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || '/'

export function createFileActions(deps: FileActionDeps) {
  const { bridge, store, notify } = deps
  let busy = false

  const exclusive = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    try { await fn() } finally { busy = false }
  }

  async function touchRecent(path: string) {
    try { await bridge.invoke('notebook/touchRecent', { path }) } catch { /* best effort */ }
  }

  async function pick(kind: 'open' | 'save', suggested?: string): Promise<string | null> {
    try {
      const r = await bridge.invoke<Pick>(kind === 'open' ? 'notebook/pickOpen' : 'notebook/pickSave',
        kind === 'open' ? {} : { suggestedName: suggested })
      if (r?.cancelled || !r?.path) return null
      return r.path
    } catch {
      notify(t('file.pickError'), 'error')
      return deps.pickPath ? deps.pickPath(kind, suggested) : null
    }
  }

  async function pickTarget(kind: 'open' | 'save', suggested?: string) {
    return pick(kind, suggested)
  }

  async function write(path: string, expected: number | null | undefined, mapping?: Record<string, string>): Promise<boolean> {
    store.sealHistory()
    let revision = store.revision.value
    const params: Record<string, unknown> = { path, text: store.toText(mapping) }
    if (expected != null) params.expectedMtimeMs = expected
    const r = await bridge.invoke<{ mtimeMs: number }>('notebook/write', params)
    if (mapping && store.rewriteMarkdownImageLinks(mapping) > 0 && revision === store.revision.value - 1) revision = store.revision.value
    store.markSaved(path, r.mtimeMs, revision)
    await touchRecent(path)
    await saveResults(path)
    return true
  }

  // Results live in the `.out` sidecar (separate mode). A failure here never undoes the main-file save.
  async function saveResults(path: string): Promise<void> {
    const mode = store.nb.value.settings?.outputs
    const rev = store.resultsRevision.value
    if (mode === 'separate') {
      const entries = store.collectEntries()
      if (Object.keys(entries).length > 0) {
        try {
          await bridge.invoke('notebook/writeOut', { path, text: serializeOutFile(entries) })
        } catch (e) {
          notify(t('file.resultsSaveError', { message: msgOf(e) }), 'error')
          return
        }
      } else {
        try { await bridge.invoke('notebook/deleteOut', { path }) } catch { /* ignore */ }
      }
    } else {
      try { await bridge.invoke('notebook/deleteOut', { path }) } catch { /* ignore */ }
    }
    store.markResultsSaved(rev)
  }

  async function loadResults(path: string): Promise<void> {
    try {
      const r = await bridge.invoke<{ text?: string; exists?: boolean } | undefined>('notebook/readOut', { path })
      if (!r || r.exists === false || typeof r.text !== 'string') return
      const parsed = parseOutFile(r.text)
      if (parsed.warnings.length > 0) notify(t('file.outWarnings', { count: parsed.warnings.length }), 'info')
      if (parsed.entries && Object.keys(parsed.entries).length > 0) store.applyEntries(parsed.entries, undefined, { overwrite: true })
    } catch (e) {
      notify(t('file.outReadError', { message: msgOf(e) }), 'error')
    }
  }

  async function loadFrom(path: string): Promise<boolean> {
    let r: { text: string; mtimeMs: number }
    try {
      r = await bridge.invoke<{ text: string; mtimeMs: number }>('notebook/read', { path })
    } catch (e) {
      notify(t('file.readError', { message: msgOf(e) }), 'error')
      return false
    }
    try {
      store.load(r.text, path, r.mtimeMs)
    } catch (e) {
      if (e instanceof NotebookInvalidError) {
        notify(t('file.invalid', { message: e.message }), 'error')
      } else if (e instanceof SqlnbParseError) {
        notify(e.line != null
          ? t('file.parseError', { line: e.line, column: e.column ?? 1, message: e.message })
          : t('file.parseErrorNoPos', { message: e.message }), 'error')
      } else notify(t('file.readError', { message: msgOf(e) }), 'error')
      return false
    }
    await loadResults(path)
    await touchRecent(path)
    return true
  }

  async function doSave(): Promise<boolean> {
    const path = store.path.value
    if (!path) return doSaveAs()
    try {
      return await write(path, store.mtimeMs.value)
    } catch (e) {
      const code = rpcOf(e)
      try {
        if (code === -32011) {
          const choice = await deps.askExternalChange()
          if (choice === 'overwrite') return await write(path, null)
          if (choice === 'reload') { await loadFrom(path); return false }
          return false
        }
        if (code === -32010) return await write(path, null)
      } catch (e2) {
        return failSave(path, e2)
      }
      return failSave(path, e)
    }
  }

  function failSave(path: string, e: unknown): false {
    if (rpcOf(e) === -32012) notify(t('file.parentMissing', { dir: dirOf(path) }), 'error')
    else notify(t('file.saveError', { message: msgOf(e) }), 'error')
    return false
  }

  function copyFailedMessage(rels: unknown[]): string {
    const names = rels.filter((r): r is string => typeof r === 'string').map((r) => r.split('/').pop() ?? r).filter(Boolean)
    const shown = names.slice(0, 3).join(', ') + (rels.length > 3 ? ' …' : '')
    return t('mdimg.copyFailed', { n: rels.length }) + (names.length > 0 ? t('mdimg.copyFailedNames', { names: shown }) : '')
  }

  // Copies referenced relative images next to the new file; returns the old -> new mapping for the saved text.
  async function copyAssetsFor(to: string): Promise<Record<string, string> | undefined> {
    const from = store.path.value
    if (!from || from === to) return undefined
    const rels = [...new Set(store.nb.value.blocks.flatMap((b) => (b.type === 'markdown' && typeof b.content === 'string' ? collectRelImageLinks(b.content) : [])))]
    if (rels.length === 0) return undefined
    try {
      const r = await bridge.invoke<{ mapping?: Record<string, unknown>; failed?: unknown[] }>('notebook/copyAssets', { fromNotebookPath: from, toNotebookPath: to, relPaths: rels })
      const mapping: Record<string, string> = {}
      for (const [k, v] of Object.entries(r?.mapping ?? {})) if (rels.includes(k) && typeof v === 'string') mapping[k] = v
      if (Array.isArray(r?.failed) && r.failed.length > 0) notify(copyFailedMessage(r.failed), 'error')
      return mapping
    } catch {
      notify(copyFailedMessage(rels), 'error')
      return undefined
    }
  }

  async function doSaveAs(): Promise<boolean> {
    const current = (store.path.value ?? '').split(/[\\/]/).pop() ?? ''
    const path = await pickTarget('save', current || 'notebook.sqlnb')
    if (!path) return false
    try {
      if (path !== store.path.value) {
        const r = await bridge.invoke<{ exists: boolean }>('notebook/exists', { path })
        if (r?.exists && !(await (deps.confirmOverwrite ?? (async () => false))(path))) return false
      }
      const ok = await write(path, null, await copyAssetsFor(path))
      if (ok) { store.history.clear(); store.appliedNotice.value = null }
      return ok
    } catch (e) {
      return failSave(path, e)
    }
  }

  async function guard(reason: 'new' | 'open'): Promise<boolean> {
    // Only `dirty` prompts: results-only changes (resultsDirty) are re-runnable and never block replacing the notebook.
    if (!store.dirty.value) return true
    const c = await deps.confirm(reason)
    if (c === 'cancel') return false
    if (c === 'save') return doSave()
    return true
  }

  return {
    newNotebook: () => exclusive(async () => {
      if (!(await guard('new'))) return
      store.load(serializeNotebook(createEmptyNotebook()), null, null)
    }),
    open: (path?: string) => exclusive(async () => {
      if (!(await guard('open'))) return
      const p = path ?? (await pickTarget('open'))
      if (!p) return
      await loadFrom(p)
    }),
    confirmLeave: async (): Promise<boolean> => {
      if (busy) return false
      busy = true
      try { return await guard('new') } finally { busy = false }
    },
    save: () => exclusive(async () => {
      const path = store.path.value
      if (path && !store.dirty.value) {
        if (store.resultsDirty.value) await saveResults(path)
        return
      }
      await doSave()
    }),
    saveAs: () => exclusive(async () => { await doSaveAs() }),
    async recent(): Promise<RecentItem[]> {
      try {
        const r = await bridge.invoke<{ items: RecentItem[] }>('notebook/recent', {})
        return r?.items ?? []
      } catch { return [] }
    },
  }
}
