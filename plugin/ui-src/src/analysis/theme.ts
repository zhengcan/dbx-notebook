// fontFamily: the document's computed font stack. Vega measures text on a canvas, where 'inherit' is invalid (falls back to sans-serif), so the real stack must be passed for layout to match the rendered text.
export interface ThemeTokens { foreground: string; mutedForeground: string; border: string; background: string; fontFamily?: string }

// Each colour has >=3:1 contrast against both #ffffff and #1a1a1a.
export const PALETTE = ['#3b82f6', '#e8590c', '#12a150', '#c026d3', '#c08a00', '#0d9fb3', '#e03e5c', '#8b6cf0']

const FALLBACK: ThemeTokens = { foreground: '#1f2328', mutedForeground: '#6b7280', border: '#d0d7de', background: '#ffffff' }
const FALLBACK_DARK: ThemeTokens = { foreground: '#eeeeee', mutedForeground: '#9ca3af', border: '#444444', background: '#1a1a1a' }

export interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const num = (t: string, pct: number): number | null => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(t)
  return m ? (m[2] ? (Number(m[1]) / 100) * pct : Number(m[1])) : null
}
const hue = (t: string): number | null => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i.exec(t)
  if (!m) return null
  const v = Number(m[1]), u = (m[2] ?? 'deg').toLowerCase()
  return u === 'grad' ? v * 0.9 : u === 'rad' ? (v * 180) / Math.PI : u === 'turn' ? v * 360 : v
}
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function oklab(L: number, a: number, b: number, alpha: number): Rgba {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  const [r, g, bl] = lin.map((v) => clamp(gamma(clamp(v, 0, 1)) * 255, 0, 255))
  return { r, g, b: bl, a: alpha }
}

// The single colour parser: hex, rgb(), hsl(), color(srgb), oklch(), oklab(), transparent. Anything else (var(), color-mix(), names, garbage) is null.
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].replace(/./g, '$&$&') : hex[1]
    const v = [0, 2, 4, 6].map((i) => (h.length > i ? parseInt(h.slice(i, i + 2), 16) : 255))
    return { r: v[0], g: v[1], b: v[2], a: v[3] / 255 }
  }
  const fn = /^([a-z-]+)\(([^()]*)\)$/.exec(s)
  if (!fn) return null
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  const alphaOf = (t: string | undefined) => (t === undefined ? 1 : num(t, 1))
  const name = fn[1]
  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3 || parts.length > 4) return null
    const c = parts.slice(0, 3).map((t) => num(t, 255)), a = alphaOf(parts[3])
    if (c.some((v) => v === null) || a === null) return null
    return { r: clamp(c[0]!, 0, 255), g: clamp(c[1]!, 0, 255), b: clamp(c[2]!, 0, 255), a: clamp(a, 0, 1) }
  }
  if (name === 'hsl' || name === 'hsla') {
    if (parts.length < 3 || parts.length > 4) return null
    const h = hue(parts[0]), sat = num(parts[1], 1), li = num(parts[2], 1), a = alphaOf(parts[3])
    if (h === null || sat === null || li === null || a === null || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return null
    const L = clamp(li, 0, 1), q = clamp(sat, 0, 1) * Math.min(L, 1 - L)
    const k = (n: number) => (n + h / 30) % 12
    const f = (n: number) => (L - q * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255
    return { r: f(0), g: f(8), b: f(4), a: clamp(a, 0, 1) }
  }
  if (name === 'color') {
    if (parts[0] !== 'srgb' || parts.length < 4 || parts.length > 5) return null
    const c = parts.slice(1, 4).map((t) => num(t, 1)), a = alphaOf(parts[4])
    if (c.some((v) => v === null) || a === null) return null
    return { r: clamp(c[0]! * 255, 0, 255), g: clamp(c[1]! * 255, 0, 255), b: clamp(c[2]! * 255, 0, 255), a: clamp(a, 0, 1) }
  }
  if (name === 'oklch' || name === 'oklab') {
    if (parts.length < 3 || parts.length > 4) return null
    const L = num(parts[0], 1), a = alphaOf(parts[3])
    if (L === null || a === null) return null
    if (name === 'oklab') {
      const x = num(parts[1], 0.4), y = num(parts[2], 0.4)
      return x === null || y === null ? null : oklab(L, x, y, clamp(a, 0, 1))
    }
    const C = num(parts[1], 0.4), h = hue(parts[2])
    if (C === null || h === null) return null
    return oklab(L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180), clamp(a, 0, 1))
  }
  return null
}

const hex2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')
export const toHex = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
const over = (top: Rgba, base: Rgba): Rgba => {
  const a = top.a + base.a * (1 - top.a)
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number) => (t * top.a + b * base.a * (1 - top.a)) / a
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a }
}

function viaCanvas(css: string): Rgba | null {
  try {
    const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!g) return null
    g.fillStyle = '#000'
    g.fillStyle = css
    g.clearRect(0, 0, 1, 1)
    g.fillRect(0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }
  } catch { return null }
}

// Resolves any CSS colour token (var(), color-mix(), hsl/oklch, bare channel triplets, ...) to rgba through the browser, in `el`'s cascade.
export function resolveColor(el: Element, value: string): Rgba | null {
  const v = value.trim()
  if (!v) return null
  const doc = el.ownerDocument
  for (const cand of [v, `hsl(${v})`, `oklch(${v})`, `rgb(${v})`]) {
    const direct = parseColor(cand)
    if (direct) return direct
    const probe = doc.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
    probe.style.color = cand
    if (!probe.style.color) continue
    el.appendChild(probe)
    let computed = ''
    try { computed = getComputedStyle(probe).color } finally { probe.remove() }
    const c = parseColor(computed) ?? (computed ? viaCanvas(computed) : null)
    if (c) return c
  }
  return null
}

function opaqueBackdrop(el: HTMLElement, fallback: Rgba): Rgba {
  const layers: Rgba[] = []
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    const c = parseColor(getComputedStyle(e).backgroundColor)
    if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break }
  }
  return layers.reduceRight((base, l) => over(l, base), fallback)
}

export function readTokens(el: HTMLElement): ThemeTokens {
  const cs = getComputedStyle(el)
  const dark = !!el.closest?.('[data-theme="dark"]')
  const fb = dark ? FALLBACK_DARK : FALLBACK
  const fbBg = parseColor(fb.background)!
  const get = (name: string) => cs.getPropertyValue(`--color-${name}`).trim()
  const rawBg = get('background')
  const bgTok = rawBg ? resolveColor(el, rawBg) : null
  const bg = bgTok && bgTok.a >= 1 ? bgTok : over(bgTok ?? { r: 0, g: 0, b: 0, a: 0 }, opaqueBackdrop(el, fbBg))
  const pick = (name: string, d: string) => {
    const raw = get(name)
    const c = raw ? resolveColor(el, raw) : null
    return c ? toHex(over(c, bg)) : d
  }
  const fontFamily = cs.fontFamily?.trim()
  return { foreground: pick('foreground', fb.foreground), mutedForeground: pick('muted-foreground', fb.mutedForeground), border: pick('border', fb.border), background: toHex(bg), ...(fontFamily ? { fontFamily } : {}) }
}

// Keeps a themed text colour only if it is verifiably readable (>=4.5:1) on the themed background; otherwise (or if it cannot be parsed) the better theme fallback is used.
export function readableOn(color: string, bg: string, fallbackDark: string, fallbackLight: string): string {
  const white = parseColor(FALLBACK.background)!
  const b0 = parseColor(bg) ?? white
  const b = b0.a >= 1 ? b0 : over(b0, white)
  const ratio = (c: Rgba) => {
    const l = (x: Rgba) => { const [r, g, bl] = [x.r, x.g, x.b].map((v) => { const t = v / 255; return t <= 0.03928 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl }
    const [hi, lo] = [l(c), l(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }
  const c0 = parseColor(color)
  if (c0) {
    const c = over(c0, b)
    if (ratio(c) >= 4.5) return c0.a >= 1 && /^#[0-9a-f]{3,8}$/i.test(color.trim()) ? color : toHex(c)
  }
  return ratio(parseColor(fallbackDark)!) >= ratio(parseColor(fallbackLight)!) ? fallbackDark : fallbackLight
}

export function vegaConfig(tokens: ThemeTokens, _appearance: 'light' | 'dark', width?: number): object {
  const fg = readableOn(tokens.foreground, tokens.background, FALLBACK.foreground, FALLBACK_DARK.foreground)
  const muted = readableOn(tokens.mutedForeground, tokens.background, FALLBACK.mutedForeground, FALLBACK_DARK.mutedForeground)
  const bd = parseColor(tokens.border)
  const border = bd ? toHex(bd.a >= 1 ? bd : over(bd, parseColor(tokens.background) ?? parseColor(FALLBACK.background)!)) : FALLBACK.border
  const text = { labelColor: muted, titleColor: fg }
  const narrow = width !== undefined && width < 520
  const font = tokens.fontFamily || 'inherit'
  const w = width ?? 480
  return {
    padding: { top: 8, right: 12, bottom: 4, left: 4 },
    background: 'transparent',
    font,
    view: { stroke: 'transparent' },
    title: { color: fg, subtitleColor: fg, font, anchor: 'middle', limit: Math.max(80, Math.floor(w * 0.6)) },
    axis: { ...text, labelLimit: Math.max(60, Math.min(160, Math.floor(w * 0.3))), domainColor: border, gridColor: border, tickColor: border, labelFont: font, titleFont: font },
    legend: { ...text, labelFont: font, titleFont: font, orient: narrow ? 'bottom' : 'right', labelLimit: narrow ? Math.max(60, Math.floor(w * 0.4)) : 140, titleLimit: narrow ? Math.max(60, Math.floor(w * 0.4)) : 140, ...(narrow ? { columns: 1 } : {}) },
    range: { category: PALETTE, ordinal: PALETTE },
    mark: { color: PALETTE[0] },
    text: { color: fg },
  }
}
