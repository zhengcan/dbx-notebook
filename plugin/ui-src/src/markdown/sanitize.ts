import DOMPurify from 'dompurify'
import { classifySrc } from './imagePolicy'

export const REL_ATTR = 'data-sqlnb-src'
/** Marks an inline data image above the cap; the preview shows the 「图片过大」 placeholder. */
export const OVERSIZE_ATTR = 'data-sqlnb-oversize'
export const MAX_INLINE_DATA = 1024 * 1024
const MAX_ALT = 1000

const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/**
 * Rebuilds every <img>: only png/jpeg/gif/webp data URIs keep a `src`; a safe relative path moves to `data-sqlnb-src`
 * (never `src`, the preview sets that after the sidecar read succeeds); everything else becomes its alt text.
 * Only `alt` survives (no title, srcset, sizes, style, width, height, on*).
 */
export function sanitizeImages(root: ParentNode, opts: { allowRelative: boolean; remoteUrlAsText?: boolean }): void {
  const doc = (root as Node).ownerDocument ?? (root as Document)
  root.querySelectorAll('img').forEach((img) => {
    const alt = (img.getAttribute('alt') ?? '').slice(0, MAX_ALT)
    const src = img.getAttribute('src') ?? ''
    const c = classifySrc(src)
    if (c.kind === 'blocked' || (c.kind === 'relative' && !opts.allowRelative)) {
      // Remote URLs without alt text stay visible as text (never fetched); local paths are never echoed.
      img.replaceWith(doc.createTextNode(alt || (opts.remoteUrlAsText && /^https?:\/\//i.test(src) ? src.slice(0, MAX_ALT) : '')))
      return
    }
    const out = doc.createElement('img')
    out.setAttribute('alt', alt)
    if (c.kind === 'data' && c.src.length - c.src.indexOf(',') - 1 > MAX_INLINE_DATA) out.setAttribute(OVERSIZE_ATTR, '1')
    else if (c.kind === 'data') out.setAttribute('src', c.src)
    else out.setAttribute(REL_ATTR, c.rel)
    img.replaceWith(out)
  })
}

export function sanitizeMarkdownHtml(html: string, opts: { allowRelative?: boolean } = {}): string {
  const clean = purify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['picture', 'source', 'style'],
    FORBID_ATTR: ['srcset', 'sizes'],
    ALLOW_DATA_ATTR: false,
  })
  const tpl = document.createElement('template')
  tpl.innerHTML = clean
  sanitizeImages(tpl.content, { allowRelative: opts.allowRelative === true, remoteUrlAsText: true })
  return tpl.innerHTML
}
