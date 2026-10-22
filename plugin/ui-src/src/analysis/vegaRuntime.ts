import { parseColor } from './theme'
import { enhanceHover, hoverLines } from './hover'
export { enhanceHover, hoverLines, HOVER_RANK } from './hover'
// hover: screen rendering only (ChartView). Absent for export / PDF / AI preview, which stay static.
export interface RenderOpts { width?: number; height?: number; config: object; hover?: { more: (n: number) => string } }
export interface RenderedChart { view: unknown; svg: () => Promise<string>; destroy(): void }
export interface VegaRuntime {
  render(el: HTMLElement, spec: object, data: unknown[], opts: RenderOpts): Promise<RenderedChart>
}

let cached: Promise<VegaRuntime> | null = null

// Plain-text tooltip (textContent only, so labels are never interpreted as markup). Fixed-position and pointer-transparent: it never affects layout.
export function attachTooltip(view: any, el: HTMLElement, more: (n: number) => string = (n) => `… +${n}`): HTMLElement {
  const box = el.ownerDocument.createElement('div')
  box.setAttribute('data-chart-tooltip', '')
  box.style.cssText = 'position:fixed;z-index:50;display:none;pointer-events:none;max-width:280px;padding:4px 8px;border-radius:4px;font-size:12px;line-height:1.4;white-space:pre-line;background:var(--color-background,#fff);color:var(--color-foreground,#111);border:1px solid var(--color-border,#ccc);box-shadow:0 2px 8px rgba(0,0,0,.2)'
  view.tooltip((_h: unknown, ev: MouseEvent, _item: unknown, value: unknown) => {
    if (value == null || typeof value !== 'object') { box.style.display = 'none'; return }
    const lines = hoverLines(value as Record<string, unknown>, more)
    if (!lines.length) { box.style.display = 'none'; return }
    box.textContent = lines.join('\n')
    box.style.display = 'block'
    box.style.left = `${Math.min(ev.clientX + 12, Math.max(0, el.ownerDocument.documentElement.clientWidth - 290))}px`
    const h = box.offsetHeight
    const vh = el.ownerDocument.documentElement.clientHeight
    box.style.top = `${vh > 0 && ev.clientY + 12 + h > vh ? Math.max(0, ev.clientY - 12 - h) : ev.clientY + 12}px`
  })
  return box
}

// Data-value labels must read as text: a colour-encoded text layer would inherit the series colour, so it is filled with the themed text colour instead.
// Pie/donut labels sit on palette-coloured slices, so they also get a halo layer (text stroked in the opposite colour) beneath them: legible on any slice colour.
export function themeTextLayers(spec: any, color: string | undefined): void {
  if (!color || !spec || typeof spec !== 'object') return
  const c = parseColor(color)
  const halo = c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 127 ? '#000000' : '#ffffff') : null
  const isText = (u: any) => (typeof u?.mark === 'string' ? u.mark : u?.mark?.type) === 'text'
  const visit = (u: any) => {
    if (!u || typeof u !== 'object') return
    if (Array.isArray(u.layer)) {
      const out: any[] = []
      for (const l of u.layer) {
        visit(l)
        if (halo && isText(l) && l.encoding?.theta) {
          const h = JSON.parse(JSON.stringify(l))
          h.mark = { ...(typeof h.mark === 'string' ? { type: h.mark } : h.mark), stroke: halo, strokeWidth: 3, strokeJoin: 'round', strokeOpacity: 1, aria: false }
          h.encoding.color = { value: halo }
          out.push(h)
        }
        out.push(l)
      }
      u.layer = out
      return
    }
    if (!isText(u)) return
    ;(u.encoding ??= {}).color = { value: color }
  }
  visit(spec)
}

async function create(): Promise<VegaRuntime> {
  const [vega, vl, { expressionInterpreter }] = await Promise.all([import('vega'), import('vega-lite'), import('vega-interpreter')])
  return {
    async render(el, spec, data, opts) {
      const s: any = JSON.parse(JSON.stringify(spec))
      themeTextLayers(s, (opts.config as any)?.text?.color)
      if (opts.width && s.width === undefined) s.width = opts.width
      if (opts.height && s.height === undefined) s.height = opts.height
      if (s.autosize === undefined && typeof s.width === 'number' && typeof s.height === 'number') s.autosize = { type: 'fit', contains: 'padding' }
      let rows = data
      let input = s
      if (opts.hover) {
        const c: any = opts.config
        const fg = typeof c?.text?.color === 'string' ? c.text.color : '#888888'
        const e = enhanceHover(s, data, { rule: typeof c?.axis?.labelColor === 'string' ? c.axis.labelColor : fg, stroke: fg })
        input = e.spec
        rows = e.data
      }
      const compiled = vl.compile(input, { config: opts.config as any }).spec
      const runtime = vega.parse(compiled as any, opts.config as any, { ast: true })
      const view = new vega.View(runtime, { expr: expressionInterpreter as any, renderer: 'svg', container: el })
      const names = ((compiled as any).data ?? []).map((d: any) => d.name) as string[]
      const name = names.includes('table') || !names.length ? 'table' : names[0]
      const tip = attachTooltip(view, el, opts.hover?.more)
      view.data(name, rows as any[])
      await view.runAsync()
      el.appendChild(tip)
      return { view, svg: () => view.toSVG(), destroy: () => { tip.remove(); view.finalize() } }
    },
  }
}

export function loadVega(): Promise<VegaRuntime> {
  if (!cached) {
    const p = create()
    cached = p
    p.catch(() => { if (cached === p) cached = null })
  }
  return cached
}
