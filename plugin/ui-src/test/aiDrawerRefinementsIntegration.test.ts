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
import { setLocale, t } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { genRequests, genPrompts, hostAiCalls } from './aiRequests'
import manifest from '../../manifest.json'

vi.mock('../src/ai/formatSql', async (orig) => ({ ...(await orig<typeof import('../src/ai/formatSql')>()), formatAiSql: async (sql: string) => ({ ok: false, sql, reason: 'failed' }) }))

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'
const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const PATH = '/tmp/a.sqlnb'
const GEN = 'host.ai.generateTextStream'
const GEN_ONCE = 'host.ai.generateText'
const TABLES = ['PROBE_TBL_ORDERS', 'PROBE_TBL_USERS', 'PROBE_TBL_A', 'PROBE_TBL_B', 'PROBE_TBL_C', 'PROBE_TBL_D']
const COL = (table: string) => `PROBE_COL_${table}`
const CELL_PROBE = 'PROBE_CELL_VALUE'
const SQL_PROBE = 'PROBE_SQL_TEXT'
const DECLINE = '__DECLINE__'
const isCatalog = (sql: string) => /information_schema|sqlite_master/.test(sql)

const chartCfg = { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'avg' }] }, chartOptions: { type: 'line' } }
const schemes = () => fence('json', JSON.stringify([{ title: 'SchemeA', ...chartCfg }, { title: 'SchemeB', pivot: chartCfg.pivot, chartOptions: { type: 'bar' } }, { title: 'SchemeC', pivot: chartCfg.pivot, chartOptions: { type: 'pie' } }]))
const one = (title: string, type: string) => fence('json', JSON.stringify({ title, pivot: chartCfg.pivot, chartOptions: { type } }))

function notebook() {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.blocks.push(
    { id: 'b_sqlaaa', type: 'sql', content: `select region, amount from sales -- ${SQL_PROBE}`, metadata: { resultName: 'sales' } } as any,
    { id: 'b_sqlbbb', type: 'sql', content: 'select 2 as other', metadata: {} } as any,
    { id: 'b_sqlccc', type: 'sql', content: 'select 3 as third', metadata: {} } as any,
    { id: 'b_chartb', type: 'chart', metadata: { data: 'sales', spec: {}, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any,
  )
  return serializeNotebook(nb)
}

type Reply = string | ((p: any) => string | Promise<string>)
const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }
const gate = () => { let go: (v: string) => void = () => {}; const p = new Promise<string>((r) => { go = r }); return { p, go } }

async function boot(o: { replies?: Reply[]; dbType?: string; onMetadata?: (table: string) => void } = {}) {
  setLocale('en')
  document.body.innerHTML = ''
  drawerEditors.length = 0
  const replies = [...(o.replies ?? [])]
  const writes: string[] = []
  const outWrites: string[] = []
  const queries: string[] = []
  const metaCalls: string[] = []
  const genHandler = async (params: any) => {
    const r = replies.shift() ?? 'QUESTION: anything else?'
    const v = typeof r === 'function' ? await r(params) : r
    if (v === DECLINE) throw new Error('AI generation cancelled.')
    return v
  }
  const bridge: any = createFakeBridge({
    caps: { aiCompletion: true, aiCompletionStream: true },
    context: () => ({ ...CTX, dbType: o.dbType ?? CTX.dbType }),
    onContext: () => () => {},
    queryData: async (req: any) => {
      queries.push(req.sql)
      if (isCatalog(req.sql)) return { columns: [{ name: 'name', dataType: 'text' }], rows: TABLES.map((n) => [n]), truncated: false, elapsedMs: 1, dbType: 'postgres' }
      return { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [[CELL_PROBE, 1], ['b', 5]], truncated: false, elapsedMs: 1, dbType: 'postgres' }
    },
    getTableMetadata: async (req: any) => { metaCalls.push(req.table); o.onMetadata?.(req.table); return { columns: [{ name: COL(req.table), dataType: 'text', nullable: true }] } },
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: notebook(), mtimeMs: 1 }),
      'notebook/write': (p: any) => { writes.push(p.text); return { mtimeMs: 2 } },
      'notebook/writeOut': (p: any) => { outWrites.push(p.text); return {} },
      'notebook/deleteOut': () => ({}),
      'notebook/touchRecent': () => ({}),
    },
    requestHandlers: { 'host.ai.listModels': () => MODELS, [GEN]: genHandler, [GEN_ONCE]: genHandler, 'host.ai.cancelGeneration': () => ({ cancelled: true }) },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  const store = () => (w.vm as any).store
  const calls = () => bridge.calls as any[]
  const home = async () => {
    await w.find('[data-test=home]').trigger('click'); await flushPromises()
    const discard = w.findAll('button').find((b) => b.text() === t('dlg.discard'))
    if (discard) { await discard.trigger('click'); await flushPromises() }
  }
  const open = async () => { await w.find('.sp-path input').setValue(PATH); await w.find('[data-test=open-path]').trigger('click'); await flushPromises() }
  await home(); await open()
  const block = (id: string) => w.find(`[data-block-id=${id}]`)
  const runBlock = async (id = 'b_sqlaaa') => { await block(id).find('[data-test=run]').trigger('click'); await flushPromises(); await flushPromises() }
  const openSql = async (id = 'b_sqlaaa') => { await block(id).find('[data-test=ask-ai]').trigger('click'); await flushPromises() }
  const typeSend = async (text: string, wait = true) => {
    await w.find('[data-test=chat-input]').setValue(text)
    await w.find('[data-test=chat-send]').trigger('click')
    if (wait) await settle()
  }
  const pressEsc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flushPromises() }
  const draftEdit = async (text: string) => { const e = drawerEditors[drawerEditors.length - 1]; e.doc = text; e.opts.onChange(text); await flushPromises() }
  const setToggle = async (name: 'schema' | 'sql' | 'data', v: boolean) => {
    await home()
    await w.find(`[data-test=ai-send-${name}]`).setValue(v)
    await flushPromises()
    await open()
  }
  const content = (id = 'b_sqlaaa') => store().nb.value.blocks.find((b: any) => b.id === id)?.content as string
  const order = () => store().nb.value.blocks.map((b: any) => b.id) as string[]
  const chatSets = () => calls().filter((c) => c.method === 'storageSet' && String(c.args.key).startsWith('ai.chat.v1.'))
  const catalogSqls = () => queries.filter(isCatalog)
  const save = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })); await flushPromises(); await flushPromises() }
  const confirm = async () => { await w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises() }
  const dlg = (id: string) => w.find(`[data-test=cd-${id}]`)
  return { w, bridge, store, calls, queries, catalogSqls, metaCalls, writes, outWrites, home, open, block, runBlock, openSql, typeSend, pressEsc, draftEdit, setToggle, content, order, chatSets, save, confirm, dlg, flip: (p: Record<string, boolean>) => (w.vm as any).aiSettings.setSend(p) }
}
type S = Awaited<ReturnType<typeof boot>>
const chatText = (s: S) => s.w.find('[data-test=chat-pane]').text()
const savedText = (s: S) => JSON.stringify(s.chatSets().map((c) => c.args.value))
const allPrompts = (s: S) => genPrompts(s.bridge).join('\n=====\n')
const NEEDS = (...n: string[]) => `NEED_TABLES: ${n.join(', ')}`

beforeEach(() => setLocale('en'))

describe('AI database awareness: schema toggle', () => {
  it('schema OFF: zero catalog queries, zero getTableMetadata, zero NEED handling, no table names anywhere in any prompt (incl. history across a flip and a NEED reply)', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_USERS'), fence('sql', 'select 1 from sales') + '\nWhy: PROBE_TBL_USERS holds the users', 'NEED_LIST:', 'NEED_TABLES: PROBE_TBL_ORDERS'] })
    // positive control: with schema ON the very same flow queries the catalog, reads structures and sends names
    await s.openSql()
    await s.typeSend('which tables count users?')
    expect(s.catalogSqls().length).toBeGreaterThan(0)
    expect(s.metaCalls).toEqual(expect.arrayContaining(['PROBE_TBL_USERS']))
    expect(genRequests(s.bridge).length).toBe(2)
    expect(allPrompts(s)).toContain('PROBE_TBL_ORDERS')
    expect(savedText(s)).toContain('PROBE_TBL_USERS')
    await s.pressEsc()
    const sqlBefore = s.catalogSqls().length
    const metaBefore = s.metaCalls.length
    const genBefore = genRequests(s.bridge).length

    await s.setToggle('schema', false)
    await s.openSql()
    await s.typeSend('and again please')
    await s.typeSend('one more please')
    // the NEED replies were NOT followed up: exactly one request per message
    expect(genRequests(s.bridge).length).toBe(genBefore + 2)
    expect(s.catalogSqls().length).toBe(sqlBefore)
    expect(s.metaCalls.length).toBe(metaBefore)
    const offPrompts = genPrompts(s.bridge).slice(genBefore)
    expect(offPrompts.length).toBe(2)
    for (const p of offPrompts) {
      for (const tn of TABLES) expect(p, tn).not.toContain(tn)
      expect(p).not.toContain('PROBE_COL_')
      expect(p).not.toContain('[TABLE LIST]')
      expect(p).not.toContain('NEED_TABLES')
    }
    expect(offPrompts[0]).toContain('and again please')
  })

  it('schema ON: "which tables count users?" → list query → NEED_TABLES → structure → final SQL uses a real table name; draft updated; notices shown', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_USERS'), fence('sql', 'select count(*) from PROBE_TBL_USERS')] })
    await s.openSql()
    await s.typeSend('which tables count users?')
    const prompts = genPrompts(s.bridge)
    expect(prompts.length).toBe(2)
    expect(prompts[0]).toContain('[TABLE LIST]')
    for (const tn of TABLES) expect(prompts[0], tn).toContain(tn)
    expect(prompts[0]).toContain(COL('sales'))
    expect(prompts[0]).not.toContain(COL('PROBE_TBL_USERS'))
    expect(prompts[0]).toContain('NEED_TABLES')
    expect(prompts[1]).toContain(COL('PROBE_TBL_USERS'))
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe('select count(*) from PROBE_TBL_USERS')
    const notices = s.w.findAll('[data-test=chat-notice]').map((n) => n.text()).join('|')
    expect(notices).toMatch(/table list|PROBE_TBL_USERS/i)
    expect(s.catalogSqls().length).toBe(1)
    expect(s.store().history.undoDepth.value).toBe(0)
  })
})

describe('NEED chain', () => {
  it('multi-round chain ends at the 3-round limit: 3 automatic follow-ups, the 4th NEED → limit error, nothing saved', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), NEEDS('PROBE_TBL_B'), NEEDS('PROBE_TBL_C'), NEEDS('PROBE_TBL_D'), fence('sql', 'select 99')] })
    await s.openSql()
    await s.typeSend('explore')
    expect(genRequests(s.bridge).length).toBe(4)
    expect(s.w.find('[data-test=chat-error]').text()).toContain(t('ai.catalog.limit'))
    expect(s.metaCalls).not.toContain('PROBE_TBL_D')
    expect(s.content()).toContain('select region')
    expect(drawerEditors[drawerEditors.length - 1].doc).not.toContain('select 99')
    expect(savedText(s)).not.toContain('assistant')
    expect(savedText(s)).not.toContain('PROBE_TBL_C')
  })

  it('repeated names → one final answer-now round (no fetch, no NEED note)', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), NEEDS('PROBE_TBL_A'), fence('sql', 'select 7 from PROBE_TBL_A')] })
    await s.openSql()
    await s.typeSend('explore')
    expect(genRequests(s.bridge).length).toBe(3)
    expect(s.metaCalls.filter((n) => n === 'PROBE_TBL_A').length).toBe(1)
    expect(genPrompts(s.bridge)[2]).not.toContain('NEED_TABLES')
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe('select 7 from PROBE_TBL_A')
  })

  it('schema flipped off INSIDE a structure fetch → no further request, no structures sent, nothing saved', async () => {
    let flipped = false
    const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), fence('sql', 'select 5')], onMetadata: (tn) => { if (tn === 'PROBE_TBL_A' && !flipped) { flipped = true; void (globalThis as any).__flip?.() } } })
    ;(globalThis as any).__flip = () => s.flip({ schema: false })
    await s.openSql()
    await s.typeSend('explore')
    delete (globalThis as any).__flip
    expect(flipped).toBe(true)
    expect(genRequests(s.bridge).length).toBe(1)
    expect(allPrompts(s)).not.toContain(COL('PROBE_TBL_A'))
    expect(s.w.find('[data-test=chat-notice], [data-test=chat-error]').exists()).toBe(true)
    expect(savedText(s)).not.toContain('PROBE_TBL_A')
    expect(drawerEditors[drawerEditors.length - 1].doc).not.toContain('select 5')
  })

  it('data and sql flipped off mid-chain → later prompts drop the cell values and the block SQL', async () => {
    let flipped = false
    const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), fence('sql', 'select 5')], onMetadata: (tn) => { if (tn === 'PROBE_TBL_A' && !flipped) { flipped = true; void (globalThis as any).__flip?.() } } })
    ;(globalThis as any).__flip = () => s.flip({ data: false, sql: false })
    await s.runBlock()
    await s.openSql()
    await s.typeSend('explore')
    delete (globalThis as any).__flip
    const prompts = genPrompts(s.bridge)
    expect(prompts[0]).toContain(CELL_PROBE)
    expect(prompts[0]).toContain(SQL_PROBE)
    expect(prompts.length).toBe(2)
    expect(prompts[1]).not.toContain(CELL_PROBE)
    expect(prompts[1]).not.toContain(SQL_PROBE)
    expect(prompts[1]).toContain(COL('PROBE_TBL_A'))
  })

  describe('stopping mid-chain sends nothing further and saves nothing', () => {
    const start = async (how: string) => {
      const g = gate()
      const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), () => g.p, NEEDS('PROBE_TBL_B'), fence('sql', 'select 1')] })
      await s.openSql()
      await s.typeSend('explore', false)
      await settle()
      // positive control: round 2 is really in flight
      expect(genRequests(s.bridge).length).toBe(2)
      void how
      return { s, g }
    }
    const finish = async (s: S, g: ReturnType<typeof gate>) => {
      g.go(NEEDS('PROBE_TBL_B'))
      await settle()
      expect(genRequests(s.bridge).length).toBe(2)
      expect(s.metaCalls).not.toContain('PROBE_TBL_B')
      expect(savedText(s)).not.toContain('"assistant"')
      expect(s.store().history.undoDepth.value).toBe(0)
    }
    it('Cancel button', async () => {
      const { s, g } = await start('cancel')
      await s.w.find('[data-test=chat-cancel]').trigger('click'); await flushPromises()
      await finish(s, g)
    })
    it('Esc (draft unchanged → closes the drawer)', async () => {
      const { s, g } = await start('esc')
      await s.pressEsc()
      expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
      await finish(s, g)
    })
    it('close button', async () => {
      const { s, g } = await start('close')
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
      await finish(s, g)
    })
    it('consent declined in DBX', async () => {
      const s = await boot({ replies: [NEEDS('PROBE_TBL_A'), DECLINE, fence('sql', 'select 1')] })
      await s.openSql()
      await s.typeSend('explore')
      expect(genRequests(s.bridge).length).toBe(2)
      await settle()
      expect(genRequests(s.bridge).length).toBe(2)
      expect(s.w.find('[data-test=chat-error]').exists()).toBe(true)
      expect(savedText(s)).not.toContain('"assistant"')
      expect(drawerEditors[drawerEditors.length - 1].doc).not.toContain('select 1')
    })
  })
})

describe('close dialog and diff', () => {
  it('SQL diff is collapsed by default and opens on demand', async () => {
    const s = await boot()
    await s.openSql()
    await s.draftEdit('select 42')
    expect(s.w.find('[data-test=diff-view]').exists()).toBe(false)
    await s.w.find('[data-test=sql-diff-toggle]').trigger('click')
    expect(s.w.find('[data-test=diff-view]').exists()).toBe(true)
  })

  it('changed draft → four buttons; each button’s effect', async () => {
    const s = await boot()
    const original = s.content()
    const before = serializeNotebook(s.store().nb.value)
    // no dialog when the draft equals the block
    await s.openSql()
    await s.pressEsc()
    expect(s.w.find('[data-test=cd-update]').exists()).toBe(false)
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)

    await s.openSql()
    await s.draftEdit('select 42 -- DRAFT')
    await s.pressEsc()
    expect(['update', 'insertNew', 'skip', 'cancel'].map((id) => s.dlg(id).text())).toEqual(['Update SQL block', 'Insert as new block', 'Not now', 'Cancel'])

    // Cancel keeps the drawer and the draft
    await s.dlg('cancel').trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(true)
    expect(s.dlg('update').exists()).toBe(false)
    expect(drawerEditors[drawerEditors.length - 1].doc).toBe('select 42 -- DRAFT')
    expect(serializeNotebook(s.store().nb.value)).toBe(before)

    // Not now closes with the notebook byte-identical
    await s.pressEsc()
    await s.dlg('skip').trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    expect(serializeNotebook(s.store().nb.value)).toBe(before)
    expect(s.store().history.undoDepth.value).toBe(0)

    // Insert as new block lands below the block, original untouched
    await s.openSql()
    await s.draftEdit('select 43 -- NEW')
    await s.pressEsc()
    await s.dlg('insertNew').trigger('click'); await flushPromises(); await flushPromises()
    expect(s.order().slice(0, 2)).toEqual(['b_sqlaaa', expect.any(String)])
    expect(s.order().length).toBe(5)
    expect(s.content()).toBe(original)
    expect(s.store().nb.value.blocks[1].content).toBe('select 43 -- NEW')
    expect(s.store().history.undoDepth.value).toBe(1)

    // Update SQL block: one more history entry + AppliedBar outcome
    await s.openSql()
    await s.draftEdit('select 44 -- UPD')
    await s.pressEsc()
    await s.dlg('update').trigger('click'); await flushPromises(); await flushPromises()
    expect(s.content()).toBe('select 44 -- UPD')
    expect(s.store().history.undoDepth.value).toBe(2)
    expect(s.w.find('[data-test=ai-drawer]').exists()).toBe(false)
    expect(s.w.find('[data-test=ai-applied-bar]').exists()).toBe(true)
    await settle()
    expect(s.w.find('[data-test=ai-outcome]').exists()).toBe(true)
  })
})

describe('interpretation drawer', () => {
  const openInterpret = async (s: S, id = 'b_sqlbbb') => { await s.block(id).find('[data-test=ai-interpret]').trigger('click'); await settle() }
  const preview = (s: S) => s.w.find('[data-test=interpret-preview]').text()

  it('auto-generates once on first open; zero on a cached open; ANSWER keeps, UPDATE replaces; Insert lands below the opened middle block', async () => {
    const s = await boot({ replies: ['## First', 'ANSWER: the max is 5', 'plain unmarked text', 'UPDATE: ## Second'] })
    await s.runBlock('b_sqlbbb')
    await openInterpret(s)
    expect(genRequests(s.bridge).length).toBe(1)
    expect(preview(s)).toContain('First')

    await s.typeSend('what is the max?')
    expect(preview(s)).toContain('First')
    expect(chatText(s)).toContain('the max is 5')
    await s.typeSend('hmm')
    expect(preview(s)).toContain('First')
    await s.typeSend('rewrite it')
    expect(preview(s)).toContain('Second')
    expect(genRequests(s.bridge).length).toBe(4)

    expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)

    // another block moves while the drawer is open: the insert still lands directly below the opened block
    s.store().moveBlock('b_sqlccc', -1)
    await flushPromises()
    expect(s.order()).toEqual(['b_sqlaaa', 'b_sqlccc', 'b_sqlbbb', 'b_chartb'])
    await s.confirm()
    const o = s.order()
    expect(o[o.indexOf('b_sqlbbb') + 1]).not.toBe('b_chartb')
    expect(s.store().nb.value.blocks[o.indexOf('b_sqlbbb') + 1].type).toBe('markdown')
    expect(o.length).toBe(5)
    expect(s.store().history.undoDepth.value).toBe(2) // the move is its own step now

    // reopen: cached, zero additional requests
    const n = genRequests(s.bridge).length
    await openInterpret(s)
    expect(genRequests(s.bridge).length).toBe(n)
    expect(preview(s)).toContain('Second')
  })

  it('anchor deleted → Insert disabled with a reason; data off → zero requests', async () => {
    const s = await boot({ replies: ['## First'] })
    await s.runBlock('b_sqlbbb')
    await openInterpret(s)
    expect(genRequests(s.bridge).length).toBe(1)
    s.store().removeBlock('b_sqlbbb')
    await flushPromises()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toBe(t('drawer.interpret.deleted'))
    const len = s.order().length
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    expect(s.order().length).toBe(len)

    const d = await boot()
    await d.setToggle('data', false)
    await d.runBlock('b_sqlbbb')
    await d.block('b_sqlbbb').find('[data-test=ai-interpret]').trigger('click'); await settle()
    expect(d.w.find('[data-test=interpret-drawer]').exists()).toBe(false)
    expect(genRequests(d.bridge).length).toBe(0)
    expect(hostAiCalls(d.bridge).filter((c) => /generate/i.test(c.args.method))).toEqual([])
  })
})

describe('chart drawer', () => {
  const titles = (s: S) => s.w.findAll('[data-test=scheme-card]').map((c) => c.find('.tn').text())
  const selectedIdx = (s: S) => s.w.findAll('[data-test=scheme-card]').findIndex((c) => c.attributes('aria-checked') === 'true')
  const openChart = async (s: S) => { await s.runBlock(); await s.block('b_chartb').find('[data-test=ask-ai]').trigger('click'); await flushPromises() }

  it('always candidates as summary cards without thumbnails; one config replaces the selected scheme; a set replaces all', async () => {
    const s = await boot({ replies: [schemes(), one('Replaced2', 'area'), schemes().replace(/Scheme/g, 'Fresh')] })
    await openChart(s)
    await s.w.find('[data-test=chart-generate]').trigger('click'); await settle()
    const cards = s.w.findAll('[data-test=scheme-card]')
    expect(cards.length).toBe(3)
    for (const c of cards) expect(c.find('svg, img, canvas').exists()).toBe(false)
    await cards[1].trigger('click'); await flushPromises()
    await s.typeSend('make it an area chart')
    expect(titles(s)[0]).toContain('SchemeA')
    expect(titles(s)[1]).toContain('Replaced2')
    expect(titles(s)[2]).toContain('SchemeC')
    expect(genPrompts(s.bridge)[1]).toContain('SELECTED SCHEME 2')
    await s.typeSend('give me other options')
    expect(titles(s).every((x) => x.includes('Fresh'))).toBe(true)
  })

  it('the selection is not yanked by a late single-config reply', async () => {
    const g = gate()
    const s = await boot({ replies: [schemes(), () => g.p] })
    await openChart(s)
    await s.w.find('[data-test=chart-generate]').trigger('click'); await settle()
    const cards = () => s.w.findAll('[data-test=scheme-card]')
    await cards()[1].trigger('click'); await flushPromises()
    await s.typeSend('make it an area chart', false)
    await settle()
    expect(genRequests(s.bridge).length).toBe(2)
    await cards()[2].trigger('click'); await flushPromises()
    g.go(one('LateTwo', 'area'))
    await settle()
    expect(titles(s)[1]).toContain('LateTwo')
    expect(selectedIdx(s)).toBe(2)
  })

  it('data off: refusal with zero requests on both generation channels (positive control: re-enabled generates)', async () => {
    const s = await boot({ replies: [schemes()] })
    await s.setToggle('data', false)
    await s.runBlock()
    const btn = s.block('b_chartb').find('[data-test=ask-ai]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=chart-drawer]').exists()).toBe(false)
    expect(genRequests(s.bridge).length).toBe(0)
    await s.setToggle('data', true)
    await openChart(s)
    await s.w.find('[data-test=chart-generate]').trigger('click'); await settle()
    expect(genRequests(s.bridge).length).toBe(1)
  })
})

describe('privacy and contract', () => {
  it('serialized notebook (.sqlnb and .sqlnb.out) contains no catalog data, table lists, chat, prompts, summaries or notices', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_USERS'), fence('sql', 'select 3'), '## PROBE_INTERPRET_BODY', 'ANSWER: PROBE_ANSWER_TEXT', schemes(), one('PROBE_REPLACED', 'area')] })
    await s.runBlock()
    await s.runBlock('b_sqlbbb')
    await s.openSql()
    await s.typeSend('PROBE_USER_ASK which tables count users?')
    await s.pressEsc()
    await s.dlg('skip').trigger('click'); await flushPromises()
    await s.block('b_sqlbbb').find('[data-test=ai-interpret]').trigger('click'); await settle()
    await s.typeSend('PROBE_FOLLOWUP')
    await s.pressEsc()
    await s.block('b_chartb').find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    await s.w.find('[data-test=chart-generate]').trigger('click'); await settle()
    await s.typeSend('PROBE_CHART_CHAT')
    await s.pressEsc()
    // positive control: all of that really reached the AI and the chat cache
    expect(genRequests(s.bridge).length).toBe(6)
    expect(savedText(s)).toContain('PROBE_USER_ASK')
    await s.save()
    expect(s.writes.length).toBe(1)
    const texts = [serializeNotebook(s.store().nb.value), s.store().toText(), s.writes[0], ...s.outWrites]
    const bad = [...TABLES, 'PROBE_COL_', 'PROBE_USER_ASK', 'PROBE_INTERPRET_BODY', 'PROBE_ANSWER_TEXT', 'PROBE_FOLLOWUP', 'PROBE_CHART_CHAT', 'PROBE_REPLACED', 'NEED_TABLES', 'NEED_LIST', 'ANSWER:', 'UPDATE:', '[TABLE LIST]', 'ai.chat', 'SELECTED SCHEME', 'Read the table list', 'Read table structure', 'catalog']
    for (const txt of texts) for (const b of bad) expect(txt, b).not.toContain(b)
  })

  it('FakeBridge rejects invoke("host.*"); every catalog/AI call went through request/queryData', async () => {
    const s = await boot({ replies: [NEEDS('PROBE_TBL_USERS'), fence('sql', 'select 1')] })
    await s.openSql()
    await s.typeSend('which tables?')
    await expect(s.bridge.invoke('host.ai.generateText', {})).rejects.toBeTruthy()
    const hostCalls = s.calls().filter((c) => /^host\./.test(String(c.args?.method ?? '')))
    expect(hostCalls.length).toBeGreaterThan(0)
    expect(hostCalls.filter((c) => c.method === 'invoke' && c.args.method !== 'host.ai.generateText')).toEqual([])
    expect(hostCalls.filter((c) => c.method === 'request' && /^host\.ai\.generateText/.test(c.args.method)).length).toBe(2)
    expect(s.catalogSqls().length).toBeGreaterThan(0)
  })

  it('manifest permissions are exactly the six and engines.dbx is >=0.6.48', () => {
    expect(manifest.permissions).toEqual(['host.data:read', 'host.schema:read', 'host.ai', 'host.storage', 'host.workbench', 'host.connections:read'])
    expect((manifest as any).engines.dbx).toBe('>=0.6.48')
  })
})
