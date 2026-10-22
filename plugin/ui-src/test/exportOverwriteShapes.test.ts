import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'
import { runExport } from '../src/export/runExport'
import { createExportClient } from '../src/export/exportClient'
import { createHostBridge } from '../src/host/bridge'
import { setLocale, t } from '../src/i18n'
import { buildExportLabels } from '../src/export/labels'

setLocale('en')
const MSG = '[-32030] Target already exists: /o/x.html'
// Ways a host can surface the sidecar's JSON-RPC error { code: -32030, message: MSG } to the iframe.
const shapes: [string, () => unknown][] = [
  ['Error with the sidecar message', () => new Error(MSG)],
  ['plain string', () => MSG],
  ['object {code, message}', () => ({ code: -32030, message: MSG })],
  ['object with a bare message and numeric code', () => Object.assign(new Error('Target already exists: /o/x.html'), { code: -32030 })],
  ['host-prefixed message', () => new Error(`Plugin RPC error: ${MSG}`)],
  ['host-prefixed with the code only mid-message', () => new Error('invoke export/saveHtml failed (code -32030): Target already exists')],
  ['nested JSON-RPC error object', () => ({ error: { code: -32030, message: 'Target already exists: /o/x.html' } })],
  ['JSON text', () => JSON.stringify({ code: -32030, message: 'Target already exists' })],
]

function store() {
  return {
    nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'm1', type: 'markdown', content: 'hi', metadata: {} }] }),
    runs: new Map(), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(), dirty: ref(false),
    refreshAnalysis: vi.fn(), refreshBigNumber: vi.fn(),
  } as any
}
function hostClient(reject: () => unknown, seen: unknown[] = []) {
  ;(globalThis as any).window.dbxPlugin = {
    invoke: vi.fn(async (_m: string, p: unknown) => { seen.push(p); if (!(p as any).overwrite) throw reject(); return { path: '/o/x.html', bytes: 5 } }),
  }
  return createExportClient(createHostBridge())
}
const deps = (client: any, extra: any = {}) => ({ store: store(), client, settings: { browserPath: ref('') }, labels: buildExportLabels((k, p) => t(k as any, p as any)), path: '/o/x.html', dataSourceName: () => undefined, ...extra })

describe('existing target through the real host bridge wrapper', () => {
  for (const [name, make] of shapes) {
    it(`${name} -> target-exists, then retry with overwrite:true succeeds`, async () => {
      const seen: any[] = []
      const client = hostClient(make, seen)
      const first = await runExport(deps(client), { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
      expect(first).toMatchObject({ ok: false, code: 'target-exists' })
      const again = await runExport(deps(client, { overwrite: true }), { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
      expect(again).toMatchObject({ ok: true })
      expect(seen[1].overwrite).toBe(true)
    })
  }
  it('an unrelated failure is not mistaken for an existing target', async () => {
    const client = hostClient(() => new Error('[-32013] Cannot write /o/x.html: permission denied'))
    expect(await runExport(deps(client), { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise).toMatchObject({ ok: false, code: 'write-failed' })
  })
  it('an exception that is not an Error never escapes as a rejection', async () => {
    const client: any = { saveHtml: vi.fn(async () => { throw undefined }), pdf: vi.fn(), browserStatus: vi.fn() }
    expect(await runExport(deps(client), { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise).toMatchObject({ ok: false })
  })
})
