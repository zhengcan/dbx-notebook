import { loadVega, type VegaRuntime } from '../analysis/vegaRuntime'
import { vegaConfig, type ThemeTokens } from '../analysis/theme'
import type { ChartSection } from './model'
import type { Orientation } from './options'
import type { ChartSvg } from './html'
import { CJK_FONTS } from './printCss'

export const EXPORT_THEME: ThemeTokens = { background: '#ffffff', foreground: '#1a1a1a', mutedForeground: '#555', border: '#d0d0d0' }

export function chartHeight(orientation: Orientation): number {
  return orientation === 'landscape' ? 400 : 340
}

export function chartWidth(orientation: Orientation): number {
  return orientation === 'landscape' ? 960 : 680
}

function exportConfig(width: number): object {
  const c: any = vegaConfig(EXPORT_THEME, 'light', width)
  const f = CJK_FONTS
  c.background = EXPORT_THEME.background
  c.font = f
  c.title = { ...c.title, font: f }
  c.axis = { ...c.axis, labelFont: f, titleFont: f }
  c.legend = { ...c.legend, labelFont: f, titleFont: f }
  return c
}

export async function renderChartSvgs(
  sections: ChartSection[],
  orientation: Orientation,
  deps: { vega?: () => Promise<VegaRuntime> } = {},
): Promise<{ svgs: Record<string, ChartSvg>; failed: string[] }> {
  const svgs: Record<string, ChartSvg> = {}
  const failed: string[] = []
  const fail = (id: string, error: string) => { svgs[id] = { svg: null, error }; failed.push(id) }
  const width = chartWidth(orientation)
  let rt: VegaRuntime | null = null
  let loadErr: string | null = null
  for (const s of sections) {
    if (!s.rows.length) { fail(s.blockId, 'no-data'); continue }
    if (!rt && !loadErr) {
      try { rt = await (deps.vega ?? loadVega)() } catch (e) { loadErr = e instanceof Error ? e.message : String(e) }
    }
    if (!rt) { fail(s.blockId, loadErr ?? 'vega-load-failed'); continue }
    let chart: Awaited<ReturnType<VegaRuntime['render']>> | null = null
    try {
      const el = document.createElement('div')
      chart = await rt.render(el, JSON.parse(JSON.stringify(s.spec)), s.rows, { width, height: chartHeight(orientation), config: exportConfig(width) })
      svgs[s.blockId] = { svg: await chart.svg() }
    } catch (e) {
      fail(s.blockId, e instanceof Error ? e.message : String(e))
    } finally {
      try { chart?.destroy() } catch { /* ignore */ }
    }
  }
  return { svgs, failed }
}
