import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createImageResolver } from '../src/markdown/imageResolver'
import { ImageError, type LoadedImage } from '../src/files/imageClient'
import { setLocale } from '../src/i18n'

const img = (n = 1, dims = {}): LoadedImage => ({ mime: 'image/png', dataUri: `data:image/png;base64,AA${n}=`, size: 10, mtimeMs: 1, width: 4, height: 3, ...dims })
const root = (rels: string[], alt = 'alt') => {
  const el = document.createElement('div')
  el.innerHTML = rels.map((r, i) => `<p><img data-sqlnb-src="${r}" alt="${alt}${i}"></p>`).join('')
  document.body.appendChild(el)
  return el
}
const defer = <T>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b }); return { p, res, rej } }
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { setLocale('zh-CN'); document.body.innerHTML = '' })

describe('imageResolver', () => {
  it('loading placeholder reserves space, then the image is set with data-state ok', async () => {
    const d = defer<LoadedImage>()
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: () => d.p })
    const el = root(['a.png'])
    const run = r.resolve(el)
    const ph = el.querySelector('[data-state="loading"]') as HTMLElement
    expect(ph).toBeTruthy()
    expect(ph.getAttribute('role')).toBe('img')
    expect(ph.getAttribute('aria-label')).toContain('alt0')
    expect(ph.style.minHeight).toBe('48px')
    d.res(img())
    await run
    const i = el.querySelector('img') as HTMLImageElement
    expect(i.getAttribute('src')).toBe('data:image/png;base64,AA1=')
    expect(i.getAttribute('data-state')).toBe('ok')
    expect(i.getAttribute('alt')).toBe('alt0')
    expect(i.getAttribute('width')).toBe('4')
    expect(i.getAttribute('height')).toBe('3')
    expect(el.querySelector('[data-state="loading"]')).toBeNull()
  })
  it('error codes become role=img placeholders with the alt text and a hint', async () => {
    const hints: Record<string, string> = { notFound: '找不到图片', unsupported: '不支持的图片', tooLarge: '图片过大', invalidPath: '无效的图片路径', readFailed: '无法显示此图片', needsSave: '保存笔记本后显示图片' }
    for (const [code, hint] of Object.entries(hints)) {
      const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: async () => { throw new ImageError(code as any) } })
      const el = root(['a.png'], 'Pic')
      await r.resolve(el)
      const ph = el.querySelector('[data-state="error"]') as HTMLElement
      expect(ph.getAttribute('data-error')).toBe(code)
      expect(ph.getAttribute('role')).toBe('img')
      expect(ph.textContent).toContain('Pic0')
      expect(ph.textContent).toContain(hint)
      expect(ph.getAttribute('aria-label')).toContain('Pic0')
      expect(ph.getAttribute('aria-label')).toContain(hint)
      expect(el.querySelector('img')).toBeNull()
      expect(el.innerHTML).not.toContain('/n/a')
      el.remove()
    }
  })
  it('en locale hints', async () => {
    setLocale('en')
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: async () => { throw new ImageError('notFound') } })
    const el = root(['a.png'])
    await r.resolve(el)
    expect(el.textContent).toMatch(/not found/i)
  })
  it('unsaved notebook: save hint, zero client calls', async () => {
    const client = vi.fn()
    const r = createImageResolver({ notebookPath: () => null, client })
    const el = root(['a.png', 'b.png'])
    await r.resolve(el)
    expect(client).not.toHaveBeenCalled()
    expect(el.querySelectorAll('[data-state="error"]').length).toBe(2)
    expect(el.textContent).toContain('保存笔记本后显示图片')
  })
  it('unsupported file shows alt + hint, no src, role=img', async () => {
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: async () => { throw new ImageError('unsupported') } })
    const el = root(['a.avif'], 'photo')
    await r.resolve(el)
    const ph = el.querySelector('[data-state="error"]')!
    expect(ph.hasAttribute('src')).toBe(false)
    expect(ph.getAttribute('role')).toBe('img')
    expect(ph.textContent).toContain('不支持的图片')
    expect(ph.textContent).toContain('photo0')
  })
  it('img onerror becomes alt text + decodeFailed hint, no broken icon', async () => {
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: async () => img() })
    const el = root(['a.png'], 'bad')
    await r.resolve(el)
    el.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(el.querySelector('img')).toBeNull()
    const ph = el.querySelector('[data-state="error"]')!
    expect(ph.getAttribute('data-error')).toBe('decodeFailed')
    expect(ph.textContent).toContain('无法显示此图片')
    expect(ph.textContent).toContain('bad0')
  })
  it('cache hit makes no second call; invalidate refetches', async () => {
    const client = vi.fn(async () => img())
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    await r.resolve(root(['a.png']))
    const el2 = root(['a.png'])
    await r.resolve(el2)
    expect(client).toHaveBeenCalledTimes(1)
    expect(el2.querySelector('img')!.getAttribute('src')).toContain('data:image/png')
    r.invalidate('a.png')
    await r.resolve(root(['a.png']))
    expect(client).toHaveBeenCalledTimes(2)
    r.invalidate()
    expect(r.stats()).toEqual({ entries: 0, bytes: 0 })
  })
  it('cache hit already knows dimensions: reserved box uses aspect-ratio', async () => {
    const d = defer<LoadedImage>()
    let first = true
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: () => { if (first) { first = false; return Promise.resolve(img(1, { width: 200, height: 100 })) } return d.p } })
    await r.resolve(root(['a.png']))
    r.invalidate('x')
    const el = root(['a.png'])
    const run = r.resolve(el)
    expect(el.querySelector('img')!.getAttribute('width')).toBe('200')
    await run
  })
  it('never exceeds the concurrency cap with 20 images', async () => {
    let active = 0, max = 0
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', concurrency: 4, client: async () => { active++; max = Math.max(max, active); await tick(); active--; return img() } })
    const el = root(Array.from({ length: 20 }, (_, i) => `i${i}.png`))
    await r.resolve(el)
    expect(max).toBe(4)
    expect(el.querySelectorAll('img[data-state="ok"]').length).toBe(20)
  })
  it('dispose aborts pending loads and late results are ignored', async () => {
    const ds: Array<ReturnType<typeof defer<LoadedImage>>> = []
    const signals: AbortSignal[] = []
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: (_n, _r, s) => { signals.push(s!); const d = defer<LoadedImage>(); ds.push(d); return d.p } })
    const el = root(['a.png', 'b.png'])
    const run = r.resolve(el)
    await tick()
    r.dispose()
    expect(signals.every((s) => s.aborted)).toBe(true)
    ds.forEach((d) => d.res(img()))
    await run
    expect(el.querySelector('img')).toBeNull()
    expect(r.stats().entries).toBe(0)
  })
  it('a new resolve cancels stale loads of the previous root', async () => {
    const ds = new Map<string, ReturnType<typeof defer<LoadedImage>>>()
    const sig = new Map<string, AbortSignal>()
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', concurrency: 1, client: (_n, rel, s) => { const d = defer<LoadedImage>(); ds.set(rel, d); sig.set(rel, s!); return d.p } })
    const el1 = root(['a.png', 'b.png'])
    const run1 = r.resolve(el1)
    await tick()
    const el2 = root(['c.png'])
    const run2 = r.resolve(el2)
    await tick()
    expect(sig.get('a.png')!.aborted).toBe(true)
    expect(ds.has('b.png')).toBe(false)
    ds.get('a.png')!.res(img())
    ds.get('c.png')!.res(img(3))
    await Promise.all([run1, run2])
    expect(el1.querySelector('img')).toBeNull()
    expect(el2.querySelector('img')!.getAttribute('src')).toContain('AA3=')
  })
  it('no DOM writes after dispose even when the client rejects late', async () => {
    const d = defer<LoadedImage>()
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: () => d.p })
    const el = root(['a.png'])
    const run = r.resolve(el)
    await tick()
    const before = el.innerHTML
    r.dispose()
    d.rej(new ImageError('notFound'))
    await run
    expect(el.innerHTML).toBe(before)
  })
  it('LRU stays under the cache cap', async () => {
    let n = 0
    const big = (): LoadedImage => ({ ...img(), dataUri: 'data:image/png;base64,' + 'A'.repeat(1000) + (n++) })
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', cacheBytes: 3500, client: async () => big() })
    await r.resolve(root(Array.from({ length: 10 }, (_, i) => `p${i}.png`)))
    expect(r.stats().bytes).toBeLessThanOrEqual(3500)
    expect(r.stats().entries).toBeLessThanOrEqual(3)
  })
  it('a changed notebook path drops the cache', async () => {
    let p: string | null = '/n/a.sqlnb'
    const client = vi.fn(async () => img())
    const r = createImageResolver({ notebookPath: () => p, client })
    await r.resolve(root(['a.png']))
    p = '/m/b.sqlnb'
    await r.resolve(root(['a.png']))
    expect(client).toHaveBeenCalledTimes(2)
  })
  it('leaves non-relative images untouched', async () => {
    const client = vi.fn()
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const el = document.createElement('div')
    el.innerHTML = '<img src="data:image/png;base64,AAAA" alt="d">'
    await r.resolve(el)
    expect(client).not.toHaveBeenCalled()
    expect(el.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })
})
