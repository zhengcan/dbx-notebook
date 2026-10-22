import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { highlightSql } from '../editor/sqlHighlight'
import { highlightCode, canonicalLang } from './codeHighlight'
import { sanitizeImages, REL_ATTR, OVERSIZE_ATTR } from '../markdown/sanitize'
import { ImageError, type ReadImageFn } from '../files/imageClient'

const md = new MarkdownIt({ html: false, linkify: true })
const purify = DOMPurify(window)

const SQL_LANGS = new Set(['sql', 'postgresql', 'mysql', 'sqlite', 'tsql', 'pgsql'])
const mdSql = new MarkdownIt({
  html: false,
  linkify: true,
  highlight: (str, lang) => (SQL_LANGS.has((lang || '').trim().split(/\s+/)[0].toLowerCase()) ? `<pre><code class="language-sql">${highlightSql(str)}</code></pre>` : ''),
})

const mdCode = new MarkdownIt({
  html: false,
  linkify: true,
  highlight: (str, lang) => {
    const c = canonicalLang(lang)
    return c ? `<pre><code class="language-${c}">${highlightCode(str, c)}</code></pre>` : ''
  },
})

export function renderMarkdownSafe(source: string, opts: { highlightSql?: boolean; highlightCode?: boolean; relativeImages?: boolean } = {}): string {
  const code = opts.highlightCode === true
  const hl = opts.highlightSql === true || code
  const raw = purify.sanitize((code ? mdCode : hl ? mdSql : md).render(source), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'em', 'strong', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', ...(hl ? ['span'] : [])],
    ALLOWED_ATTR: ['href', 'rel', 'src', 'alt', 'title', ...(hl ? ['class'] : [])],
    ALLOWED_URI_REGEXP: opts.relativeImages ? /^(?:https?:|mailto:|data:image\/|(?![a-z][a-z0-9+.-]*:)[^\\]*$)/i : /^(?:https?:|mailto:|data:image\/)/i,
  })
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html')
  doc.querySelectorAll('a').forEach((a) => {
    a.removeAttribute('target')
    if (!/^(?:https?:|mailto:)/i.test(a.getAttribute('href') ?? '')) a.removeAttribute('href')
  })
  sanitizeImages(doc.body, { allowRelative: opts.relativeImages === true })
  if (hl) {
    doc.querySelectorAll('[class]').forEach((el) => {
      const c = el.getAttribute('class') ?? ''
      const ok = el.tagName === 'SPAN'
        ? (code ? /^tok-[a-z]+$/ : /^sql-[a-zA-Z]+$/).test(c)
        : el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE' && (code ? /^language-[a-z]+$/.test(c) && canonicalLang(c.slice(9)) === c.slice(9) : c === 'language-sql')
      if (!ok) el.removeAttribute('class')
    })
    doc.querySelectorAll('span:not([class])').forEach((sp) => sp.replaceWith(...Array.from(sp.childNodes)))
  }
  return doc.body.innerHTML
}

export const EXPORT_IMAGE_BUDGET = 50 * 1024 * 1024
export interface ImageBudget { remaining: number }
export const createImageBudget = (bytes = EXPORT_IMAGE_BUDGET): ImageBudget => ({ remaining: bytes })

export interface ExportImageCtx { notebookPath: string | null; client?: ReadImageFn; budget?: number | ImageBudget }

/** Renders Markdown for export and embeds relative images as data URIs (total capped by `budget`, in document order). */
export async function renderMarkdownForExport(
  source: string,
  ctx: ExportImageCtx,
  opts: { highlightCode?: boolean } = { highlightCode: true },
): Promise<{ html: string; embedded: number; skipped: number }> {
  const budget = typeof ctx.budget === 'object' ? ctx.budget : createImageBudget(ctx.budget)
  const raw = renderMarkdownSafe(source, { ...opts, relativeImages: true })
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html')
  let embedded = 0
  let skipped = 0
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const rel = img.getAttribute(REL_ATTR)
    if (rel === null && !img.hasAttribute(OVERSIZE_ATTR)) continue
    const alt = img.getAttribute('alt') ?? ''
    let uri: string | null = null
    if (rel !== null && ctx.notebookPath && ctx.client && budget.remaining > 0) {
      try {
        const r = await ctx.client(ctx.notebookPath, rel)
        if (r.dataUri.length <= budget.remaining) { budget.remaining -= r.dataUri.length; uri = r.dataUri }
      } catch (e) {
        if (!(e instanceof ImageError)) console.debug('[sqlnb export] image read failed')
      }
    }
    if (uri) {
      img.removeAttribute(REL_ATTR)
      img.setAttribute('src', uri)
      embedded++
    } else {
      skipped++
      const m = doc.createElement('span')
      m.className = 'sqlnb-img-missing'
      m.textContent = alt
      img.replaceWith(m)
    }
  }
  return { html: doc.body.innerHTML, embedded, skipped }
}
