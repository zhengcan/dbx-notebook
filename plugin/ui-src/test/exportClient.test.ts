import { describe, it, expect, vi } from 'vitest'
import { createExportClient, ExportCancelled, ExportError } from '../src/export/exportClient'

function mk(handler: (method: string, params: any) => unknown) {
  const calls: { method: string; params: any }[] = []
  const bridge: any = {
    invoke: vi.fn(async (method: string, params: any, opts?: any) => {
      calls.push({ method, params })
      return handler(method, params)
    }),
  }
  return { bridge, calls }
}

describe('exportClient', () => {
  it('pdf starts then polls until done', async () => {
    let n = 0
    const { bridge, calls } = mk((m) => {
      if (m === 'export/pdfStart') return { jobId: 'j1' }
      if (m === 'export/pdfStatus') return ++n < 3 ? { state: 'running' } : { state: 'done', path: '/a.pdf', bytes: 42 }
      return {}
    })
    const progress: string[] = []
    const c = createExportClient(bridge)
    const r = await c.pdf({ html: '<p>', path: '/a.pdf', orientation: 'landscape', manual: '/b', pollMs: 1, onProgress: (s) => progress.push(s) })
    expect(r).toEqual({ bytes: 42 })
    expect(calls[0]).toEqual({ method: 'export/pdfStart', params: { html: '<p>', path: '/a.pdf', orientation: 'landscape', manualBrowserPath: '/b' } })
    expect(calls.filter((x) => x.method === 'export/pdfStatus').length).toBe(3)
    expect(calls[1].params).toEqual({ jobId: 'j1' })
    expect(progress).toContain('running')
  })

  it('failed rejects with code and message', async () => {
    const { bridge } = mk((m) => (m === 'export/pdfStart' ? { jobId: 'j' } : { state: 'failed', code: 'EXPORT_TIMEOUT', message: 'slow' }))
    const p = createExportClient(bridge).pdf({ html: 'x', path: '/a.pdf', orientation: 'portrait', pollMs: 1 })
    await expect(p).rejects.toMatchObject({ name: 'ExportError', code: 'EXPORT_TIMEOUT', message: 'slow' })
    await expect(p).rejects.toBeInstanceOf(ExportError)
  })

  it('abort cancels and stops polling', async () => {
    const ac = new AbortController()
    const { bridge, calls } = mk((m) => {
      if (m === 'export/pdfStart') return { jobId: 'j9' }
      if (m === 'export/pdfStatus') return { state: 'running' }
      return { cancelled: true }
    })
    const p = createExportClient(bridge).pdf({ html: 'x', path: '/a.pdf', orientation: 'portrait', pollMs: 5, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(ExportCancelled)
    const cancel = calls.find((x) => x.method === 'export/pdfCancel')
    expect(cancel?.params).toEqual({ jobId: 'j9' })
    const n = calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBe(n)
  })

  it('already-aborted signal never starts a job', async () => {
    const ac = new AbortController(); ac.abort()
    const { bridge, calls } = mk(() => ({}))
    await expect(createExportClient(bridge).pdf({ html: 'x', path: '/a.pdf', orientation: 'portrait', signal: ac.signal })).rejects.toBeInstanceOf(ExportCancelled)
    expect(calls.length).toBe(0)
  })

  it('cancelled state rejects ExportCancelled', async () => {
    const { bridge } = mk((m) => (m === 'export/pdfStart' ? { jobId: 'j' } : { state: 'cancelled' }))
    await expect(createExportClient(bridge).pdf({ html: 'x', path: '/a.pdf', orientation: 'portrait', pollMs: 1 })).rejects.toBeInstanceOf(ExportCancelled)
  })

  it('pickSave passes through cancel; saveHtml and browserStatus', async () => {
    const { bridge, calls } = mk((m) => {
      if (m === 'export/pickSave') return { cancelled: true }
      if (m === 'export/saveHtml') return { path: '/x.html', bytes: 7 }
      return { found: false, source: 'manual', reason: 'bad' }
    })
    const c = createExportClient(bridge)
    expect(await c.pickSave('r', 'pdf')).toEqual({ cancelled: true })
    expect(calls[0].params).toEqual({ suggestedName: 'r', ext: 'pdf' })
    expect(await c.saveHtml('/x.html', '<p>')).toEqual({ bytes: 7 })
    const s = await c.browserStatus('/m')
    expect(s.found).toBe(false)
    expect(calls[2]).toEqual({ method: 'export/browserStatus', params: { manualPath: '/m' } })
  })

  it('pickFolder calls export/pickFolder with no params and passes the result through', async () => {
    const { bridge, calls } = mk(() => ({ path: '/x/y' }))
    expect(await createExportClient(bridge).pickFolder()).toEqual({ path: '/x/y' })
    expect(calls[0]).toEqual({ method: 'export/pickFolder', params: {} })
  })
  it('pickFolder passes the default folder when given', async () => {
    const { bridge, calls } = mk(() => ({ cancelled: true }))
    await createExportClient(bridge).pickFolder('/Users/me/out')
    expect(calls[0]).toEqual({ method: 'export/pickFolder', params: { defaultPath: '/Users/me/out' } })
  })

  it('saveHtml sends overwrite only when asked', async () => {
    const { bridge, calls } = mk(() => ({ path: '/a.html', bytes: 3 }))
    const c = createExportClient(bridge)
    await c.saveHtml('/a.html', 'x')
    await c.saveHtml('/a.html', 'x', true)
    expect(calls[0].params).toEqual({ path: '/a.html', html: 'x' })
    expect(calls[1].params).toEqual({ path: '/a.html', html: 'x', overwrite: true })
  })
  it('pdf sends overwrite when asked and surfaces a target-exists job failure', async () => {
    const { bridge, calls } = mk((m) => (m === 'export/pdfStart' ? { jobId: 'j' } : { state: 'failed', code: 'TARGET_EXISTS', message: 'exists' }))
    const p = createExportClient(bridge).pdf({ html: 'x', path: '/a.pdf', orientation: 'portrait', overwrite: true, pollMs: 1 })
    await expect(p).rejects.toMatchObject({ name: 'ExportError', code: 'TARGET_EXISTS' })
    expect(calls[0].params.overwrite).toBe(true)
  })
})

describe('exportClient.exporterName', () => {
  const name = async (h: (m: string, p: any) => unknown) => createExportClient(mk(h).bridge).exporterName()
  it('returns the trimmed string via invoke system/user', async () => {
    const { bridge, calls } = mk(() => ({ name: ' 张 三 ' }))
    expect(await createExportClient(bridge).exporterName()).toBe('张 三')
    expect(calls).toEqual([{ method: 'system/user', params: {} }])
    expect(bridge.invoke.mock.calls[0][2]).toEqual({ timeoutMs: 30_000 })
  })
  it('returns null on reject / {name:null} / number / empty / garbage', async () => {
    expect(await name(() => { throw new Error('x') })).toBeNull()
    expect(await name(() => ({ name: null }))).toBeNull()
    expect(await name(() => ({ name: 5 }))).toBeNull()
    expect(await name(() => ({ name: '  ' }))).toBeNull()
    expect(await name(() => undefined)).toBeNull()
  })
  it('slices to 128 chars', async () => {
    expect((await name(() => ({ name: 'a'.repeat(300) })))!.length).toBe(128)
  })
})
