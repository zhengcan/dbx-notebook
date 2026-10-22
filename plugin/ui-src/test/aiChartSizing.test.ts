import { describe, it, expect, vi, beforeEach } from 'vitest'
const render = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: (...a: unknown[]) => render(...a) }) }))
import { previewSize, chartDrawWidth, LEGEND_RESERVE, AXIS_RESERVE, MIN_DRAW_WIDTH, LABEL_FRACTION } from '../src/ai/chartSizing'
import { renderCandidatePreview } from '../src/ai/chartAiGate'

const base = { series: 1, hasLegend: false, hasTitle: false }
describe('previewSize', () => {
  it('horizontal bar few categories', () => {
    const s = previewSize({ ...base, type: 'barHorizontal', categories: 5 }, { width: 600 })
    expect(s.height).toBeGreaterThanOrEqual(260)
    expect(s.scroll).toBe(false)
  })
  it('horizontal bar many categories grows, scrolls, capped', () => {
    const s = previewSize({ ...base, type: 'barHorizontal', categories: 80 }, { width: 600 })
    expect(s.height).toBe(80 * 24 + 90)
    expect(s.scroll).toBe(true)
    const big = previewSize({ ...base, type: 'barHorizontal', categories: 99999 }, { width: 600 })
    expect(big.height).toBe(200 * 24 + 90)
  })
  it('width equals available; legend/title add padding', () => {
    const a = previewSize({ ...base, type: 'bar', categories: 5 }, { width: 413 })
    const b = previewSize({ ...base, type: 'bar', categories: 5, hasLegend: true, hasTitle: true }, { width: 413 })
    expect(a.width).toBe(413)
    expect(a.height).toBe(340)
    expect(b.height).toBe(380)
  })
})

describe('chartDrawWidth', () => {
  it('chartDrawWidth subtracts the legend reserve and never goes below 160', () => {
    expect(chartDrawWidth(600, { type: 'bar', hasLegend: false })).toBe(600 - AXIS_RESERVE)
    expect(chartDrawWidth(600, { type: 'bar', hasLegend: true })).toBe(600 - AXIS_RESERVE - LEGEND_RESERVE)
    expect(LEGEND_RESERVE).toBeGreaterThan(0)
    expect(MIN_DRAW_WIDTH).toBe(160)
    expect(chartDrawWidth(100, { type: 'bar', hasLegend: true })).toBe(160)
    expect(chartDrawWidth(0, { type: 'pie', hasLegend: false })).toBe(160)
  })
  it('caps the category label area at a fraction of the width', () => { expect(LABEL_FRACTION).toBeLessThanOrEqual(0.55) })
})

describe('preview spec', () => {
  beforeEach(() => { render.mockReset(); render.mockResolvedValue({ view: {}, svg: async () => '<svg/>', destroy() {} }) })
  const cand = { title: 'x', config: { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'sum' as const }] }, chartOptions: { type: 'barHorizontal' as const, title: 'T'.repeat(80) } } }
  it('pads title/legend and does not truncate bar labels', async () => {
    await renderCandidatePreview({ columns: ['r', 'v'], rows: [['a', 1]] }, cand as any, { width: 600, height: 300, large: true })
    const [, spec, , o] = render.mock.calls[0] as any[]
    expect(spec.autosize).toEqual({ type: 'fit', contains: 'padding' })
    expect(o.config.axis.labelLimit).toBe(0)
    expect(o.config.axisY.labelLimit).toBe(Math.floor(600 * LABEL_FRACTION))
    expect(o.config.axisY.labelOverlap).toBe(false)
    expect(o.config.title.limit).toBe(592)
  })
  it('non-large preview keeps the default (fit) autosize and untouched axis/title config', async () => {
    await renderCandidatePreview({ columns: ['r', 'v'], rows: [['a', 1]] }, cand as any, { width: 220, height: 120 })
    const [, spec, , o] = render.mock.calls[0] as any[]
    expect(spec.autosize).toBeUndefined()
    expect(o.config.axis.labelLimit).not.toBe(0)
    expect(o.config.axisY).toBeUndefined()
  })
  it('labelOverlap off only on the horizontal-bar category axis', async () => {
    await renderCandidatePreview({ columns: ['r', 'v'], rows: [['a', 1]] }, cand as any, { width: 600, height: 300, large: true })
    expect((render.mock.calls[0] as any[])[3].config.axisY.labelOverlap).toBe(false)
    render.mockClear()
    const v = { ...cand, config: { ...cand.config, chartOptions: { type: 'bar' as const } } }
    await renderCandidatePreview({ columns: ['r', 'v'], rows: [['a', 1]] }, v as any, { width: 600, height: 300, large: true })
    const cfg = (render.mock.calls[0] as any[])[3].config
    expect(cfg.axisY).toBeUndefined()
    expect(cfg.axis.labelOverlap).toBeUndefined()
  })
})

import { labelFontSize, wrapTitle, textUnits } from '../src/ai/chartSizing'
describe('title wrap and label size', () => {
  it('wrapTitle keeps short titles and wraps long ones within width', () => {
    expect(wrapTitle('Short', 300)).toBe('Short')
    const l = wrapTitle('Quarterly revenue by region and customer tier segment, year over year comparison', 200) as string[]
    expect(l.length).toBeGreaterThan(2)
    expect(l.every((x) => x.length <= 25)).toBe(true)
    expect(l.join(' ')).toContain('comparison')
    expect((wrapTitle('x'.repeat(100), 200) as string[]).every((x) => x.length <= 25)).toBe(true)
  })
  it('wrapTitle counts full-width (CJK) characters as double width', () => {
    const zh = '各维度每日新增空间数量趋势对比分析及同比环比变化情况的详细说明与总结报告'
    expect(zh.length).toBeGreaterThanOrEqual(30)
    const l = wrapTitle(zh, 200) as string[]
    expect(Array.isArray(l)).toBe(true)
    expect(l.join('')).toBe(zh)
    expect(l.every((x) => textUnits(x) <= 25)).toBe(true)
    expect(Math.max(...l.map((x) => x.length))).toBeLessThanOrEqual(12)
    expect(wrapTitle('短标题', 300)).toBe('短标题')
    const mixed = wrapTitle('2026 年度 revenue 与成本对比分析报告 final', 160) as string[]
    expect(mixed.every((x) => textUnits(x) <= 20)).toBe(true)
  })
  it('emoji / surrogate pairs count as 2 units and are never split', () => {
    expect(textUnits('😀')).toBe(2)
    expect(textUnits('a😀')).toBe(3)
    const l = wrapTitle('😀'.repeat(40), 200) as string[]
    expect(l.join('')).toBe('😀'.repeat(40))
    expect(l.every((x) => textUnits(x) <= 25)).toBe(true)
    expect(l.every((x) => !/[\ud800-\udbff]$/.test(x) && !/^[\udc00-\udfff]/.test(x))).toBe(true)
  })
  it('whitespace-only or blank over-long titles never return an empty line list', () => {
    for (const t of [' '.repeat(100), '\t\n '.repeat(40)]) {
      const r = wrapTitle(t, 200)
      expect(Array.isArray(r) ? r.length : 1).toBeGreaterThan(0)
      expect(typeof r === 'string' || r.every((x) => typeof x === 'string')).toBe(true)
    }
    expect(wrapTitle('x'.repeat(100), 200)).not.toEqual([])
  })
  it('labelFontSize shrinks within 8..10', () => {
    expect(labelFontSize(500, 36)).toBe(10)
    expect(labelFontSize(190, 36)).toBe(8)
    expect(labelFontSize(50, 36)).toBe(8)
    expect(labelFontSize(100, 0)).toBe(10)
  })
  it('large render wraps a long title and shrinks long horizontal labels', async () => {
    render.mockReset(); render.mockResolvedValue({ view: {}, svg: async () => '<svg/>', destroy() {} })
    const cand = { title: 'x', config: { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'v', agg: 'sum' as const }] }, chartOptions: { type: 'barHorizontal' as const, title: 'Quarterly revenue by region and customer tier segment, year over year' } } }
    await renderCandidatePreview({ columns: ['r', 'v'], rows: [['a'.repeat(36), 1]] }, cand as any, { width: 250, height: 300, large: true })
    const [, spec, , o] = render.mock.calls[0] as any[]
    expect(Array.isArray(spec.title)).toBe(true)
    expect(o.config.axisY.labelFontSize).toBe(8)
  })
})
