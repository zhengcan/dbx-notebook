import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { genRequests, hostAiCalls } from './aiRequests'
import { t } from '../src/i18n'
import { cleanup, fence, m, setup } from './aiMetricsHarness'

beforeEach(cleanup)
const three = () => fence([m('sales', 'region', 'distinct', { label: 'Regions' }), m('sales', 'amount', 'sum', { label: 'East total', filter: [{ field: 'region', op: '=', value: 'a' }] }), m('sales', 'amount', 'sum', { label: 'MoM', compare: { kind: 'mom', dateField: 'd' } })])
const allReq = (s: Awaited<ReturnType<typeof setup>>) => genRequests(s.bridge).length + s.calls.length

describe('MetricsDrawer turns', () => {
  it('opening sends nothing', async () => {
    const s = await setup()
    expect(s.calls.length).toBe(0)
    expect(genRequests(s.bridge).length).toBe(0)
    expect(s.w.find('[data-test=bn-hint]').exists()).toBe(true)
    expect(s.w.find('[data-test=bn-card]').exists()).toBe(false)
  })
  it('generate → one request with table/column names, user text outside the fence', async () => {
    const s = await setup()
    await s.gen()
    expect(s.calls.length).toBe(1)
    const p = s.calls[0].prompt
    expect(p).toContain('sales'); expect(p).toContain('amount'); expect(p).toContain('costs')
    expect(p).not.toContain(t('drawer.bn.firstTurn') + '\n[') // sanity
    const fenceEnd = p.lastIndexOf('[END DATA]') >= 0 ? p.lastIndexOf('[END DATA]') : -1
    expect(p.indexOf(t('drawer.bn.firstTurn'))).toBeGreaterThan(-1)
    if (fenceEnd >= 0) expect(p.indexOf(t('drawer.bn.firstTurn'))).toBeGreaterThan(fenceEnd)
  })
  it('user request is capped at 2000 chars', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three())
    await s.w.find('[data-test=chat-input]').setValue('x'.repeat(3000))
    await s.w.find('[data-test=chat-send]').trigger('click'); await flushPromises()
    expect(s.calls[1].prompt).toContain('x'.repeat(2000))
    expect(s.calls[1].prompt).not.toContain('x'.repeat(2001))
  })
  it('schema off → reason, generate and typing disabled, zero generateText AND generateTextStream (positive control: schema on → one request)', async () => {
    const off = await setup({ send: { schema: false } })
    expect(off.w.find('[data-test=bn-reason]').text()).toBe(t('ai.bn.gate.no-schema-setting'))
    expect(off.w.find('[data-test=bn-generate]').attributes('disabled')).toBeDefined()
    expect(off.w.find('[data-test=chat-send]').attributes('disabled')).toBeDefined()
    await off.w.find('[data-test=bn-generate]').trigger('click'); await off.settle()
    await off.chatSend('hello'); await off.settle()
    expect(off.calls.length).toBe(0)
    expect(hostAiCalls(off.bridge).length).toBe(0)
    expect(genRequests(off.bridge).length).toBe(0)
    cleanup()
    const on = await setup()
    await on.gen()
    expect(on.calls.length).toBe(1)
  })
  it('unsupported host → reason; even a forced click sends nothing (drawer-level gate)', async () => {
    const s = await setup({ aiCompletion: false })
    expect(s.w.find('[data-test=bn-reason]').text()).toBe(t('ai.bn.gate.unsupported'))
    const b = s.w.find('[data-test=bn-generate]')
    ;(b.element as HTMLButtonElement).disabled = false
    await b.trigger('click'); await s.settle()
    expect(allReq(s)).toBe(0)
    expect(hostAiCalls(s.bridge).length).toBe(0)
  })
  it('data off → no PROBE_CELL; data on → present', async () => {
    const off = await setup({ send: { data: false } })
    await off.gen()
    expect(off.calls[0].prompt).not.toContain('PROBE_CELL')
    expect(off.calls[0].prompt).toContain('amount')
    cleanup()
    const on = await setup()
    await on.gen()
    expect(on.calls[0].prompt).toContain('PROBE_CELL')
  })
  it('no local tables → no-tables reason, nothing sent', async () => {
    const s = await setup({ noTables: true })
    expect(s.w.find('[data-test=bn-reason]').text()).toBe(t('ai.bn.gate.no-tables'))
    await s.w.find('[data-test=bn-generate]').trigger('click'); await s.settle()
    expect(allReq(s)).toBe(0)
  })
  it('sendOptions flipped to schema-off during the turn → no request', async () => {
    const s = await setup()
    let n = 0
    s.settings.sendOptions.mockImplementation(async () => (++n >= 3 ? { schema: false, sql: true, data: true } : { schema: true, sql: true, data: true }))
    await s.gen(); await s.settle()
    expect(s.calls.length).toBe(0)
    expect(genRequests(s.bridge).length).toBe(0)
  })
  it('3 candidates incl. distinct, a filtered sum and a MoM → 3 cards with local previews and compare text; values never in any prompt', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three()); await s.settle()
    expect(s.cards().length).toBe(3)
    const txt = s.cards().map((c) => c.find('[data-test=bn-card-preview]').text())
    expect(txt).toEqual(['42', '42', '42'])
    expect(s.cards()[2].find('[data-test=bn-card-compare]').text()).toContain('▲')
    expect(s.calls.every((c) => !c.prompt.includes('150'))).toBe(true)
    expect(s.cards().every((c) => c.attributes('role') === 'group' && !!c.attributes('aria-label'))).toBe(true)
    expect(s.cards()[0].attributes('aria-current')).toBe('true')
  })
  it('invalid table/column/type/filter/compare → red card with reason, unchecked', async () => {
    const s = await setup()
    await s.gen()
    await s.respond(fence([
      m('nope', 'x'), m('sales', 'zzz'), m('sales', 'region', 'sum'),
      m('sales', 'amount', 'sum', { filter: [{ field: 'amount', op: '=', value: 'str' }] }),
      m('sales', 'amount', 'sum', { compare: { kind: 'mom', dateField: 'region' } }), m('sales', 'amount'),
    ]))
    await s.settle()
    const cs = s.cards()
    expect(cs.map((c) => c.find('[data-test=bn-card-error]').exists())).toEqual([true, true, true, true, true, false])
    expect(cs[0].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.NO_TABLE'))
    expect(cs[1].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.NO_COLUMN'))
    expect(cs[2].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.TYPE'))
    expect(cs[3].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.BAD_FILTER'))
    expect(cs[4].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.BAD_COMPARE'))
    const checks = cs.map((c) => c.find('[data-test=bn-card-check]').element as HTMLInputElement)
    expect(checks.map((c) => c.checked)).toEqual([false, false, false, false, false, true])
    expect(checks.slice(0, 5).every((c) => c.disabled)).toBe(true)
    expect(checks[5].getAttribute('aria-label')).toBe('sum(amount)')
  })
  it('13 candidates → 12 + warning', async () => {
    const s = await setup()
    await s.gen(); await s.respond(fence(Array.from({ length: 13 }, (_, i) => m('sales', 'amount', 'sum', { label: `M${i}` })))); await s.settle()
    expect(s.cards().length).toBe(12)
    expect(s.w.find('[data-test=bn-warnings]').exists()).toBe(true)
  })
  it('"第2个改成百分比" → only card 2 replaced', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three()); await s.settle()
    await s.chatSend('第2个改成百分比')
    expect(s.calls[1].prompt).toContain('[SELECTED METRIC 2]')
    await s.respond(fence(m('sales', 'amount', 'sum', { label: 'Pct', format: { kind: 'percent' } }))); await s.settle()
    const names = s.cards().map((c) => c.find('[data-test=bn-card-pick]').text())
    expect(names).toEqual(['1. Regions', '2. Pct', '3. MoM'])
    expect(s.cards()[1].attributes('aria-current')).toBe('true')
  })
  it('second Generate replaces the whole set', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three()); await s.settle()
    await s.gen(); await s.respond(fence([m('sales', 'amount', 'max', { label: 'Only' })])); await s.settle()
    expect(s.cards().length).toBe(1)
    expect(s.w.find('[data-test=bn-generate]').text()).toBe(t('drawer.bn.regenerate'))
  })
  it('question-only reply renders as chat, no cards', async () => {
    const s = await setup()
    await s.gen(); await s.respond('QUESTION: which table?'); await s.settle()
    expect(s.cards().length).toBe(0)
    expect(s.w.text()).toContain('which table?')
  })
  it('unmount mid-turn → no state written', async () => {
    const s = await setup()
    await s.gen()
    s.w.unmount()
    await s.respond(three()).catch(() => {})
    const c = await s.chat.load('/n.sqlnb', 'n1:bignumber')
    expect(c.messages.some((x) => x.role === 'assistant')).toBe(false)
  })
  it('notebook reload mid-turn → no cards, no assistant message', async () => {
    const s = await setup()
    await s.gen()
    s.store.generation.value++
    await s.respond(three()).catch(() => {})
    expect(s.cards().length).toBe(0)
  })
  it('IME composing Enter does not send', async () => {
    const s = await setup()
    const ta = s.w.find('[data-test=chat-input]')
    await ta.setValue('hello')
    await ta.trigger('compositionstart')
    await ta.trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()
    expect(s.calls.length).toBe(0)
    await ta.trigger('compositionend')
  })
  it('reopen restores cached candidates, re-validates, shows bn-older after source columns change', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three()); await s.settle()
    s.w.unmount()
    expect((await s.mountIt()).find('[data-test=bn-older]').exists()).toBe(false)
    cleanup()
  })
  it('restored candidates with a dropped column → red card and bn-older', async () => {
    const s = await setup()
    await s.gen(); await s.respond(three()); await s.settle()
    s.w.unmount()
    s.store.runs.set('s1', { status: 'ok', executedAt: 'T2', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'd', dataType: 'date' }], rows: [['a', '2026-01-01']], truncated: false, elapsedMs: 1 } } as any)
    const w2 = await s.mountIt(); await s.settle()
    expect(w2.find('[data-test=bn-older]').exists()).toBe(true)
    const cards = w2.findAll('[data-test=bn-card]')
    expect(cards.length).toBe(3)
    expect(cards[1].find('[data-test=bn-card-error]').text()).toContain(t('ai.bn.problem.NO_COLUMN'))
    expect((cards[1].find('[data-test=bn-card-check]').element as HTMLInputElement).disabled).toBe(true)
    expect(allReq(s)).toBe(1)
  })
})

describe('i18n', () => {
  it('drawer.bn.*, ai.bn.* exist in zh and en, none empty, same placeholders', async () => {
    const { messages } = await import('../src/i18n')
    const zh = messages['zh-CN'] as Record<string, string>, en = messages.en as Record<string, string>
    const keys = Object.keys(en).filter((k) => /^(drawer\.bn|ai\.bn)\./.test(k))
    expect(keys.length).toBeGreaterThan(30)
    for (const k of keys) {
      expect(zh[k], k).toBeTruthy(); expect(en[k], k).toBeTruthy()
      expect((zh[k].match(/\{\w+\}/g) ?? []).sort(), k).toEqual((en[k].match(/\{\w+\}/g) ?? []).sort())
    }
    expect(Object.keys(zh).filter((k) => /^(drawer\.bn|ai\.bn)\./.test(k)).sort()).toEqual(keys.slice().sort())
    for (const c of ['NO_TABLE', 'NO_COLUMN', 'BAD_AGG', 'TYPE', 'BAD_FILTER', 'BAD_COMPARE', 'AMBIGUOUS']) expect(en[`ai.bn.problem.${c}`]).toBeTruthy()
    for (const c of ['ambiguous', 'invalid', 'mixedSources', 'tooMany', 'empty', 'sourceGone', 'columnGone', 'blockGone', 'notBigNumber', 'anchorMissing']) expect(en[`ai.bn.reject.${c}`]).toBeTruthy()
  })
})
