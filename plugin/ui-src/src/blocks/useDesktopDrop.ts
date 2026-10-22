// Subscribes to host (desktop OS) file drops and routes them to a Markdown block. Every received handle is
// released exactly once, whatever happens to the drop.
import { ref, type Ref } from 'vue'
import { t } from '../i18n'
import type { FileTransferClient, HostDrop } from '../files/fileTransferClient'
import type { DropGate } from './dropGate'
import { dropSignature, createDropGate } from './dropGate'
import { pickDropTarget, type createDropTargets } from './mdDropTargets'
import { inspectHandles } from './mdImagePaste'

export interface DesktopDropOpts {
  client: FileTransferClient
  targets: ReturnType<typeof createDropTargets>
  say: (kind: 'error' | 'info', text: string) => void
  gate?: DropGate
  /** null: host not there yet (retry later); a promise: wait for it before subscribing; undefined: subscribe now. */
  ready?: () => Promise<unknown> | null | undefined
}

const RETRY_MS = 250
const RETRY_MAX = 20

export const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null

export function useDesktopDrop(opts: DesktopDropOpts): { dragging: Ref<boolean>; candidateId: Ref<string | null>; hint: Ref<boolean>; dispose(): void } {
  const gate = opts.gate ?? createDropGate()
  const dragging = ref(false)
  const candidateId = ref<string | null>(null)
  const hint = ref(false)
  const ac = new AbortController()
  let disposed = false
  let queue: Promise<void> = Promise.resolve()
  let offDrop: () => void = () => {}
  let offState: () => void = () => {}

  const onMove = () => clear()
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
  const onBlur = () => clear()
  function clear() {
    dragging.value = false
    candidateId.value = null
    hint.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('blur', onBlur)
  }
  function onState(active: boolean) {
    if (disposed) return
    if (!active) { clear(); return }
    if (modalOpen()) return
    const { target } = pickDropTarget(opts.targets.list(), opts.targets.lastActiveId())
    dragging.value = true
    candidateId.value = target?.id ?? null
    hint.value = !target
    window.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
  }

  async function handle(d: HostDrop) {
    const files = d.files
    try {
      if (disposed) return
      if (gate.claim('host', dropSignature(files), d.dropId || undefined) === 'duplicate') return
      if (modalOpen() || files.length === 0) return
      const blocks = opts.targets.list()
      const { target, reason } = pickDropTarget(blocks, opts.targets.lastActiveId())
      if (!target) { opts.say('info', t('mddrop.pickBlock')); return }
      const { sources, summary } = inspectHandles(files, d.truncated, opts.client)
      await target.insert(sources, { signal: ac.signal, summary, viaRecent: reason === 'recent' && blocks.length > 1 })
    } catch {
      if (!disposed) opts.say('error', t('mdimg.pasteFailed'))
    } finally {
      await Promise.all(files.map((f) => opts.client.release(f)))
    }
  }
  function onDrop(d: HostDrop) {
    clear()
    queue = queue.then(() => handle(d)).catch(() => {})
  }

  function subscribe() {
    if (disposed) return
    offDrop = opts.client.onDrop(onDrop)
    offState = opts.client.onDragState(onState)
  }
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  function start() {
    if (disposed) return
    const r = opts.ready ? opts.ready() : undefined
    if (r === null) {
      if (++attempts <= RETRY_MAX) retry = setTimeout(start, RETRY_MS)
      return
    }
    if (r) void Promise.resolve(r).catch(() => {}).then(subscribe)
    else subscribe()
  }
  start()

  return {
    dragging, candidateId, hint,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(retry)
      ac.abort()
      offDrop(); offState()
      clear()
    },
  }
}
