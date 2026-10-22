import { createApp, h, ref } from 'vue'
import MarkdownBlock from '../blocks/MarkdownBlock.vue'
import { BridgeKey, StoreKey } from '../injection'
import { createImageClient } from '../files/imageClient'
import { runExport } from '../export/runExport'
import { buildExportLabels } from '../export/labels'
import { DEFAULT_EXPORT_OPTIONS } from '../export/options'
import { setLocale, t } from '../i18n'
import { installFileDropGuard } from '../shell/fileDropGuard'
import { useNotebookStore } from '../state/notebookStore'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#1f2328;--color-muted:#f6f8fa;--color-muted-foreground:#656d76;--color-border:#d0d7de;--color-primary:#0969da',
  dark: '--color-background:#1a1a1a;--color-foreground:#eeeeee;--color-muted:#2a2a2a;--color-muted-foreground:#a1a1aa;--color-border:#444;--color-primary:#58a6ff',
}

interface Fx { mime: string; base64: string; size: number; mtimeMs: number; width: number; height: number }
type Entry = Fx | { error: string }

const b64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }

async function canvasFx(mime: string, width: number, height: number, color: string): Promise<Fx> {
  const c = document.createElement('canvas')
  c.width = width; c.height = height
  const g = c.getContext('2d')!
  g.fillStyle = color; g.fillRect(0, 0, width, height)
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), mime, 0.9))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { mime, base64: b64(bytes), size: bytes.length, mtimeMs: 1, width, height }
}

function gifFx(): Fx {
  const w = 8, hgt = 6
  const bits: number[] = []
  const put = (v: number) => { for (let i = 0; i < 3; i++) bits.push((v >> i) & 1) }
  for (let i = 0; i < (w * hgt) / 2; i++) { put(4); put(0); put(0) }
  put(5)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v |= (bits[i + j] ?? 0) << j; data.push(v) }
  const bytes = new Uint8Array([
    ...'GIF89a'.split('').map((c) => c.charCodeAt(0)), w, 0, hgt, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255,
    0x2c, 0, 0, 0, 0, w, 0, hgt, 0, 0, 2, data.length, ...data, 0, 0x3b,
  ])
  return { mime: 'image/gif', base64: b64(bytes), size: bytes.length, mtimeMs: 1, width: w, height: hgt }
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMdImgFixtures = async () => ({
    png: await canvasFx('image/png', 120, 80, '#d33'),
    jpeg: await canvasFx('image/jpeg', 100, 60, '#3a3'),
    webp: await canvasFx('image/webp', 90, 70, '#33d'),
    gif: gifFx(),
  })
  const fakeBridge = (images: Record<string, Entry>, delayMs: number) => ({
    invoke: async (method: string, params: any) => {
      ;(w.__rpc ??= []).push({ method, params })
      if (method !== 'notebook/readImage') throw new Error(`[-32601] unexpected ${method}`)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      const e = images[params.relPath]
      if (!e) throw new Error('[-32040] [notFound] image not found')
      if ('error' in e) throw new Error(`[-32040] [${e.error}] ${e.error}`)
      return e
    },
  }) as any

  w.__sqlnbMountMdImg = (o: { theme: 'light' | 'dark'; value: string; path: string | null; images: Record<string, Entry>; delayMs?: number; locale?: string }) => {
    setLocale(o.locale ?? 'zh-CN')
    w.__rpc = []
    w.__mdApp?.unmount()
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.className = 'app'
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;padding:8px;width:720px`)
    root.innerHTML = '<div id="prev" style="height:40px">above</div><div id="blk"></div><div id="next" style="height:40px">below</div>'
    host.appendChild(root)
    const value = ref(o.value)
    w.__sqlnbMdSetValue = (v: string) => { value.value = v }
    w.__mdApp = createApp({ render: () => h(MarkdownBlock, { modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v } }) })
    w.__mdApp.provide(BridgeKey, fakeBridge(o.images, o.delayMs ?? 0))
    w.__mdApp.provide(StoreKey, { path: ref(o.path) })
    w.__mdApp.mount(root.querySelector('#blk')!)
  }

  w.__sqlnbMdImgExport = async (o: { value: string; path: string | null; images: Record<string, Entry>; capImages?: boolean }) => {
    setLocale('zh-CN')
    w.__rpc = []
    const store = {
      nb: ref({ sqlnb: '1', metadata: {}, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'm', type: 'markdown', content: o.value, metadata: {} }] }),
      path: ref(o.path), runs: new Map(), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
      dirty: ref(false), refreshAnalysis: async () => ({}), refreshBigNumber: async () => ({}),
    } as any
    let html = ''
    const client: any = { saveHtml: async (_p: string, s: string) => { html = s; return { bytes: s.length } }, pdf: async () => ({ bytes: 0 }), browserStatus: async () => ({ found: false, source: 'none' }) }
    const r = await runExport({
      store, client, settings: { browserPath: ref('') } as any, labels: buildExportLabels((k, p) => t(k as any, p as any)), path: '/o/x.html', dataSourceName: () => undefined,
      readImage: createImageClient(fakeBridge(o.images, 0)).readImage,
    }, { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
    return { ok: r.ok, html }
  }

  // The app installs this once at the root; the smoke page has no App, so install it here.
  installFileDropGuard(document)

  // Paste/drop scenario: a real notebook store; the fake host keeps what saveImage wrote and serves it back to readImage.
  w.__sqlnbMountMdPaste = (o: { value: string; path: string | null }) => {
    setLocale('zh-CN')
    w.__rpc = []
    w.__mdApp?.unmount()
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.className = 'app'
    root.setAttribute('style', `${TOKENS.light};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;padding:8px;width:720px`)
    root.innerHTML = '<div id="blk"></div><div id="next" style="height:40px">below</div>'
    host.appendChild(root)
    const nb: any = createEmptyNotebook()
    nb.blocks = [{ id: 'm1', type: 'markdown', content: o.value }]
    const store = useNotebookStore()
    store.load(serializeNotebook(nb), o.path, o.path ? 1 : null)
    const saved = new Map<string, { mime: string; base64: string }>()
    let n = 0
    const bridge = {
      invoke: async (method: string, params: any) => {
        ;(w.__rpc ??= []).push({ method, params: { ...params, base64: params.base64 ? `<${params.base64.length}b64>` : undefined } })
        if (method === 'notebook/saveImage') {
          const rel = `report.sqlnb.assets/image-20260101-00000${++n}-abcd123${n}.png`
          saved.set(rel, { mime: params.mime, base64: params.base64 })
          return { relPath: rel, size: 1 }
        }
        if (method === 'notebook/readImage') {
          const e = saved.get(params.relPath)
          if (!e) throw new Error('[-32040] [notFound] image not found')
          return { ...e, size: 1, mtimeMs: 1, width: 120, height: 80 }
        }
        throw new Error(`[-32601] unexpected ${method}`)
      },
    } as any
    w.__mdStore = { content: () => store.nb.value.blocks[0].content, depth: () => store.history.undoDepth.value, undo: () => store.undo(), redo: () => store.redo(), type: (v: string) => store.updateContent('m1', v, { coalesce: true }) }
    w.__mdApp = createApp({ render: () => h(MarkdownBlock, { modelValue: store.nb.value.blocks[0].content ?? '', blockId: 'm1', 'onUpdate:modelValue': (v: string) => store.updateContent('m1', v, { coalesce: true }) }) })
    w.__mdApp.provide(BridgeKey, bridge)
    w.__mdApp.provide(StoreKey, store)
    w.__mdApp.mount(root.querySelector('#blk')!)
  }
}
