export type SqlTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'function' | 'identifier' | 'quotedIdentifier' | 'placeholder' | 'plain'

export const SQL_KINDS: SqlTokenKind[] = ['keyword', 'string', 'number', 'comment', 'operator', 'function', 'identifier', 'quotedIdentifier', 'placeholder', 'plain']

// GitHub Primer light / dark. The only place in src/ that holds these hex values.
export const SQL_PALETTE: { light: Record<SqlTokenKind, string>; dark: Record<SqlTokenKind, string>; bg: { light: string; dark: string } } = {
  light: {
    keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781', operator: '#0550ae',
    function: '#8250df', identifier: '#24292f', quotedIdentifier: '#116329', placeholder: '#953800', plain: '#24292f',
  },
  dark: {
    keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e', operator: '#79c0ff',
    function: '#d2a8ff', identifier: '#c9d1d9', quotedIdentifier: '#7ee787', placeholder: '#ffa657', plain: '#c9d1d9',
  },
  bg: { light: '#ffffff', dark: '#0d1117' },
}

const lum = (hex: string): number => {
  const n = parseInt(hex.replace('#', ''), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

export const SQL_TARGETS: Record<SqlTokenKind, number> = {
  keyword: 4.5, string: 4.5, number: 4.5, comment: 3.5, operator: 4.5, function: 4.5,
  identifier: 4.5, quotedIdentifier: 4.5, placeholder: 4.5, plain: 4.5,
}

export function contrast(fg: string, bg: string): number {
  const a = lum(fg), b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function sqlPaletteVars(dark: boolean): Record<string, string> {
  const p = dark ? SQL_PALETTE.dark : SQL_PALETTE.light
  return Object.fromEntries(SQL_KINDS.map((k) => [`--sql-${k}`, p[k]]))
}

const decl = (dark: boolean) => Object.entries(sqlPaletteVars(dark)).map(([k, v]) => `${k}:${v}`).join(';')

export function sqlPaletteCss(): string {
  const rules = SQL_KINDS.map((k) => `.sql-${k}{color:var(--sql-${k})}`).join('')
  return `:root,[data-theme="light"]{${decl(false)}}[data-theme="dark"]{${decl(true)}}${rules}`
}

// Theme follows the host: the plugin sets data-theme on the app root, so one stylesheet serves both themes.
export function ensureSqlPaletteStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('sqlnb-sql-palette')) return
  const el = document.createElement('style')
  el.id = 'sqlnb-sql-palette'
  el.textContent = sqlPaletteCss()
  document.head.appendChild(el)
}

export function parseCssColor(input: string): number[] | null {
  const s = input.trim().toLowerCase()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1)
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (m) return [+m[1], +m[2], +m[3], alphaOf(m[4])]
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, alphaOf(m[4])]
  return null
}
const alphaOf = (a?: string) => (a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a))

export function compositeOver(fg: number[], alpha: number, bg: number[]): number[] {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha))
}

const toHex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn
  if (d === 0) return [0, 0, l]
  const sat = d / (1 - Math.abs(2 * l - 1))
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, sat, l]
}

function hslToRgb(h: number, s: number, l: number): number[] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// Nudges lightness (hue/saturation kept) away from the background until every [bg, target] pair is met.
function nudge(hex: string, pairs: Array<[string, number]>): string {
  const ok = (c: string) => pairs.every(([bg, t]) => contrast(c, bg) >= t)
  if (ok(hex)) return hex
  const bgHex = pairs[0][0]
  const [h, sat, l0] = rgbToHsl(parseCssColor(hex)!)
  const lighten = lum(bgHex) < 0.18
  for (let l = l0; lighten ? l <= 1 : l >= 0; l += lighten ? 0.005 : -0.005) {
    const c = toHex(hslToRgb(h, sat, l))
    if (ok(c)) return c
  }
  return contrast('#000000', bgHex) >= contrast('#ffffff', bgHex) ? '#000000' : '#ffffff'
}

// Selection paints foreground at ~18% over the surface (see sqlEditor darkTheme); tokens stay >= 3:1 on it too.
export const SQL_SELECTION_ALPHA = 0.18
export const SQL_SELECTION_TARGET = 2.8

export function adjustSqlPalette(bgHex: string): Record<SqlTokenKind, string> {
  const dark = contrast(SQL_PALETTE.dark.plain, bgHex) > contrast(SQL_PALETTE.light.plain, bgHex)
  const base = dark ? SQL_PALETTE.dark : SQL_PALETTE.light
  const sel = toHex(compositeOver((dark ? [255, 255, 255] : [0, 0, 0]), SQL_SELECTION_ALPHA, parseCssColor(bgHex)!))
  return Object.fromEntries(SQL_KINDS.map((k) => [k, nudge(base[k], [[bgHex, SQL_TARGETS[k]], [sel, SQL_SELECTION_TARGET]])])) as Record<SqlTokenKind, string>
}

// Opaque colour a surface actually shows: its computed background composited over ancestors (white canvas as last resort).
export function effectiveBackground(el: Element): string | null {
  const layers: number[][] = []
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = parseCssColor(getComputedStyle(n).backgroundColor)
    if (!c) { if (getComputedStyle(n).backgroundColor) return null; continue }
    if (c[3] <= 0) continue
    layers.push(c)
    if (c[3] >= 1) break
  }
  let acc = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop()! : [255, 255, 255, 1]
  while (layers.length) { const t = layers.pop()!; acc = compositeOver(t, t[3], acc).concat(1) }
  return toHex(acc)
}

export interface SqlContrastGuard { refresh(): void; dispose(): void }

// Rewrites the --sql-* vars on `target` so tokens meet SQL_TARGETS on what `surface` actually shows.
// Re-runs on ancestor theme attribute changes and on the host's dbx-plugin-env event. Only writes changed values.
export function applySqlContrastGuard(surface: Element, target: HTMLElement): SqlContrastGuard {
  let pending = false
  const refresh = () => {
    pending = false
    const bg = effectiveBackground(surface)
    if (!bg) return
    const p = adjustSqlPalette(bg)
    for (const k of SQL_KINDS) {
      if (target.style.getPropertyValue(`--sql-${k}`) !== p[k]) target.style.setProperty(`--sql-${k}`, p[k])
    }
  }
  const schedule = () => { if (!pending) { pending = true; queueMicrotask(refresh) } }
  refresh()
  let mo: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver((recs) => { if (recs.some((r) => r.target !== target)) schedule() })
    for (let n: Element | null = surface; n; n = n.parentElement) mo.observe(n, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  }
  window.addEventListener('dbx-plugin-env', schedule)
  return { refresh, dispose() { mo?.disconnect(); window.removeEventListener('dbx-plugin-env', schedule) } }
}
