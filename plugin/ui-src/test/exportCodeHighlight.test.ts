import { describe, it, expect } from 'vitest'
import { highlightCode, canonicalLang, CODE_LANGS, CODE_MAX_CHARS, CODE_MAX_LINES, codeThemeCss, CODE_THEME_LIGHT, CODE_BG } from '../src/export/codeHighlight'
import { contrast } from '../src/editor/sqlPalette'
import { renderMarkdownSafe } from '../src/export/markdown'
import { renderExportHtml } from '../src/export/html'
import { DEFAULT_EXPORT_OPTIONS } from '../src/export/options'

const L: any = { exporter: '', firstN: () => '', truncatedAtRun: () => '', empty: '', exportedAt: '', dataRunAt: '', dataSource: '', chartUnavailable: '', noData: 'n', page: '', serial: '#', summary: '', notSet: '', continued: '', colon: ':', listSep: ';' }
function buildHtml(sql: string, md?: string) {
  const sections: any[] = [{ kind: 'table', blockId: 't', columns: ['a'], rows: [['1']], nullMask: [[false]], totalRows: 1, shownRows: 1, limitedNote: null, groups: [{ cols: [0] }], numeric: [true], sql }]
  if (md) sections.push({ kind: 'markdown', blockId: 'm', source: md })
  const model: any = { documentTitle: 'T', exportedAt: '2026-10-18T00:00:00.000Z', runTimes: [], exporter: null, dataSources: [], note: '', sections, catalog: [], skipped: [], staleBlockIds: [], estimate: { totalRows: 1, bigTables: [] }, exportable: true }
  return { html: renderExportHtml(model, DEFAULT_EXPORT_OPTIONS, {}, L), sql }
}

const text = (html: string) => new DOMParser().parseFromString(`<body><pre>${html}</pre></body>`, 'text/html').body.textContent ?? ''
const toks = (html: string) => (html.match(/<span class="tok-[a-z]+">/g) ?? []).length

const FIX: Record<string, { src: string; cls: string[] }> = {
  sql: { src: "SELECT count(*), 'a' FROM t WHERE x > 10 -- hi", cls: ['tok-keyword', 'tok-string', 'tok-number', 'tok-comment'] },
  json: { src: '{"a": [1, true, null], "b": "x"}', cls: ['tok-string', 'tok-number'] },
  yaml: { src: 'name: demo\nitems:\n  - 1\n# c\n', cls: ['tok-comment'] },
  javascript: { src: 'const a = 1 + "x"; // c\nfunction f() { return a }', cls: ['tok-keyword', 'tok-string', 'tok-number', 'tok-comment'] },
  typescript: { src: 'interface A { x: number }\nlet a: string = "s"', cls: ['tok-keyword', 'tok-string'] },
  python: { src: 'def f(x):\n    return "s" + 1  # c', cls: ['tok-keyword', 'tok-string', 'tok-number', 'tok-comment'] },
  bash: { src: 'if [ -f a ]; then echo "x"; fi # c', cls: ['tok-keyword', 'tok-string', 'tok-comment'] },
}

describe('canonicalLang', () => {
  it('aliases', () => {
    for (const [a, c] of Object.entries({ js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', JSON: 'json', 'SQL title="x"': 'sql', jsx: 'javascript', tsx: 'typescript', py: 'python' }))
      expect(canonicalLang(a), a).toBe(c)
  })
  it('unknown / hostile → null', () => {
    for (const a of ['', ' ', 'cobol', 'constructor', '__proto__', 'toString', 'html', 'xml', 'css', 'sql"><script>', 'js\u0000', 'markdown']) expect(canonicalLang(a), a).toBeNull()
    expect(canonicalLang(undefined)).toBeNull()
  })
  it('allow list is small and listed', () => {
    expect(CODE_LANGS).toEqual(expect.arrayContaining(['sql', 'json', 'yaml', 'javascript', 'typescript', 'python', 'bash']))
  })
})

describe('highlightCode', () => {
  for (const [lang, f] of Object.entries(FIX)) {
    it(`${lang}: tokens + round trip`, () => {
      const h = highlightCode(f.src, lang)
      for (const c of f.cls) expect(h, c).toContain(`class="${c}"`)
      expect(text(h)).toBe(f.src)
    })
  }
  it('deterministic', () => {
    expect(highlightCode(FIX.sql.src, 'sql')).toBe(highlightCode(FIX.sql.src, 'sql'))
  })
  it('unknown language: plain escaped, no spans', () => {
    const h = highlightCode('SELECT 1 <b>', 'cobol')
    expect(h).toBe('SELECT 1 &lt;b&gt;')
    expect(highlightCode('x', null)).toBe('x')
  })
  it('hostile content stays text', () => {
    const src = '</span><script>alert(1)</script>"\' & <img onerror=x>'
    for (const lang of Object.keys(FIX)) {
      const h = highlightCode(src, lang)
      expect(h, lang).not.toMatch(/<script|<img/)
      expect(text(h), lang).toBe(src)
      expect(h.replace(/<span class="tok-[a-z]+">|<\/span>/g, ''), lang).not.toMatch(/<(?!\/?$)/)
    }
  })
  it('unicode / RTL / astral', () => {
    const src = "SELECT 'שלום עולם', '😀𠮷', 'مرحبا' -- 注释"
    const h = highlightCode(src, 'sql')
    expect(text(h)).toBe(src)
    expect(toks(h)).toBeGreaterThan(0)
  })
  it('CRLF and tabs preserved', () => {
    const src = 'SELECT 1\r\n\tFROM t\r\n'
    const h = highlightCode(src, 'sql')
    expect(h.replace(/<[^>]*>/g, '')).toBe(src)
    expect(text(h)).toBe(src.replace(/\r\n/g, '\n'))
  })
  it('size cap by chars falls back to plain', () => {
    const big = 'SELECT 1;'.repeat(Math.ceil(CODE_MAX_CHARS / 9) + 1)
    const h = highlightCode(big, 'sql')
    expect(toks(h)).toBe(0)
    expect(text(h)).toBe(big)
  })
  it('size cap by lines falls back to plain', () => {
    const big = 'a\n'.repeat(CODE_MAX_LINES + 1)
    expect(toks(highlightCode(big, 'sql'))).toBe(0)
    const ok = 'SELECT 1\n'.repeat(100)
    expect(toks(highlightCode(ok, 'sql'))).toBeGreaterThan(0)
  })
  it('100k chars within cap highlights and round-trips', () => {
    const src = ("SELECT 'x', 1 FROM t; ").repeat(4500).slice(0, 100000)
    const h = highlightCode(src, 'sql')
    expect(text(h)).toBe(src)
    expect(toks(h)).toBeGreaterThan(0)
  })
  it('huge single line round-trips', () => {
    const src = 'SELECT ' + 'a,'.repeat(50000)
    expect(text(highlightCode(src, 'sql'))).toBe(src)
  })
  it('tokeniser error → plain text, never throws', () => {
    expect(() => highlightCode('x', 'sql', { parse: () => { throw new Error('boom') } })).not.toThrow()
    expect(highlightCode('a<b', 'sql', { parse: () => { throw new Error('boom') } })).toBe('a&lt;b')
  })
  it('empty', () => { expect(highlightCode('', 'sql')).toBe('') })
})

describe('markdown fences (export mode)', () => {
  const r = (src: string) => renderMarkdownSafe(src, { highlightCode: true })
  const codeText = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').querySelector('pre code')?.textContent
  it('highlights known fences, text round trips', () => {
    for (const [lang, f] of Object.entries(FIX)) {
      const h = r('```' + lang + '\n' + f.src + '\n```')
      expect(toks(h), lang).toBeGreaterThan(0)
      expect(codeText(h), lang).toBe(f.src + '\n')
      expect(h).toContain(`<code class="language-${lang}">`)
    }
  })
  it('alias js → javascript class', () => {
    expect(r('```js\nconst a = 1\n```')).toContain('language-javascript')
  })
  it('unknown/missing language is plain, class not echoed', () => {
    for (const info of ['', 'cobol', '"><script>x</script>', 'sql"onclick="x']) {
      const h = r('```' + info + '\nSELECT 1 <b>\n```')
      if (info.startsWith('sql"')) continue
      expect(toks(h), info).toBe(0)
      expect(h).not.toMatch(/<script|onclick|language-cobol/)
      expect(codeText(h)).toBe('SELECT 1 <b>\n')
    }
  })
  it('hostile code inside fence stays text', () => {
    const src = '</span><script>alert(1)</script>'
    const h = r('```sql\n' + src + '\n```')
    expect(h).not.toMatch(/<script/)
    expect(codeText(h)).toBe(src + '\n')
  })
  it('only tok-* / language-* classes survive; default mode unchanged', () => {
    const h = r('```sql\nSELECT 1\n```\n\n<span class="evil">x</span> `a`')
    const els = Array.from(new DOMParser().parseFromString(`<body>${h}</body>`, 'text/html').querySelectorAll('[class]'))
    expect(els.length).toBeGreaterThan(0)
    for (const el of els) expect(el.getAttribute('class')).toMatch(/^(tok-[a-z]+|language-[a-z]+)$/)
    expect(renderMarkdownSafe('```sql\nSELECT 1\n```')).not.toContain('tok-')
  })
})

describe('export html', () => {
  it('SQL blocks are highlighted, text intact', () => {
    const { html, sql } = buildHtml("SELECT 'a' FROM t -- c")
    expect(html).toMatch(/<pre class="sql">.*<span class="tok-keyword">SELECT<\/span>/s)
    const pre = new DOMParser().parseFromString(html, 'text/html').querySelector('pre.sql')!
    expect(pre.textContent).toBe(sql)
  })
  it('hostile SQL cannot inject', () => {
    const { html } = buildHtml('</pre><script>alert(1)</script>')
    expect(html).not.toMatch(/<script>alert/)
  })
  it('markdown block fences are highlighted', () => {
    const { html } = buildHtml('SELECT 1', '```python\ndef f(): pass\n```')
    expect(html).toMatch(/language-python"><span class="tok-/)
  })
})

describe('theme', () => {
  it('all token colours meet WCAG AA on the code background', () => {
    for (const [k, v] of Object.entries(CODE_THEME_LIGHT)) expect(contrast(v, CODE_BG), k).toBeGreaterThanOrEqual(4.5)
  })
  it('one theme block, print-color-adjust exact', () => {
    const css = codeThemeCss()
    expect(css).toContain('print-color-adjust:exact')
    for (const k of Object.keys(CODE_THEME_LIGHT)) expect(css).toContain(`.tok-${k}`)
    expect(css).not.toMatch(/prefers-color-scheme/)
  })
})
