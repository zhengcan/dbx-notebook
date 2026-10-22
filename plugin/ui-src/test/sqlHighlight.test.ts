import { describe, expect, it } from 'vitest'
import { highlightSql } from '../src/editor/sqlHighlight'
import { createSqlEditor } from '../src/editor/sqlEditor'

const unescape = (h: string) => h.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

describe('highlightSql', () => {
  const sample = "SELECT 'a<b>' AS x, 1 -- c\nFROM \"T\" WHERE id = {{ id }}"
  it('emits all kinds, escaped', () => {
    const h = highlightSql(sample)
    for (const k of ['keyword', 'string', 'number', 'comment', 'quotedIdentifier', 'placeholder']) expect(h).toContain(`class="sql-${k}"`)
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;b&gt;')
    expect(unescape(h)).toBe(sample)
  })
  it('placeholder span wraps exactly the placeholder', () => {
    expect(highlightSql('x = {{ id }}')).toContain('<span class="sql-placeholder">{{ id }}</span>')
  })
  it('empty', () => { expect(highlightSql('')).toBe('') })
  it('multiline block comment round-trips', () => {
    const s = 'SELECT 1 /* a\n b <i> */\nFROM t'
    const h = highlightSql(s)
    expect(h).toContain('sql-comment')
    expect(h).not.toContain('<i>')
    expect(unescape(h)).toBe(s)
  })
  const hostile = ['<script>alert(1)</script>', '& &amp; &lt;', `"'"'`, '</span><img src=x onerror=alert(1)>', 'a\u0000b', 'héllo 日本語 😀', "SELECT 'unterminated <b>", '/* unterminated <b>', "'</span>'", '{{ <b> }}', 'SELECT {{ a }}{{ b }}']
  for (const s of hostile) {
    it('hostile ' + JSON.stringify(s).slice(0, 30), () => {
      const h = highlightSql(s)
      expect(unescape(h)).toBe(s)
      expect(h.replace(/<span class="sql-[A-Za-z]+">|<\/span>/g, '')).not.toMatch(/[<>]/)
    })
  }
  it('DOM-level: only spans, no injected elements', () => {
    const el = document.createElement('div')
    el.innerHTML = highlightSql(hostile.filter((s) => !s.includes('\u0000')).join('\n'))
    expect(el.querySelectorAll('*:not(span)').length).toBe(0)
    expect(el.querySelectorAll('script,img,[onerror]').length).toBe(0)
    expect(Array.from(el.querySelectorAll('span')).every((s) => /^sql-/.test(s.className) && s.attributes.length === 1)).toBe(true)
    expect(el.textContent).toBe(hostile.filter((s) => !s.includes('\u0000')).join('\n'))
  })
  it('200 KB under 1500 ms', () => {
    const big = "SELECT a, 'x', 1 FROM t WHERE b = {{ p }} -- c\n".repeat(4500)
    const t0 = performance.now()
    const h = highlightSql(big)
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(unescape(h)).toBe(big)
  })
  it('never throws on huge / odd input', () => {
    expect(() => highlightSql("'".repeat(100000))).not.toThrow()
  })
})

describe('createSqlEditor highlighting', () => {
  const mk = (doc: string) => {
    const parent = document.createElement('div'); document.body.appendChild(parent)
    return { parent, ed: createSqlEditor(parent, { doc, dialect: 'PostgreSQL', onChange: () => {} }) }
  }
  it('keyword/placeholder classes present; setDark keeps doc', () => {
    const { parent, ed } = mk("SELECT 1 FROM t WHERE a = {{ a }}")
    expect(parent.querySelector('.sql-keyword')?.textContent).toBe('SELECT')
    expect(parent.querySelector('.sql-number')).not.toBeNull()
    expect(parent.querySelector('.sql-placeholder')?.textContent).toBe('{{ a }}')
    ed.setDark(true)
    expect(ed.getDoc()).toBe("SELECT 1 FROM t WHERE a = {{ a }}")
    expect(parent.querySelector('.sql-keyword')).not.toBeNull()
    ed.destroy()
  })
  it('typing a placeholder yields a placeholder span', () => {
    const { parent, ed } = mk('')
    ed.setDoc('SELECT {{ a }}')
    expect(parent.querySelector('.sql-placeholder')).not.toBeNull()
    ed.destroy()
  })
  it('palette style injected once', () => {
    mk('select 1').ed.destroy()
    expect(document.querySelectorAll('#sqlnb-sql-palette').length).toBe(1)
  })
  it('20k lines: bounded rendered lines', () => {
    const { parent, ed } = mk('SELECT 1 FROM t;\n'.repeat(20000))
    expect(parent.querySelectorAll('.cm-line').length).toBeLessThan(500)
    ed.destroy()
  })
  it('5k-line doc: edits stay fast', () => {
    const { ed } = mk("SELECT a, 'x', 1 FROM t WHERE b = {{ p }};\n".repeat(5000))
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) ed.setDoc(ed.getDoc() + ' ')
    const per = (performance.now() - t0) / 20
    console.log('5k-line edit ms/op', per.toFixed(1))
    expect(per).toBeLessThan(150)
    ed.destroy()
  })
})

describe('highlightSql size cap + placeholders', () => {
  it('1 MB input: bounded time, escaped, round-trips', () => {
    const big = "SELECT a, '<b>', 1 FROM t WHERE b = {{ p }} -- c\n".repeat(21000)
    expect(big.length).toBeGreaterThan(1_000_000)
    const t0 = performance.now()
    const h = highlightSql(big)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(h).not.toContain('<b>')
    expect(unescape(h)).toBe(big)
  })
  it('over the cap falls back to escaped plain text', () => {
    const big = 'SELECT <x> & 1\n'.repeat(20000)
    const h = highlightSql(big, { maxChars: 1000 })
    expect(h).not.toContain('<span')
    expect(unescape(h)).toBe(big)
    expect(h).toContain('&lt;x&gt; &amp;')
  })
  it('nested single-level braces are one placeholder; multi-line is not', () => {
    expect(highlightSql('x = {{ a{b} }}')).toContain('<span class="sql-placeholder">{{ a{b} }}</span>')
    expect(highlightSql('x = {{ a\nb }}')).not.toContain('sql-placeholder')
  })
  it('placeholder inside a string or comment is coloured as placeholder', () => {
    expect(highlightSql("SELECT '{{ a }}'")).toContain('<span class="sql-placeholder">{{ a }}</span>')
    expect(highlightSql('-- {{ a }}')).toContain('<span class="sql-placeholder">{{ a }}</span>')
  })
})
