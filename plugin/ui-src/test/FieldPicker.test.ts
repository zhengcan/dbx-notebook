import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldPicker from '../src/analysis/FieldPicker.vue'
import { setLocale } from '../src/i18n'

const fields = [{ name: 'region', kind: 'text' as const }, { name: 'amount', kind: 'number' as const }, { name: 'd', kind: 'temporal' as const }, { name: 'ok', kind: 'boolean' as const }]
beforeEach(() => setLocale('en'))
const last = (w: any) => w.emitted('update:modelValue').at(-1)[0]

describe('FieldPicker', () => {
  it('adds a dimension via the dropdown', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [], fields, kind: 'dimension', multiple: true } })
    const sel = w.find('[data-test="fp-add"]')
    await sel.setValue('region')
    expect(last(w)).toEqual([{ field: 'region' }])
  })
  it('single mode replaces and hides dropdown when full', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'region' }], fields, kind: 'dimension', multiple: true, max: 1 } })
    expect(w.find('[data-test="fp-add"]').exists()).toBe(false)
    const s = mount(FieldPicker, { props: { modelValue: [{ field: 'region' }], fields, kind: 'dimension', multiple: false } })
    await s.find('[data-test="fp-add"]').setValue('amount')
    expect(last(s)).toEqual([{ field: 'amount' }])
  })
  it('removes and reorders chips', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'region' }, { field: 'd' }], fields, kind: 'dimension', multiple: true } })
    await w.findAll('[data-test="fp-down"]')[0].trigger('click')
    expect(last(w)).toEqual([{ field: 'd' }, { field: 'region' }])
    await w.findAll('[data-test="fp-up"]')[1].trigger('click')
    expect(last(w)).toEqual([{ field: 'd' }, { field: 'region' }])
    await w.findAll('[data-test="fp-remove"]')[0].trigger('click')
    expect(last(w)).toEqual([{ field: 'd' }])
    expect(w.findAll('[data-test="fp-up"]')[0].attributes('disabled')).toBeDefined()
  })
  it('grain select only for temporal columns', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'region' }, { field: 'd' }], fields, kind: 'dimension', multiple: true } })
    const g = w.findAll('[data-test="fp-grain"]')
    expect(g).toHaveLength(1)
    await g[0].setValue('month')
    expect(last(w)).toEqual([{ field: 'region' }, { field: 'd', grain: 'month' }])
  })
  it('value chips: default agg by type, count-all, agg disabling, format', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'region', agg: 'count' }], fields, kind: 'value', multiple: true } })
    const opts = w.find('[data-test="fp-agg"]').findAll('option')
    const dis = (v: string) => opts.find((o) => o.element.value === v)!.attributes('disabled') !== undefined
    expect(dis('sum')).toBe(true); expect(dis('avg')).toBe(true); expect(dis('median')).toBe(true)
    expect(dis('count')).toBe(false); expect(dis('countDistinct')).toBe(false); expect(dis('min')).toBe(false)
    await w.find('[data-test="fp-add"]').setValue('amount')
    expect(last(w)[1]).toEqual({ field: 'amount', agg: 'sum' })
    await w.find('[data-test="fp-add"]').setValue('\u0000count')
    expect(last(w)[1]).toEqual({ field: '', agg: 'count' })
    await w.find('[data-test="fp-fmt"]').setValue('thousands')
    expect(last(w)[0].format).toEqual({ kind: 'thousands' })
    await w.find('[data-test="fp-dec"]').setValue('2')
    expect(last(w)[0].format.decimals).toBe(2)
  })
  it('numeric columns allow sum; missing fields are flagged but removable; labels bilingual', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'amount', agg: 'sum' }, { field: 'gone', agg: 'count' }], fields, kind: 'value', multiple: true } })
    const o = w.findAll('[data-test="fp-agg"]')[0].findAll('option').find((x) => x.element.value === 'sum')!
    expect(o.attributes('disabled')).toBeUndefined()
    expect(w.findAll('.fp-chip')[1].classes()).toContain('miss')
    expect(w.findAll('.fp-chip')[1].text()).toContain('missing')
    setLocale('zh-CN')
    const z = mount(FieldPicker, { props: { modelValue: [{ field: 'gone', agg: 'count' }], fields, kind: 'value', multiple: true } })
    expect(z.text()).toContain('字段缺失')
    expect(z.find('[data-test="fp-remove"]').attributes('aria-label')).toContain('移除')
  })
  it('a field cannot be added twice to the same dimension list', async () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'region' }], fields, kind: 'dimension', multiple: true } })
    const vals = w.find('[data-test="fp-add"]').findAll('option').map((o) => o.element.value)
    expect(vals).not.toContain('region')
    expect(vals).toContain('amount')
    await w.find('[data-test="fp-add"]').setValue('region')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
  it('value lists may repeat a field (different aggregates)', () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'amount', agg: 'sum' }], fields, kind: 'value', multiple: true } })
    expect(w.find('[data-test="fp-add"]').findAll('option').map((o) => o.element.value)).toContain('amount')
  })
  it('has no summary select (the method is edited in the table summary cells)', () => {
    const w = mount(FieldPicker, { props: { modelValue: [{ field: 'amount', agg: 'sum' }], fields, kind: 'value', multiple: true } })
    expect(w.find('[data-test="fp-summary"]').exists()).toBe(false)
  })
})
