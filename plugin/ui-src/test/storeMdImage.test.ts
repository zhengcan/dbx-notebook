import { describe, it, expect, vi } from 'vitest'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import { mkStore } from './undoHelpers'
import { createFakeBridge } from '../src/host/fakeBridge'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFileActions } from '../src/shell/fileActions'

describe('store.insertMarkdownImages', () => {
  it('inserts encoded links joined by \\n at the range, one entry, label insertImage', () => {
    const { s, blk } = mkStore()
    const caret = s.insertMarkdownImages('m1', ['a b.sqlnb.assets/x (1).png', 'a b.sqlnb.assets/y.png'], { from: 2, to: 2 })
    expect(blk('m1').content).toBe('he![](a%20b.sqlnb.assets/x%20%281%29.png)\n![](a%20b.sqlnb.assets/y.png)llo')
    expect(caret).toBe(2 + '![](a%20b.sqlnb.assets/x%20%281%29.png)\n![](a%20b.sqlnb.assets/y.png)'.length)
    expect(s.history.undoDepth.value).toBe(1)
    expect(s.history.lastLabel.value).toBe('history.label.insertImage')
    expect((s.history.stack.peekUndo() as any).sealed).toBe(true)
  })
  it('replaces the selection; undo restores exact text, redo reapplies', () => {
    const { s, blk } = mkStore()
    s.insertMarkdownImages('m1', ['p.assets/a.png'], { from: 1, to: 4 })
    expect(blk('m1').content).toBe('h![](p.assets/a.png)o')
    s.undo(); expect(blk('m1').content).toBe('hello'); expect(s.dirty.value).toBe(false)
    s.redo(); expect(blk('m1').content).toBe('h![](p.assets/a.png)o')
  })
  it('never merges with typing before or after', () => {
    const { s, clock, blk } = mkStore()
    s.updateContent('m1', 'hello1', { coalesce: true }); clock.t += 10
    s.insertMarkdownImages('m1', ['p.assets/a.png'], { from: 6, to: 6 }); clock.t += 10
    s.updateContent('m1', blk('m1').content + 'z', { coalesce: true })
    expect(s.history.undoDepth.value).toBe(3)
    expect((s.history.stack as any).undoStack[0].sealed).toBe(true)
    s.undo(); expect(blk('m1').content).toBe('hello1![](p.assets/a.png)')
    s.undo(); expect(blk('m1').content).toBe('hello1')
    s.undo(); expect(blk('m1').content).toBe('hello')
  })
  it('clamps an out-of-range selection; non-markdown / unknown block / empty refs are no-ops', () => {
    const { s, blk } = mkStore()
    s.insertMarkdownImages('m1', ['a.png'], { from: 99, to: 120 })
    expect(blk('m1').content).toBe('hello![](a.png)')
    const d = s.history.undoDepth.value
    expect(s.insertMarkdownImages('s1', ['a.png'], { from: 0, to: 0 })).toBeNull()
    expect(s.insertMarkdownImages('nope', ['a.png'], { from: 0, to: 0 })).toBeNull()
    expect(s.insertMarkdownImages('m1', [], { from: 0, to: 0 })).toBeNull()
    expect(s.history.undoDepth.value).toBe(d)
  })
})

const nbText = (md: string[]) => {
  const nb: any = createEmptyNotebook()
  nb.blocks = md.map((c, i) => ({ id: `m${i}`, type: 'markdown', content: c }))
  return serializeNotebook(nb)
}

function setup(handlers: Record<string, (p: any) => unknown>, from: string | null, md: string[]) {
  const bridge = createFakeBridge({ invokeHandlers: { 'notebook/touchRecent': () => ({}), 'notebook/exists': () => ({ exists: false }), 'notebook/write': () => ({ mtimeMs: 9 }), ...handlers } })
  const store = useNotebookStore()
  store.load(nbText(md), from, from ? 1 : null)
  const notify = vi.fn()
  const fa = createFileActions({ bridge, store, confirm: vi.fn(async () => 'discard' as const), askExternalChange: vi.fn(async () => 'cancel' as const), notify, confirmOverwrite: async () => true } as any)
  const callsOf = (m: string) => (bridge.calls as any[]).filter((c) => c.args?.method === m).map((c) => c.args.params)
  const methods = () => (bridge.calls as any[]).filter((c) => c.method === 'invoke').map((c) => c.args.method)
  return { fa, store, notify, callsOf, methods }
}
const blocks = (s: ReturnType<typeof setup>) => s.store.nb.value.blocks.map((b: any) => b.content)

describe('Save As asset copy', () => {
  const to = '/new/dir/copy.sqlnb'
  const md = ['![a](old.sqlnb.assets/image-1.png) and ![b](./pic.png)\n![a2](old.sqlnb.assets/image-1.png)', '![c](docs/z.png) ![r](https://e.x/y.png) ![u](../up.png)\n```\n![k](code.png)\n```']
  const pick = { 'notebook/pickSave': () => ({ path: to }) }

  it('copies exactly the referenced relative images (deduped) and rewrites links in the saved file', async () => {
    const s = setup({ ...pick, 'notebook/copyAssets': (p: any) => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'copy.sqlnb.assets/image-1.png', './pic.png': 'pic.png', 'docs/z.png': 'docs/z.png' }, copied: p.relPaths, failed: [], errors: {} }) }, '/old/old.sqlnb', md)
    s.store.history.clear()
    await s.fa.saveAs()
    const c = s.callsOf('notebook/copyAssets')
    expect(c).toHaveLength(1)
    expect(c[0]).toEqual({ fromNotebookPath: '/old/old.sqlnb', toNotebookPath: to, relPaths: ['old.sqlnb.assets/image-1.png', './pic.png', 'docs/z.png'] })
    const written = s.callsOf('notebook/write')[0].text as string
    expect(written).toContain('![a](copy.sqlnb.assets/image-1.png) and ![b](./pic.png)')
    expect(written).toContain('![a2](copy.sqlnb.assets/image-1.png)')
    expect(written).not.toContain('old.sqlnb.assets')
    expect(written).toContain('![k](code.png)')
    expect(blocks(s)[0]).toContain('copy.sqlnb.assets/image-1.png')
    expect(s.store.dirty.value).toBe(false)
    expect(s.store.history.undoDepth.value).toBe(0)
    expect(s.store.path.value).toBe(to)
    expect(s.methods().indexOf('notebook/copyAssets')).toBeLessThan(s.methods().indexOf('notebook/write'))
  })
  it('encodes mapped names with spaces and parentheses', async () => {
    const s = setup({ ...pick, 'notebook/pickSave': () => ({ path: '/n/my (x).sqlnb' }), 'notebook/copyAssets': () => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'my (x).sqlnb.assets/image-1.png' }, copied: [], failed: [], errors: {} }) }, '/old/old.sqlnb', ['![a](old.sqlnb.assets/image-1.png)'])
    await s.fa.saveAs()
    expect(blocks(s)[0]).toBe('![a](my%20%28x%29.sqlnb.assets/image-1.png)')
  })
  it('copy failure: notice with count, file still saved, failed links unchanged', async () => {
    const s = setup({ ...pick, 'notebook/copyAssets': () => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'copy.sqlnb.assets/image-1.png' }, copied: [], failed: ['./pic.png', 'docs/z.png'], errors: { './pic.png': 'notFound', 'docs/z.png': 'tooLarge' } }) }, '/old/old.sqlnb', md)
    await s.fa.saveAs()
    expect(s.callsOf('notebook/write')).toHaveLength(1)
    expect(blocks(s)[0]).toContain('![b](./pic.png)')
    expect(blocks(s)[0]).toContain('copy.sqlnb.assets/image-1.png')
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('2'), expect.anything())
    const m = String(s.notify.mock.calls.find((c: any[]) => /pic\.png/.test(String(c[0])))?.[0])
    expect(m).toContain('pic.png, z.png')
    expect(m).not.toMatch(/docs|\.\/|\//)
    expect(s.store.path.value).toBe(to)
    expect(s.store.dirty.value).toBe(false)
  })
  it('more than 3 failures list the first three file names and an ellipsis', async () => {
    const many = ['![](d1/a.png) ![](d2/b.png) ![](d3/c.png) ![](d4/d.png) ![](d5/e.png)']
    const s = setup({ ...pick, 'notebook/copyAssets': (p: any) => ({ mapping: {}, copied: [], failed: p.relPaths, errors: {} }) }, '/old/old.sqlnb', many)
    await s.fa.saveAs()
    const m = s.notify.mock.calls[0][0] as string
    expect(m).toContain('5')
    expect(m).toContain('a.png, b.png, c.png')
    expect(m).toContain('…')
    expect(m).not.toContain('d.png')
    expect(m).not.toContain('d1')
  })
  it('copyAssets RPC error: file still saved with links unchanged, notice counts all', async () => {
    const s = setup({ ...pick, 'notebook/copyAssets': () => { throw new Error('[-32040] [tooLarge] x') } }, '/old/old.sqlnb', md)
    await s.fa.saveAs()
    expect(s.callsOf('notebook/write')[0].text).toContain('old.sqlnb.assets/image-1.png')
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('3'), expect.anything())
    expect(s.store.dirty.value).toBe(false)
  })
  it('same file: no copy, no rewrite', async () => {
    const s = setup({ 'notebook/pickSave': () => ({ path: '/old/old.sqlnb' }), 'notebook/copyAssets': () => { throw new Error('no') } }, '/old/old.sqlnb', md)
    await s.fa.saveAs()
    expect(s.callsOf('notebook/copyAssets')).toHaveLength(0)
    expect(s.callsOf('notebook/write')[0].text).toContain('old.sqlnb.assets/image-1.png')
  })
  it('same directory, new name: ./pic.png stays unchanged', async () => {
    const s = setup({ 'notebook/pickSave': () => ({ path: '/old/copy.sqlnb' }), 'notebook/copyAssets': () => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'copy.sqlnb.assets/image-1.png', './pic.png': 'pic.png' }, copied: [], failed: [], errors: {} }) }, '/old/old.sqlnb', md)
    await s.fa.saveAs()
    expect(blocks(s)[0]).toContain('![b](./pic.png)')
    expect(blocks(s)[0]).toContain('copy.sqlnb.assets/image-1.png')
  })
  it('unsaved notebook: no copyAssets call and links untouched', async () => {
    const s = setup({ ...pick, 'notebook/copyAssets': () => { throw new Error('no') } }, null, md)
    await s.fa.saveAs()
    expect(s.callsOf('notebook/copyAssets')).toHaveLength(0)
    expect(s.callsOf('notebook/write')[0].text).toContain('old.sqlnb.assets/image-1.png')
    expect(s.notify).not.toHaveBeenCalled()
  })
  it('notebook without relative images: no copyAssets call', async () => {
    const s = setup({ ...pick }, '/old/old.sqlnb', ['no images ![r](https://e.x/a.png)'])
    await s.fa.saveAs()
    expect(s.callsOf('notebook/copyAssets')).toHaveLength(0)
  })
  it('write failure leaves content unrewritten and dirty', async () => {
    const s = setup({ ...pick, 'notebook/write': () => { throw new Error('[-32013] disk') }, 'notebook/copyAssets': () => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'copy.sqlnb.assets/image-1.png' }, copied: [], failed: [], errors: {} }) }, '/old/old.sqlnb', md)
    s.store.addBlock('markdown', null)
    await s.fa.saveAs()
    expect(blocks(s).join('')).toContain('old.sqlnb.assets/image-1.png')
    expect(blocks(s).join('')).not.toContain('copy.sqlnb.assets')
    expect(s.store.path.value).toBe('/old/old.sqlnb')
    expect(s.store.dirty.value).toBe(true)
  })
  it('plain Save never touches assets', async () => {
    const s = setup({ 'notebook/copyAssets': () => { throw new Error('no') } }, '/old/old.sqlnb', md)
    s.store.addBlock('markdown', null)
    await s.fa.save()
    expect(s.callsOf('notebook/copyAssets')).toHaveLength(0)
    expect(s.callsOf('notebook/write')).toHaveLength(1)
  })
  it('edit during the in-flight Save As keeps the notebook dirty', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const s = setup({ ...pick, 'notebook/write': async () => { await gate; return { mtimeMs: 9 } }, 'notebook/copyAssets': () => ({ mapping: { 'old.sqlnb.assets/image-1.png': 'copy.sqlnb.assets/image-1.png' }, copied: [], failed: [], errors: {} }) }, '/old/old.sqlnb', md)
    const p = s.fa.saveAs()
    await vi.waitFor(() => expect(s.callsOf('notebook/copyAssets')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    s.store.updateContent('m1', 'typed')
    release(); await p
    expect(s.store.dirty.value).toBe(true)
  })
})
