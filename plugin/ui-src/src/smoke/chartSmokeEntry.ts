import { toChartRows } from '../analysis/chartRows'
import { resolveLabels } from '../analysis/labelResolve'
import { buildPortableSpec, buildRenderSpec } from '@sqlnb/format'
import { loadVega } from '../analysis/vegaRuntime'
import { createApp, h } from 'vue'
import ChartView from '../analysis/ChartView.vue'
import { vegaConfig } from '../analysis/theme'
import { renderCandidatePreview } from '../ai/chartAiGate'
import { renderChartSvgs } from '../export/chartSvg'
import ChartSchemeBoard from '../ai/ChartSchemeBoard.vue'

const tokens = { foreground: '#111111', mutedForeground: '#666666', border: '#cccccc', background: '#ffffff' }

if (import.meta.env.MODE === 'smoke') {
  ;(window as any).__sqlnbRenderChartForSmoke = async (cfg: any, rows: unknown[]) => {
    const res: any = cfg.portable ? buildPortableSpec({ ...cfg, dataName: 'src' }) : buildRenderSpec(cfg)
    if (res.error) throw new Error('spec error: ' + res.error)
    const el = document.createElement('div')
    document.getElementById('host')!.appendChild(el)
    const rt = await loadVega()
    const chart = await rt.render(el, res.spec, rows, { width: cfg.smokeWidth ?? 400, height: 240, config: vegaConfig(tokens, 'light') })
    const svg = await chart.svg()
    const q = (s: string) => el.querySelectorAll(s).length
    const xs = new Set(Array.from(el.querySelectorAll('g.mark-rect path')).map((n) => /M([-\d.e]+),/.exec(n.getAttribute('d') ?? '')?.[1]).filter(Boolean)).size
    const svgEl = el.querySelector('svg')!
    const sw = Number(svgEl.getAttribute('width')); const sh = Number(svgEl.getAttribute('height'))
    const bb = svgEl.getBBox()
    const fit = sw <= (cfg.smokeWidth ?? 400) && bb.x >= -1 && bb.y >= -1 && bb.x + bb.width <= sw + 1 && bb.y + bb.height <= sh + 1 ? 1 : 0
    const rx = Array.from(new Set(Array.from(el.querySelectorAll('g.mark-rect path')).map((n) => Number(/M([-\d.e]+),/.exec(n.getAttribute('d') ?? '')?.[1])).filter((n) => Number.isFinite(n)))).sort((a, b) => a - b)
    const mx = Array.from(el.querySelectorAll('g.mark-line path')).flatMap((n) => Array.from((n.getAttribute('d') ?? '').matchAll(/[ML]([-\d.e]+),/g)).map((m) => Number(m[1])))
    const px = rx.length > 1 ? rx : Array.from(new Set(mx)).sort((a, b) => a - b)
    const gs = px.slice(1).map((v, i) => v - px[i])
    const gapSpread = gs.length ? Math.round(Math.max(...gs) - Math.min(...gs)) : 0
    const xlabels = el.querySelectorAll('g[aria-label^="X-axis"] g.role-axis-label text').length
    return {
      gapSpread, xlabels, nx: px.length,
      fit, svgW: sw, svgH: sh, bbox: [bb.x, bb.y, bb.x + bb.width, bb.y + bb.height].map(Math.round).join(','),
      xs,
      svgType: typeof svg,
      svgLen: svg.length,
      rect: q('g.mark-rect path'),
      line: q('g.mark-line path'),
      area: q('g.mark-area path'),
      symbol: q('g.mark-symbol path'),
      arc: q('g.mark-arc path'),
      text: q('g.mark-text text'),
      paths: q('svg path'), rects: q('svg rect'), texts: q('svg text'),
      roles: [...new Set(Array.from(el.querySelectorAll("[aria-roledescription]")).map((n) => n.getAttribute('aria-roledescription')))],
    }
  }

  // Production path: the real ChartView (wrapper CSS, ResizeObserver, theme, vegaRuntime options) in a pane of the given width.
  ;(window as any).__sqlnbMountChartForSmoke = async (cfg: any, rows: unknown[], paneWidth: number) => {
    const res: any = buildRenderSpec(cfg)
    if (res.error) throw new Error('spec error: ' + res.error)
    const pane = document.createElement('div')
    pane.className = 'ab-pane'
    pane.style.cssText = `width:${paneWidth}px;min-width:0;margin:8px 0;`
    document.getElementById('host')!.appendChild(pane)
    createApp(ChartView, { spec: res.spec, rows, title: cfg.chart?.title }).mount(pane)
    const wrap = pane.querySelector('.chart-host') as HTMLElement
    const t0 = Date.now()
    let last = ''
    let stable = 0
    while (Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100))
      const svg = wrap.querySelector('svg')
      const sig = svg ? `${svg.getAttribute('width')}x${svg.getAttribute('height')}:${svg.outerHTML.length}` : ''
      if (sig && sig === last) { if (++stable >= 3) break } else { stable = 0; last = sig }
    }
    const svg = wrap.querySelector('svg')!
    const w = wrap.getBoundingClientRect()
    const clipped: string[] = []
    const tol = 1
    for (const n of Array.from(svg.querySelectorAll('text, path, rect'))) {
      const r = (n as Element).getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.left < w.left - tol || r.top < w.top - tol || r.right > w.right + tol || r.bottom > w.bottom + tol) {
        const cls = (n.closest('g[class*="mark-"]') as Element | null)?.getAttribute('class') ?? n.parentElement?.getAttribute('class') ?? ''
        clipped.push(`${n.tagName}[${cls}${n.tagName === 'text' ? ':' + (n.textContent ?? '').slice(0, 24) : ''}] ${[r.left - w.left, r.top - w.top, r.right - w.left, r.bottom - w.top].map(Math.round).join(',')}`)
      }
    }
    let titleOff: number | null = null
    const tt = svg.querySelector('g.role-title text') as Element | null
    if (tt) {
      const tr = tt.getBoundingClientRect()
      const parts = Array.from(svg.querySelectorAll('g.role-axis-domain line, g.role-axis-domain path, g.mark-arc')).map((n) => n.getBoundingClientRect()).filter((r) => r.width > r.height)
      if (parts.length) {
        const l = Math.min(...parts.map((r) => r.left))
        const rr = Math.max(...parts.map((r) => r.right))
        titleOff = Math.round(((tr.left + tr.right) / 2 - (l + rr) / 2) * 10) / 10
      }
    }
    return {
      titleOff,
      wrap: [Math.round(w.width), Math.round(w.height)].join('x'), svg: `${svg.getAttribute('width')}x${svg.getAttribute('height')}`,
      scrollOver: wrap.scrollWidth > wrap.clientWidth || wrap.scrollHeight > wrap.clientHeight,
      sizeOk: Number(svg.getAttribute('width')) <= wrap.clientWidth && Number(svg.getAttribute('height')) <= wrap.clientHeight + 1,
      clipped,
    }
  }

  // Real ChartView with custom labels (title/axis titles/legend/mapped ticks/unit+scale) in a themed pane.
  ;(window as any).__sqlnbMountLabelChartForSmoke = async (o: { theme: 'light' | 'dark'; editable: boolean; labels?: boolean; pie?: boolean; tokens?: { foreground: string; mutedForeground: string; background: string; x?: string } }) => {
    const w = window as any
    w.__chartApp?.unmount()
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('data-theme', o.theme)
    root.setAttribute('style', `${o.tokens ? `--x:${o.tokens.x ?? '#ccc'};--color-background:${o.tokens.background};--color-foreground:${o.tokens.foreground};--color-muted-foreground:${o.tokens.mutedForeground};--color-border:#888888` : o.theme === 'dark' ? '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted-foreground:#a3a3a3;--color-border:#333333' : '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted-foreground:#737373;--color-border:#e5e5e5'};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;width:560px;padding:8px`)
    host.appendChild(root)
    const columns = [{ name: 'flag', kind: 'number' as const }, { name: 'tier', kind: 'text' as const }, { name: 'amt', kind: 'number' as const }]
    const pivot: any = {
      rows: [{ field: 'flag', label: '渠道', valueLabels: { '0': '否', '1': '是' } }],
      columns: [{ field: 'tier', label: '是否 VIP' }],
      values: [{ field: 'amt', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 1, unit: '万元', scale: 10000 } }],
    }
    const chart: any = { type: 'bar', title: 'Q3 销售额', stacking: 'grouped', ...(o.labels ? { labels: true } : {}) }
    if (o.pie) { chart.type = 'pie'; chart.stacking = undefined; chart.labels = true; pivot.columns = [] }
    const res: any = buildRenderSpec({ pivot, chart, columns })
    const resolved = resolveLabels({ pivot, chart }, { empty: '（空）', summary: '合计' })
    const rows: any[] = o.pie
      ? Array.from({ length: 8 }, (_, i) => ({ x: `类别${i}`, value: 10 + i * 3, valueText: `${10 + i * 3}` }))
      : toChartRows({ dims: [], measures: [], rows: [[0, 'a', 125000], [0, 'b', 90000], [1, 'a', 50000], [1, 'b', 80000]] } as any, pivot, chart, columns, resolved)
    w.__chartEdits = []
    w.__chartApp = createApp({ render: () => h(ChartView, { spec: res.spec, rows, title: chart.title, editable: o.editable, measureNames: resolved.measureNames, onEditLabel: (p: any) => w.__chartEdits.push(p.target) }) })
    w.__chartApp.mount(root)
    const t0 = Date.now()
    let last = ''
    let stable = 0
    while (Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100))
      const svg = root.querySelector('svg')
      const sig = svg ? `${svg.getAttribute('width')}x${svg.getAttribute('height')}:${svg.outerHTML.length}` : ''
      if (sig && sig === last) { if (++stable >= 3) break } else { stable = 0; last = sig }
    }
  }

  // Scheme board large preview: real renderCandidatePreview(large) injected into an overflow:auto container.
  ;(window as any).__sqlnbRenderBoardForSmoke = async (kind: 'uuid' | 'stacked', containerWidth: number) => {
    const uuid = (i: number) => `${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}-4b1e-4c2a-9d3f-${(i * 40503 >>> 0).toString(16).padStart(12, '0')}`
    const source = kind === 'uuid'
      ? { columns: [{ name: 'id', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: Array.from({ length: 40 }, (_, i) => [uuid(i), 10 + i]) as unknown[][] }
      : { columns: [{ name: 'region', dataType: 'text' }, { name: 'tier', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: ['north', 'south', 'east', 'west'].flatMap((r, i) => ['gold tier customers (long legend label)', 'silver tier customers (long legend label)'].map((t, j) => [r, t, 10 + i * 7 + j * 5])) as unknown[][] }
    const cand = kind === 'uuid'
      ? { title: 'u', config: { pivot: { rows: [{ field: 'id' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'barHorizontal' } } }
      : { title: 's', config: { pivot: { rows: [{ field: 'region' }], columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar', stacking: 'stacked', title: 'Revenue by region and customer tier (a rather long chart title for clipping)' } } }
    const height = kind === 'uuid' ? 40 * 24 + 90 : 380
    const r = await renderCandidatePreview(source as any, cand as any, { tokens, width: containerWidth, height, large: true })
    if (!r.svg) throw new Error('render failed: ' + r.error)
    const box = document.createElement('div')
    box.style.cssText = `width:${containerWidth}px;overflow:auto;max-height:520px;margin:8px 0;`
    box.innerHTML = r.svg
    document.getElementById('host')!.appendChild(box)
    const svg = box.querySelector('svg')!
    const sw = Number(svg.getAttribute('width')); const sh = Number(svg.getAttribute('height'))
    const bb = svg.getBBox()
    const texts = Array.from(svg.querySelectorAll('text')).map((n) => n.textContent ?? '')
    const titleEl = svg.querySelector('g.role-title text') as Element | null
    const tb = titleEl ? (titleEl as unknown as SVGGraphicsElement).getBoundingClientRect() : null
    const sb = svg.getBoundingClientRect()
    return {
      svgW: sw, svgH: sh, bbox: [bb.x, bb.y, bb.x + bb.width, bb.y + bb.height].map(Math.round),
      bboxFits: bb.x >= -1 && bb.y >= -1 && bb.x + bb.width <= sw + 1 && bb.y + bb.height <= sh + 1,
      titleTop: tb ? Math.round(tb.top - sb.top) : null, hasTitle: !!titleEl,
      ellipsis: texts.filter((x) => x.endsWith('…')).length, nTexts: texts.length,
      labelsFull: kind === 'uuid' ? texts.filter((x) => /^[0-9a-f]{8}-4b1e-4c2a-9d3f-[0-9a-f]{12}$/.test(x)).length : 0,
      scrollW: box.scrollWidth, clientW: box.clientWidth,
    }
  }

  // Real ChartSchemeBoard inside a replica of AiDrawer's .dr-left (overflow:auto; padding 12px 14px; border-right 1px); paneWidth = outer left-pane width.
  ;(window as any).__sqlnbMountBoardForSmoke = async (kind: 'uuid' | 'stacked' | 'pie' | 'line', paneWidth: number, o: { resizeTo?: number; classic?: boolean; gutterAuto?: boolean; longTitle?: boolean; cjkTitle?: string; shortTitle?: string } = {}) => {
    const uuid = (i: number) => `${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}-4b1e-4c2a-9d3f-${(i * 40503 >>> 0).toString(16).padStart(12, '0')}`
    const LL = ['gold tier customers (long legend label)', 'silver tier customers (long legend label)']
    let source: any, cand: any
    if (kind === 'uuid') {
      source = { columns: [{ name: 'id', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: Array.from({ length: 40 }, (_, i) => [uuid(i), 10 + i]) }
      cand = { title: 'u', config: { pivot: { rows: [{ field: 'id' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'barHorizontal' } } }
    } else if (kind === 'stacked') {
      source = { columns: [{ name: 'region', dataType: 'text' }, { name: 'tier', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: ['north', 'south', 'east', 'west'].flatMap((r, i) => LL.map((t, j) => [r, t, 10 + i * 7 + j * 5])) }
      cand = { title: 's', config: { pivot: { rows: [{ field: 'region' }], columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar', stacking: 'stacked', title: 'Revenue by region and customer tier (a rather long chart title for clipping)' } } }
    } else if (kind === 'pie') {
      source = { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: ['north region long label', 'south region long label', 'east region long label', 'west region long label'].map((r, i) => [r, 10 + i * 7]) }
      cand = { title: 'p', config: { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'pie', title: 'Share of revenue by region' } } }
    } else {
      source = { columns: [{ name: 'day', dataType: 'date' }, { name: 'tier', dataType: 'text' }, { name: 'amount', dataType: 'number' }], rows: Array.from({ length: 12 }, (_, d) => LL.map((t, j) => [new Date(Date.UTC(2024, d, 1)).toISOString(), t, 20 + d + j * 5])).flat() }
      cand = { title: 'l', config: { pivot: { rows: [{ field: 'day', grain: 'month' }], columns: [{ field: 'tier' }], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'line', title: 'Monthly amount by customer tier' } } }
    }
    if (!document.getElementById('sm-style')) {
      const st = document.createElement('style')
      st.id = 'sm-style'
      st.textContent = '.sm-classic ::-webkit-scrollbar{width:16px;height:16px}.sm-classic ::-webkit-scrollbar-thumb{background:#999}.sm-gauto [data-test="scheme-large"]{scrollbar-gutter:auto !important}'
      document.head.appendChild(st)
    }
    if (o.longTitle && cand.config.chartOptions.title !== undefined) cand.config.chartOptions.title = 'Quarterly revenue by region and customer tier segment, year over year comparison'
    else if (o.longTitle) cand.config.chartOptions.title = 'Quarterly revenue by region and customer tier segment, year over year comparison'
    if (o.shortTitle) cand.config.chartOptions.title = o.shortTitle
    if (o.cjkTitle) cand.config.chartOptions.title = o.cjkTitle
    const pane = document.createElement('div')
    pane.className = (o.classic ? 'sm-classic ' : '') + (o.gutterAuto ? 'sm-gauto' : '')
    pane.style.cssText = `width:${paneWidth}px;min-width:0;margin:8px 0;box-sizing:border-box;overflow:auto;padding:12px 14px;border-right:1px solid #ccc;height:640px;`
    document.getElementById('host')!.appendChild(pane)
    createApp(ChartSchemeBoard, { source, candidates: [cand, cand, cand], selected: 0 }).mount(pane)
    const large = pane.querySelector('[data-test="scheme-large"]') as HTMLElement
    const settle = async () => {
      const t0 = Date.now()
      let last = ''
      let stable = 0
      while (Date.now() - t0 < 6000) {
        await new Promise((r) => setTimeout(r, 120))
        const sv = large.querySelector('svg')
        const sig = sv ? `${sv.getAttribute('width')}x${sv.getAttribute('height')}:${sv.outerHTML.length}` : ''
        if (sig && sig === last) { if (++stable >= 4) break } else { stable = 0; last = sig }
      }
    }
    await settle()
    if (o.resizeTo) { pane.style.width = `${o.resizeTo}px`; await new Promise((r) => setTimeout(r, 400)); await settle() }
    const svg = large.querySelector('svg')!
    const w = large.getBoundingClientRect()
    const cw = large.clientWidth
    const clipped: string[] = []
    const tol = 1
    const left = w.left + large.clientLeft; const right = left + cw
    for (const n of Array.from(svg.querySelectorAll('text, path, rect'))) {
      const r = (n as Element).getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.left < left - tol || r.right > right + tol) clipped.push(`${n.tagName}:${(n.textContent ?? '').slice(0, 20)} ${Math.round(r.left - left)},${Math.round(r.right - left)}`)
    }
    const texts = Array.from(svg.querySelectorAll('text')).map((n) => n.textContent ?? '')
    const tRects = Array.from(svg.querySelectorAll('g.role-title text')).map((n) => n.getBoundingClientRect())
    const titleEl = svg.querySelector('g.role-title text')
    const sb = svg.getBoundingClientRect()
    const tb = titleEl ? titleEl.getBoundingClientRect() : null
    return {
      largeClient: cw, largeScroll: large.scrollWidth, largeScrollH: large.scrollHeight, largeClientH: large.clientHeight,
      svgW: Number(svg.getAttribute('width')), svgH: Number(svg.getAttribute('height')),
      clipped, overflowX: large.scrollWidth > cw, paneOverflowX: pane.scrollWidth > pane.clientWidth, svgFits: Number(svg.getAttribute('width')) <= cw,
      titleLines: Array.from(svg.querySelectorAll('g.role-title text')).map((n) => n.textContent ?? ''),
      titleJoined: Array.from(svg.querySelectorAll('g.role-title text')).map((n) => n.textContent ?? '').join(''),
      titleOffs: (() => {
        const ref = Array.from(svg.querySelectorAll('g.role-axis, g.role-legend, g.role-scope')).filter((n) => !n.closest('g.role-title')).map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0)
        const rc = ref.length ? (Math.min(...ref.map((r) => r.left)) + Math.max(...ref.map((r) => r.right))) / 2 : 0
        const lines = Array.from(svg.querySelectorAll('g.role-title text')).flatMap((n) => { const ts = Array.from(n.querySelectorAll('tspan')); return ts.length ? ts : [n] })
        return lines.map((l) => { const r = l.getBoundingClientRect(); return Math.round(((r.left + r.right) / 2 - rc) * 10) / 10 })
      })(),
      titleAnchors: Array.from(svg.querySelectorAll('g.role-title text')).map((n) => n.getAttribute('text-anchor') ?? ''),
      titleRight: tRects.length ? Math.round(Math.max(...tRects.map((r) => r.right)) - left) : null, titleLeft: tRects.length ? Math.round(Math.min(...tRects.map((r) => r.left)) - left) : null, hasTitle: !!titleEl, titleTop: tb ? Math.round(tb.top - sb.top) : null,
      ellipsis: texts.filter((x) => x.endsWith('…')).length,
      yLabel: (() => { const n = svg.querySelector('g[aria-label^="Y-axis"] g.role-axis-label text') as SVGTextElement | null; return n ? `${n.getAttribute('font-size') ?? getComputedStyle(n).fontSize}/${Math.round(n.getBoundingClientRect().width)}/${(n.textContent ?? '').length}` : '' })(),
      titleH: Math.round(Math.max(0, ...tRects.map((r) => r.bottom)) - Math.min(1e9, ...tRects.map((r) => r.top))),
      shortEllipsis: texts.filter((x) => x.endsWith('…') && x.length <= 3).length,
      labelsFull: texts.filter((x) => /^[0-9a-f]{8}-4b1e-4c2a-9d3f-[0-9a-f]{12}$/.test(x)).length,
      nLegend: svg.querySelectorAll('g.role-legend').length,
    }
  }
  // Hover smoke: the real ChartView (screen path, hover enabled) in a themed pane of the given width.
  ;(window as any).__sqlnbMountHoverForSmoke = async (cfg: any, rows: unknown[], paneWidth: number, theme: 'light' | 'dark' = 'light') => {
    const res: any = buildRenderSpec(cfg)
    if (res.error) throw new Error('spec error: ' + res.error)
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('data-theme', theme)
    root.setAttribute('style', `${theme === 'dark' ? '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted-foreground:#a3a3a3;--color-border:#333333' : '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted-foreground:#737373;--color-border:#e5e5e5'};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;width:${paneWidth}px;padding:8px;box-sizing:content-box`)
    host.appendChild(root)
    ;(window as any).__hoverApp?.unmount()
    const app = createApp(ChartView, { spec: res.spec, rows, title: cfg.chart?.title })
    ;(window as any).__hoverApp = app
    app.mount(root)
    const t0 = Date.now()
    let last = ''
    let stable = 0
    while (Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100))
      const svg = root.querySelector('svg')
      const sig = svg ? `${svg.getAttribute('width')}x${svg.getAttribute('height')}:${svg.outerHTML.length}` : ''
      if (sig && sig === last) { if (++stable >= 3) break } else { stable = 0; last = sig }
    }
  }

  // Export path (static SVG used by HTML/PDF export) for the same config.
  ;(window as any).__sqlnbExportSvgForSmoke = async (cfg: any, rows: unknown[]) => {
    const res: any = buildRenderSpec(cfg)
    if (res.error) throw new Error('spec error: ' + res.error)
    const out = await renderChartSvgs([{ blockId: 'b', spec: res.spec, rows } as any], 'portrait')
    return out.svgs.b?.svg ?? null
  }
}
