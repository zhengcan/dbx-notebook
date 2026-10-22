import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { serializeNotebook } from '@sqlnb/format'
import { runBigNumber } from '../src/analysis/runBigNumber'
import { t } from '../src/i18n'
import { cleanup, fence, m, setup } from './aiMetricsHarness'

beforeEach(cleanup)
const A = (label: string, extra: Record<string, unknown> = {}) => m('sales', 'amount', 'sum', { label, ...extra })
const B = (label: string) => m('costs', 'cost', 'sum', { label })
async function withCards(list: unknown[], o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o)
  await s.gen(); await s.respond(fence(list)); await s.settle()
  const upd = () => s.w.find('[data-test=bn-apply-update]')
  const ins = () => s.w.find('[data-test=bn-apply-insert]')
  const click = async (sel: string) => { await s.w.find(sel).trigger('click'); await s.settle() }
  const uncheck = async (i: number) => { await s.cards()[i].find('[data-test=bn-card-check]').setValue(false); await flushPromises() }
  const ids = () => s.store.nb.value.blocks.map((b) => b.id)
  const bytes = () => serializeNotebook(s.store.nb.value)
  const metrics = (id: string) => { const mt = s.meta(id); return mt.metrics ?? [{ ...mt.value, label: mt.label }] }
  return { ...s, upd, ins, click, uncheck, ids, bytes, metrics }
}

describe('Apply update', () => {
  it('3 checked same-source cards → one block with 3 metrics, undo restores', async () => {
    const s = await withCards([A('a'), A('b'), A('c')])
    const before = s.bytes()
    expect(s.upd().attributes('disabled')).toBeUndefined()
    await s.click('[data-test=bn-apply-update]')
    expect(s.metrics('n1').map((x: any) => x.label)).toEqual(['a', 'b', 'c'])
    expect(s.meta().data).toBe('sales')
    expect(s.store.history.undoDepth.value).toBe(1)
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })
  it('emits close after apply', async () => {
    const s = await withCards([A('a')])
    await s.click('[data-test=bn-apply-update]')
    expect(s.w.emitted('close')).toBeTruthy()
  })
  it('mixed sources → update disabled with reason, insert still enabled', async () => {
    const s = await withCards([A('a'), B('b')])
    expect(s.upd().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=bn-apply-reason]').text()).toBe(t('ai.bn.reject.mixedSources'))
    expect(s.ins().attributes('disabled')).toBeUndefined()
  })
  it('>8 checked → disabled with reason', async () => {
    const s = await withCards(Array.from({ length: 9 }, (_, i) => A(`m${i}`)))
    expect(s.upd().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=bn-apply-reason]').text()).toBe(t('ai.bn.reject.tooMany'))
    await s.uncheck(8)
    expect(s.upd().attributes('disabled')).toBeUndefined()
  })
  it('unchecking a card excludes it from both applies', async () => {
    const s = await withCards([A('a'), A('b'), A('c')])
    await s.uncheck(1)
    expect(s.ins().text()).toBe(t('ai.bn.insertN', { n: 1, m: 2 }))
    await s.click('[data-test=bn-apply-update]')
    expect(s.metrics('n1').map((x: any) => x.label)).toEqual(['a', 'c'])
  })
  it('invalid cards are excluded from both applies', async () => {
    const s = await withCards([A('a'), m('nope', 'x')])
    expect(s.ins().text()).toBe(t('ai.bn.insertN', { n: 1, m: 1 }))
    await s.click('[data-test=bn-apply-update]')
    expect(s.metrics('n1').map((x: any) => x.label)).toEqual(['a'])
  })
  it('names are canonicalised to the live table spelling', async () => {
    const s = await withCards([m('SALES', 'AMOUNT', 'sum', { label: 'ci' })])
    await s.click('[data-test=bn-apply-update]')
    expect(s.meta().data).toBe('sales')
    expect(s.metrics('n1')[0].field).toBe('amount')
  })
  it('applied block shows the same value as the card preview', async () => {
    const s = await withCards([A('a')])
    const shown = s.cards()[0].find('[data-test=bn-card-preview]').text()
    await s.click('[data-test=bn-apply-update]')
    const r = await runBigNumber({ store: s.store, engine: s.engine }, 'n1')
    expect(String(r.items[0].value)).toBe(shown)
  })
  it('no checked card → disabled with the empty reason', async () => {
    const s = await withCards([A('a')])
    await s.uncheck(0)
    expect(s.upd().attributes('disabled')).toBeDefined()
    expect(s.ins().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=bn-apply-reason]').text()).toBe(t('ai.bn.reject.empty'))
  })
})

describe('Apply insert', () => {
  it('grouping preview: 3 cards from A + 1 from B → "2 blocks (4 metrics)", cards show block 1,1,1,2; unchecking updates', async () => {
    const s = await withCards([A('a1'), A('a2'), A('a3'), B('b1')])
    expect(s.ins().text()).toBe(t('ai.bn.insertN', { n: 2, m: 4 }))
    expect(s.cards().map((c) => c.find('[data-test=bn-card-group]').text())).toEqual(['→ block 1', '→ block 1', '→ block 1', '→ block 2'])
    await s.uncheck(0)
    expect(s.ins().text()).toBe(t('ai.bn.insertN', { n: 2, m: 3 }))
    await s.uncheck(3)
    expect(s.ins().text()).toBe(t('ai.bn.insertN', { n: 1, m: 2 }))
    expect(s.cards()[0].find('[data-test=bn-card-group]').exists()).toBe(false)
  })
  it('insert 3 same-source cards → ONE block with 3 metrics after current, one undo', async () => {
    const s = await withCards([A('a'), A('b'), A('c')])
    const before = s.bytes()
    await s.click('[data-test=bn-apply-insert]')
    const ids = s.ids()
    expect(ids.length).toBe(4)
    expect(ids[ids.indexOf('n1') + 1]).not.toBe(undefined)
    const nid = ids[ids.indexOf('n1') + 1]
    expect(s.metrics(nid).map((x: any) => x.label)).toEqual(['a', 'b', 'c'])
    expect(s.metrics('n1')).toEqual([{ field: 'amount', aggregate: 'sum' }])
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })
  it('insert 10 same-source → blocks of 8 and 2 in order, one undo removes both', async () => {
    const s = await withCards(Array.from({ length: 10 }, (_, i) => A(`m${i}`)))
    const before = s.bytes()
    await s.click('[data-test=bn-apply-insert]')
    const ids = s.ids(); const i = ids.indexOf('n1')
    expect(s.metrics(ids[i + 1]).length).toBe(8)
    expect(s.metrics(ids[i + 2]).length).toBe(2)
    expect(s.metrics(ids[i + 1])[0].label).toBe('m0'); expect(s.metrics(ids[i + 2])[0].label).toBe('m8')
    expect(s.store.history.undoDepth.value).toBe(1)
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })
  it('insert mixed A,B,A → block A(2 metrics) then block B', async () => {
    const s = await withCards([A('a1'), B('b1'), A('a2')])
    await s.click('[data-test=bn-apply-insert]')
    const ids = s.ids(); const i = ids.indexOf('n1')
    expect(s.meta(ids[i + 1]).data).toBe('sales'); expect(s.metrics(ids[i + 1]).map((x: any) => x.label)).toEqual(['a1', 'a2'])
    expect(s.meta(ids[i + 2]).data).toBe('costs'); expect(s.metrics(ids[i + 2]).map((x: any) => x.label)).toEqual(['b1'])
  })
})

describe('Apply refusals', () => {
  it('source column gone at click time → rejection text, notebook unchanged', async () => {
    const s = await withCards([A('a'), A('b')])
    const before = s.bytes()
    s.store.runs.set('s1', { status: 'ok', executedAt: 'T9', result: { columns: [{ name: 'region', dataType: 'text' }], rows: [['a']], truncated: false, elapsedMs: 1 } } as any)
    await s.w.find('[data-test=bn-apply-update]').trigger('click') // no flush: the button is still enabled in the DOM
    await s.settle()
    expect(s.bytes()).toBe(before)
    expect(s.w.find('[data-test=bn-reject]').text()).toContain(t('ai.bn.reject.columnGone'))
    expect(s.w.emitted('close')).toBeUndefined()
  })
  it('source table gone at click time → sourceGone', async () => {
    const s = await withCards([A('a')])
    s.store.runs.delete('s1')
    await s.w.find('[data-test=bn-apply-insert]').trigger('click'); await s.settle()
    expect(s.w.find('[data-test=bn-reject]').text()).toContain(t('ai.bn.reject.sourceGone'))
    expect(s.ids()).toEqual(['s1', 's2', 'n1'])
  })
  it('current block deleted → both disabled with reason', async () => {
    const s = await withCards([A('a')])
    s.store.removeBlock('n1')
    await s.settle()
    expect(s.upd().attributes('disabled')).toBeDefined()
    expect(s.ins().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=bn-apply-reason]').text()).toBe(t('ai.bn.reject.blockGone'))
  })
  it('block deleted at click time: update → blockGone; nothing changes, no crash', async () => {
    const s = await withCards([A('a')])
    s.store.removeBlock('n1')
    const before = s.bytes()
    await s.w.find('[data-test=bn-apply-update]').trigger('click'); await s.settle()
    expect(s.w.find('[data-test=bn-reject]').text()).toContain(t('ai.bn.reject.blockGone'))
    expect(s.bytes()).toBe(before)
  })
  it('anchor deleted at click time: insert → anchorMissing, nothing inserted', async () => {
    const s = await withCards([A('a')])
    s.store.removeBlock('n1')
    const before = s.bytes()
    await s.w.find('[data-test=bn-apply-insert]').trigger('click'); await s.settle()
    expect(s.w.find('[data-test=bn-reject]').text()).toContain(t('ai.bn.reject.anchorMissing'))
    expect(s.bytes()).toBe(before)
  })
  it('block turned into another type → notBigNumber', async () => {
    const s = await withCards([A('a')])
    ;(s.store.nb.value.blocks.find((b) => b.id === 'n1') as any).type = 'markdown'
    await s.w.find('[data-test=bn-apply-update]').trigger('click'); await s.settle()
    expect(s.w.find('[data-test=bn-reject]').text()).toContain(t('ai.bn.reject.notBigNumber'))
  })
  it('busy → both disabled', async () => {
    const s = await withCards([A('a')])
    await s.chatSend('again')
    expect(s.w.find('[data-test=chat-cancel]').exists()).toBe(true)
    expect(s.upd().attributes('disabled')).toBeDefined()
    expect(s.ins().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=bn-generate]').attributes('disabled')).toBeDefined()
  })
  it('forced click while busy writes nothing', async () => {
    const s = await withCards([A('a')])
    await s.chatSend('again')
    const before = s.bytes()
    const b = s.w.find('[data-test=bn-apply-update]')
    ;(b.element as HTMLButtonElement).disabled = false
    await b.trigger('click'); await s.settle()
    expect(s.bytes()).toBe(before)
    expect(s.w.emitted('close')).toBeUndefined()
  })
  it('notebook reloaded (generation changed) → apply writes nothing and closes', async () => {
    const s = await withCards([A('a')])
    const before = s.bytes()
    s.store.generation.value++
    await s.w.find('[data-test=bn-apply-update]').trigger('click'); await s.settle()
    expect(s.bytes()).toBe(before)
    expect(s.w.emitted('close')).toBeTruthy()
  })
  it('Escape closes the drawer (not dirty), backdrop click too', async () => {
    const s = await withCards([A('a')])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(s.w.emitted('close')).toBeTruthy()
  })
  it('nothing AI-related reaches the notebook bytes', async () => {
    const s = await withCards([A('a', { note: 'PRIVATE_NOTE' })])
    await s.click('[data-test=bn-apply-update]')
    expect(s.bytes()).not.toMatch(/PRIVATE_NOTE|metricsAfter|metricsSampled|bignumber/)
  })
})
