import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BigNumberBlock from '../src/analysis/BigNumberBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale, messages } from '../src/i18n'

const COLS = [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: 'd', dataType: 'date' }, { name: 'd2', dataType: 'date' }, { name: 'ok', dataType: 'boolean' }]
const src = { id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } }
const M = (over: any = {}) => ({ field: 'amount', aggregate: 'sum', ...over })
const bn = (m: any = M(), extra: any = {}) => ({ data: 'sales', value: { field: 'amount', aggregate: 'sum' }, metrics: [m], ...extra })

function setup(meta: any, cols = COLS, attach = false) {
  setLocale('en')
  const store = useNotebookStore()
  store.nb.value.blocks.push(src as any, { id: 'n1', type: 'big-number', metadata: meta } as any)
  store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: cols, rows: [], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
  const runner = vi.fn(async () => ({ status: 'ok', value: 1, items: [{ value: 1 }], partial: false, ranAt: 'x' }) as any)
  store.setBigNumberRunner(runner)
  const w = mount(BigNumberBlock, { props: { blockId: 'n1' }, attachTo: attach ? document.body : undefined, global: { provide: { [StoreKey as symbol]: store } } })
  const metrics = () => (store.nb.value.blocks.find((b) => b.id === 'n1')!.metadata as any).metrics
  return { store, w, runner, metrics }
}
const set = async (el: any, v: string) => { (el.element as HTMLInputElement).value = v; await el.trigger('change') }
const settle = () => new Promise((r) => setTimeout(r, 150))
const opts = (sel: any) => sel.findAll('option').map((o: any) => o.element.value)

describe('distinct aggregate', () => {
  it('present and selectable; disabled for the row-count pseudo-field', async () => {
    const { w, metrics } = setup(bn(M({ field: 'region' })))
    const agg = w.find('[data-test=bn-agg]')
    const o = agg.findAll('option').find((x) => x.element.value === 'distinct')!
    expect(o.text()).toBe('Distinct count')
    expect(o.attributes('disabled')).toBeUndefined()
    await set(agg, 'distinct')
    expect(metrics()[0].aggregate).toBe('distinct')
    const rows = setup(bn({ field: '', aggregate: 'count' }))
    const d = rows.w.find('[data-test=bn-agg]').findAll('option').find((x) => x.element.value === 'distinct')!
    expect(d.attributes('disabled')).toBeDefined()
  })
})

describe('filter editor', () => {
  it('add writes only after a value is entered (empty value not written)', async () => {
    const { w, store, metrics, runner } = setup(bn())
    store.dirty.value = false
    await w.find('[data-test=bn-filter-add]').trigger('click')
    expect(w.findAll('[data-test=bn-filter-row]')).toHaveLength(1)
    expect(metrics()[0].filter).toBeUndefined()
    await set(w.find('[data-test=bn-filter-value]'), '')
    expect(metrics()[0].filter).toBeUndefined()
    expect(store.dirty.value).toBe(false)
    expect(w.find('[data-test=bn-filter-error]').attributes('role')).toBe('status')
    await set(w.find('[data-test=bn-filter-value]'), '5')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: '=', value: '5' }])
    await settle()
    expect(runner).toHaveBeenCalled()
  })
  it('number column values are written as numbers; invalid number is not written', async () => {
    const { w, metrics } = setup(bn())
    await w.find('[data-test=bn-filter-add]').trigger('click')
    await set(w.find('[data-test=bn-filter-field]'), 'amount')
    await set(w.find('[data-test=bn-filter-value]'), 'abc')
    expect(metrics()[0].filter).toBeUndefined()
    expect(w.find('[data-test=bn-filter-error]').exists()).toBe(true)
    await set(w.find('[data-test=bn-filter-value]'), '12.5')
    expect(metrics()[0].filter).toEqual([{ field: 'amount', op: '=', value: 12.5 }])
    expect(w.find('[data-test=bn-filter-error]').exists()).toBe(false)
  })
  it('op list depends on column kind', async () => {
    const { w } = setup(bn())
    await w.find('[data-test=bn-filter-add]').trigger('click')
    const op = () => opts(w.find('[data-test=bn-filter-op]'))
    expect(op()).toContain('contains')
    await set(w.find('[data-test=bn-filter-field]'), 'amount')
    expect(op()).not.toContain('contains')
    expect(op()).toContain('>=')
    await set(w.find('[data-test=bn-filter-field]'), 'ok')
    expect(op()).toEqual(['=', '!=', 'isNull', 'notNull'])
  })
  it('isNull hides value and writes no value', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a' }] })))
    expect(w.find('[data-test=bn-filter-value]').exists()).toBe(true)
    await set(w.find('[data-test=bn-filter-op]'), 'isNull')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: 'isNull' }])
    expect(w.find('[data-test=bn-filter-value]').exists()).toBe(false)
  })
  it('in parses "a, b" and shows the list back', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'region', op: 'in', value: ['x'] }] })))
    expect((w.find('[data-test=bn-filter-value]').element as HTMLInputElement).value).toBe('x')
    await set(w.find('[data-test=bn-filter-value]'), 'a, b ,, c')
    expect(metrics()[0].filter[0].value).toEqual(['a', 'b', 'c'])
    expect((w.find('[data-test=bn-filter-value]').element as HTMLInputElement).value).toBe('a, b, c')
  })
  it('in with more than 50 values is rejected', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'region', op: 'in', value: ['x'] }] })))
    await set(w.find('[data-test=bn-filter-value]'), Array.from({ length: 51 }, (_, i) => 'v' + i).join(','))
    expect(metrics()[0].filter[0].value).toEqual(['x'])
    expect(w.find('[data-test=bn-filter-error]').exists()).toBe(true)
  })
  it('6th filter blocked (add disabled at 5)', async () => {
    const f = Array.from({ length: 5 }, (_, i) => ({ field: 'region', op: '=', value: 'v' + i }))
    const { w } = setup(bn(M({ filter: f })))
    expect(w.findAll('[data-test=bn-filter-row]')).toHaveLength(5)
    expect(w.find('[data-test=bn-filter-add]').attributes('disabled')).toBeDefined()
    const four = setup(bn(M({ filter: f.slice(0, 4) })))
    expect(four.w.find('[data-test=bn-filter-add]').attributes('disabled')).toBeUndefined()
  })
  it('remove filter; removing the last drops the key', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a' }, { field: 'amount', op: '>', value: 1 }] })))
    await w.findAll('[data-test=bn-filter-remove]')[0].trigger('click')
    expect(metrics()[0].filter).toEqual([{ field: 'amount', op: '>', value: 1 }])
    await w.find('[data-test=bn-filter-remove]').trigger('click')
    expect('filter' in metrics()[0]).toBe(false)
  })
  it('editing a stored value keeps unknown extra keys and re-runs', async () => {
    const { w, metrics, runner } = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a', note: 'keep' }] })))
    runner.mockClear()
    await set(w.find('[data-test=bn-filter-value]'), 'b')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: '=', value: 'b', note: 'keep' }])
    await settle()
    expect(runner).toHaveBeenCalled()
  })
  it('a stored unknown op is displayed as-is with an error, not rewritten on mount', async () => {
    const { w, store, metrics } = setup(bn(M({ filter: [{ field: 'region', op: 'regex', value: 'a' }] })))
    expect(store.dirty.value).toBe(false)
    expect(opts(w.find('[data-test=bn-filter-op]'))).toContain('regex')
    expect((w.find('[data-test=bn-filter-op]').element as HTMLSelectElement).value).toBe('regex')
    expect(w.find('[data-test=bn-filter-error]').text()).toContain('regex')
    expect(metrics()[0].filter[0].op).toBe('regex')
  })
})

describe('compare editor', () => {
  it('select writes compare and auto-picks the only temporal column; none removes it', async () => {
    const { w, metrics, runner } = setup(bn(M()), COLS.filter((c) => c.name !== 'd2'))
    runner.mockClear()
    expect(w.find('[data-test=bn-compare-date]').exists()).toBe(false)
    await set(w.find('[data-test=bn-compare-kind]'), 'yoy')
    expect(metrics()[0].compare).toEqual({ kind: 'yoy', dateField: 'd' })
    await settle()
    expect(runner).toHaveBeenCalled()
    await set(w.find('[data-test=bn-compare-kind]'), 'mom')
    expect(metrics()[0].compare).toEqual({ kind: 'mom', dateField: 'd' })
    await set(w.find('[data-test=bn-compare-kind]'), 'none')
    expect('compare' in metrics()[0]).toBe(false)
  })
  it('with several temporal columns the first is picked and the date select lists only temporal columns', async () => {
    const { w, metrics } = setup(bn(M()))
    await set(w.find('[data-test=bn-compare-kind]'), 'mom')
    expect(metrics()[0].compare.dateField).toBe('d')
    expect(opts(w.find('[data-test=bn-compare-date]'))).toEqual(['d', 'd2'])
    await set(w.find('[data-test=bn-compare-date]'), 'd2')
    expect(metrics()[0].compare).toEqual({ kind: 'mom', dateField: 'd2' })
  })
  it('no temporal column → compare disabled with a hint', async () => {
    const { w } = setup(bn(M()), COLS.slice(0, 2))
    expect(w.find('[data-test=bn-compare-kind]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test=bn-compare-hint]').text()).toBe('Needs a date column')
  })
  it('a stored unknown kind is shown as-is with an error and not rewritten', async () => {
    const { w, store, metrics } = setup(bn(M({ compare: { kind: 'qoq', dateField: 'd' } })))
    expect(store.dirty.value).toBe(false)
    expect((w.find('[data-test=bn-compare-kind]').element as HTMLSelectElement).value).toBe('qoq')
    expect(w.find('[data-test=bn-compare-error]').text()).toContain('qoq')
    expect(metrics()[0].compare.kind).toBe('qoq')
  })
})

describe('labels, i18n, tokens', () => {
  it('aria labels carry the metric number in en and zh', async () => {
    const { w, store } = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a' }] })))
    const label = (s: string) => w.find(`[data-test=${s}]`).attributes('aria-label')
    expect(label('bn-filter-field')).toBe('Filter field (metric 1, condition 1)')
    expect(label('bn-compare-kind')).toBe('Comparison (metric 1)')
    expect(label('bn-filter-remove')).toBe('Remove filter 1 (metric 1)')
    setLocale('zh')
    const z = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: store } } })
    expect(z.find('[data-test=bn-filter-field]').attributes('aria-label')).toBe('筛选字段（指标 1，条件 1）')
    expect(z.find('[data-test=bn-compare-kind]').attributes('aria-label')).toBe('对比（指标 1）')
    expect(z.find('[data-test=bn-filter-group] .bn-filter-head').text()).toContain('筛选：')
    expect(z.find('[data-test=bn-agg]').findAll('option').some((o) => o.text() === '去重计数')).toBe(true)
  })
  it('filter/compare keys have zh+en parity', () => {
    const keys = (d: Record<string, string>) => Object.keys(d).filter((k) => /^bn\.(filter|cmp|agg)/.test(k)).sort()
    expect(keys(messages['zh-CN'])).toEqual(keys(messages.en))
    expect(keys(messages.en)).toContain('bn.agg.distinct')
    expect(keys(messages.en)).toContain('bn.filter.add')
    expect(keys(messages.en)).toContain('bn.cmp.none')
  })
  it('editor styles use dark tokens only (no hard-coded colours outside var fallbacks)', async () => {
    const raw = (await import('../src/analysis/BigNumberMetricEditor.vue?raw')).default as string
    const style = raw.slice(raw.indexOf('<style'))
    expect(style).toContain('var(--color-')
    expect(style.replace(/var\(--color-[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/)
  })
})

const two = () => ({ data: 'sales', value: { field: 'amount', aggregate: 'sum' }, metrics: [M(), { field: 'region', aggregate: 'distinct' }] })

describe('draft state follows its metric', () => {
  it('draft on metric 2, remove metric 1 → draft stays with its own metric and writes there', async () => {
    const { w, metrics } = setup(two())
    await w.findAll('[data-test=bn-filter-add]')[1].trigger('click')
    await w.findAll('[data-test=bn-remove]')[0].trigger('click')
    expect(metrics()).toHaveLength(1)
    expect(w.findAll('[data-test=bn-filter-row]')).toHaveLength(1)
    await set(w.find('[data-test=bn-filter-value]'), 'x')
    expect(metrics()[0].field).toBe('region')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: '=', value: 'x' }])
  })
  it('draft on metric 1 does not appear on metric 2 after removing metric 1', async () => {
    const { w, metrics } = setup(two())
    await w.findAll('[data-test=bn-filter-add]')[0].trigger('click')
    await w.findAll('[data-test=bn-remove]')[0].trigger('click')
    expect(w.findAll('[data-test=bn-filter-row]')).toHaveLength(0)
    expect(metrics()[0].filter).toBeUndefined()
  })
  it('draft follows its metric when moved; error stays with it', async () => {
    const { w, metrics } = setup(two())
    await w.findAll('[data-test=bn-filter-add]')[1].trigger('click')
    await set(w.find('[data-test=bn-filter-value]'), '')
    await w.findAll('[data-test=bn-up]')[1].trigger('click')
    const groups = w.findAll('[data-test=bn-filter-group]')
    expect(groups[0].findAll('[data-test=bn-filter-row]')).toHaveLength(1)
    expect(groups[1].findAll('[data-test=bn-filter-row]')).toHaveLength(0)
    expect(groups[0].find('[data-test=bn-filter-error]').exists()).toBe(true)
    expect(groups[1].find('[data-test=bn-filter-error]').exists()).toBe(false)
    await set(groups[0].find('[data-test=bn-filter-value]'), 'q')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: '=', value: 'q' }])
    expect(metrics()[1].filter).toBeUndefined()
  })
})

describe('draft hint', () => {
  it('shows "not saved yet" (role=status) until saved or removed, incl. after op/field change; zh too', async () => {
    const { w } = setup(bn())
    const hint = () => w.find('[data-test=bn-filter-draft-hint]')
    expect(hint().exists()).toBe(false)
    await w.find('[data-test=bn-filter-add]').trigger('click')
    expect(hint().text()).toBe('Not saved yet')
    expect(hint().attributes('role')).toBe('status')
    await set(w.find('[data-test=bn-filter-field]'), 'amount')
    expect(hint().exists()).toBe(true)
    await set(w.find('[data-test=bn-filter-op]'), '>')
    expect(hint().exists()).toBe(true)
    await set(w.find('[data-test=bn-filter-value]'), '3')
    expect(hint().exists()).toBe(false)
    await w.find('[data-test=bn-filter-add]').trigger('click')
    expect(hint().exists()).toBe(true)
    await w.findAll('[data-test=bn-filter-remove]')[1].trigger('click')
    expect(hint().exists()).toBe(false)
    setLocale('zh')
    await w.find('[data-test=bn-filter-add]').trigger('click')
    expect(hint().text()).toBe('尚未保存')
  })
  it('isNull draft is saved immediately (no hint)', async () => {
    const { w, metrics } = setup(bn())
    await w.find('[data-test=bn-filter-add]').trigger('click')
    await set(w.find('[data-test=bn-filter-op]'), 'isNull')
    expect(metrics()[0].filter).toEqual([{ field: 'region', op: 'isNull' }])
    expect(w.find('[data-test=bn-filter-draft-hint]').exists()).toBe(false)
  })
})

describe('focus after removing a filter row', () => {
  const f = [{ field: 'region', op: '=', value: 'a' }, { field: 'region', op: '=', value: 'b' }, { field: 'region', op: '=', value: 'c' }]
  const active = () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')
  it('stored row: focus goes to the next row remove button, else previous, else add', async () => {
    const { w } = setup(bn(M({ filter: f })), COLS, true)
    await w.findAll('[data-test=bn-filter-remove]')[0].trigger('click'); await flushPromises()
    expect(active()).toBe('Remove filter 1 (metric 1)')
    expect(document.activeElement).toBe(w.findAll('[data-test=bn-filter-remove]')[0].element)
    await w.findAll('[data-test=bn-filter-remove]')[1].trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(w.findAll('[data-test=bn-filter-remove]')[0].element)
    await w.find('[data-test=bn-filter-remove]').trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(w.find('[data-test=bn-filter-add]').element)
    w.unmount()
  })
  it('draft row removal moves focus to the previous row remove button, else add', async () => {
    const { w } = setup(bn(M({ filter: f.slice(0, 1) })), COLS, true)
    await w.find('[data-test=bn-filter-add]').trigger('click')
    await w.findAll('[data-test=bn-filter-remove]')[1].trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(w.findAll('[data-test=bn-filter-remove]')[0].element)
    await w.find('[data-test=bn-filter-remove]').trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(w.find('[data-test=bn-filter-add]').element)
    w.unmount()
  })
})

describe('rejected writes', () => {
  it('rejected input is reset to the stored value; error belongs to that row and clears on a good edit', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'amount', op: '=', value: 1 }, { field: 'amount', op: '=', value: 2 }] })))
    const rows = () => w.findAll('[data-test=bn-filter-row]')
    await set(rows()[0].find('[data-test=bn-filter-value]'), 'abc')
    expect((rows()[0].find('[data-test=bn-filter-value]').element as HTMLInputElement).value).toBe('1')
    expect(rows()[0].find('[data-test=bn-filter-error]').exists()).toBe(true)
    expect(rows()[1].find('[data-test=bn-filter-error]').exists()).toBe(false)
    await set(rows()[1].find('[data-test=bn-filter-value]'), '7')
    expect(rows()[0].find('[data-test=bn-filter-error]').exists()).toBe(true)
    await set(rows()[0].find('[data-test=bn-filter-value]'), '5')
    expect(rows()[0].find('[data-test=bn-filter-error]').exists()).toBe(false)
    expect(metrics()[0].filter.map((x: any) => x.value)).toEqual([5, 7])
  })
  it('text values are trimmed like in-values; whitespace-only is rejected', async () => {
    const { w, metrics } = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a' }] })))
    await set(w.find('[data-test=bn-filter-value]'), '  east  ')
    expect(metrics()[0].filter[0].value).toBe('east')
    await set(w.find('[data-test=bn-filter-value]'), '   ')
    expect(metrics()[0].filter[0].value).toBe('east')
    expect(w.find('[data-test=bn-filter-error]').exists()).toBe(true)
  })
})

describe('editor layout (plan 13 T4)', () => {
  const order = (w: any, sels: string[]) => {
    const all = Array.from(w.find('[data-test=bn-metric]').element.querySelectorAll(sels.map((s) => `[data-test=${s}]`).join(',')) as NodeListOf<HTMLElement>)
    return all.map((e) => e.getAttribute('data-test'))
  }
  const ALL = ['bn-field', 'bn-agg', 'bn-label', 'bn-format', 'bn-decimals', 'bn-compare-kind', 'bn-compare-date', 'bn-up', 'bn-down', 'bn-remove']
  it('controls appear in order field, agg, label, format, decimals, compare, up, down, remove', () => {
    const { w } = setup(bn())
    expect(order(w, ALL)).toEqual(['bn-field', 'bn-agg', 'bn-label', 'bn-format', 'bn-decimals', 'bn-compare-kind', 'bn-up', 'bn-down', 'bn-remove'])
  })
  it('compare date select sits directly after compare kind, before up', () => {
    const { w } = setup(bn(M({ compare: { kind: 'mom', dateField: 'd' } })))
    expect(order(w, ALL)).toEqual(['bn-field', 'bn-agg', 'bn-label', 'bn-format', 'bn-decimals', 'bn-compare-kind', 'bn-compare-date', 'bn-up', 'bn-down', 'bn-remove'])
  })
  it('up/down/remove are buttons with aria-labels', () => {
    const { w } = setup(bn())
    for (const s of ['bn-up', 'bn-down', 'bn-remove']) {
      const b = w.find(`[data-test=${s}]`)
      expect(b.element.tagName).toBe('BUTTON')
      expect(b.attributes('aria-label')).toBeTruthy()
    }
  })
  it('filter group: no details, one-line header with 0 filters, rows below', async () => {
    const { w } = setup(bn())
    const g = w.find('[data-test=bn-filter-group]')
    expect(g.find('details').exists()).toBe(false)
    const head = g.find('.bn-filter-head')
    expect(head.text()).toContain('Filter:')
    expect(head.find('[data-test=bn-filter-add]').exists()).toBe(true)
    const r = setup(bn(M({ filter: [{ field: 'region', op: '=', value: 'a' }] })))
    const rg = r.w.find('[data-test=bn-filter-group]')
    const kids = Array.from(rg.element.children)
    expect(kids[0].classList.contains('bn-filter-head')).toBe(true)
    expect(kids[1].getAttribute('data-test')).toBe('bn-filter-row')
  })
  it('zh header is 筛选：', () => {
    const { w } = setup(bn())
    setLocale('zh')
    const z = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: useNotebookStore() } } })
    expect(z.find('.bn-filter-head').text()).toContain('筛选：')
  })
  it('second metric carries the separator class, the first does not', () => {
    const { w } = setup(bn(M(), { metrics: [M(), M({ field: 'region', aggregate: 'count' })] }))
    const ms = w.findAll('[data-test=bn-metric]')
    expect(ms[0].classes()).not.toContain('bn-sep')
    expect(ms[1].classes()).toContain('bn-sep')
  })
  it('header key parity', () => {
    expect(messages.en['bn.filter.header']).toBe('Filter:')
    expect(messages['zh-CN']['bn.filter.header']).toBe('筛选：')
  })
  const five = Array.from({ length: 5 }, (_, i) => ({ field: 'region', op: '=', value: 'v' + i }))
  it('cap reason: none and enabled at 4; disabled with described-by reason at 5 (en+zh); gone after removing one', async () => {
    const four = setup(bn(M({ filter: five.slice(0, 4) })))
    const a4 = four.w.find('[data-test=bn-filter-add]')
    expect(a4.attributes('disabled')).toBeUndefined()
    expect(a4.attributes('aria-describedby')).toBeUndefined()
    expect(four.w.find('[data-test=bn-filter-max]').exists()).toBe(false)
    const { w } = setup(bn(M({ filter: five })), COLS, true)
    const add = w.find('[data-test=bn-filter-add]')
    expect(add.attributes('disabled')).toBeDefined()
    const id = add.attributes('aria-describedby')!
    expect(id).toBeTruthy()
    const why = w.find('[data-test=bn-filter-max]')
    expect(why.attributes('id')).toBe(id)
    expect(why.classes()).toContain('sr-only')
    expect(why.text()).toBe('At most 5 conditions')
    expect(add.attributes('title')).toBe('At most 5 conditions')
    await w.findAll('[data-test=bn-filter-remove]')[0].trigger('click')
    expect(w.find('[data-test=bn-filter-add]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test=bn-filter-max]').exists()).toBe(false)
    w.unmount()
    const z = setup(bn(M({ filter: five })))
    setLocale('zh')
    const zz = mount(BigNumberBlock, { props: { blockId: 'n1' }, global: { provide: { [StoreKey as symbol]: z.store } } })
    expect(zz.find('[data-test=bn-filter-max]').text()).toBe('最多 5 个条件')
  })
})
