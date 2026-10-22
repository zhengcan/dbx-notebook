import { ref } from 'vue'
import type { DialogButton } from './dialogTypes'
export type { DialogButton }

/** Decides whether a button may close the dialog: resolves to an error message to show (dialog stays open) or null to close. */
export type DialogGuard = (id: string) => Promise<string | null> | null

export interface DialogState { title: string; message: string; buttons: DialogButton[]; initialFocus?: string; resolve: (id: string) => void; guard?: DialogGuard }

export function createDialogHost() {
  const dlg = ref<DialogState | null>(null)
  const error = ref('')
  let busy = false
  function ask(title: string, message: string, buttons: DialogButton[], initialFocus?: string, guard?: DialogGuard): Promise<string> {
    error.value = ''
    return new Promise((resolve) => { dlg.value = { title, message, buttons, initialFocus, resolve, guard } })
  }
  async function choose(id: string) {
    const d = dlg.value
    if (!d || busy) return
    const pending = d.guard?.(id)
    if (pending) {
      busy = true
      const err = await pending.finally(() => { busy = false })
      if (dlg.value !== d) return
      if (err) { error.value = err; return }
    }
    dlg.value = null
    d.resolve(id)
  }
  return { dlg, error, ask, choose }
}

/** RPC code of the sidecar's refusal to open a file on a network location (UNC). */
export const UNSUPPORTED_LOCATION_RPC = -32051

export function isUnsupportedLocation(e: unknown): boolean {
  const o = (e ?? {}) as Record<string, any>
  if ([o.rpcCode, o.code, o.error?.code, o.data?.code].some((c) => c === UNSUPPORTED_LOCATION_RPC)) return true
  const re = /-32051/
  return [e, o.message, o.rawMessage, o.error?.message].some((m) => typeof m === 'string' && re.test(m))
}

/** Button focused when the export-finished dialog opens (and triggered by Enter): the primary OK, never Open. */
export const EXPORT_DONE_INITIAL_FOCUS = 'ok'

export interface ExportDoneLabels { ok: string; open: string; openFailed: string; openUnsupported: string }

/** Buttons, initial focus and close guard of the "export finished" dialog. Open is offered only when the client can open files. */
export function buildExportDoneDialog(o: { path: string; client: { openFile?: (path: string) => Promise<void> }; labels: ExportDoneLabels; onError?: (e: unknown) => void }) {
  const { client, path, labels } = o
  const buttons: DialogButton[] = [{ id: 'ok', label: labels.ok, variant: 'primary', escape: true }]
  if (client.openFile) buttons.push({ id: 'open', label: labels.open })
  const guard: DialogGuard = (id) => {
    if (id !== 'open') return null
    if (!client.openFile) return Promise.resolve(labels.openFailed)
    return client.openFile(path).then(() => null, (e) => { o.onError?.(e); return isUnsupportedLocation(e) ? labels.openUnsupported : labels.openFailed })
  }
  return { buttons, initialFocus: EXPORT_DONE_INITIAL_FOCUS, guard }
}
