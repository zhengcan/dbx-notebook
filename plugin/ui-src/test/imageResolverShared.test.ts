import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createImageResolver } from '../src/markdown/imageResolver'
import { ImageError, type LoadedImage } from '../src/files/imageClient'
import { setLocale } from '../src/i18n'
import { sanitizeMarkdownHtml } from '../src/markdown/sanitize'
import { isSafeRel, classifySrc } from '../src/markdown/imagePolicy'

const img = (n = 1, extra = {}): LoadedImage => ({ mime: 'image/png', dataUri: `data:image/png;base64,AA${n}=`, size: 10, mtimeMs: 1, width: 4, height: 3, ...extra })
const root = (rels: string[]) => {
  const el = document.createElement('div')
  el.innerHTML = rels.map((r, i) => `<p><img data-sqlnb-src="${r}" alt="a${i}"></p>`).join('')
  document.body.appendChild(el)
  return el
}
const defer = <T>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b }); return { p, res, rej } }
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { setLocale('zh-CN'); document.body.innerHTML = '' })
afterEach(() => { vi.useRealTimers() })

describe('shared image resolver core', () => {
  it('50 references to one image make exactly one read', async () => {
    const client = vi.fn(async () => { await tick(); return img() })
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const el = root(Array(50).fill('a.png'))
    await r.resolve(el)
    expect(client).toHaveBeenCalledTimes(1)
    expect(el.querySelectorAll('img[data-state="ok"]').length).toBe(50)
  })
  it('two blocks referencing the same image read and store it once', async () => {
    const client = vi.fn(async () => { await tick(); return img() })
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const e1 = root(['a.png']), e2 = root(['a.png'])
    await Promise.all([a.resolve(e1), b.resolve(e2)])
    expect(client).toHaveBeenCalledTimes(1)
    expect(e1.querySelector('img')).toBeTruthy()
    expect(e2.querySelector('img')).toBeTruthy()
    expect(a.stats()).toEqual(b.stats())
    expect(a.stats().entries).toBe(1)
  })
  it('the shared key can be an explicit object (e.g. the bridge)', async () => {
    const shared = {}
    const c1 = vi.fn(async () => img()), c2 = vi.fn(async () => img())
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: c1, shared })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: c2, shared })
    await a.resolve(root(['a.png']))
    await b.resolve(root(['a.png']))
    expect(c1.mock.calls.length + c2.mock.calls.length).toBe(1)
  })
  it('a queued load re-checks the cache when it starts (concurrency 1, other block fills it)', async () => {
    const ds: Array<ReturnType<typeof defer<LoadedImage>>> = []
    const client = vi.fn((_n: string, rel: string) => { const d = defer<LoadedImage>(); ds.push(d); return d.p })
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client, concurrency: 1 })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const r1 = a.resolve(root(['x.png', 'y.png']))
    const r2 = b.resolve(root(['y.png']))
    await tick()
    ds[0].res(img(1))
    await tick()
    ds[1].res(img(2))
    await Promise.all([r1, r2])
    expect(client.mock.calls.map((c) => c[1]).sort()).toEqual(['x.png', 'y.png'])
  })
  it('aborting one consumer does not cancel the shared read for the others', async () => {
    const d = defer<LoadedImage>()
    let sig!: AbortSignal
    const client = vi.fn((_n: string, _r: string, s?: AbortSignal) => { sig = s!; return d.p })
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const e1 = root(['a.png']), e2 = root(['a.png'])
    const ra = a.resolve(e1)
    const rb = b.resolve(e2)
    await tick()
    a.dispose()
    await tick()
    expect(sig.aborted).toBe(false)
    d.res(img())
    await Promise.all([ra, rb])
    expect(e2.querySelector('img')!.getAttribute('src')).toContain('data:image/png')
    expect(e1.querySelector('img')).toBeNull()
    expect(client).toHaveBeenCalledTimes(1)
  })
  it('the read is aborted only when all consumers are gone, and is not cached', async () => {
    const d = defer<LoadedImage>()
    let sig!: AbortSignal
    const client = vi.fn((_n: string, _r: string, s?: AbortSignal) => { sig = s!; return d.p })
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const ra = a.resolve(root(['a.png'])), rb = b.resolve(root(['a.png']))
    await tick()
    a.dispose()
    expect(sig.aborted).toBe(false)
    b.dispose()
    expect(sig.aborted).toBe(true)
    d.res(img())
    await Promise.all([ra, rb])
    expect(a.stats().entries).toBe(0)
  })
  it('a failed read is cached for a short TTL, then retried', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const client = vi.fn(async () => { throw new ImageError('notFound') })
    const r = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const e1 = root(['a.png'])
    await r.resolve(e1)
    const e2 = root(['a.png'])
    await r.resolve(e2)
    expect(client).toHaveBeenCalledTimes(1)
    expect(e2.querySelector('[data-error="notFound"]')).toBeTruthy()
    vi.setSystemTime(1_000_000 + 3100)
    await r.resolve(root(['a.png']))
    expect(client).toHaveBeenCalledTimes(2)
  })
  it('invalidate(rel) on one block drops the shared entry and the failure memo', async () => {
    const client = vi.fn(async () => img())
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    await a.resolve(root(['a.png']))
    a.invalidate('a.png')
    await b.resolve(root(['a.png']))
    expect(client).toHaveBeenCalledTimes(2)
    let fail = true
    const c2 = vi.fn(async () => { if (fail) throw new ImageError('notFound'); return img() })
    const x = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client: c2 })
    await x.resolve(root(['n.png']))
    fail = false
    x.invalidate('n.png')
    const el = root(['n.png'])
    await x.resolve(el)
    expect(el.querySelector('img')).toBeTruthy()
  })
  it('the 32 MiB-style LRU is global across blocks', async () => {
    let n = 0
    const client = vi.fn(async () => ({ ...img(), dataUri: 'data:image/png;base64,' + 'A'.repeat(1000) + (n++) }))
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client, cacheBytes: 3500 })
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    await a.resolve(root(Array.from({ length: 4 }, (_, i) => `a${i}.png`)))
    await b.resolve(root(Array.from({ length: 4 }, (_, i) => `b${i}.png`)))
    expect(b.stats().bytes).toBeLessThanOrEqual(3500)
    expect(a.stats()).toEqual(b.stats())
  })
  it("disposing one block keeps the shared cache for the others", async () => {
    const client = vi.fn(async () => img())
    const a = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    await a.resolve(root(['a.png']))
    a.dispose()
    const b = createImageResolver({ notebookPath: () => '/n/a.sqlnb', client })
    const el = root(['a.png'])
    await b.resolve(el)
    expect(client).toHaveBeenCalledTimes(1)
    expect(el.querySelector('img')).toBeTruthy()
  })
  it('a notebook path change resets the shared cache', async () => {
    let p = '/n/a.sqlnb'
    const client = vi.fn(async () => img())
    const a = createImageResolver({ notebookPath: () => p, client })
    const b = createImageResolver({ notebookPath: () => p, client })
    await a.resolve(root(['a.png']))
    p = '/m/b.sqlnb'
    await b.resolve(root(['z.png']))
    expect(b.stats().entries).toBe(1)
    p = '/n/a.sqlnb'
    await a.resolve(root(['a.png']))
    expect(client.mock.calls.filter((c: any[]) => c[1] === 'a.png').length).toBe(2)
  })
})

describe('inline data URI cap and isSafeRel', () => {
  it('a data image over 1 MiB of base64 becomes a too-large placeholder, no src', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024 + 4)
    const html = sanitizeMarkdownHtml(`<img src="${big}" alt="huge">`)
    expect(html).not.toContain('base64')
    const el = document.createElement('div')
    el.innerHTML = html
    await createImageResolver({ notebookPath: () => '/n/a.sqlnb' }).resolve(el)
    const ph = el.querySelector('[data-state="error"]')!
    expect(ph.getAttribute('data-error')).toBe('tooLarge')
    expect(ph.textContent).toContain('huge')
    expect(ph.textContent).toContain('图片过大')
    expect(el.querySelector('img')).toBeNull()
    const small = sanitizeMarkdownHtml(`<img src="data:image/png;base64,${'A'.repeat(1000)}" alt="s">`)
    expect(small).toContain('src="data:image/png')
  })
  it('.. segments are rejected by the remaining dot rule', () => {
    for (const p of ['..', '../a.png', 'a/../b.png', 'a/..', '...']) expect(isSafeRel(p), p).toBe(false)
    expect(classifySrc('%2e%2e/a.png').kind).toBe('blocked')
    expect(isSafeRel('./a.png')).toBe(true)
  })
})
