import { describe, it, expect } from 'vitest'
import { sanitizeMarkdownHtml } from '../src/markdown/sanitize'
import { renderMarkdownSafe } from '../src/export/markdown'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const doc = (h: string) => new DOMParser().parseFromString(`<body>${h}</body>`, 'text/html')
const san = (h: string, allowRelative = true) => sanitizeMarkdownHtml(h, { allowRelative })

describe('sanitizeMarkdownHtml images', () => {
  it('remote http(s) images become alt text', () => {
    const d = doc(san('<p><img src="https://x/y.png" alt="a"> <img src="http://x/y.png" alt="b"></p>'))
    expect(d.querySelector('img')).toBeNull()
    expect(d.body.textContent).toContain('a')
    expect(d.body.textContent).toContain('b')
    expect(d.body.innerHTML).not.toContain('x/y.png')
  })
  it('keeps png/jpeg/gif/webp data URIs only', () => {
    for (const m of ['png', 'jpeg', 'gif', 'webp']) expect(doc(san(`<img src="data:image/${m};base64,AAAA" alt="k">`)).querySelector('img')?.getAttribute('src')).toBe(`data:image/${m};base64,AAAA`)
    for (const m of ['svg+xml', 'avif', 'jxl', 'heic']) {
      const d = doc(san(`<img src="data:image/${m};base64,AAAA" alt="drop">`))
      expect(d.querySelector('img'), m).toBeNull()
      expect(d.body.textContent).toBe('drop')
    }
    expect(doc(san(`<img src="${PNG}" alt="a">`)).querySelector('img')?.getAttribute('src')).toBe(PNG)
  })
  it('relative src moves to data-sqlnb-src and no src remains', () => {
    const img = doc(san('<img src="assets/a.png" alt="pic">')).querySelector('img')!
    expect(img.getAttribute('data-sqlnb-src')).toBe('assets/a.png')
    expect(img.hasAttribute('src')).toBe(false)
    expect(img.getAttribute('alt')).toBe('pic')
  })
  it('relative images are alt text when relative is not allowed', () => {
    const d = doc(san('<img src="a.png" alt="x">', false))
    expect(d.querySelector('img')).toBeNull()
    expect(d.body.textContent).toBe('x')
  })
  it('strips srcset, sizes, style, title, on* and picture/source', () => {
    const d = doc(san('<picture><source srcset="https://x/a.png"><img src="a.png" srcset="https://x/b.png 2x" sizes="10px" style="background:url(https://x)" title="/Users/me/secret" onerror="alert(1)" onload="x()" width="9" alt="t"></picture>'))
    const img = d.querySelector('img')!
    expect(img.getAttributeNames().sort()).toEqual(['alt', 'data-sqlnb-src'])
    expect(d.querySelector('picture,source')).toBeNull()
    expect(d.body.innerHTML).not.toMatch(/srcset|onerror|style=|title=|https:\/\/x/)
  })
  it.each([
    ['<img src=x onerror=alert(1)>', null],
    ['<img src="javascript:alert(1)" alt="j">', 'j'],
    ['<img src="data:text/html;base64,PGI+" alt="h">', 'h'],
    ['<img src="//host/x.png" alt="u">', 'u'],
    ['<img src="\\\\server\\x.png" alt="n">', 'n'],
    ['<img src="C:\\x.png" alt="c">', 'c'],
    ['<img src="file:///etc/passwd" alt="f">', 'f'],
    ['<img src="../../x.png" alt="t">', 't'],
    ['<img src="%2e%2e/x.png" alt="e">', 'e'],
    ['<img src="/abs.png" alt="a">', 'a'],
  ])('hostile %s never keeps a src', (html, alt) => {
    const d = doc(san(html))
    const img = d.querySelector('img')
    if (alt === null) { expect(img?.hasAttribute('src') ?? false).toBe(false); expect(d.body.innerHTML).not.toMatch(/onerror/) }
    else { expect(img).toBeNull(); expect(d.body.textContent).toBe(alt) }
  })
  it('overlong paths are dropped', () => {
    const d = doc(san(`<img src="${'a/'.repeat(600)}x.png" alt="long">`))
    expect(d.querySelector('img')).toBeNull()
    expect(d.body.textContent).toBe('long')
  })
  it('alt with markup stays text', () => {
    const d = doc(san('<img src="https://x/y.png" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">'))
    expect(d.querySelector('script')).toBeNull()
    expect(d.body.innerHTML).not.toContain('<script')
    const k = doc(san('<img src="a.png" alt="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">'))
    expect(k.querySelector('script')).toBeNull()
    expect(k.querySelector('img')!.getAttribute('alt') ?? '').not.toMatch(/<script/i)
  })
  it('keeps link behaviour (target and rel)', () => {
    const a = doc(san('<a href="https://a.com">x</a>')).querySelector('a')!
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('renderMarkdownSafe relativeImages', () => {
  it('default: relative image is alt text; opt-in keeps data-sqlnb-src', () => {
    expect(renderMarkdownSafe('![a](pic.png)')).not.toContain('<img')
    const h = renderMarkdownSafe('![a](pic.png) ![b](../x.png) ![c](https://x/y.png)', { relativeImages: true })
    expect(h).toContain('data-sqlnb-src="pic.png"')
    expect(h).not.toMatch(/\ssrc="(?!data:)/)
    expect(h).not.toContain('../x.png')
    expect(h).not.toContain('https://x/y.png')
  })
  it('svg data URIs are dropped', () => {
    expect(renderMarkdownSafe('![s](data:image/svg+xml;base64,AAAA)', { relativeImages: true })).not.toContain('<img')
  })
})
