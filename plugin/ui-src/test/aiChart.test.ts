import { describe, it, expect, vi, beforeEach } from 'vitest'

const render = vi.fn()
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: (...a: unknown[]) => render(...a) }) }))
import { chartAiGate, renderCandidatePreview } from '../src/ai/chartAiGate'

const send = { schema: true, sql: true, data: true }
const caps = { aiCompletion: true } as any
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="3" height="3"/></svg>'
const okRender = async () => ({ view: {}, svg: async () => SVG, destroy() {} })

const source = { columns: ['region', 'amount'], rows: [['a', 1], ['a', 2], ['b', 5]] as unknown[][] }

describe('chartAiGate', () => {
  const base = { caps, send, source, busy: false }
  it('enabled', () => expect(chartAiGate(base)).toEqual({ enabled: true }))
  it('reasons', () => {
    expect(chartAiGate({ ...base, caps: { aiCompletion: false } as any })).toEqual({ enabled: false, reason: 'unsupported' })
    expect(chartAiGate({ ...base, source: null })).toEqual({ enabled: false, reason: 'no-source' })
    expect(chartAiGate({ ...base, source: { columns: ['a'], rows: [] } })).toEqual({ enabled: false, reason: 'empty-source' })
    expect(chartAiGate({ ...base, send: { ...send, data: false } })).toEqual({ enabled: false, reason: 'no-data-setting' })
    expect(chartAiGate({ ...base, busy: true })).toEqual({ enabled: false, reason: 'ai-busy' })
  })
})

describe('renderCandidatePreview', () => {
  const cand = { title: 'x', config: { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' as const }] }, chartOptions: { type: 'bar' as const } } }
  beforeEach(() => { render.mockReset(); render.mockImplementation(okRender) })
  it('renders svg from the existing rows, aggregated locally', async () => {
    const r = await renderCandidatePreview(source, cand as any)
    expect(r.svg).toContain('<rect')
    const rows = (render.mock.calls[0] as any[])[2]
    expect(rows).toEqual([{ x: 'a', value: 3 }, { x: 'b', value: 5 }])
  })
  it('large preview title is centered with bounds framing; small ones keep the global middle anchor without it', async () => {
    await renderCandidatePreview(source, cand as any, { large: true })
    expect((render.mock.calls[0] as any[])[3].config.title).toMatchObject({ anchor: 'middle', align: 'center', frame: 'bounds' })
    render.mockClear()
    await renderCandidatePreview(source, cand as any)
    expect((render.mock.calls[0] as any[])[3].config.title?.align).toBeUndefined()
    expect((render.mock.calls[0] as any[])[3].config.title?.frame).toBeUndefined()
  })
  it('vega failure degrades to null + error', async () => {
    render.mockRejectedValue(new Error('boom'))
    const r = await renderCandidatePreview(source, cand as any)
    expect(r.svg).toBeNull()
    expect(r.error).toContain('boom')
  })
  it('vega load failure degrades too', async () => {
    const r = await renderCandidatePreview(source, cand as any, { vega: async () => { throw new Error('nolib') } })
    expect(r).toMatchObject({ svg: null })
  })
})

describe('describeChart value labels', () => {
  it('includes ValueSpec.label so the Apply diff previews it', async () => {
    const { describeChart } = await import('../src/ai/chartAiGate')
    const rows = describeChart({ pivot: { rows: [], columns: [], values: [{ field: 'amount', agg: 'sum', label: 'Revenue' }, { agg: 'count' }] } as any, chartOptions: { type: 'bar' } as any })
    expect(rows.find((r) => r.key === 'values')!.text).toBe('sum(amount) as "Revenue", count(*)')
    const a = describeChart({ pivot: { rows: [], columns: [], values: [{ field: 'amount', agg: 'sum', label: 'A' }] } as any, chartOptions: { type: 'bar' } as any })
    const b = describeChart({ pivot: { rows: [], columns: [], values: [{ field: 'amount', agg: 'sum', label: 'B' }] } as any, chartOptions: { type: 'bar' } as any })
    expect(a[3].text).not.toBe(b[3].text)
  })
})

import { chartConfigEqual as __eq } from '../src/ai/chartAiGate'
describe('chartConfigEqual', () => {
  const base = { pivot: { rows: [{ field: 'r' }], columns: [], values: [{ field: 'a', agg: 'sum' }] }, chartOptions: { type: 'bar', title: 'x' } } as any
  it('equal ignoring key order and undefined', () => {
    expect(__eq(base, { chartOptions: { title: 'x', type: 'bar', stacking: undefined }, pivot: { values: [{ agg: 'sum', field: 'a' }], columns: [], rows: [{ field: 'r' }] } } as any)).toBe(true)
  })
  it('differs in type / agg / title / pivot null', () => {
    expect(__eq(base, { ...base, chartOptions: { ...base.chartOptions, type: 'line' } })).toBe(false)
    expect(__eq(base, { ...base, pivot: { ...base.pivot, values: [{ field: 'a', agg: 'avg' }] } })).toBe(false)
    expect(__eq(base, { ...base, chartOptions: { ...base.chartOptions, title: 'y' } })).toBe(false)
    expect(__eq(base, { ...base, pivot: null })).toBe(false)
    expect(__eq({ ...base, pivot: null }, { ...base, pivot: null })).toBe(true)
  })
  it('unknown extra fields ignored; array order significant', () => {
    expect(__eq(base, { ...base, extra: 1, chartOptions: { ...base.chartOptions, zzz: 1 } })).toBe(true)
    const two = { ...base, pivot: { ...base.pivot, rows: [{ field: 'r' }, { field: 's' }] } }
    expect(__eq(two, { ...two, pivot: { ...two.pivot, rows: [{ field: 's' }, { field: 'r' }] } })).toBe(false)
  })
})
