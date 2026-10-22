import { describe, it, expect, vi } from 'vitest'
import { reactive, isReactive } from 'vue'
import { renderChartSvgs, chartWidth, EXPORT_THEME } from '../src/export/chartSvg'
import type { ChartSection } from '../src/export/model'

const sec = (id: string, rows: unknown[] = [{ a: 1 }], usesRawRows = false): ChartSection => ({ kind: 'chart', blockId: id, spec: { mark: 'bar' }, rows, usesRawRows })

function fakeVega(failIds: string[] = []) {
  const calls: any[] = []
  const destroy = vi.fn()
  let active = 0, maxActive = 0
  const rt = {
    async render(_el: HTMLElement, spec: object, data: unknown[], opts: any) {
      calls.push({ spec, data, opts })
      active++; maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      if (failIds.includes((data[0] as any)?.id)) { active--; throw new Error('boom') }
      return { view: {}, svg: async () => { active--; return '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }, destroy }
    },
  }
  return { rt, calls, destroy, max: () => maxActive }
}

describe('chartSvg', () => {
  it('widths', () => { expect(chartWidth('portrait')).toBe(680); expect(chartWidth('landscape')).toBe(960) })
  it('renders with export theme and destroys', async () => {
    const f = fakeVega()
    const r = await renderChartSvgs([sec('c1')], 'portrait', { vega: async () => f.rt as any })
    expect(r.svgs.c1.svg!.startsWith('<svg')).toBe(true)
    expect(r.failed).toEqual([])
    expect((f.calls[0].opts.config as any).background).toBe('#ffffff')
    expect(f.calls[0].opts.width).toBe(680)
    expect(EXPORT_THEME.background).toBe('#ffffff')
    expect(f.destroy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.calls[0].opts.config)).toContain('PingFang SC')
  })
  it('passes a plain (non-reactive) spec and a fit height to the renderer', async () => {
    const f = fakeVega()
    const s = { ...sec('c1'), spec: reactive({ mark: 'bar', encoding: { x: { field: 'a' } } }) as object }
    await renderChartSvgs([s], 'portrait', { vega: async () => f.rt as any })
    expect(isReactive(f.calls[0].spec)).toBe(false)
    expect(f.calls[0].spec).toEqual({ mark: 'bar', encoding: { x: { field: 'a' } } })
    expect(f.calls[0].opts.height).toBeGreaterThan(100)
  })
  it('vega load rejection resolves with all failed', async () => {
    const r = await renderChartSvgs([sec('a'), sec('b')], 'portrait', { vega: async () => { throw new Error('x') } })
    expect(r.failed).toEqual(['a', 'b'])
    expect(r.svgs.a.svg).toBeNull()
  })
  it('single render failure isolated', async () => {
    const f = fakeVega(['bad'])
    const r = await renderChartSvgs([sec('ok1', [{ id: 'ok1' }]), sec('bad', [{ id: 'bad' }]), sec('ok2', [{ id: 'ok2' }])], 'landscape', { vega: async () => f.rt as any })
    expect(r.failed).toEqual(['bad'])
    expect(r.svgs.bad.svg).toBeNull()
    expect(r.svgs.bad.error).toContain('boom')
    expect(r.svgs.ok2.svg).not.toBeNull()
  })
  it('empty rows -> no-data without calling vega', async () => {
    const vega = vi.fn()
    const r = await renderChartSvgs([sec('e', [])], 'portrait', { vega: vega as any })
    expect(vega).not.toHaveBeenCalled()
    expect(r.svgs.e).toEqual({ svg: null, error: 'no-data' })
    expect(r.failed).toEqual(['e'])
  })
  it('raw rows chart renders', async () => {
    const f = fakeVega()
    const r = await renderChartSvgs([sec('raw', [{ x: 1 }, { x: 2 }], true)], 'portrait', { vega: async () => f.rt as any })
    expect(r.svgs.raw.svg).not.toBeNull()
    expect(f.calls[0].data).toHaveLength(2)
  })
  it('sequential, 5 destroys', async () => {
    const f = fakeVega()
    const r = await renderChartSvgs([1, 2, 3, 4, 5].map(i => sec('c' + i)), 'portrait', { vega: async () => f.rt as any })
    expect(Object.keys(r.svgs)).toHaveLength(5)
    expect(f.destroy).toHaveBeenCalledTimes(5)
    expect(f.max()).toBe(1)
  })
})

import { buildRenderSpec } from '@sqlnb/format'
import { toChartRows } from '../src/analysis/chartRows'
import { resolveLabels } from '../src/analysis/labelResolve'
import { loadVega } from '../src/analysis/vegaRuntime'

describe('chartSvg with resolved labels (Plan 13 T9)', () => {
  const columns = [{ name: 'region', kind: 'text' as const }, { name: 'tier', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }]
  const build = async (pivot: any, chart: any, longRows: unknown[][]) => {
    const cfg = { pivot, chart, columns }
    const spec = buildRenderSpec(cfg) as any
    const resolved = resolveLabels({ pivot, chart }, { empty: '（空）', summary: '合计' })
    const rows = toChartRows({ dims: [], measures: [], rows: longRows }, pivot, chart, columns, resolved)
    const r = await renderChartSvgs([{ kind: 'chart', blockId: 'c', spec: spec.spec, rows, usesRawRows: false } as ChartSection], 'portrait', { vega: loadVega })
    expect(r.failed).toEqual([])
    return r.svgs.c.svg as string
  }
  const pivot = () => ({
    rows: [{ field: 'region', label: '渠道<b>', valueLabels: { '0': '否', '1': '是' }, nullLabel: '未知' }],
    columns: [{ field: 'tier', label: '等级' }],
    values: [{ field: 'amount', agg: 'sum', label: '销售额', format: { kind: 'thousands', decimals: 1, unit: '万元', scale: 10000 } }],
  })
  it('svg text has custom title, axis titles with （unit）, legend title and mapped categories; markup is escaped, tooltips carry unit', async () => {
    const svg = await build(pivot(), { type: 'bar', title: 'Q3 <i>销售额</i>', labels: true }, [[0, 'g', 125000], [1, 'g', 50000], [null, 'g', 10000]])
    expect(svg).toContain('Q3 &lt;i&gt;销售额&lt;/i&gt;')
    expect(svg).toContain('渠道&lt;b&gt;')
    expect(svg).toContain('销售额（万元）')
    expect(svg).toContain('等级')
    for (const c of ['否', '是', '未知']) expect(svg).toContain(`>${c}<`)
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('12.5万元')
    expect(svg).not.toMatch(/>125,?000</)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const ticks = Array.from(doc.querySelectorAll('g.role-axis-label text')).map((n) => n.textContent ?? '')
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.some((x) => x.includes('万元'))).toBe(false)
    expect(Math.max(...ticks.filter((x) => /^[\d.,]+$/.test(x)).map((x) => Number(x.replace(/,/g, ''))))).toBeLessThan(100)
    const tip = Array.from(doc.querySelectorAll('[aria-label]')).map((n) => n.getAttribute('aria-label') ?? '').filter((x) => x.includes('销售额'))
    expect(tip.some((x) => x.includes('12.5万元'))).toBe(true)
  })
  it('axisTitles override the defaults in the exported svg', async () => {
    const svg = await build(pivot(), { type: 'bar', axisTitles: { x: '区域', y: '金额', legend: '图例' } }, [[0, 'g', 1]])
    for (const c of ['区域', '金额', '图例']) expect(svg).toContain(`>${c}<`)
    expect(svg).not.toContain('销售额（万元）')
  })
})
