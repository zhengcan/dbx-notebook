import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/export/options'
import { runExport } from '../src/export/runExport'
import { createExportClient } from '../src/export/exportClient'
import { setLocale, t } from '../src/i18n'
import { buildExportLabels } from '../src/export/labels'

setLocale('en')
const res = (rows: unknown[][]) => ({ columns: [{ name: 'a' }], rows, truncated: false, elapsedMs: 1, dbType: 'x' })
function mkStore(opts: { blocks?: any[]; runs?: Record<string, any> } = {}) {
  const blocks = opts.blocks ?? [{ id: 's1', type: 'sql', content: 'select 1', metadata: {} }]
  const store: any = {
    nb: ref({ sqlnb: '1', metadata: { title: 'T' }, settings: { outputs: 'separate' }, connections: [], blocks }),
    runs: new Map(Object.entries(opts.runs ?? { s1: { status: 'ok', result: res([[1]]), executedAt: '2026-10-18T00:00:00Z' } })),
    analysis: new Map(), bigNumbers: new Map(),
    isStale: () => false, isPartial: () => false, transposed: new Map(),
    dirty: ref(false),
    refreshAnalysis: vi.fn(async () => ({})), refreshBigNumber: vi.fn(async () => ({})),
  }
  return store
}
function mkClient(over: Record<string, any> = {}) {
  const order: string[] = []
  const client: any = {
    saveHtml: vi.fn(async () => { order.push('saveHtml'); return { bytes: 10 } }),
    pdf: vi.fn(async () => { order.push('pdf'); return { bytes: 20 } }),
    browserStatus: vi.fn(),
    ...over,
  }
  return { client, order }
}
const deps = (store: any, client: any, extra: any = {}) => ({
  store, client, settings: { browserPath: ref('') }, labels: buildExportLabels((k, p) => t(k as any, p as any)), path: '/o/x.html', dataSourceName: () => undefined, ...extra,
})
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, format: 'html', ...o })

describe('runExport', () => {
  it('html flow: saves to the given path without any save dialog, store untouched', async () => {
    const store = mkStore(); const { client, order } = mkClient()
    const stages: string[] = []
    const r = await runExport(deps(store, client, { onStage: (s: string) => stages.push(s) }), opts()).promise
    expect(r).toMatchObject({ ok: true, path: '/o/x.html', bytes: 10 })
    expect(order).toEqual(['saveHtml'])
    expect(client.saveHtml.mock.calls[0][0]).toBe('/o/x.html')
    expect(client.pickSave).toBeUndefined()
    expect(stages).toEqual(['prepare', 'charts', 'render', 'save', 'done'])
    expect(store.dirty.value).toBe(false)
  })
  it('pdf flow renders to the chosen path', async () => {
    const { client } = mkClient()
    const r = await runExport(deps(mkStore(), client, { path: '/o/y.pdf' }), opts({ format: 'pdf' })).promise
    expect(r).toMatchObject({ ok: true, path: '/o/y.pdf', bytes: 20 })
    expect(client.pdf.mock.calls[0][0].path).toBe('/o/y.pdf')
  })
  it('no content: nothing written', async () => {
    const store = mkStore({ runs: {} }); const { client } = mkClient()
    const r = await runExport(deps(store, client), opts()).promise
    expect(r).toMatchObject({ ok: false, code: 'no-content' })
    expect(client.saveHtml).not.toHaveBeenCalled()
  })
  it('pdf abort calls pdfCancel and yields cancelled', async () => {
    const calls: string[] = []
    const bridge: any = { invoke: vi.fn(async (m: string) => { calls.push(m); return m === 'export/pdfStart' ? { jobId: 'j' } : m === 'export/pdfStatus' ? { state: 'running' } : m === 'export/pickSave' ? { path: '/o/x.pdf' } : {} }) }
    const store = mkStore()
    const run = runExport(deps(store, createExportClient(bridge), { path: '/o/x.pdf' }), opts({ format: 'pdf' }))
    await vi.waitFor(() => expect(calls).toContain('export/pdfStatus'))
    run.abort()
    expect(await run.promise).toMatchObject({ ok: false, code: 'cancelled' })
    expect(calls).toContain('export/pdfCancel')
  })
  it('pdf passes manual browser path; browser missing maps', async () => {
    const store = mkStore()
    const err = Object.assign(new Error('no browser'), { rpcCode: -32020 })
    const { client } = mkClient({ pdf: vi.fn(async () => { throw err }) })
    const d = deps(store, client); d.settings.browserPath.value = '/b'
    const r = await runExport(d, opts({ format: 'pdf' })).promise
    expect(client.pdf.mock.calls[0][0].manual).toBe('/b')
    expect(r).toMatchObject({ ok: false, code: 'browser-missing' })
  })
  it('saveHtml IO failure -> write-failed with reason', async () => {
    const { client } = mkClient({ saveHtml: vi.fn(async () => { throw Object.assign(new Error('read-only dir'), { rpcCode: -32013 }) }) })
    const r = await runExport(deps(mkStore(), client), opts()).promise
    expect(r).toMatchObject({ ok: false, code: 'write-failed' })
    expect((r as any).message).toContain('read-only dir')
  })
  it('chart failure still succeeds and warns with the reason', async () => {
    const store = mkStore({
      blocks: [{ id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1' } }, { id: 'c1', type: 'chart', content: '', metadata: { data: 's1', spec: { mark: 'bar' }, title: 'Sales' } }],
      runs: { s1: { status: 'ok', result: res([]), executedAt: '2026-10-18T00:00:00Z' } },
    })
    const { client } = mkClient()
    const r = await runExport(deps(store, client), opts()).promise
    expect(r.ok).toBe(true)
    expect((r as any).warnings.join('|')).toContain('c1: No data')
    expect(store.refreshAnalysis).not.toHaveBeenCalled()
  })
  it('chart render error reason reaches warnings', async () => {
    vi.resetModules()
    vi.doMock('../src/export/chartSvg', () => ({ renderChartSvgs: async (secs: any[]) => ({ svgs: Object.fromEntries(secs.map((x) => [x.blockId, { svg: null, error: 'boom' }])), failed: secs.map((x) => x.blockId) }) }))
    const { runExport: re } = await import('../src/export/runExport')
    const store = mkStore({
      blocks: [{ id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1' } }, { id: 'c1', type: 'chart', content: '', metadata: { data: 's1', spec: { mark: 'bar' }, title: 'Sales' } }],
      runs: { s1: { status: 'ok', result: res([[1]]), executedAt: '2026-10-18T00:00:00Z' } },
    })
    const r = await re(deps(store, mkClient().client), opts()).promise
    vi.doUnmock('../src/export/chartSvg')
    expect(r.ok).toBe(true)
    expect((r as any).warnings.join('|')).toContain('c1: boom')
  })
  it('prepare refreshes missing analysis/big-number locally before the model', async () => {
    const store = mkStore({
      blocks: [{ id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1' } }, { id: 'c1', type: 'chart', content: '', metadata: { data: 's1' } }, { id: 'n1', type: 'big-number', content: '', metadata: { data: 's1' } }],
    })
    store.refreshAnalysis = vi.fn(async (id: string) => { const r = { status: 'ok' }; store.analysis.set(id, r); return r })
    const { client } = mkClient()
    await runExport(deps(store, client), opts()).promise
    expect(store.refreshAnalysis).toHaveBeenCalledWith('c1')
    expect(store.analysis.has('c1')).toBe(true)
    expect(store.refreshBigNumber).toHaveBeenCalledWith('n1')
  })
  it('a rejecting refresh does not fail the export', async () => {
    const store = mkStore({ blocks: [{ id: 's1', type: 'sql', content: 'x', metadata: { resultName: 's1' } }, { id: 'n1', type: 'big-number', content: '', metadata: { data: 's1' } }] })
    store.refreshBigNumber = vi.fn(async () => { throw new Error('x') })
    const r = await runExport(deps(store, mkClient().client), opts()).promise
    expect(r.ok).toBe(true)
  })

  describe('existing target', () => {
    const exists = () => Object.assign(new Error('[-32030] exists'), { rpcCode: -32030 })
    it('html: sidecar says the target exists -> target-exists, nothing reported as saved', async () => {
      const { client } = mkClient({ saveHtml: vi.fn(async () => { throw exists() }) })
      const r = await runExport(deps(mkStore(), client), opts()).promise
      expect(r).toMatchObject({ ok: false, code: 'target-exists' })
    })
    it('pdf: pdfStart error and job failure both map to target-exists', async () => {
      for (const err of [exists(), Object.assign(new Error('exists'), { code: 'TARGET_EXISTS' })]) {
        const { client } = mkClient({ pdf: vi.fn(async () => { throw err }) })
        expect(await runExport(deps(mkStore(), client), opts({ format: 'pdf' })).promise).toMatchObject({ ok: false, code: 'target-exists' })
      }
    })
    it('overwrite is passed to the client; absent by default', async () => {
      const { client } = mkClient()
      await runExport(deps(mkStore(), client), opts()).promise
      expect(client.saveHtml.mock.calls[0][2]).toBeFalsy()
      await runExport(deps(mkStore(), client, { overwrite: true }), opts()).promise
      expect(client.saveHtml.mock.calls[1][2]).toBe(true)
      await runExport(deps(mkStore(), client, { overwrite: true }), opts({ format: 'pdf' })).promise
      expect(client.pdf.mock.calls[0][0].overwrite).toBe(true)
    })
  })
})
