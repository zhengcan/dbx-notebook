import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import DiffView from '../src/ai/DiffView.vue'
import { DIFF_HIGHLIGHT_MAX_LINES } from '../src/ai/diffHighlight'
import { useSqlContrastGuard } from '../src/ai/useSqlContrastGuard'
import { renderMarkdownSafe } from '../src/export/markdown'
import { setLocale } from '../src/i18n'

describe('DiffView highlighting', () => {
  beforeEach(() => setLocale('zh-CN'))
  it('highlights each line, keeps markers/kinds/text', () => {
    const w = mount(DiffView, { props: { before: 'SELECT 1\nkeep', after: 'SELECT 2\nkeep' } })
    const rows = w.findAll('.ln')
    expect(rows.map((r) => r.attributes('data-kind'))).toEqual(['del', 'add', 'same'])
    expect(rows[0].find('.sql-keyword').text()).toBe('SELECT')
    expect(rows[0].find('.mk').text()).toBe('-')
    expect(rows[1].find('.mk').text()).toBe('+')
    expect(rows[0].find('.sr').exists()).toBe(true)
    expect(rows[0].find('.tx').text()).toBe('SELECT 1')
    expect(rows[2].find('.tx').text()).toBe('keep')
  })
  it('hostile line stays text', () => {
    const w = mount(DiffView, { props: { before: '', after: '<img src=x onerror=alert(1)>' } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('.tx').text()).toBe('<img src=x onerror=alert(1)>')
  })
  it('caps highlighting above N lines and stays fast', () => {
    const big = Array.from({ length: DIFF_HIGHLIGHT_MAX_LINES + 50 }, (_, i) => `SELECT ${i}`).join('\n')
    const t0 = performance.now()
    const w = mount(DiffView, { props: { before: '', after: big } })
    expect(w.findAll('.ln').length).toBe(DIFF_HIGHLIGHT_MAX_LINES + 50)
    expect(w.find('.sql-keyword').exists()).toBe(false)
    expect(w.findAll('.tx')[3].text()).toBe('SELECT 3')
    expect(performance.now() - t0).toBeLessThan(3000)
  })
  it('5000-line diff renders fast', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `SELECT ${i}`).join('\n')
    const t0 = performance.now()
    mount(DiffView, { props: { before: '', after: big } })
    expect(performance.now() - t0).toBeLessThan(2500)
  })
})

describe('useSqlContrastGuard', () => {
  it('applies on mount and disposes on unmount', async () => {
    const C = defineComponent({ setup() { const el = ref<HTMLElement | null>(null); useSqlContrastGuard(el); return () => h('div', { ref: el }, 'x') } })
    const w = mount(C, { attachTo: document.body })
    await nextTick()
    expect((w.element as HTMLElement).style.getPropertyValue('--sql-keyword')).not.toBe('')
    w.unmount()
  })
})

describe('DiffView guard and highlight at the cap', () => {
  it('disposes the contrast guard on unmount (positive control: it reacts while mounted)', async () => {
    const w = mount(DiffView, { props: { before: 'a', after: 'select 1' }, attachTo: document.body })
    const el = w.find('[data-test=ai-diff]').element as HTMLElement
    const settle = () => new Promise((r) => setTimeout(r, 60))
    el.style.setProperty('--sql-keyword', '#123456')
    window.dispatchEvent(new Event('dbx-plugin-env'))
    await settle()
    expect(el.style.getPropertyValue('--sql-keyword')).not.toBe('#123456')
    w.unmount()
    el.style.setProperty('--sql-keyword', '#123456')
    window.dispatchEvent(new Event('dbx-plugin-env'))
    await settle()
    expect(el.style.getPropertyValue('--sql-keyword')).toBe('#123456')
  })
  it('600 highlighted lines render with spans and fast; 601 are plain', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} FROM t`).join('\n')
    const t0 = performance.now()
    const w = mount(DiffView, { props: { before: '', after: mk(DIFF_HIGHLIGHT_MAX_LINES) } })
    expect(w.findAll('.ln').length).toBe(DIFF_HIGHLIGHT_MAX_LINES)
    expect(w.findAll('.sql-keyword').length).toBeGreaterThanOrEqual(DIFF_HIGHLIGHT_MAX_LINES)
    expect(performance.now() - t0).toBeLessThan(2500)
    expect(mount(DiffView, { props: { before: '', after: mk(DIFF_HIGHLIGHT_MAX_LINES + 1) } }).find('.sql-keyword').exists()).toBe(false)
  })
})

describe('renderMarkdownSafe highlightSql', () => {
  const on = { highlightSql: true }
  it('highlights sql fences only when on', () => {
    const src = '```sql\nSELECT 1\n```'
    expect(renderMarkdownSafe(src, on)).toContain('sql-keyword')
    expect(renderMarkdownSafe(src, on)).toContain('<pre><code class="language-sql">')
    expect(renderMarkdownSafe(src)).not.toContain('<span')
    expect(renderMarkdownSafe(src)).toBe(renderMarkdownSafe(src, { highlightSql: false }))
  })
  it('aliases case-insensitive; other langs and inline code plain', () => {
    for (const l of ['SQL', 'PostgreSQL', 'mysql', 'sqlite', 'tsql', 'pgsql']) expect(renderMarkdownSafe('```' + l + '\nSELECT 1\n```', on)).toContain('sql-keyword')
    expect(renderMarkdownSafe('```html\nSELECT 1\n```', on)).not.toContain('<span')
    expect(renderMarkdownSafe('```\nSELECT 1\n```', on)).not.toContain('<span')
    expect(renderMarkdownSafe('`SELECT 1`', on)).not.toContain('<span')
    expect(renderMarkdownSafe('```js\nSELECT 1\n```', on)).not.toContain('class=')
  })
  it('hostile content stays inert at DOM level', () => {
    const src = '```sql\nSELECT \'</code></pre><script>alert(1)</script><img src=x onerror=alert(1)>\' -- javascript:alert(1)\n```\n\n<span class="sql-x" style="x" onclick="a()">h</span>'
    const d = new DOMParser().parseFromString(renderMarkdownSafe(src, on), 'text/html')
    expect(d.querySelector('script,img')).toBeNull()
    for (const el of Array.from(d.body.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        const ok = (el.tagName === 'SPAN' && a.name === 'class' && /^sql-[a-zA-Z]+$/.test(a.value)) || (el.tagName === 'CODE' && a.name === 'class' && a.value === 'language-sql')
        expect(ok).toBe(true)
      }
    }
    expect(d.body.textContent).toContain('<script>alert(1)</script>')
    expect(d.querySelectorAll('pre').length).toBe(1)
  })
  it('huge block above cap is plain and inert', () => {
    const big = 'SELECT ' + '<b>'.repeat(200_000)
    const out = renderMarkdownSafe('```sql\n' + big + '\n```', on)
    expect(out).not.toContain('<span')
    expect(out).not.toContain('<b>')
  })
})

describe('markdown camelCase token kinds', () => {
  it('keeps sql-quotedIdentifier spans', () => {
    expect(renderMarkdownSafe('```sql\nSELECT "T"\n```', { highlightSql: true })).toContain('sql-quotedIdentifier')
  })
})
