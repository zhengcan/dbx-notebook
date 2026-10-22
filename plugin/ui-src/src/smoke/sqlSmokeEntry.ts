import { createSqlEditor } from '../editor/sqlEditor'
import { highlightSql } from '../editor/sqlHighlight'
import { applySqlContrastGuard } from '../editor/sqlPalette'
import { createApp } from 'vue'
import DiffView from '../ai/DiffView.vue'
import { renderMarkdownSafe } from '../export/markdown'

const SQL = "SELECT 'a<b>' AS x, 42 FROM \"T\" WHERE id = {{ id }} -- note"
const KINDS = ['keyword', 'string', 'number', 'comment', 'quotedIdentifier', 'placeholder']

// Mirrors the real App.vue CSS: `.app` paints var(--nb-bg) = var(--color-background, #fff | #1a1a1a for dark).
// The palette's own backgrounds are NOT used here; only the host token (or the app fallback) decides the surface.
const APP_CSS = `.app{--nb-bg:var(--color-background,#fff);--nb-fg:var(--color-foreground,#111);background:var(--nb-bg);color:var(--nb-fg);padding:8px}
.app[data-theme='dark']{--nb-bg:var(--color-background,#1a1a1a);--nb-fg:var(--color-foreground,#eee)}`

type Opts = { theme: 'light' | 'dark'; token?: string; fg?: string }

function opaque(el: Element | null): string {
  for (let n = el; n; n = n.parentElement) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(n).backgroundColor)
    if (m && (m[4] === undefined || +m[4] === 1)) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`
  }
  return 'rgb(255, 255, 255)'
}

function read(root: HTMLElement, ed: HTMLElement, ro: HTMLElement) {
  const md = root.children[2] as HTMLElement | undefined
  const df = root.children[3] as HTMLElement | undefined
  const color = (el: Element | null) => (el ? getComputedStyle(el).color : '')
  const grab = (r: Element) => Object.fromEntries(KINDS.map((k) => [k, color(r.querySelector('.sql-' + k))]))
  return { editorBg: opaque(ed.querySelector('.cm-editor')), roBg: opaque(ro), body: color(ed.querySelector('.cm-content')), roBody: color(ro), editor: grab(ed), readonly: grab(ro), theme: root.getAttribute('data-theme'),
    mdBg: md ? opaque(md) : '', mdBody: md ? color(md) : '', markdown: md ? grab(md) : {}, diffBg: df ? opaque(df) : '', diffBody: df ? color(df) : '', diff: df ? grab(df) : {} }
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  if (!document.getElementById('app-css')) {
    const st = document.createElement('style'); st.id = 'app-css'; st.textContent = APP_CSS; document.head.appendChild(st)
  }
  w.__sqlnbMountSqlForSmoke = (o: Opts) => {
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.className = 'app'
    root.setAttribute('data-theme', o.theme)
    if (o.token) root.style.setProperty('--color-background', o.token)
    if (o.fg) root.style.setProperty('--color-foreground', o.fg)
    const ed = document.createElement('div')
    const ro = document.createElement('pre')
    ro.innerHTML = highlightSql(SQL)
    const mdEl = document.createElement('div')
    mdEl.innerHTML = renderMarkdownSafe('```sql\n' + SQL + '\n```', { highlightSql: true })
    const dfEl = document.createElement('div')
    w.__sqlnbDiffApp?.unmount()
    w.__sqlnbDiffApp = createApp(DiffView, { before: 'SELECT 0', after: SQL })
    root.append(ed, ro, mdEl, dfEl)
    host.appendChild(root)
    const handle = createSqlEditor(ed, { doc: SQL, dialect: 'PostgreSQL', onChange: () => {} })
    handle.setDark(o.theme === 'dark')
    w.__sqlnbRoGuard?.dispose?.()
    w.__sqlnbRoGuard = applySqlContrastGuard(ro, ro)
    w.__sqlnbMdGuard?.dispose?.()
    w.__sqlnbMdGuard = applySqlContrastGuard(mdEl, mdEl)
    w.__sqlnbDiffApp.mount(dfEl)
    return read(root, ed, ro)
  }
  w.__sqlnbFlipForSmoke = async (o: Opts) => {
    const root = document.querySelector('.app') as HTMLElement
    root.setAttribute('data-theme', o.theme)
    if (o.token) root.style.setProperty('--color-background', o.token); else root.style.removeProperty('--color-background')
    if (o.fg) root.style.setProperty('--color-foreground', o.fg)
    window.dispatchEvent(new Event('dbx-plugin-env'))
    await new Promise((r) => setTimeout(r, 30))
    const ed = root.children[0] as HTMLElement, ro = root.children[1] as HTMLElement
    return read(root, ed, ro)
  }
}
