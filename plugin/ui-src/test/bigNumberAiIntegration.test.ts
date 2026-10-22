import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale, t } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { genRequests, genPrompts, hostAiCalls } from './aiRequests'
import manifest from '../../manifest.json'

const PROMPT = 'PROMPT_SENT_7f3a'
const CHAT = 'CHATREPLY_SENT_9c1b'
const NOTE = 'NOTE_SENT_4d2e'
const COL = 'COL_UNUSED_SENT_5a6f'
const SAMPLE = 'SAMPLE_SENT_8b0c'
const TBL = 'TBL_SENT_2e9d'
const AI_SENTINELS = [PROMPT, CHAT, NOTE]
const PATH = '/tmp/a.sqlnb'
const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const fence = (v: unknown) => CHAT + '\n```json\n' + JSON.stringify(v) + '\n```'
const cand = (label: string, extra: Record<string, unknown> = {}) => ({ data: TBL, field: 'amount', aggregate: 'sum', label, note: NOTE, ...extra })

type Outputs = 'none' | 'separate' | 'inline'
function file(o: { outputs?: Outputs; legacy?: boolean } = {}) {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.settings.outputs = o.outputs ?? 'none'
  nb.blocks.push(
    { id: 'b_sql001', type: 'sql', content: 'select * from t', metadata: { resultName: TBL } } as any,
    { id: 'b_bn0001', type: 'big-number', metadata: o.legacy ? { data: TBL, value: { field: 'amount', aggregate: 'sum' }, label: 'Total' } : { data: TBL, value: { field: 'amount', aggregate: 'sum' } } } as any,
    { id: 'b_sql002', type: 'sql', content: 'select 2', metadata: {} } as any,
  )
  return serializeNotebook(nb)
}

const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
beforeEach(() => setLocale('en'))
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

async function boot(o: { outputs?: Outputs; legacy?: boolean; replies?: string[]; streaming?: boolean } = {}) {
  document.body.innerHTML = ''
  const replies = [...(o.replies ?? [])]
  const writes: string[] = []
  const outWrites: string[] = []
  const htmls: string[] = []
  const queries: string[] = []
  const gen = async () => replies.shift() ?? CHAT
  const bridge: any = createFakeBridge({
    caps: { aiCompletion: true, aiCompletionStream: o.streaming === true },
    context: () => CTX,
    onContext: () => () => {},
    queryData: async (req: any) => {
      queries.push(req.sql)
      return { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }, { name: COL, dataType: 'text' }], rows: [[SAMPLE, 3, 'x'], ['b', 5, 'y']], truncated: false, elapsedMs: 1, dbType: 'postgres' }
    },
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: file(o), mtimeMs: 1 }),
      'notebook/write': (p: any) => { writes.push(p.text); return { mtimeMs: 2 } },
      'notebook/writeOut': (p: any) => { outWrites.push(p.text); return {} },
      'notebook/deleteOut': () => ({}),
      'notebook/touchRecent': () => ({}),
      'engine/register': () => ({}),
      'engine/query': () => ({ columns: [], rows: [[42]], truncated: false, elapsedMs: 1 }),
      'export/browserStatus': () => ({ found: true, path: '/c', source: 'auto' }),
      'export/pickFolder': () => ({ path: '/o' }),
      'system/user': () => ({ name: 'u' }),
      'export/saveHtml': (p: any) => { htmls.push(p.html); return { path: '/o/r.html', bytes: 5 } },
    },
    requestHandlers: { 'host.ai.listModels': () => MODELS, 'host.ai.generateText': gen, 'host.ai.generateTextStream': gen, 'host.ai.cancelGeneration': () => ({ cancelled: true }) },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  const store = () => (w.vm as any).store
  const home = async () => {
    await w.find('[data-test=home]').trigger('click'); await flushPromises()
    const discard = w.findAll('button').find((b) => b.text() === t('dlg.discard'))
    if (discard) { await discard.trigger('click'); await flushPromises() }
  }
  const open = async () => { await w.find('.sp-path input').setValue(PATH); await w.find('[data-test=open-path]').trigger('click'); await settle() }
  await home(); await open()
  const block = (id: string) => w.find(`[data-block-id=${id}]`)
  const runSql = async () => { await block('b_sql001').find('[data-test=run]').trigger('click'); await settle() }
  const askBtn = (id = 'b_bn0001') => block(id).find('[data-test=bn-ask-ai]')
  const openAi = async (id = 'b_bn0001') => { (askBtn(id).element as HTMLElement).focus(); await askBtn(id).trigger('click'); await settle() }
  const send = async (text: string) => { await w.find('[data-test=chat-input]').setValue(text); await w.find('[data-test=chat-send]').trigger('click'); await settle() }
  const cards = () => w.findAll('[data-test=bn-board] [data-test=bn-card]')
  const save = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })); await settle() }
  const flip = (p: Record<string, boolean>) => (w.vm as any).aiSettings.setSend(p)
  const calls = () => bridge.calls as any[]
  const storageSets = () => calls().filter((c) => c.method === 'storageSet')
  const blocks = () => store().nb.value.blocks as any[]
  return { w, bridge, store, home, open, block, runSql, askBtn, openAi, send, cards, save, flip, calls, storageSets, blocks, writes, outWrites, htmls, queries, replies }
}
type S = Awaited<ReturnType<typeof boot>>

async function exportHtml(s: S) {
  const q = (k: string) => document.querySelector(`[data-test=${k}]`) as HTMLElement | null
  const click = async (el: Element | null | undefined) => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }
  await s.w.find('[data-test=export]').trigger('click'); await flushPromises()
  await click(q('fmt-html')); await click(q('choose')); await click(q('go'))
}

const twoCands = () => fence([cand('Total'), cand('Average', { aggregate: 'mean' })])
async function fullFlow(s: S) {
  await s.runSql()
  await s.openAi()
  await s.send(PROMPT)
  expect(s.cards()).toHaveLength(2)
  await s.w.find('[data-test=bn-apply-insert]').trigger('click'); await settle()
}
const lastWrite = (s: S) => s.writes[s.writes.length - 1] ?? ''

describe('big-number AI: privacy integration', () => {
  it('full flow (outputs none): Ask AI → generate → cards → insert 2 → save → .sqlnb has only ordinary big-number metadata', async () => {
    const s = await boot({ replies: [twoCands()] })
    await fullFlow(s)
    const bns = s.blocks().filter((b) => b.type === 'big-number')
    expect(bns).toHaveLength(2)
    expect(bns[1].metadata.metrics.map((m: any) => m.label)).toEqual(['Total', 'Average'])
    await s.save()
    const text = lastWrite(s)
    expect(text).toContain('"Average"')
    for (const x of [PROMPT, CHAT, NOTE, COL, SAMPLE]) expect(text).not.toContain(x)
    expect(text).not.toMatch(/metricsAfter|metricsSampled|metricsSchema|bignumber/)
    // positive control: the scan can see sentinels where they are expected
    expect(genPrompts(s.bridge).join('\n')).toContain(PROMPT)
    expect(genPrompts(s.bridge).join('\n')).toContain(COL)
    expect(genPrompts(s.bridge).join('\n')).toContain(SAMPLE)
    expect(JSON.stringify(s.storageSets().map((c) => c.args.value))).toContain(PROMPT)
    expect(text).toContain(TBL)
  })

  for (const mode of ['separate', 'inline'] as const) {
    it(`outputs ${mode}: .sqlnb / .sqlnb.out carry no AI sentinel`, async () => {
      const s = await boot({ outputs: mode, replies: [twoCands()] })
      await fullFlow(s)
      await s.save()
      const all = [lastWrite(s), ...s.outWrites].join('\n=====\n')
      for (const x of AI_SENTINELS) expect(all).not.toContain(x)
      expect(all).not.toMatch(/metricsAfter|metricsSampled|metricsSchema|bignumber/)
      // positive control: the result data itself is legitimately saved (where it is expected)
      expect(all).toContain(SAMPLE)
      if (mode === 'separate') expect(s.outWrites.length).toBeGreaterThan(0)
    })
  }

  it('export HTML has none of the AI sentinels', async () => {
    const s = await boot({ replies: [twoCands()] })
    await fullFlow(s)
    await exportHtml(s)
    expect(s.htmls).toHaveLength(1)
    for (const x of AI_SENTINELS) expect(s.htmls[0]).not.toContain(x)
    expect(s.htmls[0]).toContain('Average')
  })

  it('schema off → zero generateText/generateTextStream (positive control: on)', async () => {
    const off = await boot({ replies: [twoCands()] })
    await off.runSql()
    await off.flip({ schema: false })
    await settle()
    await off.home(); await off.open(); await off.runSql()
    const btn = off.askBtn()
    expect(btn.attributes('disabled')).toBeDefined()
    expect(off.w.find('#' + btn.attributes('aria-describedby')!).text()).toBe(t('ai.bn.gate.no-schema-setting'))
    ;(btn.element as HTMLButtonElement).disabled = false
    await btn.trigger('click'); await settle()
    expect(genRequests(off.bridge)).toHaveLength(0)
    expect(hostAiCalls(off.bridge).filter((c) => /generate/.test(c.args.method))).toHaveLength(0)
    const on = await boot({ replies: [twoCands()] })
    await on.runSql(); await on.openAi(); await on.send(PROMPT)
    expect(genRequests(on.bridge).length).toBeGreaterThan(0)
  })

  it('data off → sample sentinel absent (control: on); replaying cached chat after data off masks earlier replies', async () => {
    const off = await boot({ replies: [twoCands()] })
    await off.runSql()
    await off.flip({ data: false })
    await off.openAi(); await off.send(PROMPT)
    expect(genPrompts(off.bridge).join('\n')).not.toContain(SAMPLE)
    expect(genPrompts(off.bridge).join('\n')).toContain(PROMPT)
    off.w.unmount()

    const s = await boot({ replies: [twoCands(), twoCands()] })
    await s.runSql(); await s.openAi(); await s.send(PROMPT)
    expect(genPrompts(s.bridge)[0]).toContain(SAMPLE)
    await s.flip({ data: false })
    await s.send('second question')
    const p2 = genPrompts(s.bridge)[1]
    expect(p2).toContain('second question')
    expect(p2).not.toContain(SAMPLE)
    expect(p2).not.toContain(NOTE)
    // positive control: same flow with data still on replays the earlier reply
    const c = await boot({ replies: [twoCands(), twoCands()] })
    await c.runSql(); await c.openAi(); await c.send(PROMPT); await c.send('second question')
    expect(genPrompts(c.bridge)[1]).toContain(NOTE)
  })

  it('AI calls always use request, never invoke', async () => {
    const s = await boot({ replies: [twoCands()] })
    await fullFlow(s)
    await s.save()
    const ai = hostAiCalls(s.bridge)
    expect(ai.length).toBeGreaterThan(0)
    expect(ai.every((c) => c.method === 'request')).toBe(true)
    const invokes = s.calls().filter((c) => c.method === 'invoke').map((c) => String(c.args.method))
    expect(invokes.some((m) => /^host\./.test(m))).toBe(false)
    expect(invokes.some((m) => /ai/i.test(m))).toBe(false)
    const payloads = JSON.stringify(s.calls().filter((c) => c.method === 'invoke' && !/^notebook\/write|^export\/saveHtml/.test(String(c.args.method))).map((c) => c.args))
    for (const x of [PROMPT, CHAT, NOTE]) expect(payloads).not.toContain(x)
    // positive control: the request channel does carry the prompt
    expect(JSON.stringify(ai.map((c) => c.args))).toContain(PROMPT)
  })

  it('streaming capability: still request only', async () => {
    const s = await boot({ replies: [twoCands()], streaming: true })
    await fullFlow(s)
    expect(hostAiCalls(s.bridge).length).toBeGreaterThan(0)
    expect(hostAiCalls(s.bridge).every((c) => c.method === 'request')).toBe(true)
  })

  it('chat cache is saved only under the block key; manifest permissions unchanged (six)', async () => {
    const s = await boot({ replies: [twoCands()] })
    await s.runSql(); await s.openAi(); await s.send(PROMPT)
    const withSentinel = s.storageSets().filter((c) => JSON.stringify(c.args.value).includes(PROMPT))
    expect(withSentinel.length).toBeGreaterThan(0)
    expect(withSentinel.every((c) => /^ai\.chat\.v1\.[^.]+\.b_bn0001:bignumber$/.test(c.args.key))).toBe(true)
    const others = s.storageSets().filter((c) => !String(c.args.key).startsWith('ai.chat.v1.'))
    for (const x of [PROMPT, CHAT, NOTE, COL, SAMPLE]) expect(JSON.stringify(others.map((c) => c.args))).not.toContain(x)
    expect([...(manifest as any).permissions].sort()).toEqual(['host.ai', 'host.connections:read', 'host.data:read', 'host.schema:read', 'host.storage', 'host.workbench'])
  })

  it('opening another notebook closes the drawer', async () => {
    const s = await boot({ replies: [twoCands()] })
    await s.runSql(); await s.openAi()
    expect(s.w.find('[data-test=bn-drawer]').exists()).toBe(true)
    await s.home(); await s.open()
    expect(s.w.find('[data-test=bn-drawer]').exists()).toBe(false)
  })

  it('focus returns to the Ask AI button after the drawer closes', async () => {
    const s = await boot()
    await s.runSql(); await s.openAi()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(s.w.find('[data-test=bn-drawer]').exists()).toBe(false)
    expect(document.activeElement).toBe(s.askBtn().element)
  })

  it('update-current with 3 metrics then undo restores', async () => {
    const s = await boot({ replies: [fence([cand('A'), cand('B', { aggregate: 'mean' }), cand('C', { aggregate: 'max' })])] })
    await s.runSql(); await s.openAi(); await s.send(PROMPT)
    const before = serializeNotebook(s.store().nb.value)
    await s.w.find('[data-test=bn-apply-update]').trigger('click'); await settle()
    const bn = s.blocks().find((b) => b.id === 'b_bn0001')
    expect(bn.metadata.metrics.map((m: any) => m.label)).toEqual(['A', 'B', 'C'])
    s.store().undo()
    await flushPromises()
    expect(serializeNotebook(s.store().nb.value)).toBe(before)
  })

  it('old file without new fields: open → Ask AI → no apply → file text unchanged (dirty false)', async () => {
    const s = await boot({ legacy: true, replies: [twoCands()] })
    await s.runSql()
    const before = serializeNotebook(s.store().nb.value)
    await s.openAi(); await s.send(PROMPT)
    expect(s.cards()).toHaveLength(2)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(serializeNotebook(s.store().nb.value)).toBe(before)
    expect(s.store().dirty.value).toBe(false)
    expect(s.writes).toHaveLength(0)
  })
})
