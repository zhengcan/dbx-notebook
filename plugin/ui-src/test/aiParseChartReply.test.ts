import { describe, it, expect } from 'vitest'
import { parseChartReply, detectSchemeTarget, type ChartCandidate } from '../src/ai/parse'
import { CHART_EXAMPLE } from '../src/ai/prompt'

const columns = ['category', 'amount', 'month']
const cfg = (title: string, type = 'bar') => ({ ...CHART_EXAMPLE, chartOptions: { type, title } })
const cur = (): ChartCandidate[] => {
  const r = parseChartReply(JSON.stringify([cfg('A'), cfg('B', 'line'), cfg('C')]), { columns, truncated: false, current: [], selected: null })
  if (!r.ok) throw new Error('setup')
  return r.value.schemes
}
const ctx = (o: any = {}) => ({ columns, truncated: false, current: cur(), selected: null as number | null, ...o })

describe('detectSchemeTarget', () => {
  it('detects numbered references', () => {
    for (const t of ['把方案2改成折线', 'change scheme 2', 'fix chart #2 please', '第二个换成柱状图', 'Scheme2']) expect(detectSchemeTarget(t)).toBe(2)
    expect(detectSchemeTarget('方案1')).toBe(1)
    expect(detectSchemeTarget('第三个')).toBe(3)
  })
  it('false positives and ambiguity -> all', () => {
    for (const t of ['把 #3b82f6 的蓝色用在图表里', '#2 priority column', 'show 2 schemes', '方案1和方案2都改成折线', 'scheme 2 and 3']) expect(detectSchemeTarget(t)).toBe('all')
  })
  it('numerals and context forms', () => {
    expect(detectSchemeTarget('方案二')).toBe(2)
    expect(detectSchemeTarget('change scheme 2 to a line')).toBe(2)
    expect(detectSchemeTarget('把第3个方案改成面积图')).toBe(3)
    expect(detectSchemeTarget('第二个方案换成饼图')).toBe(2)
    expect(detectSchemeTarget('scheme #2 make it a line')).toBe(2)
    expect(detectSchemeTarget('change option #3 to area')).toBe(3)
    expect(detectSchemeTarget('方案2和方案2')).toBe(2)
  })
  it('none or out of range -> all', () => {
    expect(detectSchemeTarget('make it blue')).toBe('all')
    expect(detectSchemeTarget('方案 5')).toBe('all')
    expect(detectSchemeTarget('scheme 0')).toBe('all')
  })
})

describe('parseChartReply: shape comes from the reply, not from how many configs survive validation', () => {
  const bad = (t: string) => ({ ...cfg(t), values: [{ field: 'ghost', agg: 'sum' }] })
  it('selected + set of 3 with 2 invalid -> nothing replaced, retry error (incomplete)', () => {
    const r = parseChartReply(JSON.stringify([cfg('V'), bad('x'), bad('y')]), ctx({ selected: 1 }))
    expect(r).toEqual({ ok: false, reason: 'incomplete' })
  })
  it('selected + set of 2 with 1 invalid -> incomplete as well', () => {
    expect(parseChartReply(JSON.stringify([cfg('V'), bad('x')]), ctx({ selected: 0 }))).toEqual({ ok: false, reason: 'incomplete' })
  })
  it('selected + set with all invalid -> unparseable, nothing replaced', () => {
    expect(parseChartReply(JSON.stringify([bad('x'), bad('y')]), ctx({ selected: 1 }))).toEqual({ ok: false, reason: 'unparseable' })
  })
  it('selected + single invalid item -> unparseable, selected scheme untouched', () => {
    expect(parseChartReply(JSON.stringify(bad('x')), ctx({ selected: 1 }))).toEqual({ ok: false, reason: 'unparseable' })
    expect(parseChartReply(JSON.stringify([bad('x')]), ctx({ selected: 1 }))).toEqual({ ok: false, reason: 'unparseable' })
  })
  it('first turn: 3 configs with 2 invalid -> keeps the 1 valid as the set, with a warning', () => {
    const r = parseChartReply(JSON.stringify([cfg('V'), bad('x'), bad('y')]), ctx({ current: [], selected: null }))
    expect(r.ok && r.value.replaced).toBe('all')
    expect(r.ok && r.value.schemes.map((x) => x.config.chartOptions.title)).toEqual(['V'])
    expect(r.ok && r.warnings.some((w) => /only 1 of 3/.test(w))).toBe(true)
  })
  it('numbered turn: an array reply is still reduced to the first config by shape (unchanged)', () => {
    const r = parseChartReply(JSON.stringify([cfg('F1'), bad('x')]), ctx({ selected: 1, numbered: true }))
    expect(r.ok && r.value.schemes[1].config.chartOptions.title).toBe('F1')
  })
})

describe('parseChartReply', () => {
  it('selected + single object -> replaces only the selected scheme', () => {
    const current = cur()
    const r = parseChartReply(JSON.stringify(cfg('NEW', 'area')), ctx({ current, selected: 1 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.replaced).toBe('one')
    expect(r.value.index).toBe(1)
    expect(r.value.schemes.length).toBe(3)
    expect(r.value.schemes[0]).toEqual(current[0])
    expect(r.value.schemes[2]).toEqual(current[2])
    expect(r.value.schemes[1].config.chartOptions.title).toBe('NEW')
  })
  it('selected + 1-item array -> same', () => {
    const current = cur()
    const r = parseChartReply(JSON.stringify([cfg('NEW', 'area')]), ctx({ current, selected: 0 }))
    expect(r.ok && r.value.replaced).toBe('one')
    expect(r.ok && r.value.schemes.map((s) => s.config.chartOptions.title)).toEqual(['NEW', 'B', 'C'])
  })
  it('selected + array of 3 -> replaces all 3', () => {
    const r = parseChartReply(JSON.stringify([cfg('X'), cfg('Y'), cfg('Z')]), ctx({ selected: 2 }))
    expect(r.ok && r.value.replaced).toBe('all')
    expect(r.ok && r.value.schemes.map((s) => s.config.chartOptions.title)).toEqual(['X', 'Y', 'Z'])
  })
  it('selected + array of 2 -> replaces the set with 2', () => {
    const r = parseChartReply(JSON.stringify([cfg('X'), cfg('Y')]), ctx({ selected: 2 }))
    expect(r.ok && r.value.schemes.length).toBe(2)
  })
  it('no selection + single object -> set of one', () => {
    const r = parseChartReply(JSON.stringify(cfg('Only')), ctx({ current: [] }))
    expect(r.ok && r.value.schemes.length).toBe(1)
    expect(r.ok && r.value.replaced).toBe('all')
  })
  it('no selection + array of 5 -> first 3, warning', () => {
    const r = parseChartReply(JSON.stringify(['a', 'b', 'c', 'd', 'e'].map((x) => cfg(x))), ctx({ current: [] }))
    expect(r.ok && r.value.schemes.length).toBe(3)
    expect(r.ok && r.warnings.length).toBeGreaterThan(0)
  })
  it('numbered turn with an array uses only the first config for that scheme, with a warning', () => {
    const r = parseChartReply(JSON.stringify([cfg('F1'), cfg('F2')]), ctx({ selected: 1, numbered: true }))
    expect(r.ok && r.value.schemes[1].config.chartOptions.title).toBe('F1')
    expect(r.ok && r.value.schemes.length).toBe(3)
    expect(r.ok && r.warnings.length).toBeGreaterThan(0)
  })
  it('summary: kept <=200, HTML kept as text, control chars stripped; missing -> undefined', () => {
    const r = parseChartReply(JSON.stringify([{ ...cfg('A'), summary: '  <img src=x onerror=1>\u0007hi\n' + 'z'.repeat(300) }, { ...cfg('B'), summary: undefined }]), ctx({ current: [] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.value.schemes[0].summary!
    expect(s.length).toBe(200)
    expect(s.startsWith('<img src=x onerror=1>')).toBe(true)
    expect(/[\u0000-\u001f]/.test(s)).toBe(false)
    expect(r.value.schemes[1].summary).toBeUndefined()
  })
  it('top-level and nested pivot shapes both parse', () => {
    const nested = { pivot: { rows: [{ field: 'category' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, chartOptions: { type: 'bar' } }
    const a = parseChartReply(JSON.stringify(cfg('T')), ctx())
    const b = parseChartReply(JSON.stringify(nested), ctx())
    expect(a.ok && b.ok).toBe(true)
    expect(a.ok && b.ok && a.value.schemes[0].config.pivot.values[0].field).toBe(b.ok && b.value.schemes[0].config.pivot.values[0].field)
  })
  it('prose around fenced json tolerated', () => {
    const r = parseChartReply('Sure!\n```json\n' + JSON.stringify([cfg('P')]) + '\n```\nDone.', ctx())
    expect(r.ok).toBe(true)
  })
  it('truncated and empty fail', () => {
    expect(parseChartReply('```json\n[{"rows":', ctx())).toEqual({ ok: false, reason: 'truncated' })
    expect(parseChartReply('[{"rows":[', ctx())).toEqual({ ok: false, reason: 'truncated' })
    expect(parseChartReply('x', ctx({ truncated: true }))).toEqual({ ok: false, reason: 'truncated' })
    expect(parseChartReply('  ', ctx())).toEqual({ ok: false, reason: 'empty' })
  })
  it('unknown columns dropped with warnings', () => {
    const bad = { ...cfg('U'), rows: [{ field: 'category' }, { field: 'nope' }] }
    const r = parseChartReply(JSON.stringify(bad), ctx())
    expect(r.ok && r.value.schemes[0].config.pivot.rows.map((x) => x.field)).toEqual(['category'])
    expect(r.ok && r.warnings.some((w) => w.includes('nope'))).toBe(true)
  })
  it('QUESTION: reply yields question and no schemes', () => {
    const r = parseChartReply('QUESTION: Which column is the time axis?', ctx())
    expect(r.ok && r.value.question).toBe('Which column is the time axis?')
    expect(r.ok && r.value.schemes).toEqual([])
  })
  it('question with brackets/braces in prose is a question', () => {
    const r = parseChartReply('QUESTION: Do you mean column [amount] or {total}?', ctx())
    expect(r.ok && r.value.question).toBe('Do you mean column [amount] or {total}?')
  })
  it('question marker + valid config: config wins, question kept', () => {
    const r = parseChartReply('QUESTION: is this ok?\n```json\n' + JSON.stringify(cfg('W')) + '\n```', ctx())
    expect(r.ok && r.value.schemes.length).toBe(1)
    expect(r.ok && r.value.question).toContain('is this ok?')
  })
  it('question text capped at 2000', () => {
    const r = parseChartReply('QUESTION: ' + 'q'.repeat(5000), ctx())
    expect(r.ok && r.value.question?.length).toBe(2000)
  })
})
