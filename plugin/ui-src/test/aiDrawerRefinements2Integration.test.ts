import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'

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
import { genRequests, genPrompts } from './aiRequests'

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'
const CTX = { id: 'c1', name: 'main', dbType: 'postgres', database: 'db1' }
const MODELS = [{ configId: 'cfg', name: 'Cfg', model: 'm1', isDefault: true }]
const PATH = '/tmp/a.sqlnb'
const GEN = 'host.ai.generateTextStream'
const GEN_ONCE = 'host.ai.generateText'
const TABLES = ['PROBE_TBL_ORDERS', 'PROBE_TBL_ITEMS']
const isCatalog = (sql: string) => /information_schema|sqlite_master/.test(sql)

function notebook() {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = 'main'
  nb.blocks.push(
    { id: 'b_sqlaaa', type: 'sql', content: 'select 1', metadata: { schema: 'sales' } } as any,
    { id: 'b_sqlbbb', type: 'sql', content: 'select 2 as other', metadata: {} } as any,
  )
  return serializeNotebook(nb)
}

const mounted: { unmount(): void }[] = []
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = '' })
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

async function boot(replies: string[], schema = true) {
  setLocale('en')
  document.body.innerHTML = ''
  drawerEditors.length = 0
  const queries: string[] = []
  const metaCalls: string[] = []
  const genHandler = async () => replies.shift() ?? 'QUESTION: anything else?'
  const bridge: any = createFakeBridge({
    caps: { aiCompletion: true, aiCompletionStream: true },
    context: () => CTX,
    onContext: () => () => {},
    queryData: async (req: any) => {
      queries.push(req.sql)
      if (isCatalog(req.sql)) return { columns: [{ name: 'name', dataType: 'text' }], rows: TABLES.map((n) => [n]), truncated: false, elapsedMs: 1, dbType: 'postgres' }
      return { columns: [{ name: 'a', dataType: 'integer' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' }
    },
    getTableMetadata: async (req: any) => { metaCalls.push(req.table); return { columns: [{ name: `PROBE_COL_${req.table}`, dataType: 'text', nullable: true }] } },
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: notebook(), mtimeMs: 1 }),
      'notebook/write': () => ({ mtimeMs: 2 }),
      'notebook/writeOut': () => ({}),
      'notebook/deleteOut': () => ({}),
      'notebook/touchRecent': () => ({}),
    },
    requestHandlers: { 'host.ai.listModels': () => MODELS, [GEN]: genHandler, [GEN_ONCE]: genHandler, 'host.ai.cancelGeneration': () => ({ cancelled: true }) },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  const home = async () => {
    await w.find('[data-test=home]').trigger('click'); await flushPromises()
    const discard = w.findAll('button').find((b) => b.text() === t('dlg.discard'))
    if (discard) { await discard.trigger('click'); await flushPromises() }
  }
  const open = async () => { await w.find('.sp-path input').setValue(PATH); await w.find('[data-test=open-path]').trigger('click'); await flushPromises() }
  await home()
  if (!schema) {
    ;(w.vm as any).aiSettings.setSend({ schema: false })
    await flushPromises()
  }
  await open()
  const openSql = async () => { await w.find('[data-block-id=b_sqlaaa] [data-test=ask-ai]').trigger('click'); await flushPromises() }
  const typeSend = async (text: string) => {
    await w.find('[data-test=chat-input]').setValue(text)
    await w.find('[data-test=chat-send]').trigger('click')
    await settle()
  }
  return { w, bridge, queries, metaCalls, catalogSqls: () => queries.filter(isCatalog), openSql, typeSend }
}

beforeEach(() => setLocale('en'))

const RAW = "select o.id,o.total from orders o where o.day = {{ d }} and o.kind='x' order by o.id"

describe('drawer refinements 2: cross-feature flow', () => {
  it('non-public schema list → AI SQL formatted (real formatter) and highlighted → markdown reply rendered safely', async () => {
    const s = await boot([fence('sql', RAW), '**bold** and <img src=x onerror="window.__x=1"> [bad](javascript:alert(1))'])
    await s.openSql()
    await s.typeSend('orders per day')
    // exactly one catalog query, scoped to the block schema
    expect(s.catalogSqls().length).toBe(1)
    expect(s.catalogSqls()[0]).toContain("table_schema = 'sales'")
    expect(genPrompts(s.bridge)[0]).toContain('PROBE_TBL_ORDERS')

    // formatted draft, placeholder intact
    await vi.waitFor(() => expect(drawerEditors[drawerEditors.length - 1].doc).toContain('\n'), { timeout: 3000 })
    const doc = drawerEditors[drawerEditors.length - 1].doc
    expect(doc).toContain('{{ d }}')
    expect(doc).toMatch(/SELECT/)
    expect(doc).not.toBe(RAW)

    // highlighted diff
    await s.w.find('[data-test=sql-diff-toggle]').trigger('click')
    expect(s.w.find('[data-test=ai-diff] .sql-keyword').exists()).toBe(true)

    // markdown reply: rendered, inert
    await s.typeSend('explain')
    const md = s.w.findAll('[data-test=chat-md]').pop()!.element as HTMLElement
    expect(md.querySelector('strong')?.textContent).toBe('bold')
    expect(md.querySelector('img,script,[onerror]')).toBeNull()
    expect(md.querySelector('a[href^="javascript"]')).toBeNull()
    expect(md.textContent).toContain('<img src=x')
    expect((window as any).__x).toBeUndefined()
  })

  it('schema OFF: no catalog query, no table metadata, no table names in any prompt (positive control: ON sends them)', async () => {
    const on = await boot([fence('sql', 'select 1 from orders')])
    await on.openSql()
    await on.typeSend('go')
    expect(on.catalogSqls().length).toBe(1)
    expect(genPrompts(on.bridge).join('\n')).toContain('PROBE_TBL_ORDERS')

    const off = await boot([fence('sql', 'select 1 from orders'), 'NEED_TABLES: PROBE_TBL_ORDERS'], false)
    await off.openSql()
    await off.typeSend('go')
    await off.typeSend('and again')
    expect(genRequests(off.bridge).length).toBe(2)
    expect(off.catalogSqls().length).toBe(0)
    expect(off.metaCalls.length).toBe(0)
    for (const p of genPrompts(off.bridge)) {
      for (const tn of TABLES) expect(p).not.toContain(tn)
      expect(p).not.toContain('PROBE_COL_')
      expect(p).not.toContain('[TABLE LIST]')
    }
  })

  it('IME: a committing Enter does not send; a plain Enter does. Interpretation drawer has no generate button', async () => {
    const s = await boot(['QUESTION: ok', '## Interp'])
    await s.openSql()
    const input = s.w.find('[data-test=chat-input]')
    await input.setValue('你好')
    const el = input.element as HTMLElement
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    await settle()
    expect(genRequests(s.bridge).length).toBe(0)
    await new Promise((r) => setTimeout(r, 120))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(genRequests(s.bridge).length).toBe(1)

    await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
    await s.w.find('[data-block-id=b_sqlbbb] [data-test=run]').trigger('click'); await settle()
    await s.w.find('[data-block-id=b_sqlbbb] [data-test=ai-interpret]').trigger('click'); await settle()
    expect(s.w.find('[data-test=interpret-generate]').exists()).toBe(false)
  })
})
