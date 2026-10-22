import { describe, it, expect, vi } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { createFakeBridge } from '../src/host/fakeBridge'
import { HostError } from '../src/host/bridge'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFileActions } from '../src/shell/fileActions'

const text = (t = 'x') => { const nb = createEmptyNotebook(); (nb.metadata as any).note = t; return serializeNotebook(nb) }
const rpc = (c: number) => new Error(`[${c}] e`)

function setup(handlers: Record<string, (p: any) => unknown> = {}, over: Record<string, any> = {}) {
  const bridge = createFakeBridge({ invokeHandlers: { 'notebook/touchRecent': () => ({}), ...handlers } })
  const store = useNotebookStore()
  const deps = {
    bridge, store,
    confirm: vi.fn(async () => 'discard' as const),
    askExternalChange: vi.fn(async () => 'cancel' as const),
    notify: vi.fn(),
    ...over,
  }
  const fa = createFileActions(deps as any)
  const methods = () => (bridge.calls as any[]).filter((c) => c.method === 'invoke').map((c) => c.args.method)
  const callsOf = (m: string) => (bridge.calls as any[]).filter((c) => c.args?.method === m).map((c) => c.args.params)
  return { fa, store, deps, methods, callsOf }
}

describe('fileActions', () => {
  it('open with dirty + cancel does nothing', async () => {
    const s = setup({}, { confirm: vi.fn(async () => 'cancel') })
    s.store.load(text(), '/a.sqlnb', 1); s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    expect(s.methods()).not.toContain('notebook/read')
    expect(s.store.path.value).toBe('/a.sqlnb')
  })
  it('open with dirty + discard opens', async () => {
    const s = setup({ 'notebook/read': () => ({ text: text('b'), mtimeMs: 7 }) })
    s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    expect(s.store.path.value).toBe('/b.sqlnb'); expect(s.store.mtimeMs.value).toBe(7)
    expect(s.callsOf('notebook/touchRecent')[0]).toMatchObject({ path: '/b.sqlnb' })
  })
  it('open with dirty + save writes then opens', async () => {
    const s = setup({
      'notebook/write': () => ({ mtimeMs: 2 }),
      'notebook/read': () => ({ text: text('b'), mtimeMs: 7 }),
    }, { confirm: vi.fn(async () => 'save') })
    s.store.load(text(), '/a.sqlnb', 1); s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    const m = s.methods()
    expect(m.indexOf('notebook/write')).toBeLessThan(m.indexOf('notebook/read'))
    expect(s.store.path.value).toBe('/b.sqlnb')
  })
  it('open with dirty + save failing aborts', async () => {
    const s = setup({ 'notebook/write': () => { throw rpc(-32013) } }, { confirm: vi.fn(async () => 'save') })
    s.store.load(text(), '/a.sqlnb', 1); s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    expect(s.methods()).not.toContain('notebook/read')
    expect(s.store.dirty.value).toBe(true)
  })
  it('open without path uses pickOpen; cancelled is no-op', async () => {
    const s = setup({ 'notebook/pickOpen': () => ({ cancelled: true }) })
    await s.fa.open()
    expect(s.methods()).toEqual(['notebook/pickOpen'])
  })
  it('open parse error notifies and keeps notebook', async () => {
    const s = setup({ 'notebook/read': () => ({ text: 'garbage', mtimeMs: 1 }) })
    s.store.load(text('keep'), '/a.sqlnb', 1)
    await s.fa.open('/bad.sqlnb')
    expect(s.deps.notify).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(s.store.path.value).toBe('/a.sqlnb')
  })
  it('new file save goes through saveAs without expectedMtimeMs', async () => {
    const s = setup({ 'notebook/pickSave': () => ({ path: '/n.sqlnb' }), 'notebook/exists': () => ({ exists: false }), 'notebook/write': () => ({ mtimeMs: 3 }) })
    await s.fa.save()
    expect(s.callsOf('notebook/pickSave')[0].suggestedName).toMatch(/\.sqlnb$/)
    const w = s.callsOf('notebook/write')[0]
    expect(w.path).toBe('/n.sqlnb'); expect('expectedMtimeMs' in w).toBe(false)
    expect(s.store.path.value).toBe('/n.sqlnb'); expect(s.store.mtimeMs.value).toBe(3)
    expect(s.callsOf('notebook/touchRecent').length).toBe(1)
  })
  it('save sends expectedMtimeMs and touches recent', async () => {
    const s = setup({ 'notebook/write': () => ({ mtimeMs: 9 }) })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.callsOf('notebook/write')[0]).toMatchObject({ path: '/a.sqlnb', expectedMtimeMs: 5 })
    expect(s.store.dirty.value).toBe(false)
    expect(s.callsOf('notebook/touchRecent').length).toBe(1)
  })
  it('-32011 cancel leaves state', async () => {
    const s = setup({ 'notebook/write': () => { throw rpc(-32011) } })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.deps.askExternalChange).toHaveBeenCalled()
    expect(s.callsOf('notebook/write').length).toBe(1)
    expect(s.store.dirty.value).toBe(true)
  })
  it('stale mtime with real-shape message reaches askExternalChange', async () => {
    const s = setup({ 'notebook/write': () => { throw new Error('[-32011] file changed on disk') } })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.deps.askExternalChange).toHaveBeenCalledTimes(1)
  })
  it('dirty guard: save then reload aborts the open', async () => {
    const s = setup({
      'notebook/write': () => { throw rpc(-32011) },
      'notebook/read': () => ({ text: text('disk'), mtimeMs: 20 }),
    }, { confirm: vi.fn(async () => 'save'), askExternalChange: vi.fn(async () => 'reload') })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    expect(s.callsOf('notebook/read').map((c: any) => c.path)).toEqual(['/a.sqlnb'])
    expect(s.store.path.value).toBe('/a.sqlnb')
  })
  it('confirm receives typed reason', async () => {
    const s = setup({ 'notebook/read': () => ({ text: text(), mtimeMs: 1 }) })
    s.store.addBlock('sql', null)
    await s.fa.open('/b.sqlnb')
    s.store.addBlock('sql', null)
    await s.fa.newNotebook()
    expect(s.deps.confirm.mock.calls.map((c: any) => c[0])).toEqual(['open', 'new'])
  })
  it('-32011 overwrite rewrites without expectedMtimeMs', async () => {
    let n = 0
    const s = setup({ 'notebook/write': () => { if (n++ === 0) throw rpc(-32011); return { mtimeMs: 11 } } },
      { askExternalChange: vi.fn(async () => 'overwrite') })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    const w = s.callsOf('notebook/write')
    expect('expectedMtimeMs' in w[1]).toBe(false)
    expect(s.store.mtimeMs.value).toBe(11); expect(s.store.dirty.value).toBe(false)
  })
  it('-32011 reload loads disk version', async () => {
    const s = setup({
      'notebook/write': () => { throw rpc(-32011) },
      'notebook/read': () => ({ text: text('disk'), mtimeMs: 20 }),
    }, { askExternalChange: vi.fn(async () => 'reload') })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.store.mtimeMs.value).toBe(20); expect(s.store.dirty.value).toBe(false)
    expect(s.store.nb.value.blocks.length).toBe(0)
  })
  it('-32012 notifies naming folder', async () => {
    const s = setup({ 'notebook/write': () => { throw rpc(-32012) } })
    s.store.load(text(), '/gone/dir/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.deps.notify.mock.calls[0][0]).toContain('/gone/dir')
    expect(s.store.dirty.value).toBe(true)
  })
  it('-32010 on save recreates the file without expectedMtimeMs', async () => {
    let n = 0
    const s = setup({ 'notebook/write': () => { if (n++ === 0) throw rpc(-32010); return { mtimeMs: 4 } } })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect('expectedMtimeMs' in s.callsOf('notebook/write')[1]).toBe(false)
    expect(s.store.dirty.value).toBe(false)
  })
  it('other save error keeps dirty', async () => {
    const s = setup({ 'notebook/write': () => { throw rpc(-32013) } })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.deps.notify).toHaveBeenCalled(); expect(s.store.dirty.value).toBe(true)
  })
  it('pick failure falls back to pickPath once', async () => {
    const pickPath = vi.fn(async () => '/f.sqlnb')
    const s = setup({
      'notebook/pickOpen': () => { throw new HostError('UNKNOWN', 'method not found') },
      'notebook/read': () => ({ text: text(), mtimeMs: 1 }),
    }, { pickPath })
    await s.fa.open()
    expect(s.deps.notify).toHaveBeenCalled()
    expect(pickPath).toHaveBeenCalledTimes(1)
    expect(s.store.path.value).toBe('/f.sqlnb')
  })
  it('newNotebook resets to empty untitled', async () => {
    const s = setup()
    s.store.load(text(), '/a.sqlnb', 1)
    await s.fa.newNotebook()
    expect(s.store.path.value).toBeNull(); expect(s.store.dirty.value).toBe(false)
  })
  it('recent returns items, [] on failure', async () => {
    const s = setup({ 'notebook/recent': () => ({ items: [{ path: '/a', openedAt: 1 }] }) })
    expect(await s.fa.recent()).toEqual([{ path: '/a', openedAt: 1 }])
    const s2 = setup({ 'notebook/recent': () => { throw rpc(-32013) } })
    expect(await s2.fa.recent()).toEqual([])
  })
  it('ignores a second action while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const s = setup({ 'notebook/read': async () => { await gate; return { text: text(), mtimeMs: 1 } } })
    const p1 = s.fa.open('/a.sqlnb')
    await s.fa.open('/b.sqlnb')
    release(); await p1
    expect(s.callsOf('notebook/read').length).toBe(1)
  })

  describe('save as overwrite guard (I1)', () => {
    const mk = (exists: boolean, ok: boolean, current: string | null = null) => {
      const confirmOverwrite = vi.fn(async () => ok)
      const s = setup({
        'notebook/pickSave': () => ({ path: '/n.sqlnb' }),
        'notebook/exists': () => ({ exists }),
        'notebook/write': () => ({ mtimeMs: 3 }),
      }, { confirmOverwrite })
      if (current) s.store.load(text(), current, 1)
      s.store.addBlock('sql', null)
      return { ...s, confirmOverwrite }
    }
    it('existing file asks confirm', async () => {
      const s = mk(true, true)
      await s.fa.saveAs()
      expect(s.confirmOverwrite).toHaveBeenCalledWith('/n.sqlnb')
      expect(s.callsOf('notebook/exists')[0]).toEqual({ path: '/n.sqlnb' })
      expect(s.callsOf('notebook/write')).toHaveLength(1)
    })
    it('cancel writes nothing', async () => {
      const s = mk(true, false)
      await s.fa.saveAs()
      expect(s.callsOf('notebook/write')).toHaveLength(0)
      expect(s.store.dirty.value).toBe(true)
    })
    it('same path as current needs no confirm', async () => {
      const s = mk(true, false, '/n.sqlnb')
      await s.fa.saveAs()
      expect(s.confirmOverwrite).not.toHaveBeenCalled()
      expect(s.callsOf('notebook/write')).toHaveLength(1)
    })
    it('missing file needs no confirm', async () => {
      const s = mk(false, false)
      await s.fa.saveAs()
      expect(s.confirmOverwrite).not.toHaveBeenCalled()
      expect(s.callsOf('notebook/write')).toHaveLength(1)
    })
  })

  it('edit during in-flight write keeps dirty (I2)', async () => {
    let s!: ReturnType<typeof setup>
    s = setup({ 'notebook/write': () => { s.store.addBlock('sql', null); return { mtimeMs: 9 } } })
    s.store.load(text(), '/a.sqlnb', 1); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.store.dirty.value).toBe(true)
    expect(s.store.mtimeMs.value).toBe(9)
  })
  it('no edit during write clears dirty (I2)', async () => {
    const s = setup({ 'notebook/write': () => ({ mtimeMs: 9 }) })
    s.store.load(text(), '/a.sqlnb', 1); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.store.dirty.value).toBe(false)
  })
  it('real-shape [-32010] from the bridge recreates the file (I3)', async () => {
    const { mapHostError } = await import('../src/host/bridge')
    let n = 0
    const s = setup({ 'notebook/write': () => { if (n++ === 0) throw mapHostError(new Error('[-32010] File not found: /a.sqlnb')); return { mtimeMs: 4 } } })
    s.store.load(text(), '/a.sqlnb', 5); s.store.addBlock('sql', null)
    await s.fa.save()
    expect(s.callsOf('notebook/write')).toHaveLength(2)
    expect('expectedMtimeMs' in s.callsOf('notebook/write')[1]).toBe(false)
    expect(s.store.dirty.value).toBe(false)
  })
  it('invalid notebook on open notifies and leaves notebook intact', async () => {
    const s = setup({ 'notebook/read': () => ({ text: 'sqlnb: "1"\nblocks: 5\n', mtimeMs: 1 }) })
    s.store.load(text('keep'), '/a.sqlnb', 1)
    await s.fa.open('/b.sqlnb')
    expect(s.deps.notify.mock.calls[0][0]).toContain('SQL Notebook')
    expect(s.store.path.value).toBe('/a.sqlnb')
    expect((s.store.nb.value.metadata as any).note).toBe('keep')
  })
  it('save on clean named notebook is a no-op (M5)', async () => {
    const s = setup()
    s.store.load(text(), '/a.sqlnb', 1)
    const at = s.store.nb.value.metadata.modifiedAt
    await s.fa.save()
    expect(s.methods()).not.toContain('notebook/write')
    expect(s.store.nb.value.metadata.modifiedAt).toBe(at)
  })
})

import { parseOutFile, serializeOutFile } from '@sqlnb/format'
import { parseNotebook } from '@sqlnb/format'

describe('fileActions results sidecar', () => {
  const okRun = () => ({ status: 'ok' as const, result: { columns: [{ name: 'x' }], rows: [[1]], truncated: false, elapsedMs: 1 } as any, ranSqlHash: 'h', executedAt: 'T' })
  const entry = () => ({ columns: [{ name: 'x' }], rows: [[2]], executedAt: 'T', elapsedMs: 3, truncated: false, sqlHash: 'q' })
  function ready(handlers: Record<string, (p: any) => unknown> = {}, mode: 'separate' | 'inline' | 'none' = 'separate', over: Record<string, any> = {}) {
    const s = setup({ 'notebook/write': () => ({ mtimeMs: 5 }), 'notebook/writeOut': () => ({ mtimeMs: 1 }), 'notebook/deleteOut': () => ({ deleted: true }), ...handlers }, over)
    s.store.load(text(), '/a.sqlnb', 1)
    const id = s.store.addBlock('sql', null)
    s.store.setOutputsMode(mode)
    s.store.runs.set(id, okRun() as any); s.store.noteRunFinished(id)
    return { ...s, id }
  }
  it('separate+dirty: write then writeOut with parsable payload', async () => {
    const s = ready()
    await s.fa.save()
    const m = s.methods().filter((x) => x.startsWith('notebook/') && x !== 'notebook/touchRecent')
    expect(m).toEqual(['notebook/write', 'notebook/writeOut'])
    const p = s.callsOf('notebook/writeOut')[0]
    expect(p.path).toBe('/a.sqlnb')
    expect(Object.keys(parseOutFile(p.text).entries)).toEqual([s.id])
    expect(s.store.dirty.value).toBe(false)
  })
  it('only resultsDirty: one writeOut, zero write', async () => {
    const s = ready()
    await s.fa.save(); s.deps.notify.mockClear()
    const mt = s.store.mtimeMs.value
    s.store.noteRunFinished(s.id)
    expect(s.store.dirty.value).toBe(false); expect(s.store.resultsDirty.value).toBe(true)
    await s.fa.save()
    expect(s.callsOf('notebook/write')).toHaveLength(1)
    expect(s.callsOf('notebook/writeOut')).toHaveLength(2)
    expect(s.store.mtimeMs.value).toBe(mt)
    expect(s.store.resultsDirty.value).toBe(false)
  })
  it('no entries: deleteOut instead', async () => {
    const s = ready(); s.store.runs.clear()
    await s.fa.save()
    expect(s.callsOf('notebook/writeOut')).toHaveLength(0)
    expect(s.callsOf('notebook/deleteOut')).toEqual([{ path: '/a.sqlnb' }])
  })
  it('writeOut failure keeps main saved, notifies, retries only writeOut', async () => {
    let fail = true
    const s = ready({ 'notebook/writeOut': () => { if (fail) throw rpc(-32603); return { mtimeMs: 1 } } })
    await s.fa.save()
    expect(s.store.dirty.value).toBe(false); expect(s.store.resultsDirty.value).toBe(true)
    expect(s.deps.notify).toHaveBeenCalledWith(expect.stringMatching(/结果未保存|not saved/), 'error')
    fail = false
    await s.fa.save()
    expect(s.callsOf('notebook/write')).toHaveLength(1)
    expect(s.callsOf('notebook/writeOut')).toHaveLength(2)
    expect(s.store.resultsDirty.value).toBe(false)
  })
  it('deleteOut failure ignored', async () => {
    const s = ready({ 'notebook/deleteOut': () => { throw rpc(-32603) } }); s.store.runs.clear()
    await s.fa.save()
    expect(s.deps.notify).not.toHaveBeenCalled()
  })
  it('inline: outputs inside write then deleteOut', async () => {
    const s = ready({}, 'inline')
    await s.fa.save()
    const doc: any = parseNotebook(s.callsOf('notebook/write')[0].text)
    expect(doc.blocks[0].outputs).toBeTruthy()
    const m = s.methods().filter((x) => x.endsWith('Out') || x === 'notebook/write')
    expect(m).toEqual(['notebook/write', 'notebook/deleteOut'])
  })
  it('none: deleteOut only', async () => {
    const s = ready({}, 'none')
    await s.fa.save()
    const m = s.methods().filter((x) => x.endsWith('Out') || x === 'notebook/write')
    expect(m).toEqual(['notebook/write', 'notebook/deleteOut'])
  })
  it('Save As writes .out at new path', async () => {
    const s = ready({ 'notebook/pickSave': () => ({ path: '/n.sqlnb' }), 'notebook/exists': () => ({ exists: false }) })
    await s.fa.saveAs()
    expect(s.callsOf('notebook/writeOut')[0].path).toBe('/n.sqlnb')
  })
  it('save no-op only when nothing dirty', async () => {
    const s = ready()
    await s.fa.save()
    const n = s.methods().length
    await s.fa.save()
    expect(s.methods().length).toBe(n)
  })
  it('two quick saves do not interleave', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const s = ready({ 'notebook/write': async () => { await gate; return { mtimeMs: 5 } } })
    const a = s.fa.save(); const b = s.fa.save()
    release(); await Promise.all([a, b])
    expect(s.callsOf('notebook/write')).toHaveLength(1)
    expect(s.callsOf('notebook/writeOut')).toHaveLength(1)
  })
  it('run finishing during save keeps resultsDirty', async () => {
    let s0: any
    const s = ready({ 'notebook/writeOut': () => { s0.store.noteRunFinished(s0.id); return { mtimeMs: 1 } } })
    s0 = s
    await s.fa.save()
    expect(s.store.resultsDirty.value).toBe(true)
  })

  describe('load', () => {
    const open = async (readOut: (p: any) => unknown, over: Record<string, any> = {}, body = text()) => {
      const s = setup({ 'notebook/read': () => ({ text: body, mtimeMs: 7 }), 'notebook/readOut': readOut }, over)
      await s.fa.open('/b.sqlnb')
      return s
    }
    const withBlock = () => {
      const st = useNotebookStore(); st.load(text(), null, null)
      const id = st.addBlock('sql', null)
      return { id, text: st.toText(), doc: parseNotebook(st.toText()) as any }
    }
    it.each([
      ['not exists', () => ({ exists: false }), 0],
      ['invalid JSON', () => ({ text: '{nope', mtimeMs: 1 }), -1],
      ['garbage', () => ({ text: '[1,2]', mtimeMs: 1 }), -1],
      ['undefined', () => undefined, 0],
    ])('%s opens fine', async (_n, h, _w) => {
      const s = await open(h)
      expect(s.store.path.value).toBe('/b.sqlnb')
      expect(s.deps.notify).not.toHaveBeenCalledWith(expect.anything(), 'error')
    })
    it('thrown errors open + notify', async () => {
      for (const e of [new Error('boom'), rpc(-32602), new HostError('UNKNOWN', 'perm', -32603)]) {
        const s = await open(() => { throw e })
        expect(s.store.path.value).toBe('/b.sqlnb')
        expect(s.deps.notify).toHaveBeenCalledWith(expect.stringMatching(/无法读取结果文件|Could not read/), 'error')
      }
    })
    it('valid .out populates runs, overrides inline, ignores deleted blocks, no dirty', async () => {
      const w = withBlock()
      w.doc.blocks[0].outputs = { ...entry(), sqlHash: 'inline' }
      const body = (await import('@sqlnb/format')).serializeNotebook(w.doc)
      const out = serializeOutFile({ [w.id]: entry(), gone: entry() } as any)
      const s = await open(() => ({ text: out, mtimeMs: 1 }), {}, body)
      expect(s.store.runs.get(w.id)).toMatchObject({ fromFile: true, ranSqlHash: 'q' })
      expect(s.store.runs.has('gone')).toBe(false)
      expect(s.store.dirty.value).toBe(false); expect(s.store.resultsDirty.value).toBe(false)
    })
    it('warnings notify once as info', async () => {
      const w = withBlock()
      const good = JSON.parse(serializeOutFile({ [w.id]: entry() } as any))
      good.outputs = { ...(good.outputs ?? {}), bad1: { junk: 1 }, bad2: 5 }
      const s = await open(() => ({ text: JSON.stringify(good), mtimeMs: 1 }), {}, w.text)
      const calls = s.deps.notify.mock.calls.filter((c: any[]) => /结果文件有|results file had/.test(String(c[0])))
      expect(calls.length).toBe(1)
      for (const c of calls) expect(c[1]).toBe('info')
    })
    it('5 MB .out does not throw', async () => {
      const s = await open(() => ({ text: 'x'.repeat(5_000_000), mtimeMs: 1 }))
      expect(s.store.path.value).toBe('/b.sqlnb')
    })
  })
})
