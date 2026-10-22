import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises as flush } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import NotebookView from '../src/shell/NotebookView.vue'
import { BridgeKey, StoreKey, FileTransferKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFileTransferClient } from '../src/files/fileTransferClient'
import { MAX_IMAGE_BYTES } from '../src/blocks/mdImagePaste'
import { PNG_BYTES, file, fakeDt } from './mdImageHelpers'

const flushPromises = async () => { await flush(); await new Promise((r) => setTimeout(r, 0)); await flush() }
const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await flushPromises() }
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s) }
const link = (n: number) => `![](n.sqlnb.assets/image-${n}.png)`

interface HostOpts { caps?: Record<string, boolean> | null; noFileTransfer?: boolean; onDropThrows?: boolean; readHook?: (id: string, n: number) => Promise<void> }
function fakeHost(o: HostOpts = {}) {
  let dropCb: ((f: any[], m: any) => void) | null = null
  let stateCb: ((a: boolean) => void) | null = null
  let live = 0
  let maxLive = 0
  let readN = 0
  const cancel = vi.fn(async (_id: string) => {})
  const read = vi.fn(async (id: string, off: number, len?: number) => {
    live++; maxLive = Math.max(maxLive, live)
    try { await o.readHook?.(id, ++readN) } finally { live-- }
    if (id.startsWith('bad')) throw new Error('boom')
    const part = PNG_BYTES.subarray(off, off + (len ?? PNG_BYTES.length))
    return { dataBase64: b64(part), length: part.length, eof: off + part.length >= PNG_BYTES.length }
  })
  const pick = vi.fn(async (_o?: unknown): Promise<unknown> => null)
  const onDrop = vi.fn((fn: any) => { if (o.onDropThrows) throw new Error('nope'); dropCb = fn; return () => { dropCb = null } })
  const onDragState = vi.fn((fn: any) => { stateCb = fn; return () => { stateCb = null } })
  const host: any = {
    capabilities: o.caps === null ? undefined : { fileTransfer: { drop: true, pick: true, read: true, ...o.caps } },
    fileTransfer: o.noFileTransfer ? undefined : { onDrop, onDragState, pick, read, cancel },
  }
  const H = (name: string, size = PNG_BYTES.length, id = name) => ({ handleId: id, name, size, contentType: '' })
  return {
    host, H, read, cancel, pick, onDrop, onDragState,
    maxLive: () => maxLive,
    emit: (files: any[], meta: any = { dropId: 'd' + Math.random(), truncated: false }) => dropCb?.(files, meta),
    drag: (a: boolean) => stateCb?.(a),
    cancelled: () => cancel.mock.calls.map((c) => c[0]).sort(),
    subscribed: () => dropCb !== null,
  }
}

function mk(blocks: string[], path: string | null = '/n/n.sqlnb', hostOpts: HostOpts = {}) {
  const fh = fakeHost(hostOpts)
  const nb: any = createEmptyNotebook()
  nb.blocks = blocks.map((c, i) => ({ id: `m${i + 1}`, type: 'markdown', content: c }))
  const store = useNotebookStore()
  store.load(serializeNotebook(nb), path, path ? 1 : null)
  let n = 0
  const bridge = { invoke: vi.fn(async (m: string) => {
    if (m === 'notebook/saveImage') return { relPath: `n.sqlnb.assets/image-${++n}.png`, size: 3 }
    if (m === 'notebook/readImage') return { mime: 'image/png', base64: 'AAAA', size: 3, mtimeMs: 5, width: 2, height: 3 }
    throw new Error('unexpected ' + m)
  }) } as any
  const client = createFileTransferClient(fh.host)
  const w = mount(NotebookView, { global: { provide: { [BridgeKey as symbol]: bridge, [StoreKey as symbol]: store, [FileTransferKey as symbol]: client } }, attachTo: document.body })
  const body = (i = 0) => store.nb.value.blocks[i].content
  const blockEl = (i: number) => w.findAll('.md-block')[i]
  const saves = () => bridge.invoke.mock.calls.filter((c: any) => c[0] === 'notebook/saveImage').length
  return { w, fh, store, body, blockEl, saves, bridge }
}
async function edit(a: ReturnType<typeof mk>, i = 0) {
  await a.blockEl(i).find('.md-view, .md-empty').trigger('dblclick')
  await flushPromises()
  return a.blockEl(i).find('textarea').element as HTMLTextAreaElement
}
const hover = async (a: ReturnType<typeof mk>, i: number) => { a.blockEl(i).element.dispatchEvent(new Event('pointerenter')); await flushPromises() }
const dropNotice = (a: ReturnType<typeof mk>) => a.w.find('[data-test="drop-notice"]').text()

beforeEach(() => setLocale('zh-CN'))
afterEach(() => { document.body.innerHTML = '' })

describe('host drop targets', () => {
  it('editing block gets the images at the textarea cursor as one history step; handles released once', async () => {
    const a = mk(['hello', 'other'])
    const ta = await edit(a)
    ta.setSelectionRange(2, 2)
    const depth = a.store.history.undoDepth.value
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.jpg')])
    await settle()
    expect(a.body(0)).toBe(`he${link(1)}\n${link(2)}llo`)
    expect(a.body(1)).toBe('other')
    expect(a.store.history.undoDepth.value).toBe(depth + 1)
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.jpg'])
    a.store.undo()
    expect(a.body(0)).toBe('hello')
    a.w.unmount()
  })
  it('editing wins over a more recently hovered block', async () => {
    const a = mk(['one', 'two'])
    await edit(a, 0)
    await hover(a, 1)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.body(0)).toContain(link(1))
    expect(a.body(1)).toBe('two')
    a.w.unmount()
  })
  it('recent preview block gets the images appended, notice and addedTo', async () => {
    const a = mk(['one', 'two'])
    await hover(a, 1)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.body(0)).toBe('one')
    expect(a.body(1)).toBe(`two\n\n${link(1)}`)
    expect(a.blockEl(1).find('.md-notice').text()).toContain('已添加到最近使用的 Markdown 区块')
    expect(a.fh.cancelled()).toEqual(['a.png'])
    a.w.unmount()
  })
  it('undo after a recent-block drop clears the addedTo notice at once; redo does not bring it back', async () => {
    const a = mk(['one', 'two'])
    await hover(a, 1)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.blockEl(1).find('.md-notice').exists()).toBe(true)
    a.store.undo(); await flushPromises()
    expect(a.body(1)).toBe('two')
    expect(a.blockEl(1).find('.md-notice').exists()).toBe(false)
    a.store.redo(); await flushPromises()
    expect(a.blockEl(1).find('.md-notice').exists()).toBe(false)
    a.w.unmount()
  })
  it('the pick-a-block prompt disappears at exactly 3000ms', async () => {
    vi.useFakeTimers()
    try {
      const a = mk(['one', 'two'])
      a.fh.emit([a.fh.H('a.png')])
      await vi.advanceTimersByTimeAsync(100)
      expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(true)
      await vi.advanceTimersByTimeAsync(2899)
      expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
      a.w.unmount()
    } finally { vi.useRealTimers() }
  })
  it('a touched sole block gets no addedTo notice', async () => {
    const a = mk(['one'])
    await hover(a, 0)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.body(0)).toBe(`one\n\n${link(1)}`)
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    a.w.unmount()
  })
  it('sole block is silent', async () => {
    const a = mk(['one'])
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.body(0)).toBe(`one\n\n${link(1)}`)
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
    a.w.unmount()
  })
  it('two untouched blocks: prompt, nothing read or saved, every handle released', async () => {
    const a = mk(['one', 'two'])
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.png')])
    await settle()
    expect(dropNotice(a)).toContain('请先点击要插入图片的 Markdown 区块')
    expect(a.fh.read).not.toHaveBeenCalled()
    expect(a.saves()).toBe(0)
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.png'])
    a.w.unmount()
  })
  it('unsaved notebook: saveFirst, no read, all released', async () => {
    const a = mk(['one'], null)
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.png')])
    await settle()
    expect(a.blockEl(0).find('.md-notice').text()).toContain('请先保存笔记本')
    expect(a.fh.read).not.toHaveBeenCalled()
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.png'])
    a.w.unmount()
  })
  it('a modal being open: nothing inserted, handles released', async () => {
    const a = mk(['one'])
    const m = document.createElement('div'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.body(0)).toBe('one')
    expect(a.fh.read).not.toHaveBeenCalled()
    expect(a.fh.cancelled()).toEqual(['a.png'])
    a.w.unmount()
  })
  it('mixed set: only images inserted, ignored and unsupported counted, all released once', async () => {
    const a = mk(['one'])
    await edit(a)
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.csv'), a.fh.H('c.svg'), a.fh.H('d.jpg')])
    await settle()
    expect(a.saves()).toBe(2)
    const txt = a.blockEl(0).find('.md-notice').text()
    expect(txt).toContain('已忽略 1 个非图片文件')
    expect(txt).toContain('1 个文件不是支持的图片')
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.csv', 'c.svg', 'd.jpg'])
    a.w.unmount()
  })
  it('only non-images: no insertion, notice, handles released', async () => {
    const a = mk(['one'])
    a.fh.emit([a.fh.H('b.csv')])
    await settle()
    expect(a.body(0)).toBe('one')
    expect(a.blockEl(0).find('.md-notice').text()).toContain('已忽略 1 个非图片文件')
    expect(a.fh.cancelled()).toEqual(['b.csv'])
    a.w.unmount()
  })
  it('11 images: 10 inserted + tooMany, the 11th never read, all released', async () => {
    const a = mk(['one'])
    a.fh.emit(Array.from({ length: 11 }, (_, i) => a.fh.H(`p${i}.png`)))
    await settle()
    expect(a.saves()).toBe(10)
    expect(a.fh.read.mock.calls.some((c) => c[0] === 'p10.png')).toBe(false)
    expect(a.blockEl(0).find('.md-notice').text()).toContain('一次最多插入 10 张图片')
    expect(a.fh.cancelled()).toHaveLength(11)
    a.w.unmount()
  })
  it('over 10 MiB: tooLarge, never read, others inserted', async () => {
    const a = mk(['one'])
    a.fh.emit([a.fh.H('big.png', MAX_IMAGE_BYTES + 1), a.fh.H('ok.png')])
    await settle()
    expect(a.fh.read.mock.calls.some((c) => c[0] === 'big.png')).toBe(false)
    expect(a.saves()).toBe(1)
    expect(a.blockEl(0).find('.md-notice').text()).toContain('图片过大')
    expect(a.fh.cancelled()).toEqual(['big.png', 'ok.png'])
    a.w.unmount()
  })
  it('hostTruncated gets the truncated notice', async () => {
    const a = mk(['one'])
    a.fh.emit([a.fh.H('a.png')], { dropId: 'x', truncated: true })
    await settle()
    expect(a.blockEl(0).find('.md-notice').text()).toContain('文件夹内容过多')
    a.w.unmount()
  })
  it('a failing file is counted as ignored; the others are inserted in order as one step', async () => {
    const a = mk(['one'])
    const depth = a.store.history.undoDepth.value
    a.fh.emit([a.fh.H('a.png'), a.fh.H('bad.png'), a.fh.H('c.png')])
    await settle()
    expect(a.body(0)).toBe(`one\n\n${link(1)}\n${link(2)}`)
    expect(a.saves()).toBe(2)
    expect(a.blockEl(0).find('.md-notice').text()).toContain('已忽略 1 个非图片文件')
    expect(a.store.history.undoDepth.value).toBe(depth + 1)
    expect(a.fh.cancelled()).toEqual(['a.png', 'bad.png', 'c.png'])
    a.store.undo()
    expect(a.body(0)).toBe('one')
    a.w.unmount()
  })
  it('every file failing: document untouched, nothing saved, no history step, all released', async () => {
    const a = mk(['one'])
    const depth = a.store.history.undoDepth.value
    a.fh.emit([a.fh.H('bad1.png'), a.fh.H('bad2.png')])
    await settle()
    expect(a.body(0)).toBe('one')
    expect(a.saves()).toBe(0)
    expect(a.store.history.undoDepth.value).toBe(depth)
    expect(a.blockEl(0).find('.md-notice').text()).toContain('已忽略 2 个非图片文件')
    expect(a.fh.cancelled()).toEqual(['bad1.png', 'bad2.png'])
    a.w.unmount()
  })
  it('reads go one-by-one with saves interleaved and never overlap', async () => {
    const a = mk(['one'])
    const order: string[] = []
    a.bridge.invoke.mockImplementation(async (m: string) => { order.push(m); return m === 'notebook/saveImage' ? { relPath: `n.sqlnb.assets/image-${order.length}.png`, size: 3 } : {} })
    let live = 0
    let max = 0
    a.fh.read.mockImplementation(async (id: string) => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 5)); live--; order.push('read:' + id); return { dataBase64: b64(PNG_BYTES), length: PNG_BYTES.length, eof: true } })
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.png')])
    await settle()
    expect(order.filter((x) => x !== 'notebook/readImage')).toEqual(['read:a.png', 'notebook/saveImage', 'read:b.png', 'notebook/saveImage'])
    expect(max).toBe(1)
    a.w.unmount()
  })
  it('unmount mid-read: no more reads, nothing inserted, handles released', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const a = mk(['one'], '/n/n.sqlnb', { readHook: async (_id, n) => { if (n === 1) await gate } })
    a.fh.emit([a.fh.H('a.png'), a.fh.H('b.png')])
    await settle()
    expect(a.fh.read).toHaveBeenCalledTimes(1)
    const store = a.store
    a.w.unmount()
    release()
    await settle()
    expect(a.fh.read).toHaveBeenCalledTimes(1)
    expect(a.saves()).toBe(0)
    expect(store.nb.value.blocks[0].content).toBe('one')
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.png'])
  })
})

describe('dedupe between paths', () => {
  const html5 = (ta: HTMLTextAreaElement) => {
    const ev = new Event('drop', { bubbles: true, cancelable: true }) as any
    ev.dataTransfer = fakeDt([file('a.png', 'image/png')]); ev.clientX = 5; ev.clientY = 5
    ta.dispatchEvent(ev)
    return ev as Event
  }
  it('host then HTML5 inserts once; HTML5 event still default-prevented; no misleading duplicate notice', async () => {
    const a = mk(['hello'])
    const ta = await edit(a)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    const ev = html5(ta)
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(a.saves()).toBe(1)
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
    a.w.unmount()
  })
  it('HTML5 then host inserts once and the host handles are released', async () => {
    const a = mk(['hello'])
    const ta = await edit(a)
    html5(ta)
    a.fh.emit([a.fh.H('a.png')])
    await settle()
    expect(a.saves()).toBe(1)
    expect(a.fh.read).not.toHaveBeenCalled()
    expect(a.fh.cancelled()).toEqual(['a.png'])
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
    a.w.unmount()
  })
  it('a lone HTML5 drop is default-prevented and inserts', async () => {
    const a = mk(['hello'])
    const ta = await edit(a)
    const ev = html5(ta)
    await settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(a.saves()).toBe(1)
    a.w.unmount()
  })
  it('the same dropId twice inserts once, both handle sets released', async () => {
    const a = mk(['hello'])
    a.fh.emit([a.fh.H('a.png', undefined, 'h1')], { dropId: 'same', truncated: false })
    await settle()
    a.fh.emit([a.fh.H('a.png', undefined, 'h2')], { dropId: 'same', truncated: false })
    await settle()
    expect(a.saves()).toBe(1)
    expect(a.fh.cancelled()).toEqual(['h1', 'h2'])
    a.w.unmount()
  })
})

describe('capability degrade', () => {
  it.each([
    ['drop:false', { caps: { drop: false } }],
    ['capabilities missing', { caps: null }],
    ['no fileTransfer', { noFileTransfer: true }],
  ] as const)('%s → no subscription, no error, no overlay', async (_n, o) => {
    const a = mk(['one'], '/n/n.sqlnb', o as HostOpts)
    await flushPromises()
    expect(a.fh.onDrop).not.toHaveBeenCalled()
    expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
    expect(a.w.find('[data-drop-candidate]').exists()).toBe(false)
    a.w.unmount()
  })
  it('onDrop throwing at subscribe is silent', async () => {
    const a = mk(['one'], '/n/n.sqlnb', { onDropThrows: true })
    await flushPromises()
    expect(a.w.find('[data-test="drop-notice"]').exists()).toBe(false)
    a.w.unmount()
  })
  it('unmount unsubscribes', async () => {
    const a = mk(['one'])
    await flushPromises()
    expect(a.fh.subscribed()).toBe(true)
    a.w.unmount()
    expect(a.fh.subscribed()).toBe(false)
  })
})

describe('drag state', () => {
  it('candidate: editing > recent > sole; hint when ambiguous', async () => {
    const a = mk(['one', 'two'])
    await flushPromises()
    a.fh.drag(true); await flushPromises()
    expect(a.w.find('[data-test="drop-hint"]').text()).toContain('松开以添加图片')
    expect(a.w.find('[data-test="drop-hint"]').attributes('role')).toBe('status')
    expect(a.w.find('[data-drop-candidate]').exists()).toBe(false)
    a.fh.drag(false); await flushPromises()
    expect(a.w.find('[data-test="drop-hint"]').exists()).toBe(false)
    await hover(a, 1)
    a.fh.drag(true); await flushPromises()
    expect(a.blockEl(1).attributes('data-drop-candidate')).toBe('true')
    expect(a.blockEl(1).classes()).toContain('md-drop')
    a.fh.drag(false); await flushPromises()
    await edit(a, 0)
    a.fh.drag(true); await flushPromises()
    expect(a.blockEl(0).attributes('data-drop-candidate')).toBe('true')
    expect(a.blockEl(1).attributes('data-drop-candidate')).toBeUndefined()
    a.w.unmount()
  })
  it('sole block is the candidate', async () => {
    const a = mk(['one'])
    await flushPromises()
    a.fh.drag(true); await flushPromises()
    expect(a.blockEl(0).attributes('data-drop-candidate')).toBe('true')
    a.w.unmount()
  })
  const clears: Array<[string, () => void]> = [
    ['onDragState(false)', () => {}],
    ['pointermove', () => window.dispatchEvent(new Event('pointermove'))],
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
  ]
  it.each(clears)('state clears on %s', async (name, fire) => {
    const a = mk(['one', 'two'])
    await flushPromises()
    await hover(a, 1)
    a.fh.drag(true); await flushPromises()
    expect(a.blockEl(1).attributes('data-drop-candidate')).toBe('true')
    if (name === 'onDragState(false)') a.fh.drag(false); else fire()
    await flushPromises()
    expect(a.blockEl(1).attributes('data-drop-candidate')).toBeUndefined()
    a.w.unmount()
  })
  it('hint clears on Escape and on a drop', async () => {
    const a = mk(['one', 'two'])
    await flushPromises()
    a.fh.drag(true); await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flushPromises()
    expect(a.w.find('[data-test="drop-hint"]').exists()).toBe(false)
    a.fh.drag(true); await flushPromises()
    a.fh.emit([a.fh.H('a.png')]); await settle()
    expect(a.w.find('[data-test="drop-hint"]').exists()).toBe(false)
    a.w.unmount()
  })
  it('listeners are removed on unmount', async () => {
    const rm = vi.spyOn(window, 'removeEventListener')
    const a = mk(['one', 'two'])
    await flushPromises()
    a.fh.drag(true); await flushPromises()
    a.w.unmount()
    const types = rm.mock.calls.map((c) => c[0])
    expect(types).toEqual(expect.arrayContaining(['pointermove', 'keydown', 'blur']))
    rm.mockRestore()
  })
})

describe('toolbar insert image', () => {
  const btn = (a: ReturnType<typeof mk>) => a.blockEl(0).find('[data-action="image"]')
  it('unsaved: saveFirst and pick not called', async () => {
    const a = mk(['hello'], null)
    await edit(a)
    await btn(a).trigger('click'); await settle()
    expect(a.fh.pick).not.toHaveBeenCalled()
    expect(a.blockEl(0).find('.md-notice').text()).toContain('请先保存笔记本')
    a.w.unmount()
  })
  it('pick → handles inserted at the cursor as one step, caret after, handles released', async () => {
    const a = mk(['hello'])
    const ta = await edit(a)
    ta.setSelectionRange(5, 5)
    const depth = a.store.history.undoDepth.value
    a.fh.pick.mockResolvedValue([a.fh.H('a.png'), a.fh.H('b.png')])
    await btn(a).trigger('click'); await settle()
    expect(a.fh.pick).toHaveBeenCalledWith({ multiple: true })
    expect(a.body(0)).toBe(`hello${link(1)}\n${link(2)}`)
    expect(a.store.history.undoDepth.value).toBe(depth + 1)
    expect(a.fh.cancelled()).toEqual(['a.png', 'b.png'])
    const cur = a.blockEl(0).find('textarea').element as HTMLTextAreaElement
    expect(document.activeElement).toBe(cur)
    expect(cur.selectionStart).toBe(a.body(0)!.length)
    a.store.undo()
    expect(a.body(0)).toBe('hello')
    a.w.unmount()
  })
  it('pick cancel (null) → no change, no notice', async () => {
    const a = mk(['hello'])
    await edit(a)
    a.fh.pick.mockResolvedValue(null)
    await btn(a).trigger('click'); await settle()
    expect(a.body(0)).toBe('hello')
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    a.w.unmount()
  })
  it('pick rejecting with a cancel error is a no-op; other rejects show pasteFailed', async () => {
    const a = mk(['hello'])
    await edit(a)
    a.fh.pick.mockRejectedValue(new Error('user cancelled'))
    await btn(a).trigger('click'); await settle()
    expect(a.blockEl(0).find('.md-notice').exists()).toBe(false)
    a.fh.pick.mockRejectedValue(new Error('disk on fire'))
    await btn(a).trigger('click'); await settle()
    expect(a.blockEl(0).find('.md-notice').text()).toContain('无法插入图片')
    a.w.unmount()
  })
  it('textarea blur while the picker is open does not leave edit mode', async () => {
    const a = mk(['hello'])
    await edit(a)
    let done!: (v: unknown) => void
    a.fh.pick.mockImplementation(() => new Promise((r) => { done = r }))
    await btn(a).trigger('click'); await flushPromises()
    const ta = a.blockEl(0).find('textarea')
    ta.element.dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    expect(a.blockEl(0).find('textarea').exists()).toBe(true)
    done(null); await settle()
    a.w.unmount()
  })
  it.each([['pick:false', { caps: { pick: false } }], ['no fileTransfer', { noFileTransfer: true }]] as const)('%s → hidden <input type=file> fallback', async (_n, o) => {
    const clicks: HTMLInputElement[] = []
    const spy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { clicks.push(this) })
    const a = mk(['hello'], '/n/n.sqlnb', o as HostOpts)
    await edit(a)
    await btn(a).trigger('click'); await flushPromises()
    expect(clicks).toHaveLength(1)
    const inp = clicks[0]
    expect(inp.type).toBe('file')
    expect(inp.accept).toBe('image/png,image/jpeg,image/gif,image/webp')
    expect(inp.multiple).toBe(true)
    Object.defineProperty(inp, 'files', { value: [file('a.png', 'image/png')] })
    inp.dispatchEvent(new Event('change')); await settle()
    expect(a.body(0)).toBe(`hello${link(1)}`)
    spy.mockRestore()
    a.w.unmount()
  })
  it('the input fallback processes every chosen file', async () => {
    const clicks: HTMLInputElement[] = []
    const spy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { clicks.push(this) })
    const a = mk(['hello'], '/n/n.sqlnb', { noFileTransfer: true })
    await edit(a)
    await btn(a).trigger('click'); await flushPromises()
    Object.defineProperty(clicks[0], 'files', { value: [file('a.png', 'image/png'), file('b.jpg', 'image/jpeg'), file('c.gif', 'image/gif')] })
    clicks[0].dispatchEvent(new Event('change')); await settle()
    expect(a.body(0)).toBe(`hello${link(1)}\n${link(2)}\n${link(3)}`)
    spy.mockRestore()
    a.w.unmount()
  })
  it('without a cancel event, window focus resets picking after a delay', async () => {
    const clicks: HTMLInputElement[] = []
    const spy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { clicks.push(this) })
    const a = mk(['hello'], '/n/n.sqlnb', { noFileTransfer: true })
    await edit(a)
    await btn(a).trigger('click'); await flushPromises()
    await btn(a).trigger('click'); await flushPromises()
    expect(clicks).toHaveLength(1)
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 450)); await flushPromises()
    await btn(a).trigger('click'); await flushPromises()
    expect(clicks).toHaveLength(2)
    spy.mockRestore()
    a.w.unmount()
  })
  it('a change event before the focus fallback is processed once', async () => {
    const clicks: HTMLInputElement[] = []
    const spy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { clicks.push(this) })
    const a = mk(['hello'], '/n/n.sqlnb', { noFileTransfer: true })
    await edit(a)
    await btn(a).trigger('click'); await flushPromises()
    window.dispatchEvent(new Event('focus'))
    Object.defineProperty(clicks[0], 'files', { value: [file('a.png', 'image/png')] })
    clicks[0].dispatchEvent(new Event('change'))
    await new Promise((r) => setTimeout(r, 450)); await flushPromises()
    expect(a.body(0)).toBe(`hello${link(1)}`)
    expect(a.saves()).toBe(1)
    spy.mockRestore()
    a.w.unmount()
  })
})
