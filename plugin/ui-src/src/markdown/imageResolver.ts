import { ImageError, isAbort, type LoadedImage, type ReadImageFn } from '../files/imageClient'
import { REL_ATTR, OVERSIZE_ATTR } from './sanitize'
import { t } from '../i18n'

export type PlaceholderCode = ImageError['code'] | 'decodeFailed'
export const CACHE_BYTES = 32 * 1024 * 1024
const MAX_SHOWN_ALT = 200
const MAX_DIMS = 500
const ALT_ATTR = 'data-sqlnb-alt'
export const FAIL_TTL_MS = 3000

export interface ImageResolver {
  resolve(root: HTMLElement): Promise<void>
  invalidate(rel?: string): void
  dispose(): void
  stats(): { entries: number; bytes: number }
}

export function hintFor(code: PlaceholderCode): string {
  switch (code) {
    case 'notFound': return t('mdimg.notFound')
    case 'unsupported': return t('mdimg.unsupported')
    case 'tooLarge': return t('mdimg.tooLarge')
    case 'invalidPath': return t('mdimg.invalidPath')
    case 'needsSave': return t('mdimg.needsSave')
    default: return t('mdimg.decodeFailed')
  }
}

const shownAlt = (alt: string) => (alt.length > MAX_SHOWN_ALT ? alt.slice(0, MAX_SHOWN_ALT) + '…' : alt)

function span(doc: Document, state: string): HTMLSpanElement {
  const el = doc.createElement('span')
  el.className = `sqlnb-img sqlnb-img-${state}`
  el.setAttribute('data-state', state)
  el.setAttribute('role', 'img')
  return el
}

function errorPlaceholder(doc: Document, alt: string, code: PlaceholderCode): HTMLSpanElement {
  const el = span(doc, 'error')
  const hint = hintFor(code)
  const a = shownAlt(alt)
  el.setAttribute('data-error', code)
  el.setAttribute('aria-label', a ? `${a}: ${hint}` : hint)
  if (a) {
    const altEl = doc.createElement('span')
    altEl.className = 'sqlnb-img-alt'
    altEl.textContent = a
    el.appendChild(altEl)
  }
  const hintEl = doc.createElement('span')
  hintEl.className = 'sqlnb-img-hint'
  hintEl.textContent = hint
  el.appendChild(hintEl)
  return el
}

function loadingPlaceholder(doc: Document, alt: string, rel: string, dims?: { w: number; h: number }): HTMLSpanElement {
  const el = span(doc, 'loading')
  const a = shownAlt(alt)
  el.setAttribute('aria-label', a ? `${a}: ${t('mdimg.loading')}` : t('mdimg.loading'))
  el.setAttribute('aria-busy', 'true')
  el.setAttribute(REL_ATTR, rel)
  el.setAttribute(ALT_ATTR, alt)
  el.style.minHeight = '48px'
  el.style.minWidth = '96px'
  if (dims && dims.w > 0 && dims.h > 0) {
    el.style.aspectRatio = `${dims.w} / ${dims.h}`
    el.style.width = `min(${dims.w}px, 100%)`
  }
  return el
}

function watchDecode(img: HTMLImageElement, alt: string): void {
  img.addEventListener('error', () => {
    if (img.isConnected) img.replaceWith(errorPlaceholder(img.ownerDocument, alt, 'decodeFailed'))
  }, { once: true })
}

function okImage(doc: Document, alt: string, r: LoadedImage): HTMLImageElement {
  const img = doc.createElement('img')
  img.setAttribute('alt', alt)
  img.setAttribute('data-state', 'ok')
  if (r.width > 0 && r.height > 0) {
    img.setAttribute('width', String(r.width))
    img.setAttribute('height', String(r.height))
  }
  watchDecode(img, alt)
  img.setAttribute('src', r.dataUri)
  return img
}

interface Inflight { ac: AbortController; promise: Promise<LoadedImage>; refs: number }

/** Cache, in-flight reads and the concurrency cap shared by every block of one notebook session. */
interface Core {
  limit: number
  capBytes: number
  cache: Map<string, LoadedImage>
  bytes: number
  dims: Map<string, { w: number; h: number }>
  failed: Map<string, { code: ImageError['code']; until: number }>
  inflight: Map<string, Inflight>
  path: string | null | undefined
  epoch: number
  active: number
  waiters: Array<(ok: boolean) => void>
}

const cores = new WeakMap<object, Core>()
const keyOf = (path: string, rel: string) => `${path}\0${rel}`

function newCore(o: { concurrency?: number; cacheBytes?: number }): Core {
  return { limit: Math.max(1, o.concurrency ?? 4), capBytes: o.cacheBytes ?? CACHE_BYTES, cache: new Map(), bytes: 0, dims: new Map(), failed: new Map(), inflight: new Map(), path: undefined, epoch: 0, active: 0, waiters: [] }
}

function resetCore(c: Core): void {
  c.cache.clear(); c.failed.clear(); c.dims.clear(); c.bytes = 0
  for (const f of c.inflight.values()) f.ac.abort()
  c.inflight.clear()
}

function acquire(c: Core, sig: AbortSignal): Promise<boolean> {
  if (sig.aborted) return Promise.resolve(false)
  if (c.active < c.limit) { c.active++; return Promise.resolve(true) }
  return new Promise((res) => {
    c.waiters.push(res)
    sig.addEventListener('abort', () => {
      const i = c.waiters.indexOf(res)
      if (i >= 0) { c.waiters.splice(i, 1); res(false) }
    }, { once: true })
  })
}
function release(c: Core): void {
  c.active--
  const n = c.waiters.shift()
  if (n) { c.active++; n(true) }
}

function remember(c: Core, rel: string, key: string, r: LoadedImage): void {
  if (r.width > 0 && r.height > 0) {
    c.dims.delete(rel)
    c.dims.set(rel, { w: r.width, h: r.height })
    if (c.dims.size > MAX_DIMS) c.dims.delete(c.dims.keys().next().value as string)
  }
  const prev = c.cache.get(key)
  if (prev) { c.bytes -= prev.dataUri.length; c.cache.delete(key) }
  if (r.dataUri.length > c.capBytes) return
  c.cache.set(key, r)
  c.bytes += r.dataUri.length
  while (c.bytes > c.capBytes) {
    const k = c.cache.keys().next().value as string
    c.bytes -= c.cache.get(k)!.dataUri.length
    c.cache.delete(k)
  }
}

function abortErr(): Error { const e = new Error('aborted'); e.name = 'AbortError'; return e }

/** One read per (path, rel): concurrent consumers join it; it is aborted only when the last consumer leaves. */
function fetchShared(c: Core, client: ReadImageFn | undefined, path: string, rel: string, consumer: AbortSignal): Promise<LoadedImage> {
  const key = keyOf(path, rel)
  const hit = c.cache.get(key)
  if (hit) { c.cache.delete(key); c.cache.set(key, hit); return Promise.resolve(hit) }
  const bad = c.failed.get(key)
  if (bad) {
    if (bad.until > Date.now()) return Promise.reject(new ImageError(bad.code))
    c.failed.delete(key)
  }
  let f = c.inflight.get(key)
  if (!f || f.ac.signal.aborted) {
    const ac = new AbortController()
    const gen = c.path
    const entry: Inflight = { ac, refs: 0, promise: undefined as unknown as Promise<LoadedImage> }
    entry.promise = (async () => {
      if (!(await acquire(c, ac.signal))) throw abortErr()
      try {
        const again = c.cache.get(key)
        if (again) return again
        const gone = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(abortErr()), { once: true }))
        gone.catch(() => {})
        const r = await Promise.race([client ? client(path, rel, ac.signal) : Promise.reject(new ImageError('readFailed')), gone])
        if (!ac.signal.aborted && c.path === gen) remember(c, rel, key, r)
        return r
      } catch (e) {
        if (!isAbort(e) && !ac.signal.aborted && c.path === gen) c.failed.set(key, { code: e instanceof ImageError ? e.code : 'readFailed', until: Date.now() + FAIL_TTL_MS })
        throw e
      } finally {
        release(c)
      }
    })()
    entry.promise.catch(() => {}).finally(() => { if (c.inflight.get(key) === entry) c.inflight.delete(key) })
    c.inflight.set(key, entry)
    f = entry
  }
  const flight = f
  flight.refs++
  return new Promise<LoadedImage>((res, rej) => {
    let left = false
    const leave = () => {
      if (left) return
      left = true
      if (--flight.refs <= 0) { flight.ac.abort(); if (c.inflight.get(key) === flight) c.inflight.delete(key) }
    }
    const onAbort = () => { leave(); rej(abortErr()) }
    if (consumer.aborted) { onAbort(); return }
    consumer.addEventListener('abort', onAbort, { once: true })
    flight.promise.then((r) => { left = true; consumer.removeEventListener('abort', onAbort); res(r) }, (e) => { left = true; consumer.removeEventListener('abort', onAbort); rej(e) })
  })
}

export interface ImageResolverOptions {
  notebookPath: () => string | null
  client?: ReadImageFn
  concurrency?: number
  cacheBytes?: number
  /** Resolvers with the same `shared` object (default: the same `client`) share one cache, read queue and cap. */
  shared?: object
  /** Changes whenever the notebook is (re)loaded: the cache of the shared core is dropped, even for the same path. */
  epoch?: () => number
}

export function createImageResolver(opts: ImageResolverOptions): ImageResolver {
  const sharedKey = opts.shared ?? opts.client
  let core = sharedKey ? cores.get(sharedKey) : undefined
  if (!core) { core = newCore(opts); if (sharedKey) cores.set(sharedKey, core) }
  const c = core
  let disposed = false
  const activeLoads = new Map<HTMLElement, { ac: AbortController; done: Promise<void> }>()

  function startLoad(ph: HTMLElement, rel: string, alt: string, path: string): Promise<void> {
    const ac = new AbortController()
    const done = (async () => {
      try {
        const r = await fetchShared(c, opts.client, path, rel, ac.signal)
        if (ac.signal.aborted || disposed) return
        if (ph.isConnected) ph.replaceWith(okImage(ph.ownerDocument, alt, r))
      } catch (e) {
        if (ac.signal.aborted || disposed || isAbort(e)) return
        const code: PlaceholderCode = e instanceof ImageError ? e.code : 'readFailed'
        if (ph.isConnected) ph.replaceWith(errorPlaceholder(ph.ownerDocument, alt, code))
      }
    })().finally(() => { if (activeLoads.get(ph)?.ac === ac) activeLoads.delete(ph) })
    activeLoads.set(ph, { ac, done })
    return done
  }

  return {
    async resolve(root) {
      if (disposed) return
      const path = opts.notebookPath()
      const epoch = opts.epoch?.() ?? 0
      if (path !== c.path || epoch !== c.epoch) { resetCore(c); c.path = path; c.epoch = epoch }
      // Loads whose placeholder is no longer inside this root belong to replaced content: cancel them.
      for (const [ph, l] of activeLoads) if (!root.contains(ph)) l.ac.abort()
      const doc = root.ownerDocument
      const tasks: Promise<void>[] = []
      root.querySelectorAll('img, [data-state="loading"]').forEach((img) => {
        const alt = img.getAttribute('alt') ?? img.getAttribute(ALT_ATTR) ?? ''
        const oversize = img.getAttribute(OVERSIZE_ATTR)
        if (oversize !== null) { img.replaceWith(errorPlaceholder(doc, alt, 'tooLarge')); return }
        const rel = img.getAttribute(REL_ATTR)
        if (rel === null) {
          if (img.tagName === 'IMG' && img.hasAttribute('src') && !img.hasAttribute('data-state')) {
            img.setAttribute('data-state', 'ok')
            watchDecode(img as HTMLImageElement, alt)
          }
          return
        }
        const running = activeLoads.get(img as HTMLElement)
        if (running && !running.ac.signal.aborted) { tasks.push(running.done); return }
        if (!path) { img.replaceWith(errorPlaceholder(doc, alt, 'needsSave')); return }
        const key = keyOf(path, rel)
        const hit = c.cache.get(key)
        if (hit) {
          c.cache.delete(key)
          c.cache.set(key, hit)
          img.replaceWith(okImage(doc, alt, hit))
          return
        }
        const ph = img.tagName === 'IMG' ? loadingPlaceholder(doc, alt, rel, c.dims.get(rel)) : (img as HTMLElement)
        if (ph !== img) img.replaceWith(ph)
        tasks.push(startLoad(ph, rel, alt, path))
      })
      await Promise.all(tasks)
    },
    invalidate(rel) {
      if (rel === undefined) { c.cache.clear(); c.failed.clear(); c.bytes = 0; return }
      const tail = `\0${rel}`
      for (const k of Array.from(c.cache.keys())) if (k.endsWith(tail)) { c.bytes -= c.cache.get(k)!.dataUri.length; c.cache.delete(k) }
      for (const k of Array.from(c.failed.keys())) if (k.endsWith(tail)) c.failed.delete(k)
    },
    dispose() {
      disposed = true
      for (const l of activeLoads.values()) l.ac.abort()
    },
    stats: () => ({ entries: c.cache.size, bytes: c.bytes }),
  }
}
