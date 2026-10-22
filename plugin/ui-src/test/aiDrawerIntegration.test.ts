import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="3" height="3"/></svg>'
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: async () => ({ view: {}, svg: async () => SVG, destroy() {} }) }) }))
const drawerEditors = vi.hoisted(() => [] as { doc: string; opts: any }[])
vi.mock('../src/editor/sqlEditor', async (orig) => ({
  ...(await orig<typeof import('../src/editor/sqlEditor')>()),
  createSqlEditor: (_p: HTMLElement, o: any) => {
    const e = { doc: o.doc as string, opts: o }
    drawerEditors.push(e)
    return { setDoc(s: string) { e.doc = s }, getDoc: () => e.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus() {} }
  },
}))
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { chatKey, CHAT_LIMITS } from '../src/ai/chatStore'
import { setLocale, t } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { genRequests } from './aiRequests'
import manifest from '../../manifest.json'

vi.mock('../src/ai/formatSql', async (orig) => ({ ...(await orig<typeof import('../src/ai/formatSql')>()), formatAiSql: async (sql: string) => ({ ok: false, sql, reason: 'failed' }) }))

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'
const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const PATH = '/tmp/a.sqlnb'
const SQL_PROBE = 'PROBE_SQL_TEXT'
const SCHEMA_PROBE = 'PROBE_SCHEMA_COL'
const CELL_PROBE = 'PROBE_CELL_VALUE'
const USER_PROBE = 'PROBE_USER_REQUEST'
const GEN = 'host.ai.generateTextStream'
const GEN_ONCE = 'host.ai.generateText'
const isGen = (c: any) => c.method === 'request' && (c.args.method === GEN || c.args.method === GEN_ONCE)

const chartCfg = { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'avg' }] }, chartOptions: { type: 'line' } }
const schemes = () => fence('json', JSON.stringify([{ title: 'A', ...chartCfg }, { title: 'B', pivot: chartCfg.pivot, chartOptions: { type: 'bar' } }, { title: 'C', pivot: chartCfg.pivot, chartOptions: { type: 'pie' } }]))

function notebook() {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.blocks.push(
    { id: 'b_sqlaaa', type: 'sql', content: `select region, amount from sales -- ${SQL_PROBE}`, metadata: { resultName: 'sales' } } as any,
    { id: 'b_sqlbbb', type: 'sql', content: 'select 2 as other', metadata: {} } as any,
    { id: 'b_chartb', type: 'chart', metadata: { data: 'sales', spec: {}, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any,
  )
  return serializeNotebook(nb)
}

interface Opts { caps?: Record<string, boolean>; replies?: (string | ((p: any) => string))[]; seed?: Record<string, unknown>; storageFails?: boolean; path?: string }

const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

async function boot(o: Opts = {}) {
  setLocale('en')
  document.body.innerHTML = ''
  drawerEditors.length = 0
  const caps = { aiCompletion: true, aiCompletionStream: true, ...o.caps }
  const prompts: string[] = []
  const replies = [...(o.replies ?? [])]
  const writes: string[] = []
  const outWrites: string[] = []
  let bridge: any
  let nq = 0
  const genHandler = (params: any) => {
    prompts.push(params.prompt)
    const r = replies.shift() ?? 'QUESTION: anything else?'
    return typeof r === 'function' ? r(params) : r
  }
  bridge = createFakeBridge({
    caps,
    context: () => CTX,
    onContext: () => () => {},
    queryData: async () => (nq++, { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [[CELL_PROBE, 1], ['b', 5]], truncated: false, elapsedMs: 1, dbType: 'postgres' }),
    getTableMetadata: async () => ({ columns: [{ name: SCHEMA_PROBE, dataType: 'text', nullable: true }] }),
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: notebook(), mtimeMs: 1 }),
      'notebook/write': (p: any) => { writes.push(p.text); return { mtimeMs: 2 } },
      'notebook/writeOut': (p: any) => { outWrites.push(p.text); return {} },
      'notebook/deleteOut': () => ({}),
      'notebook/touchRecent': () => ({}),
    },
    requestHandlers: {
      'host.ai.listModels': () => MODELS,
      [GEN]: genHandler,
      [GEN_ONCE]: genHandler,
      'host.ai.cancelGeneration': () => ({ cancelled: true }),
    },
  } as any)
  if (o.storageFails) {
    bridge.storageGet = async (k: string) => { if (k.startsWith('ai.chat')) throw new Error('quota'); return null }
    const set = bridge.storageSet
    bridge.storageSet = async (k: string, v: unknown) => { if (k.startsWith('ai.chat')) throw new Error('quota'); return set(k, v) }
  }
  for (const [k, v] of Object.entries(o.seed ?? {})) await bridge.storageSet(k, v)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  const store = () => (w.vm as any).store
  const open = async () => {
    await w.find('.sp-path input').setValue(o.path ?? PATH)
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
  }
  const home = async () => {
    await w.find('[data-test=home]').trigger('click'); await flushPromises()
    const discard = w.findAll('button').find((b) => b.text() === t('dlg.discard'))
    if (discard) { await discard.trigger('click'); await flushPromises() }
  }
  await home()
  await open()
  const calls = () => bridge.calls as any[]
  const gens = () => calls().filter(isGen).length
  const block = (id: string) => w.find(`[data-block-id=${id}]`)
  const content = (id = 'b_sqlaaa') => store().nb.value.blocks.find((b: any) => b.id === id)?.content as string
  const runSql = async () => { await block('b_sqlaaa').find('[data-test=run]').trigger('click'); await flushPromises(); await flushPromises() }
  const openSql = async (id = 'b_sqlaaa') => { await block(id).find('[data-test=ask-ai]').trigger('click'); await flushPromises() }
  const send = async (text = USER_PROBE) => {
    await w.find('[data-test=chat-input]').setValue(text)
    await w.find('[data-test=chat-send]').trigger('click')
    await settle()
  }
  const esc = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flushPromises()
    const keep = w.findAll('button').find((b) => b.text() === t('drawer.discardDraft') || b.text() === t('drawer.close.skip'))
    if (keep) { await keep.trigger('click'); await flushPromises() }
  }
  const draftEdit = async (text: string) => { const e = drawerEditors[drawerEditors.length - 1]; e.doc = text; e.opts.onChange(text); await flushPromises() }
  const confirm = async () => { await w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises() }
  const setToggle = async (name: 'schema' | 'sql' | 'data', v: boolean) => {
    await home()
    await w.find(`[data-test=ai-send-${name}]`).setValue(v)
    await flushPromises()
    await open()
  }
  const storageSets = (pred: (k: string) => boolean = (k) => k.startsWith('ai.chat.v1.')) => calls().filter((c) => c.method === 'storageSet' && pred(c.args.key)).map((c) => c.args as { key: string; value: any })
  const key = (id: string) => chatKey(o.path ?? PATH, id)
  const undo = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); await flushPromises() }
  const save = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })); await flushPromises(); await flushPromises() }
  return { queries: () => nq, w, bridge, store, prompts, writes, outWrites, calls, gens, block, content, runSql, openSql, send, esc, draftEdit, confirm, setToggle, storageSets, key, home, open, undo, save }
}

beforeEach(() => setLocale('en'))

describe('capability off', () => {
  it('no SQL/Interpret/Chart AI entries and zero host.ai requests across open/close/typing', async () => {
    const s = await boot({ caps: { aiCompletion: false, aiCompletionStream: false } })
    await s.runSql()
    expect(s.w.find('[data-test=ask-ai]').exists()).toBe(false)
    expect(s.w.find('[data-test=ai-interpret]').exists()).toBe(false)
    expect(s.calls().filter((c) => (c.method === 'request' || c.method === 'invoke') && /^host\.ai\./.test(c.args.method))).toEqual([])
  })
})

describe('SQL multi-turn', () => {
  const S2 = 'select region from sales where amount > 1'
  const S3 = 'select region, amount from sales order by amount'

  it('QUESTION turn, answer → SQL, manual edit feeds next prompt, confirm → one history entry, auto-run rules, undo byte-exact; reopen restores', async () => {
    const s = await boot({ replies: ['QUESTION: which month?', fence('sql', S2), fence('sql', S3)] })
    await s.runSql()
    const before = serializeNotebook(s.store().nb.value)
    const original = s.content()
    await s.openSql()
    await s.send('show sales')
    expect(s.w.find('[data-test=chat-pane]').text()).toContain('which month?')
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe(original)
    await s.send('march')
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe(S2)
    await s.draftEdit(S2 + ' -- MANUAL_EDIT_MARK')
    await s.send('and sort it')
    expect(s.prompts[2]).toContain('-- MANUAL_EDIT_MARK')
    expect(s.prompts[2]).toContain('which month?')
    expect(s.content()).toBe(original)
    expect(s.store().history.undoDepth.value).toBe(0)

    const q0 = s.queries()
    await s.draftEdit(S3)
    await s.confirm()
    expect(s.content()).toBe(S3)
    expect(s.store().history.undoDepth.value).toBe(1)
    expect(s.queries()).toBeGreaterThan(q0)
    await s.undo()
    expect(serializeNotebook(s.store().nb.value)).toBe(before)

    await s.openSql()
    const msgs = s.w.findAll('[data-test=chat-msg]').map((m) => m.text()).join('|')
    expect(msgs).toContain('show sales')
    expect(msgs).toContain('which month?')
    expect(msgs).toContain('and sort it')
  })

  it('replace and insert-new each push exactly one history entry', async () => {
    const s = await boot()
    await s.openSql()
    await s.draftEdit('select 11')
    await s.confirm()
    expect(s.store().history.undoDepth.value).toBe(1)
    await s.openSql()
    await s.draftEdit('select 12')
    const before = s.store().nb.value.blocks.length
    await s.w.find('[data-test=sql-insert-new]').trigger('click'); await flushPromises(); await flushPromises()
    expect(s.store().nb.value.blocks.length).toBe(before + 1)
    expect(s.store().history.undoDepth.value).toBe(2)
  })

  it('non-read-only draft is never auto-run', async () => {
    const s = await boot()
    await s.openSql()
    await s.draftEdit('update sales set amount = 0')
    await s.confirm()
    expect(s.queries()).toBe(0)
    expect(s.content()).toBe('update sales set amount = 0')
  })
})

describe('isolation, deletion and notebook load', () => {
  it('reopen restores the chat; another block has an independent chat', async () => {
    const s = await boot({ replies: [fence('sql', 'select 1'), 'QUESTION: b2?'] })
    await s.openSql('b_sqlaaa')
    await s.send('ONLY_IN_A')
    await s.esc()
    await s.openSql('b_sqlbbb')
    expect(s.w.find('[data-test=chat-pane]').text()).not.toContain('ONLY_IN_A')
    await s.send('ONLY_IN_B')
    await s.esc()
    await s.openSql('b_sqlaaa')
    const txt = s.w.find('[data-test=chat-pane]').text()
    expect(txt).toContain('ONLY_IN_A')
    expect(txt).not.toContain('ONLY_IN_B')
    expect(s.storageSets().map((x) => x.key)).toEqual(expect.arrayContaining([s.key('b_sqlaaa'), s.key('b_sqlbbb')]))
  })

  it('deleting a block clears its base/:interpret/:chart keys and no others; a notebook load clears nothing', async () => {
    const s = await boot({ replies: [fence('sql', 'select 1')] })
    await s.openSql('b_sqlaaa')
    await s.send('x')
    await s.esc()
    const nulls = () => s.storageSets().filter((x) => x.value === null).map((x) => x.key)
    s.store().removeBlock('b_sqlbbb')
    await settle()
    expect(nulls()).toEqual(expect.arrayContaining([s.key('b_sqlbbb'), s.key('b_sqlbbb:interpret'), s.key('b_sqlbbb:chart')]))
    expect(nulls()).not.toContain(s.key('b_sqlaaa'))
    const n = nulls().length
    await s.home()
    await s.open()
    await settle()
    expect(nulls().length).toBe(n)
    await s.openSql('b_sqlaaa')
    expect(s.w.find('[data-test=chat-pane]').text()).toContain('x')
  })

  it('notebook load while the drawer is open: closes, no write, chat of the old path is not shown for the new one', async () => {
    const s = await boot({ replies: [fence('sql', 'select 1'), fence('sql', 'select 9')] })
    await s.openSql()
    await s.send('OLD_PATH_CHAT')
    const blocks = JSON.stringify(s.store().nb.value.blocks)
    await s.home()
    await s.open()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    expect(JSON.stringify(s.store().nb.value.blocks)).toBe(blocks)
    expect(s.writes).toEqual([])
    expect(s.store().history.undoDepth.value).toBe(0)
    await s.w.find('[data-test=home]').trigger('click'); await flushPromises()
    await s.w.find('.sp-path input').setValue('/tmp/renamed.sqlnb')
    await s.w.find('[data-test=open-path]').trigger('click'); await flushPromises()
    await s.openSql()
    expect(s.w.find('[data-test=chat-pane]').text()).not.toContain('OLD_PATH_CHAT')
  })

  it('mid-request notebook load: late reply is not saved and nothing is written', async () => {
    let finish: (v: string) => void = () => {}
    const s = await boot({ replies: [() => new Promise<string>((r) => { finish = r }) as any] })
    await s.openSql()
    await s.w.find('[data-test=chat-input]').setValue('slow')
    await s.w.find('[data-test=chat-send]').trigger('click')
    await settle()
    await s.home()
    await s.open()
    finish(fence('sql', 'LATE_RESULT_SQL'))
    await settle()
    expect(s.store().history.undoDepth.value).toBe(0)
    expect(s.content()).not.toContain('LATE_RESULT_SQL')
    expect(JSON.stringify(s.storageSets().map((x) => x.value))).not.toContain('LATE_RESULT_SQL')
  })
})

describe('toggles filter history (probe strings in every field)', () => {
  const PH = { text: 'PROBE_H_TEXT', data: 'PROBE_H_DATA', sql: 'PROBE_H_SQLAFTER', md: 'PROBE_H_MDAFTER', chart: 'PROBE_H_CHARTAFTER' }
  const rec = (extra: Record<string, unknown> = {}) => ({
    v: 1, updated: 1,
    messages: [
      { id: 'u1', role: 'user', at: 1, parts: [{ kind: 'text', text: PH.text }, { kind: 'data', text: PH.data }] },
      { id: 'a1', role: 'assistant', at: 2, parts: [{ kind: 'text', text: 'ok' }], sqlAfter: `select region from sales -- ${PH.sql}`, markdownAfter: PH.md, chartAfter: PH.chart },
    ],
    ...extra,
  })
  const seed = () => ({ [chatKey(PATH, 'b_sqlaaa')]: rec() })

  it('all on: every probe is sent; data off drops data parts and markdown/chartAfter; sql off drops sqlAfter and block SQL; schema off drops schema; back on restores', async () => {
    const s = await boot({ seed: seed() })
    const ask = async () => { await s.openSql(); await s.send(USER_PROBE); await s.esc(); return s.prompts[s.prompts.length - 1] }
    const p0 = await ask()
    expect(p0).not.toContain(PH.chart)
    for (const x of [PH.text, PH.data, PH.sql, PH.md, SQL_PROBE, SCHEMA_PROBE, USER_PROBE]) expect(p0, x).toContain(x)

    await s.setToggle('data', false)
    const p1 = await ask()
    for (const x of [PH.data, PH.md, PH.chart]) expect(p1, x).not.toContain(x)
    for (const x of [PH.text, PH.sql, SQL_PROBE, SCHEMA_PROBE]) expect(p1, x).toContain(x)

    await s.setToggle('data', true)
    await s.setToggle('sql', false)
    const p2 = await ask()
    for (const x of [PH.sql, SQL_PROBE]) expect(p2, x).not.toContain(x)
    for (const x of [PH.data, PH.md, PH.text, SCHEMA_PROBE]) expect(p2, x).toContain(x)

    await s.setToggle('sql', true)
    await s.setToggle('schema', false)
    const p3 = await ask()
    expect(p3).not.toContain(SCHEMA_PROBE)
    for (const x of [PH.data, PH.sql, SQL_PROBE]) expect(p3, x).toContain(x)

    await s.setToggle('schema', true)
    const p4 = await ask()
    expect(p4).toContain(SCHEMA_PROBE)
  })
})

describe('interpretation drawer', () => {
  it('opening auto-generates exactly once on the request channel (positive control)', async () => {
    const s = await boot({ replies: ['## F'] })
    await s.runSql()
    await s.block('b_sqlaaa').find('[data-test=ai-interpret]').trigger('click'); await settle()
    expect(genRequests(s.bridge).length).toBe(1)
  })

  it('send-result-data off: entry disabled with a reason, nothing sent on either generation channel', async () => {
    const s = await boot()
    await s.setToggle('data', false)
    await s.runSql()
    const entry = s.block('b_sqlaaa').find('[data-test=ai-interpret]')
    expect(entry.attributes('disabled')).toBeDefined()
    await entry.trigger('click'); await settle()
    expect(s.w.find('[data-test=interpret-drawer]').exists()).toBe(false)
    expect(genRequests(s.bridge).length).toBe(0)
  })

  it('opens and auto-generates once; preview; insert as markdown: one entry; undo exact', async () => {
    const s = await boot({ replies: ['## Findings\n\nSales are fine.'] })
    await s.runSql()
    const before = serializeNotebook(s.store().nb.value)
    const n = s.store().nb.value.blocks.length
    await s.block('b_sqlaaa').find('[data-test=ai-interpret]').trigger('click'); await settle()
    expect(s.w.find('[data-test=interpret-drawer]').exists()).toBe(true)
    expect(s.gens()).toBe(1)
    expect(s.w.find('[data-test=interpret-preview]').html()).toContain('Findings')
    expect(s.store().nb.value.blocks.length).toBe(n)
    await s.confirm()
    expect(s.store().nb.value.blocks.length).toBe(n + 1)
    expect(s.store().nb.value.blocks[1].type).toBe('markdown')
    expect(s.store().history.undoDepth.value).toBe(1)
    await s.undo()
    expect(serializeNotebook(s.store().nb.value)).toBe(before)
  })
})

describe('chart drawer', () => {
  const chart = (s: any) => s.store().nb.value.blocks.find((b: any) => b.id === 'b_chartb')
  it('candidates, numbered change, apply: one entry; undo exact', async () => {
    const s = await boot({ replies: [schemes(), fence('json', JSON.stringify([{ title: 'B2', pivot: chartCfg.pivot, chartOptions: { type: 'area' } }]))] })
    await s.runSql()
    const before = JSON.stringify(chart(s).metadata)
    await s.block('b_chartb').find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=chart-drawer]').exists()).toBe(true)
    expect(s.gens()).toBe(0)
    await s.w.find('[data-test=chart-generate]').trigger('click'); await settle()
    expect(s.w.findAll('[data-test=scheme-card]').length).toBe(3)
    expect(s.prompts[0]).toContain(CELL_PROBE)
    await s.w.find('[data-test=chat-input]').setValue('change scheme 2 to an area chart')
    await s.w.find('[data-test=chat-send]').trigger('click'); await settle()
    expect(s.prompts[1]).toContain('SELECTED SCHEME 2')
    expect(s.w.findAll('[data-test=scheme-card]').length).toBe(3)
    expect(JSON.stringify(chart(s).metadata)).toBe(before)
    await s.confirm()
    expect(s.store().history.undoDepth.value).toBe(1)
    expect(JSON.stringify(chart(s).metadata)).not.toBe(before)
    await s.undo()
    expect(JSON.stringify(chart(s).metadata)).toBe(before)
  })

  it('send.data off refuses with zero requests', async () => {
    const s = await boot()
    await s.setToggle('data', false)
    await s.runSql()
    const btn = s.block('b_chartb').find('[data-test=ask-ai]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=chart-drawer]').exists()).toBe(false)
    expect(s.gens()).toBe(0)
  })
})

describe('closing and cancelling', () => {
  it('Esc / Discard / close button send nothing and change nothing', async () => {
    const s = await boot()
    const before = serializeNotebook(s.store().nb.value)
    await s.openSql(); await s.esc()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    await s.openSql(); await s.w.find('[data-test=drawer-discard]').trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    await s.openSql(); await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    expect(s.gens()).toBe(0)
    expect(serializeNotebook(s.store().nb.value)).toBe(before)
    expect(s.store().history.undoDepth.value).toBe(0)
  })

  it('Esc during preparing sends nothing (SQL, interpret, chart)', async () => {
    const s = await boot()
    await s.runSql()
    await s.openSql()
    await s.w.find('[data-test=chat-input]').setValue('x')
    void s.w.find('[data-test=chat-send]').trigger('click')
    await s.esc(); await settle()
    expect(s.gens()).toBe(0)

    await s.block('b_sqlaaa').find('[data-test=ai-interpret]').trigger('click')
    expect(s.w.find('[data-test=interpret-drawer]').exists()).toBe(true)
    await s.esc(); await settle()
    expect(s.w.find('[data-test=interpret-drawer]').exists()).toBe(false)
    expect(s.gens()).toBe(0)

    await s.block('b_chartb').find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    void s.w.find('[data-test=chart-generate]').trigger('click')
    await s.esc(); await settle()
    expect(s.gens()).toBe(0)
    expect(s.store().history.undoDepth.value).toBe(0)
  })

  it('closing mid-request cancels and the late reply is not saved', async () => {
    let finish: (v: string) => void = () => {}
    const s = await boot({ replies: [() => new Promise<string>((r) => { finish = r }) as any] })
    await s.openSql()
    await s.w.find('[data-test=chat-input]').setValue('slow one')
    await s.w.find('[data-test=chat-send]').trigger('click')
    await settle()
    await s.esc()
    finish(fence('sql', 'LATE_REPLY_SQL'))
    await settle()
    expect(s.calls().some((c) => c.method === 'request' && c.args.method === 'host.ai.cancelGeneration')).toBe(true)
    expect(JSON.stringify(s.storageSets().map((x) => x.value))).not.toContain('LATE_REPLY_SQL')
    expect(s.content()).not.toContain('LATE_REPLY_SQL')
  })
})

describe('unsaved notebook and storage failure', () => {
  it('path null: chat works, nothing in storage', async () => {
    const s = await boot({ replies: [fence('sql', 'select 5')] })
    s.store().path.value = null
    await s.openSql()
    await s.send('hello')
    expect(s.w.find('[data-test=chat-pane]').text()).toContain('hello')
    expect(s.storageSets()).toEqual([])
  })

  it('Save As after unsaved: chat starts empty, then caches under the new path', async () => {
    const s = await boot({ replies: [fence('sql', 'select 5'), 'QUESTION: new?'] })
    s.store().path.value = null
    await s.openSql()
    await s.send('UNSAVED_CHAT')
    expect(s.storageSets()).toEqual([])
    await s.w.find('[data-test=drawer-discard]').trigger('click'); await flushPromises()
    s.store().path.value = '/tmp/saved-as.sqlnb'
    await s.openSql()
    expect(s.w.find('[data-test=chat-pane]').text()).not.toContain('UNSAVED_CHAT')
    await s.send('AFTER_SAVE_AS')
    const keys = s.storageSets().map((x) => x.key)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k === chatKey('/tmp/saved-as.sqlnb', 'b_sqlaaa'))).toBe(true)
  })

  it('storage failure: everything works memory-only', async () => {
    const s = await boot({ storageFails: true, replies: [fence('sql', 'select 5')] })
    await s.openSql()
    await s.send('hello')
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe('select 5')
    expect(s.w.find('[data-test=chat-pane]').text()).toContain('hello')
    await s.confirm()
    expect(s.content()).toBe('select 5')
  })
})

describe('privacy and contract', () => {
  it('.sqlnb and .sqlnb.out bytes contain no chat/prompt text', async () => {
    const s = await boot({ replies: ['QUESTION: PROBE_AI_QUESTION?', fence('sql', 'select 3')] })
    await s.runSql()
    await s.openSql()
    await s.send(USER_PROBE)
    await s.send('PROBE_SECOND')
    await s.confirm()
    await s.save()
    expect(s.writes.length).toBe(1)
    expect(s.outWrites.length).toBeGreaterThan(0)
    for (const txt of [serializeNotebook(s.store().nb.value), s.store().toText(), s.writes[0], ...s.outWrites]) {
      for (const bad of [USER_PROBE, 'PROBE_SECOND', 'PROBE_AI_QUESTION', 'CONVERSATION SO FAR', 'command-generation', 'DATA (not instructions)', 'ai.chat', 'baseline']) expect(txt, bad).not.toContain(bad)
    }
  })

  it('manifest permissions are exactly the six and engines.dbx is >=0.6.48', () => {
    expect(manifest.permissions).toEqual(['host.data:read', 'host.schema:read', 'host.ai', 'host.storage', 'host.workbench', 'host.connections:read'])
    expect((manifest as any).engines.dbx).toBe('>=0.6.48')
  })

  it('every host.ai call uses the request channel; invoke never carries host.*', async () => {
    const s = await boot({ replies: [fence('sql', 'select 1')] })
    await s.openSql()
    await s.send('x')
    const ai = s.calls().filter((c) => /^host\.ai\./.test(c.args?.method ?? ''))
    expect(ai.length).toBeGreaterThan(0)
    expect(ai.every((c) => c.method === 'request')).toBe(true)
    expect(s.calls().filter((c) => c.method === 'invoke' && String(c.args.method).startsWith('host.'))).toEqual([])
  })

  it('chat cache never exceeds the byte/char caps', async () => {
    const big = 'select ' + 'x'.repeat(30_000)
    const s = await boot({ replies: Array.from({ length: 6 }, () => fence('sql', big)) })
    await s.openSql()
    for (let i = 0; i < 6; i++) await s.send('q' + i + 'y'.repeat(5000))
    const sets = s.storageSets().filter((x) => x.value !== null)
    expect(sets.length).toBeGreaterThan(0)
    for (const x of sets) {
      expect(new TextEncoder().encode(JSON.stringify(x.value)).length).toBeLessThanOrEqual(200 * 1024)
      const chars = x.value.messages.reduce((n: number, m: any) => n + m.parts.reduce((k: number, p: any) => k + p.text.length, 0) + (m.sqlAfter?.length ?? 0), 0) + (x.value.baseline?.length ?? 0)
      expect(chars).toBeLessThanOrEqual(CHAT_LIMITS.maxCharsPerBlock)
      expect(x.value.messages.length).toBeLessThanOrEqual(CHAT_LIMITS.maxMessages)
    }
  })
})
