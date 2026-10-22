import { describe, it, expect, vi } from 'vitest'
import { buildRenderSpec, type ChartOptions } from '@sqlnb/format'
import { enhanceHover, hoverLines, HOVER_RANK, loadVega } from '../src/analysis/vegaRuntime'
import { renderChartSvgs } from '../src/export/chartSvg'
import { messages, setLocale, t } from '../src/i18n'

const columns: any = [{ name: 'day', kind: 'temporal' }, { name: 'region', kind: 'text' }, { name: 'tier', kind: 'text' }, { name: 'amount', kind: 'number' }, { name: 'qty', kind: 'number' }]
const THEME = { rule: '#666666', stroke: '#111111' }
const mk = (chart: ChartOptions, p: any): any => {
  const r: any = buildRenderSpec({ pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }], ...p }, chart, columns })
  expect(r.error).toBeUndefined()
  return r.spec
}
const series = (names: string[], xs = 4, nul?: (x: number, s: string) => boolean) => names.flatMap((s, j) => Array.from({ length: xs }, (_, i) => ({ x: `x${i}`, series: s, value: nul?.(i, s) ? null : 10 + i * 3 + j })))
const flat = (n: number) => Array.from({ length: n }, (_, i) => ({ x: `x${i}`, value: 5 + i }))
const layers = (s: any) => (Array.isArray(s.layer) ? s.layer : [s])
const rule = (s: any) => layers(s).find((l: any) => (l.mark?.type ?? l.mark) === 'rule')
const mtype = (l: any) => l.mark?.type ?? l.mark

describe('enhanceHover: spec transform', () => {
  it('line without series: nearest rule layer + dot layer, base loses its tooltip', () => {
    const spec = mk({ type: 'line' }, {})
    const out = enhanceHover(spec, flat(4), THEME)
    const ls = layers(out.spec)
    expect(ls.map(mtype)).toEqual(['line', 'rule', 'point'])
    expect(ls[0].encoding.tooltip).toBeUndefined()
    const r = rule(out.spec)
    expect(r.params[0].select).toMatchObject({ type: 'point', nearest: true, fields: ['x'] })
    expect(r.encoding.tooltip.length).toBe(2)
    expect(r.encoding.x).toMatchObject({ field: 'x', type: 'nominal' })
    expect(r.encoding.x.scale).toBeUndefined()
    expect(r.transform[0].filter).toContain('isValid')
    expect(ls[2].transform[0].filter.param).toBe(r.params[0].name)
    expect(spec.encoding.tooltip.length).toBe(2)
  })
  it('does not mutate its input', () => {
    const spec = mk({ type: 'line' }, { columns: [{ field: 'tier' }] })
    const before = JSON.stringify(spec)
    const rows = series(['a', 'b'])
    const rb = JSON.stringify(rows)
    enhanceHover(spec, rows, THEME)
    expect(JSON.stringify(spec)).toBe(before)
    expect(JSON.stringify(rows)).toBe(rb)
  })
  it('multi series: pivot by series index, one tooltip entry per series name from the data, rank entry', () => {
    const out = enhanceHover(mk({ type: 'line' }, { columns: [{ field: 'tier' }] }), series(['东', '西', 'x.y[0]']), THEME)
    const r = rule(out.spec)
    const pv = r.transform.find((t: any) => t.pivot)
    expect(pv.groupby).toContain('x')
    expect(pv.groupby).toContain(HOVER_RANK)
    const titles = r.encoding.tooltip.map((d: any) => d.title)
    expect(titles).toEqual(expect.arrayContaining(['东', '西', 'x.y[0]', HOVER_RANK]))
    expect((out.data[0] as any)[HOVER_RANK]).toBeTypeOf('string')
    const dots = layers(out.spec)[2]
    expect(dots.encoding.fill.legend).toBeNull()
    expect(dots.encoding.color).toBeUndefined()
  })
  it('stacked area: dots reuse the stacked y so they sit on the cumulative value', () => {
    const out = enhanceHover(mk({ type: 'area', stacking: 'stacked' }, { columns: [{ field: 'tier' }] }), series(['a', 'b']), THEME)
    expect(layers(out.spec).map(mtype)).toEqual(['area', 'rule', 'point'])
    expect(layers(out.spec)[2].encoding.y.stack).toBe('zero')
  })
  it('keeps valueText (unit/scale display text) as the tooltip value, never the raw number', () => {
    const spec = mk({ type: 'line' }, { values: [{ field: 'amount', agg: 'sum', format: { kind: 'plain', unit: '元' } }], columns: [{ field: 'tier' }] })
    const out = enhanceHover(spec, series(['a', 'b']).map((r) => ({ ...r, valueText: `${r.value}元` })), THEME)
    const r = rule(out.spec)
    expect(r.transform.find((t: any) => t.pivot).value).toBe('valueText')
    expect(r.encoding.tooltip.filter((d: any) => d.title === 'a')[0].field).toMatch(/^__sqlnb_s/)
  })
  it('combineX, compact time axis: rule x is the base x def (sort kept), groupby carries the sort field', () => {
    const s1 = mk({ type: 'line' }, { rows: [{ field: 'region' }, { field: 'tier' }] })
    expect(rule(enhanceHover(s1, flat(3), THEME).spec).encoding.x).toEqual(layers(s1)[0].encoding.x)
    const s2 = mk({ type: 'area', timeAxis: 'compact' }, { rows: [{ field: 'day', grain: 'month' }] })
    const rows = Array.from({ length: 3 }, (_, i) => ({ x: `2024-0${i + 1}-01T00:00:00.000Z`, xLabel: `2024-0${i + 1}`, value: i + 1 }))
    const out = enhanceHover(s2, rows, THEME)
    const r = rule(out.spec)
    expect(r.encoding.x.field).toBe('xLabel')
    expect(r.encoding.x.sort).toEqual({ field: 'x', op: 'min' })
    expect(out.spec.transform?.[0]?.filter).toContain('xLabel')
  })
  it('temporal x', () => {
    const s = mk({ type: 'line' }, { rows: [{ field: 'day', grain: 'day' }] })
    expect(rule(enhanceHover(s, flat(3), THEME).spec).encoding.x.type).toBe('temporal')
  })
  it('scatter: bigger (16px) transparent hit layer carries the tooltip; base point keeps its look', () => {
    const spec = mk({ type: 'scatter' }, { rows: [{ field: 'qty' }] })
    const out = enhanceHover(spec, flat(5), THEME)
    const ls = layers(out.spec)
    expect(ls.map(mtype)).toEqual(['point', 'point'])
    expect(ls[0].encoding.tooltip).toBeUndefined()
    expect(ls[0].mark).toEqual(spec.mark)
    expect(ls[1].mark).toMatchObject({ opacity: 0, filled: true, size: 256 })
    expect(ls[1].encoding.tooltip).toEqual(spec.encoding.tooltip)
    expect(ls[1].params).toBeUndefined()
  })
  for (const type of ['bar', 'barHorizontal', 'pie', 'donut', 'histogram'] as const) {
    it(`${type}: spec and data unchanged`, () => {
      const spec = mk({ type, ...(type === 'bar' ? { stacking: 'stacked' } : {}) } as any, type === 'bar' ? { columns: [{ field: 'tier' }] } : {})
      const data = series(['a', 'b'])
      const out = enhanceHover(spec, data, THEME)
      expect(out.spec).toEqual(spec)
      expect(out.data).toBe(data)
    })
  }
  it('line with data labels keeps the text layer', () => {
    const out = enhanceHover(mk({ type: 'line', labels: true }, {}), flat(3), THEME)
    expect(layers(out.spec).map(mtype)).toEqual(['line', 'text', 'rule', 'point'])
  })
})

describe('hoverLines: plain-text tooltip lines', () => {
  const more = (n: number) => `… +${n}`
  const v = (names: string[], vals: string[], x = 'x1') => ({ 日期: x, ...Object.fromEntries(names.map((n, i) => [n, vals[i]])), [HOVER_RANK]: JSON.stringify(names) })
  it('x line first, then series in rank order, using the display text as given', () => {
    expect(hoverLines(v(['b', 'a'], ['9元', '1,200元']), more)).toEqual(['日期: x1', 'b: 9元', 'a: 1,200元'])
  })
  it('skips series without a value at this x', () => {
    const val: any = v(['a', 'b'], ['1', '2']); val.b = undefined
    expect(hoverLines(val, more)).toEqual(['日期: x1', 'a: 1'])
  })
  it('more than 10 series: first 10 plus a "more" line', () => {
    const names = Array.from({ length: 13 }, (_, i) => `s${i}`)
    const lines = hoverLines(v(names, names.map((_, i) => String(i))), more)
    expect(lines.length).toBe(12)
    expect(lines[10]).toBe('s9: 9')
    expect(lines[11]).toBe('… +3')
  })
  it('exactly 10: no more line', () => {
    const names = Array.from({ length: 10 }, (_, i) => `s${i}`)
    expect(hoverLines(v(names, names.map(() => '1')), more).length).toBe(11)
  })
  it('without rank: plain key: value lines (bars, pies, scatter)', () => {
    expect(hoverLines({ a: 1, b: 'q' }, more)).toEqual(['a: 1', 'b: q'])
  })
  it('bad rank json is ignored', () => {
    expect(hoverLines({ a: 1, [HOVER_RANK]: '{' }, more)).toEqual(['a: 1'])
  })
})

describe('ranking in the data (sorted desc, ties keep order, nulls out)', () => {
  it('rank lists series by value descending per x and skips null points', () => {
    const rows = series(['a', 'b', 'c'], 3, (i, s) => i === 1 && s === 'b')
    rows.find((r) => r.series === 'c' && r.x === 'x0')!.value = 100
    const out = enhanceHover(mk({ type: 'line' }, { columns: [{ field: 'tier' }] }), rows, THEME)
    const rank = (x: string) => JSON.parse((out.data.find((r: any) => r.x === x && r[HOVER_RANK]) as any)[HOVER_RANK])
    expect(rank('x0')).toEqual(['c', 'b', 'a'])
    expect(rank('x1')).toEqual(['c', 'a'])
  })
})

const svgOf = async (spec: any, rows: any[], hover?: boolean) => {
  const rt = await loadVega()
  const el = document.createElement('div')
  const c = await rt.render(el, spec, rows, { width: 400, height: 240, config: { text: { color: '#111' }, axis: { labelColor: '#a1b2c3' } }, ...(hover ? { hover: { more: (n: number) => `+${n}` } } : {}) } as any)
  const svg = await c.svg()
  const count = (s: string) => el.querySelectorAll(s).length
  const r = { svg, rules: count('g.layer_1_marks line'), voronoi: count('g.layer_1_voronoi path'), symbols: count('g.mark-symbol path'), lines: count('g.mark-line path') }
  c.destroy()
  return r
}

describe('real render: screen vs export', () => {
  const spec = mk({ type: 'line' }, { columns: [{ field: 'tier' }] })
  it('screen render has the hit layers; default render (export path) does not', async () => {
    const rows = series(['a', 'b'], 5)
    const on = await svgOf(spec, rows, true)
    const off = await svgOf(spec, rows)
    expect(on.rules).toBe(5)
    expect(on.voronoi).toBe(5)
    expect(on.symbols).toBe(off.symbols)
    expect(off.rules).toBe(0)
    expect(off.lines).toBe(2)
  })
  it('hover render does not change the legend symbols', async () => {
    const rows = series(['a', 'b'], 5)
    const sym = (s: string) => new DOMParser().parseFromString(s, 'image/svg+xml').querySelectorAll('g.role-legend g.mark-symbol path').length
    const on = await svgOf(spec, rows, true)
    const off = await svgOf(spec, rows)
    expect(sym(off.svg)).toBe(2)
    expect(sym(on.svg)).toBe(2)
    const shape = (s: string) => Array.from(new DOMParser().parseFromString(s, 'image/svg+xml').querySelectorAll('g.role-legend g.mark-symbol path')).map((p) => p.getAttribute('d'))
    expect(shape(on.svg)).toEqual(shape(off.svg))
  })
  it('export render path never enables hover and its SVG has no interaction layer', async () => {
    const seen: any[] = []
    const real = await loadVega()
    const vega = async () => ({ render: (el: any, s: any, d: any, o: any) => { seen.push(o); return real.render(el, s, d, o) } })
    const rows = series(['a', 'b'], 5)
    const sec: any = { blockId: 'b1', spec, rows }
    const res = await renderChartSvgs([sec], 'portrait', { vega: vega as any })
    expect(seen.length).toBe(1)
    expect(seen[0].hover).toBeUndefined()
    const svg = res.svgs.b1.svg as string
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelectorAll('path[stroke-opacity="0"], path[opacity="0"]').length).toBe(0)
    expect(svg).not.toMatch(/voronoi|layer_1_marks|layer_2_marks/)
    expect(svg).not.toMatch(/__sqlnb/)
  })
  it('export of the same spec is byte-identical to a render that never knew about hover', async () => {
    const rows = series(['a', 'b'], 5)
    const a = await svgOf(spec, rows)
    const b = await svgOf(spec, rows)
    expect(a.svg).toBe(b.svg)
    expect(a.svg).not.toMatch(/__sqlnb/)
  })
  it('null points get no hit rule (an x whose values are all null)', async () => {
    const rows = series(['a', 'b'], 5, (i) => i === 2)
    const r = await svgOf(spec, rows, true)
    expect(r.rules).toBe(4)
  })
  it('single point, all-equal values, empty data and one-series data do not throw', async () => {
    for (const rows of [[{ x: 'a', series: 'a', value: 1 }], series(['a', 'b'], 3).map((r) => ({ ...r, value: 7 })), [], flat(1)]) {
      await expect(svgOf(spec, rows, true)).resolves.toBeTruthy()
    }
    await expect(svgOf(mk({ type: 'area' }, {}), flat(1), true)).resolves.toBeTruthy()
    await expect(svgOf(mk({ type: 'scatter' }, { rows: [{ field: 'qty' }] }), flat(3), true)).resolves.toBeTruthy()
  })
  it('90 days x 5 series is fast', async () => {
    const s = mk({ type: 'line' }, { rows: [{ field: 'day', grain: 'day' }], columns: [{ field: 'tier' }] })
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((n, j) => Array.from({ length: 90 }, (_, i) => ({ x: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), series: n, value: 10 + ((i * (j + 3)) % 17) })))
    const t0 = Date.now()
    const r = await svgOf(s, rows, true)
    expect(r.rules).toBe(90)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('hover i18n', () => {
  it('moreSeries key exists in both languages with {n}', () => {
    expect(messages['zh-CN']['chart.hoverMore']).toContain('{n}')
    expect(messages.en['chart.hoverMore']).toContain('{n}')
    setLocale('zh-CN'); expect(t('chart.hoverMore', { n: 3 })).toBe('…另有 3 项')
    setLocale('en'); expect(t('chart.hoverMore', { n: 3 })).toMatch(/3/)
    setLocale('zh-CN')
  })
})
void vi
