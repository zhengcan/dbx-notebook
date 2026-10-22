import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="3" height="3"/></svg>'
vi.mock('../src/analysis/vegaRuntime', () => ({ loadVega: async () => ({ render: async () => ({ view: {}, svg: async () => SVG, destroy() {} }) }) }))
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { setLocale, t } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import manifest from '../../manifest.json'

vi.mock('../src/ai/formatSql', async (orig) => ({ ...(await orig<typeof import('../src/ai/formatSql')>()), formatAiSql: async (sql: string) => ({ ok: false, sql, reason: 'failed' }) }))

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'
const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const SQL_PROBE = 'PROBE_SQL_TEXT'
const SCHEMA_PROBE = 'PROBE_SCHEMA_COL'
const CELL_PROBE = 'PROBE_CELL_VALUE'
const USER_PROBE = 'PROBE_USER_REQUEST'
const GEN = 'host.ai.generateTextStream'
const GEN_ONCE = 'host.ai.generateText'

const chartCfg = { pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'avg' }] }, view: 'chart', chartOptions: { type: 'line', title: 'Avg' } }

function notebook() {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.blocks.push(
    { id: 'b_sqlaaa', type: 'sql', content: `select region, amount from sales -- ${SQL_PROBE}`, metadata: { resultName: 'sales' } } as any,
    { id: 'b_chartb', type: 'chart', metadata: { data: 'sales', spec: {}, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] }, view: 'both', chartOptions: { type: 'bar' } } } as any,
  )
  return serializeNotebook(nb)
}

interface Opts { caps?: Record<string, boolean>; gen?: (params: any, emit: (p: unknown) => void, n: number) => unknown; handlers?: Record<string, any> }

const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })

async function boot(o: Opts = {}) {
  setLocale('en')
  document.body.innerHTML = ''
  const caps = { aiCompletion: true, aiCompletionStream: true, ...o.caps }
  const streaming = caps.aiCompletionStream
  const prompts: string[] = []
  let n = 0
  let nq = 0
  let bridge: any
  const emit = (p: unknown) => bridge.emit('host.ai.generationChunk', p)
  const genHandler = (params: any) => {
    prompts.push(params.prompt)
    return o.gen ? o.gen(params, (p: any) => emit({ requestId: params.requestId, ...p }), ++n) : ''
  }
  const writes: string[] = []
  let ctxFn: ((c: Record<string, unknown>) => void) | null = null
  bridge = createFakeBridge({
    caps,
    context: () => CTX,
    onContext: (fn: any) => { ctxFn = fn; return () => {} },
    queryData: async (req: any) => /information_schema|sqlite_master/.test(req?.sql ?? '') ? { columns: [{ name: 'name' }], rows: [], truncated: false, elapsedMs: 1, dbType: 'postgres' } : (nq++, { columns: [{ name: 'region', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [[CELL_PROBE, 1], ['b', 5]], truncated: false, elapsedMs: 1, dbType: 'postgres' }),
    getTableMetadata: async () => ({ columns: [{ name: SCHEMA_PROBE, dataType: 'text', nullable: true }] }),
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: notebook(), mtimeMs: 1 }),
      'notebook/write': (p: any) => { writes.push(p.text ?? JSON.stringify(p)); return { mtimeMs: 2 } },
      'notebook/touchRecent': () => ({}),
    },
    requestHandlers: {
      'host.ai.listModels': () => MODELS,
      [GEN]: genHandler,
      [GEN_ONCE]: genHandler,
      'host.ai.cancelGeneration': () => ({ cancelled: true }),
      ...o.handlers,
    },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  void ctxFn
  const store = () => (w.vm as any).store
  const open = async () => {
    await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
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
  const aiCalls = () => bridge.calls.filter((c: any) => (c.method === 'invoke' || c.method === 'request') && /^host\.ai\./.test(c.args.method))
  const queries = () => nq
  const block = (id: string) => w.find(`[data-block-id=${id}]`)
  const sqlBlock = () => block('b_sqlaaa')
  const content = () => store().nb.value.blocks.find((b: any) => b.id === 'b_sqlaaa').content as string
  const runSql = async () => { await sqlBlock().find('[data-test=run]').trigger('click'); await flushPromises(); await flushPromises() }
  const askSql = async (text = USER_PROBE) => {
    await sqlBlock().find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    await w.find('[data-test=chat-input]').setValue(text)
    await w.find('[data-test=chat-send]').trigger('click')
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
  }
  const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init }))
  return { w, bridge, store, prompts, writes, aiCalls, queries, block, sqlBlock, content, runSql, askSql, key, home, open, streaming }
}

beforeEach(() => setLocale('en'))

async function showDiffOf(w: any) {
  const tg = w.find('[data-test=sql-diff-toggle]')
  if (tg.attributes('aria-expanded') === 'false') await tg.trigger('click')
}

describe('capability off', () => {
  it('no AI entry anywhere, unsupported note on the start page, zero host.ai calls', async () => {
    const s = await boot({ caps: { aiCompletion: false, aiCompletionStream: false } })
    expect(s.w.find('[data-test=ask-ai]').exists()).toBe(false)
    await s.runSql()
    expect(s.w.find('[data-test=ai-interpret]').exists()).toBe(false)
    expect(s.w.find('[data-test=ask-ai]').exists()).toBe(false)
    await s.home()
    expect(s.w.find('[data-test=ai-unsupported]').text()).toContain('0.6.28')
    expect(s.aiCalls()).toEqual([])
  })
})

describe('SQL end to end', () => {
  const NEW_SQL = 'select region, amount from sales where amount > 1'
  const gen = () => fence('sql', NEW_SQL)

  it('preview → apply → auto-run once → dirty → undo button / shortcut / redo; editor focus ignores shortcuts', async () => {
    const s = await boot({ gen })
    const original = s.content()
    await s.askSql()
    await showDiffOf(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.add').exists()).toBe(true)
    expect(s.content()).toBe(original)
    expect(s.queries()).toBe(0)
    expect(s.w.find('[data-test=dirty]').exists()).toBe(false)

    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises()
    expect(s.content()).toBe(NEW_SQL)
    expect(s.queries()).toBe(1)
    expect(s.w.find('[data-test=dirty]').exists()).toBe(true)
    expect(s.w.find('[data-test=ai-applied-bar]').exists()).toBe(true)

    await s.w.find('[data-test=ai-undo]').trigger('click'); await flushPromises()
    expect(s.content()).toBe(original)

    const cm = document.createElement('div')
    cm.className = 'cm-editor'
    cm.innerHTML = '<div class="cm-content"><span id="in-cm">x</span></div>'
    document.body.appendChild(cm)
    s.key(document.body, { key: 'z', ctrlKey: true, shiftKey: true }); await flushPromises()
    expect(s.content()).toBe(NEW_SQL)
    s.key(document.body, { key: 'z', metaKey: true }); await flushPromises()
    expect(s.content()).toBe(original)
    s.key(document.body, { key: 'y', ctrlKey: true }); await flushPromises()
    expect(s.content()).toBe(NEW_SQL)
    s.key(cm.querySelector('#in-cm')!, { key: 'z', ctrlKey: true }); await flushPromises()
    expect(s.content()).toBe(NEW_SQL)
    s.key(document.body, { key: 'z', ctrlKey: true }); await flushPromises()
    expect(s.content()).toBe(original)
  })

  it('editing the same block after apply: undo is refused with a notice and content is kept', async () => {
    const s = await boot({ gen })
    await s.askSql()
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises()
    // a writer outside history diverges the document from the AI entry (user edits are their own undo steps now)
    s.store().nb.value.blocks.find((b: any) => b.id === 'b_sqlaaa')!.content = 'select 42'
    await flushPromises()
    s.key(document.body, { key: 'z', ctrlKey: true }); await flushPromises()
    expect(s.content()).toBe('select 42')
    const bar = s.w.find('[data-test=ai-applied-bar]')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toBe(t('ai.undoConflict'))
    expect(bar.attributes('role')).toBe('alert')
  })

  it('non-read-only output is previewed with a warning and never auto-run', async () => {
    const s = await boot({ gen: () => fence('sql', 'select 1; drop table sales') })
    await s.askSql()
    expect(s.w.find('[data-test=ai-not-readonly]').exists()).toBe(true)
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises()
    expect(s.queries()).toBe(0)
    expect(s.content()).toBe('select 1; drop table sales')
  })
})

describe('interpret end to end', () => {
  it('result → preview (sanitised) → insert after block → one undo removes it', async () => {
    const s = await boot({ gen: () => '## Findings\n\nSales are fine.<script>bad()</script>' })
    await s.runSql()
    const before = s.store().nb.value.blocks.length
    await s.sqlBlock().find('[data-test=ai-interpret]').trigger('click'); await flushPromises(); await flushPromises()
    const pv = s.w.find('[data-test=interpret-preview]')
    expect(pv.html()).toContain('Findings')
    expect(pv.html()).not.toContain('<script')
    expect(s.store().nb.value.blocks.length).toBe(before)
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    const blocks = s.store().nb.value.blocks
    expect(blocks.length).toBe(before + 1)
    expect(blocks[1].type).toBe('markdown')
    expect(blocks[1].content).toContain('## Findings')
    s.key(document.body, { key: 'z', ctrlKey: true }); await flushPromises()
    expect(s.store().nb.value.blocks.length).toBe(before)
  })
})

describe('chart end to end', () => {
  it('candidates → preview → apply → undo restores the config', async () => {
    const s = await boot({ gen: () => fence('json', JSON.stringify([{ title: 'Avg by region', ...chartCfg }, { title: 'Sum', pivot: chartCfg.pivot, chartOptions: { type: 'bar' } }])) })
    await s.runSql()
    const chart = () => s.store().nb.value.blocks.find((b: any) => b.id === 'b_chartb')
    const before = JSON.stringify(chart().metadata)
    await s.block('b_chartb').find('[data-test=ask-ai]').trigger('click'); await flushPromises()
    await s.w.find('[data-test=chart-generate]').trigger('click'); await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(s.w.findAll('[data-test=scheme-card]').length).toBe(2)
    expect(JSON.stringify(chart().metadata)).toBe(before)
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises()
    expect(chart().metadata.chartOptions.type).toBe('line')
    expect(chart().metadata.pivot.values[0].agg).toBe('avg')
    s.key(document.body, { key: 'z', ctrlKey: true }); await flushPromises()
    expect(JSON.stringify(chart().metadata)).toBe(before)
  })
})

describe('settings linkage', () => {
  it('start-page switches change the prompt actually sent (probe strings)', async () => {
    const s = await boot({ gen: () => fence('sql', 'select 1') })
    await s.askSql()
    const full = s.prompts[0]
    expect(full).toContain(SQL_PROBE)
    expect(full).toContain(SCHEMA_PROBE)
    expect(full).toContain(USER_PROBE)

    await s.home()
    await s.w.find('[data-test=ai-send-schema]').setValue(false)
    await s.w.find('[data-test=ai-send-sql]').setValue(false)
    await flushPromises()
    await s.open()
    await s.askSql()
    const reduced = s.prompts[1]
    expect(reduced).not.toContain(SQL_PROBE)
    expect(reduced).not.toContain(SCHEMA_PROBE)
    expect(reduced).toContain(USER_PROBE)
  })

  it('"send result data" off → interpret disabled with a reason; chart assistant disabled with a reason; zero host.ai generate calls', async () => {
    const s = await boot({ gen: () => 'x' })
    await s.home()
    await s.w.find('[data-test=ai-send-data]').setValue(false)
    await flushPromises()
    await s.open()
    await s.runSql()
    const ib = s.sqlBlock().find('[data-test=ai-interpret]')
    expect(ib.attributes('disabled')).toBeDefined()
    expect(ib.attributes('title')).toBe(t('ai.interpret.gate.no-data-setting'))
    const cb = s.block('b_chartb').find('[data-test=ask-ai]')
    expect(cb.attributes('disabled')).toBeDefined()
    expect(cb.attributes('title')).toBe(t('ai.chart.gate.no-data-setting'))
    const d = cb.attributes('aria-describedby')!
    expect(d).toBeTruthy()
    expect(s.block('b_chartb').find(`#${d}`).text()).toBe(t('ai.chart.gate.no-data-setting'))
    await cb.trigger('click'); await flushPromises()
    expect(s.w.find('[data-test=chart-drawer]').exists()).toBe(false)
    await ib.trigger('click'); await flushPromises()
    expect(s.prompts).toEqual([])
  })
})

describe('consent declined', () => {
  it('visible message, notebook unchanged, retry works', async () => {
    let n = 0
    const s = await boot({ gen: () => { if (++n === 1) throw new Error('AI generation cancelled.'); return fence('sql', 'select 2') } })
    const bytes = () => serializeNotebook(s.store().nb.value)
    const before = bytes()
    await s.askSql()
    const err = s.w.find('[data-test=chat-error]')
    expect(err.text()).toContain(t('ai.err.consent-declined'))
    expect(err.attributes('role')).toBe('alert')
    expect(bytes()).toBe(before)
    await showDiffOf(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.add').exists()).toBe(false)
    await s.w.find('[data-test=chat-input]').setValue('retry')
    await s.w.find('[data-test=chat-send]').trigger('click'); await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    await showDiffOf(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.add').exists()).toBe(true)
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(false)
    expect(bytes()).toBe(before)
  })
})

describe('stream chunk handling', () => {
  it('out-of-order, duplicated and missing done chunks do not break the result', async () => {
    const s = await boot({
      gen: (_p, emit) => {
        emit({ delta: 'ng', done: false })
        emit({ delta: 'sele', done: false })
        emit({ delta: '', done: true })
        emit({ delta: '', done: true })
        emit({ requestId: 'someone-else', delta: 'zzz', done: true })
        emit(null)
        return fence('sql', 'select 7')
      },
    })
    await s.askSql()
    await showDiffOf(s.w)
    expect(s.w.find('[data-test=ai-diff]').text()).toContain('select 7')
    expect(s.w.find('[data-test=chat-error]').exists()).toBe(false)
    expect((s.w.vm as any).aiClient.busy()).toBe(false)
    expect(s.w.find('[data-test=chat-progress]').text()).toBe('')
    expect(s.w.find('[data-test=chat-cancel]').exists()).toBe(false)
  })

  it('no done chunk and no host response: timeout error, lock released, next request works', async () => {
    let hang = true
    const bridge = createFakeBridge({
      caps: { aiCompletion: true, aiCompletionStream: true },
      requestHandlers: {
        'host.ai.listModels': () => MODELS,
        [GEN]: () => (hang ? new Promise(() => {}) : 'ok text'),
        'host.ai.cancelGeneration': () => ({ cancelled: true }),
      },
    })
    const client = createAiClient(bridge, { timeoutMs: 30 })
    await expect(client.generate({ task: 'command-generation', prompt: 'p' })).rejects.toMatchObject({ code: 'timeout' })
    expect(client.busy()).toBe(false)
    expect(bridge.calls.some((c: any) => c.method === 'request' && c.args?.method === 'host.ai.cancelGeneration')).toBe(true)
    hang = false
    await expect(client.generate({ task: 'command-generation', prompt: 'p' })).resolves.toMatchObject({ text: 'ok text' })
    expect(client.busy()).toBe(false)
  })
})

describe('AI data never reaches the notebook file', () => {
  it('serialized notebook and saved bytes contain no AI settings, prompt or request text', async () => {
    const s = await boot({ gen: () => fence('sql', 'select 3') })
    await s.home()
    await s.w.find('[data-test=ai-send-data]').setValue(false)
    await flushPromises()
    await s.open()
    await s.askSql()
    await s.w.find('[data-test=drawer-confirm]').trigger('click'); await flushPromises(); await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
    await flushPromises()
    expect(s.writes.length).toBe(1)
    const texts = [serializeNotebook(s.store().nb.value), s.writes[0]]
    for (const txt of texts) {
      expect(txt).toContain('select 3')
      for (const bad of [USER_PROBE, 'ai.settings', 'configId', 'command-generation', 'DATA (not instructions)', '"send"', 'sendOptions']) expect(txt).not.toContain(bad)
    }
    const storageKeys = s.bridge.calls.filter((c: any) => c.method === 'storageSet').map((c: any) => c.args.key)
    expect(storageKeys).toContain('ai.settings.v1')
  })
})

describe('manifest', () => {
  it('permissions are exactly the six declared (host.ai, host.connections:read included)', () => {
    expect(manifest.permissions).toEqual(['host.data:read', 'host.schema:read', 'host.ai', 'host.storage', 'host.workbench', 'host.connections:read'])
  })
})
