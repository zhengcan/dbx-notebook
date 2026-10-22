import { createApp, h } from 'vue'
import MarkdownBlock from '../blocks/MarkdownBlock.vue'
import { BridgeKey, DropCandidateKey, DropGateKey, DropTargetsKey, FileTransferKey, StoreKey } from '../injection'
import { createFileTransferClient } from '../files/fileTransferClient'
import { createDropGate } from '../blocks/dropGate'
import { createDropTargets } from '../blocks/mdDropTargets'
import { useDesktopDrop } from '../blocks/useDesktopDrop'
import { setLocale } from '../i18n'
import { createHistoryActions } from '../shell/historyActions'
import { useNotebookStore } from '../state/notebookStore'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'

const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#1f2328;--color-muted:#f6f8fa;--color-muted-foreground:#656d76;--color-border:#d0d7de;--color-primary:#0969da',
  dark: '--color-background:#1a1a1a;--color-foreground:#eeeeee;--color-muted:#2a2a2a;--color-muted-foreground:#a1a1aa;--color-border:#444;--color-primary:#58a6ff',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountMdTb = (o: { theme: 'light' | 'dark'; value: string; width?: number; locale?: string; drop?: 'full' | 'nopick' | 'none' }) => {
    setLocale(o.locale ?? 'zh-CN')
    w.__mdApp?.unmount()
    w.__mdDrop?.dispose()
    w.__mdDrop = null
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.className = 'app'
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;padding:8px;width:${o.width ?? 720}px`)
    root.innerHTML = '<div id="prev" style="height:40px">above</div><div id="blk"></div><div id="next" style="height:40px">below</div>'
    host.appendChild(root)
    const nb: any = createEmptyNotebook()
    nb.blocks = [{ id: 'm1', type: 'markdown', content: o.value }]
    const store = useNotebookStore()
    store.load(serializeNotebook(nb), o.drop ? '/n/n.sqlnb' : null, o.drop ? 1 : null)
    const hist = createHistoryActions(store)
    w.__mdStore = { content: () => store.nb.value.blocks[0].content, depth: () => store.history.undoDepth.value, undo: () => hist.undo(), redo: () => hist.redo(), type: (v: string) => store.updateContent('m1', v, { coalesce: true }) }
    w.__mdApp = createApp({ render: () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }) })
    w.__mdApp.provide(StoreKey, store)
    if (o.drop) {
      // Fake desktop host: a controllable fileTransfer namespace plus a bridge that fakes the image sidecar.
      const ft: any = { cancels: [] as string[], reads: 0, pickResult: null as unknown, dropCb: null as any, stateCb: null as any }
      const host: any = {
        capabilities: { fileTransfer: { drop: o.drop !== 'none', pick: o.drop === 'full', read: true } },
        fileTransfer: o.drop === 'none' ? undefined : {
          onDrop: (fn: any) => { ft.dropCb = fn; return () => { ft.dropCb = null } },
          onDragState: (fn: any) => { ft.stateCb = fn; return () => { ft.stateCb = null } },
          pick: async () => ft.pickResult,
          read: async () => { ft.reads++; return { dataBase64: PNG1, length: atob(PNG1).length, eof: true } },
          cancel: async (id: string) => { ft.cancels.push(id) },
        },
      }
      ft.size = atob(PNG1).length
      ft.emit = (files: any[], meta: any) => ft.dropCb?.(files, meta ?? { dropId: 'd' + Math.random(), truncated: false })
      ft.drag = (a: boolean) => ft.stateCb?.(a)
      w.__ft = ft
      let n = 0
      const bridge: any = { invoke: async (m: string) => {
        if (m === 'notebook/saveImage') return { relPath: `n.sqlnb.assets/image-${++n}.png`, size: 3 }
        if (m === 'notebook/readImage') return { mime: 'image/png', base64: PNG1, size: 3, mtimeMs: 1, width: 1, height: 1 }
        throw new Error('unexpected ' + m)
      } }
      const client = createFileTransferClient(host)
      const targets = createDropTargets()
      const gate = createDropGate()
      w.__dropNotice = ''
      const d = useDesktopDrop({ client, targets, gate, say: (_k, text) => { w.__dropNotice = text } })
      w.__mdDrop = d
      w.__mdApp.provide(BridgeKey, bridge)
      w.__mdApp.provide(FileTransferKey, client)
      w.__mdApp.provide(DropGateKey, gate)
      w.__mdApp.provide(DropTargetsKey, targets)
      w.__mdApp.provide(DropCandidateKey, d.candidateId)
    }
    w.__mdApp.mount(root.querySelector('#blk')!)
  }
}
