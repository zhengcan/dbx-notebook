import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { genPrompts } from './aiRequests'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, computed } from 'vue'
import { serializeNotebook } from '@sqlnb/format'
import SqlDrawer from '../src/ai/SqlDrawer.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { createAiClient } from '../src/ai/aiClient'
import { createChatStore } from '../src/ai/chatStore'
import { AiClientKey, AiSettingsKey, BridgeKey, CanRunKey, ChatStoreKey, EngineKey, ConnectionsKey, RunningAllKey, StoreKey } from '../src/injection'
import { createDrawerManager } from '../src/ai/drawerState'
import { setLocale } from '../src/i18n'

const fmt = vi.hoisted(() => ({ impl: null as null | ((sql: string, db: string) => Promise<any>), calls: [] as string[] }))
vi.mock('../src/ai/formatSql', async (orig) => {
  const m = await orig<typeof import('../src/ai/formatSql')>()
  return { ...m, formatAiSql: (sql: string, db: string) => { fmt.calls.push(sql); return fmt.impl ? fmt.impl(sql, db) : Promise.resolve({ ok: false, sql, reason: 'failed' }) } }
})

const fence = (sql: string) => '```sql\n' + sql + '\n```'
type Send = { schema: boolean; sql: boolean; data: boolean }

const mounted: VueWrapper<any>[] = []
afterEach(() => { mounted.splice(0).forEach((w) => { try { w.unmount() } catch { /* already unmounted */ } }) })

async function setup(opts: { send?: Partial<Send>; blocks?: any[]; replies?: string[]; hold?: boolean; dbType?: string; tables?: string[]; hostConns?: unknown[] } = {}) {
  const queryData = vi.fn(async (req?: any) => (opts.tables && /information_schema|sqlite_master/.test(req?.sql ?? '')
    ? { columns: [{ name: 'name' }], rows: opts.tables.map((n) => [n]), truncated: false, elapsedMs: 1, dbType: 'postgres' }
    : { columns: [{ name: 'a' }], rows: [[1], [2]], truncated: false, elapsedMs: 1, dbType: 'postgres' }))
  const getTableMetadata = vi.fn(async (req: any) => ({ columns: [{ name: `COL_OF_${req.table}`, dataType: 'int', nullable: true }] }))
  const replies = [...(opts.replies ?? [])]
  let release: ((v: string) => void) | null = null
  const bridge = createFakeBridge({
    queryData, getTableMetadata,
    caps: { aiCompletion: true, dataApi: true, schemaMetadataApi: true },
    connections: opts.hostConns,
    requestHandlers: {
      'host.ai.listModels': async () => [{ configId: 'c', model: 'm', name: 'M', isDefault: true }],
      'host.ai.generateText': async () => (opts.hold ? new Promise<string>((r) => { release = r }) : replies.shift() ?? 'QUESTION: which table?'),
    },
  })
  const connections = createConnectionsStore(bridge)
  connections.seedFromContext({ id: 'c1', name: 'main', dbType: opts.dbType ?? 'postgres', database: 'db1' })
  if (opts.hostConns) await connections.refresh()
  const store = useNotebookStore()
  store.path.value = '/n.sqlnb'
  store.nb.value.settings.defaultConnection = 'main'
  store.nb.value.blocks.push(...(opts.blocks ?? [
    { id: 'b1', type: 'sql', content: 'select 1', metadata: { database: 'dbx', schema: 's1' } },
    { id: 'b2', type: 'sql', content: 'select 2', metadata: {} },
  ]))
  const settings = { sendOptions: vi.fn(async () => ({ schema: true, sql: true, data: true, ...opts.send })), effectiveModel: () => undefined }
  const engine = { sessionId: 's', ensureRegistered: async () => {}, query: vi.fn(async () => ({ columns: [{ name: 'c' }], rows: [[1]], truncated: false, elapsedMs: 3 })), invalidate() {}, async close() {} }
  const chat = createChatStore(bridge)
  const editors: { doc: string; opts: any }[] = []
  const factory = (_p: HTMLElement, o: any) => {
    const e = { doc: o.doc as string, opts: o }
    editors.push(e)
    return { setDoc(s: string) { e.doc = s }, getDoc: () => e.doc, setDialect() {}, setFont() {}, setDark() {}, clearCache() {}, destroy() {}, focus() {} } as any
  }
  const mountIt = async (blockId = 'b1') => {
    const w = mount(SqlDrawer, {
      props: { spec: { purpose: 'sql', blockId }, editorFactory: factory } as any,
      attachTo: document.body,
      global: { provide: { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [AiClientKey as symbol]: createAiClient(bridge), [AiSettingsKey as symbol]: settings, [ChatStoreKey as symbol]: chat, [EngineKey as symbol]: engine, [RunningAllKey as symbol]: ref(false), [CanRunKey as symbol]: computed(() => true) } },
    })
    mounted.push(w)
    await flushPromises()
    return w
  }
  const w = await mountIt()
  const prompts = () => genPrompts(bridge)
  const edit = (text: string, i = editors.length - 1) => { editors[i].doc = text; editors[i].opts.onChange(text) }
  const send = async (text = 'do it', wr: VueWrapper<any> = w) => {
    await wr.find('[data-test=chat-input]').setValue(text)
    await wr.find('[data-test=chat-send]').trigger('click')
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
  }
  const draft = () => editors[editors.length - 1].doc
  const bytes = () => serializeNotebook(store.nb.value)
  const sql = (id: string) => store.nb.value.blocks.find((b) => b.id === id)?.content
  return { w, bridge, store, connections, queryData, getTableMetadata, engine, settings, editors, prompts, edit, send, draft, bytes, sql, mountIt, chat, release: (v: string) => release?.(v) }
}

const showDiff = async (w: VueWrapper<any>) => {
  const tg = w.find('[data-test=sql-diff-toggle]')
  if (tg.attributes('aria-expanded') === 'false') await tg.trigger('click')
}

beforeEach(() => { setLocale('en'); document.body.innerHTML = ''; fmt.impl = null; fmt.calls = [] })

describe('SqlDrawer privacy of the host connection list', () => {
  it('the connection list never reaches AI prompts, the notebook bytes or chat storage (positive control: it is in the store)', async () => {
    const S = 'SENTINEL_HOST_CONN_ZZ'
    const s = await setup({ hostConns: [{ id: 'sid-1', name: 'main', dialect: 'postgres', connected: true, readOnly: false }, { id: 'sid-2', name: S, dialect: 'mysql', connected: true, readOnly: true }], replies: [fence('select 2')] })
    expect(s.connections.list().map((c) => c.name)).toContain(S)
    await s.send('write a query')
    expect(s.prompts().length).toBeGreaterThan(0)
    expect(s.prompts().join('\n')).not.toContain(S)
    expect(s.prompts().join('\n')).not.toContain('sid-2')
    expect(s.bytes()).not.toContain(S)
    const stored = JSON.stringify((s.bridge as any).calls.filter((c: any) => c.method === 'storageSet'))
    expect(stored).not.toContain(S)
    expect(stored).not.toContain('sid-2')
  })
})

describe('SqlDrawer', () => {
  it('positive control: the prompts helper counts streaming requests too', () => {
    const fake = { calls: [{ method: 'request', args: { method: 'host.ai.generateTextStream', params: { prompt: 'STREAMED' } } }] }
    expect(genPrompts(fake)).toEqual(['STREAMED'])
  })
  it('opens with block content as draft and baseline; diff empty', async () => {
    const s = await setup()
    expect(s.draft()).toBe('select 1')
    await showDiff(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.add').exists()).toBe(false)
    await showDiff(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.del').exists()).toBe(false)
  })

  it('AI SQL reply updates the draft (notebook untouched); QUESTION leaves it', async () => {
    const s = await setup({ replies: [fence('select 9'), 'QUESTION: which month?'] })
    const before = s.bytes()
    await s.send('change it')
    expect(s.draft()).toBe('select 9')
    await showDiff(s.w)
    expect(s.w.find('[data-test=ai-diff] .ln.add').exists()).toBe(true)
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
    await s.send('and then?')
    expect(s.draft()).toBe('select 9')
    expect(s.w.text()).toContain('which month?')
  })

  it("user edit feeds the next turn's [CURRENT SQL], not the AI's previous version", async () => {
    const s = await setup({ replies: [fence('select 9'), 'QUESTION: ok?'] })
    await s.send('first')
    s.edit('select 777 -- mine')
    await s.send('second')
    const p = s.prompts()[1]
    expect(p).toContain('select 777 -- mine')
    expect(p).toContain('CURRENT SQL')
    const cur = p.slice(p.indexOf('CURRENT SQL'))
    expect(cur.slice(0, cur.indexOf('select 777'))).not.toContain('select 9')
  })

  it('confirm replace: one history entry, block = draft, undo restores byte-for-byte', async () => {
    const s = await setup({ blocks: [{ id: 'b1', type: 'sql', content: 'select 1', metadata: {} }] })
    const before = s.bytes()
    s.edit('update t set a = 1')
    await flushPromises()
    await s.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    expect(s.sql('b1')).toBe('update t set a = 1')
    expect(s.store.history.undoDepth.value).toBe(1)
    expect(s.w.emitted('close')).toBeTruthy()
    s.store.undo()
    expect(s.bytes()).toBe(before)
  })

  it('confirm insert-as-new: new block after source inherits connection metadata; one history entry', async () => {
    const s = await setup()
    s.edit('select 5')
    await s.w.find('[data-test=sql-insert-new]').trigger('click')
    await flushPromises()
    expect(s.store.nb.value.blocks.length).toBe(3)
    const nb = s.store.nb.value.blocks[1]
    expect(nb.content).toBe('select 5')
    expect(nb.metadata).toMatchObject({ database: 'dbx', schema: 's1' })
    expect(s.sql('b1')).toBe('select 1')
    expect(s.store.history.undoDepth.value).toBe(1)
  })

  it('auto-run: SELECT draft runs once after confirm; non-SELECT does not', async () => {
    const s = await setup()
    s.edit('select 42')
    await flushPromises()
    await s.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    expect(s.queryData).toHaveBeenCalledTimes(1)
    expect(s.store.history.undoDepth.value).toBe(1)
    const t = await setup()
    t.edit('delete from t')
    await flushPromises()
    await t.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    expect(t.queryData).not.toHaveBeenCalled()
    expect(t.store.runs.get('b1')).toBeUndefined()
  })

  it('failed auto-run keeps the edit and adds no second history entry', async () => {
    const s = await setup()
    s.queryData.mockRejectedValueOnce(new Error('boom'))
    s.edit('select 42')
    await flushPromises()
    await s.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    expect(s.sql('b1')).toBe('select 42')
    expect(s.store.history.undoDepth.value).toBe(1)
  })

  it('block edited while open: Replace disabled with reason, Insert enabled, baseline toggle diffs', async () => {
    const s = await setup()
    s.store.updateContent('b1', 'select 1 -- external')
    await flushPromises()
    const rep = s.w.find('[data-test=drawer-confirm]')
    expect(rep.attributes('disabled')).toBeDefined()
    expect(rep.attributes('aria-describedby')).toBeTruthy()
    expect(s.w.find('[data-test=drawer-confirm-reason]').text()).toMatch(/changed/i)
    expect(s.w.find('[data-test=sql-insert-new]').attributes('disabled')).toBeUndefined()
    await s.w.find('[data-test=sql-diff-toggle]').trigger('click')
    await s.w.find('[data-test=sql-cmp-baseline]').setValue(true)
    await showDiff(s.w)
    expect(s.w.find('[data-test=ai-diff]').text()).toContain('select 1')
    await s.w.find('[data-test=sql-insert-new]').trigger('click')
    await flushPromises()
    expect(s.store.nb.value.blocks.length).toBe(3)
  })

  it('block deleted while open: both writes disabled', async () => {
    const s = await setup()
    s.store.nb.value.blocks.splice(0, 1)
    await flushPromises()
    expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=sql-insert-new]').attributes('disabled')).toBeDefined()
  })

  it('Discard / Esc / close: no change and no host.ai request', async () => {
    const s = await setup()
    const before = s.bytes()
    await s.w.find('[data-test=drawer-discard]').trigger('click')
    expect(s.w.emitted('close')).toBeTruthy()
    expect(s.bytes()).toBe(before)
    expect(s.store.history.undoDepth.value).toBe(0)
    expect(s.prompts().length).toBe(0)
    s.w.unmount()
    const t = await setup()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(t.w.emitted('close')).toBeTruthy()
    expect(t.bytes()).toBe(before)
  })

  it('Esc with draft != block asks to confirm', async () => {
    const s = await setup()
    s.edit('select 99')
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(s.w.emitted('close')).toBeFalsy()
    expect(document.body.textContent).toMatch(/Update the notebook\?/)
  })

  it('trial run disabled for a non-read-only draft with described reason; SELECT shows rows in drawer only', async () => {
    const s = await setup()
    s.edit('delete from t')
    await flushPromises()
    await flushPromises()
    const btn = s.w.find('[data-test=sql-trial]')
    expect(btn.attributes('disabled')).toBeDefined()
    const id = btn.attributes('aria-describedby')!
    expect(s.w.find(`#${id}`).text()).toMatch(/read-only/i)
    s.edit('select a from t')
    await flushPromises()
    const before = s.bytes()
    await s.w.find('[data-test=sql-trial]').trigger('click')
    await flushPromises()
    expect(s.w.find('[data-test=sql-trial-result]').text()).toContain('2')
    expect(s.queryData).toHaveBeenCalledTimes(1)
    expect(s.store.runs.size).toBe(0)
    expect(s.bytes()).toBe(before)
    expect(s.prompts().length).toBe(0)
  })

  it('reopen restores messages; external edit while closed resets baseline to current, chat kept', async () => {
    const s = await setup({ replies: ['QUESTION: hm?'] })
    await s.send('hello')
    s.w.unmount()
    s.store.updateContent('b1', 'select 1 -- ext')
    const w2 = await s.mountIt()
    expect(w2.text()).toContain('hello')
    expect(s.editors[s.editors.length - 1].doc).toBe('select 1 -- ext')
  })

  it('reopen A: confirmed then edited block -> draft is the block content, not the stale AI SQL', async () => {
    const s = await setup({ replies: [fence('select 9')] })
    await s.send('go')
    await s.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    s.store.updateContent('b1', 'select 9 -- mine')
    s.w.unmount()
    const w2 = await s.mountIt()
    expect(s.editors[s.editors.length - 1].doc).toBe('select 9 -- mine')
    expect(w2.findComponent({ name: 'AiDrawer' }).props('dirty')).toBe(false)
  })

  it('reopen: unconfirmed AI proposal is restored when the block is unchanged', async () => {
    const s = await setup({ replies: [fence('select 9')] })
    await s.send('go')
    s.w.unmount()
    const w2 = await s.mountIt()
    expect(s.editors[s.editors.length - 1].doc).toBe('select 9')
    expect(w2.findComponent({ name: 'AiDrawer' }).props('dirty')).toBe(true)
  })

  it('Replace is disabled with a reason when the draft equals the block or is empty', async () => {
    const s = await setup()
    const rep = () => s.w.find('[data-test=drawer-confirm]')
    expect(rep().attributes('disabled')).toBeDefined()
    expect(s.w.find('[data-test=drawer-confirm-reason]').exists()).toBe(true)
    s.edit('   ')
    await flushPromises()
    expect(rep().attributes('disabled')).toBeDefined()
    s.edit('select 3')
    await flushPromises()
    expect(rep().attributes('disabled')).toBeUndefined()
  })

  it('edit during the request: reply is a pending proposal, not an overwrite; Apply / Dismiss', async () => {
    const s = await setup({ hold: true })
    await s.send('slow')
    s.edit('select 55 -- typed meanwhile')
    s.release(fence('select 9'))
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(s.draft()).toBe('select 55 -- typed meanwhile')
    const bar = s.w.find('[data-test=sql-pending]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('role')).toBe('status')
    await s.w.find('[data-test=sql-pending-apply]').trigger('click')
    expect(s.draft()).toBe('select 9')
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
  })

  it('edit during the request then Dismiss keeps the typed draft', async () => {
    const s = await setup({ hold: true })
    await s.send('slow')
    s.edit('select 55')
    s.release(fence('select 9'))
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    await s.w.find('[data-test=sql-pending-dismiss]').trigger('click')
    expect(s.draft()).toBe('select 55')
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
  })

  it('no edit during the request: reply sets the draft directly without a pending bar', async () => {
    const s = await setup({ hold: true })
    await s.send('slow')
    s.release(fence('select 9'))
    await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
    expect(s.draft()).toBe('select 9')
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
  })

  it('stale trial result is dropped when the draft changed while the query ran', async () => {
    const s = await setup()
    let go: (v: any) => void = () => {}
    s.queryData.mockImplementationOnce(() => new Promise((r) => { go = r }) as any)
    s.edit('select a from t')
    await flushPromises()
    await s.w.find('[data-test=sql-trial]').trigger('click')
    s.edit('select b from t')
    go({ columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' })
    await flushPromises()
    expect(s.w.find('[data-test=sql-trial-result]').exists()).toBe(false)
  })

  it('trial error shows a real message, never the raw reason code', async () => {
    const s = await setup()
    s.queryData.mockRejectedValueOnce(new Error(''))
    s.edit('select a from t')
    await flushPromises()
    await s.w.find('[data-test=sql-trial]').trigger('click')
    await flushPromises()
    const txt = s.w.find('[data-test=sql-trial-result]').text()
    expect(txt).not.toMatch(/\berror\b$/)
    expect(txt.length).toBeGreaterThan(20)
  })

  it('aria-busy while applying', async () => {
    const s = await setup()
    let go: (v: any) => void = () => {}
    s.queryData.mockImplementationOnce(() => new Promise((r) => { go = r }) as any)
    s.edit('select 42')
    await flushPromises()
    await s.w.find('[data-test=drawer-confirm]').trigger('click')
    await flushPromises()
    expect(s.w.find('[data-test=sql-drawer]').attributes('aria-busy')).toBe('true')
    go({ columns: [{ name: 'a' }], rows: [], truncated: false, elapsedMs: 1, dbType: 'postgres' })
    await flushPromises()
  })

  it('closing mid-request cancels and ignores the late reply', async () => {
    const s = await setup({ hold: true })
    await s.send('slow')
    s.w.unmount()
    s.release(fence('select 1000'))
    await flushPromises()
    expect(s.sql('b1')).toBe('select 1')
  })

  it('drawer is dirty only when draft differs from block', async () => {
    const s = await setup()
    expect(s.w.findComponent({ name: 'AiDrawer' }).props('dirty')).toBe(false)
    s.edit('select 2222')
    await flushPromises()
    expect(s.w.findComponent({ name: 'AiDrawer' }).props('dirty')).toBe(true)
  })

  const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises() }

  it('a newer reply applied directly clears a stale pending bar; Apply cannot restore the older SQL', async () => {
    const s = await setup({ hold: true })
    await s.send('one')
    s.edit('select 55')
    s.release(fence('select 1111'))
    await settle()
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(true)
    await s.send('two')
    s.release(fence('select 2222'))
    await settle()
    expect(s.draft()).toBe('select 2222')
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
  })

  it('a newer pending proposal replaces the older one', async () => {
    const s = await setup({ hold: true })
    await s.send('one')
    s.edit('select 55')
    s.release(fence('select 1111'))
    await settle()
    await s.send('two')
    s.edit('select 66')
    s.release(fence('select 2222'))
    await settle()
    await s.w.find('[data-test=sql-pending-apply]').trigger('click')
    expect(s.draft()).toBe('select 2222')
  })

  it('sending a new message drops the pending bar immediately; manual typing keeps it', async () => {
    const s = await setup({ hold: true })
    await s.send('one')
    s.edit('select 55')
    s.release(fence('select 1111'))
    await settle()
    s.edit('select 56')
    await flushPromises()
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(true)
    await s.send('two')
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
    s.release('QUESTION: x?')
    await settle()
  })

  it('clearing the chat drops the pending bar', async () => {
    const s = await setup({ hold: true })
    await s.send('one')
    s.edit('select 55')
    s.release(fence('select 1111'))
    await settle()
    await s.w.find('[data-test=chat-clear]').trigger('click')
    await settle()
    expect(s.w.find('[data-test=sql-pending]').exists()).toBe(false)
  })

  describe('collapsed diff and close dialog', () => {
    const esc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises() }
    const dlg = () => Array.from(document.querySelectorAll('.cd')).pop() as HTMLElement | undefined
    const btns = () => Array.from(dlg()!.querySelectorAll('button')) as HTMLButtonElement[]
    const btn = (id: string) => dlg()!.querySelector(`[data-test=cd-${id}]`) as HTMLButtonElement
    const openDlg = async (s: any, sqlText = 'select 5') => {
      s.edit(sqlText); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
    }

    it('diff is collapsed by default; toggle shows it; reopening collapses again', async () => {
      const s = await setup()
      const tg = () => s.w.find('[data-test=sql-diff-toggle]')
      expect(s.w.find('[data-test=diff-view]').exists()).toBe(false)
      expect(s.w.find('[data-test=sql-cmp-current]').exists()).toBe(false)
      expect(tg().attributes('aria-expanded')).toBe('false')
      expect(tg().text()).toBe('Show diff')
      await tg().trigger('click')
      expect(s.w.find('[data-test=diff-view]').exists()).toBe(true)
      expect(tg().attributes('aria-expanded')).toBe('true')
      expect(tg().text()).toBe('Hide diff')
      s.w.unmount()
      const w2 = await s.mountIt()
      expect(w2.find('[data-test=diff-view]').exists()).toBe(false)
    })

    it('close with an unchanged draft just closes (x and Esc)', async () => {
      const s = await setup()
      await s.w.find('[data-test=drawer-close]').trigger('click')
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')?.length).toBe(1)
      const t = await setup()
      await esc()
      expect(dlg()).toBeUndefined()
      expect(t.w.emitted('close')).toBeTruthy()
    })

    it('close with a changed draft shows the 4-button dialog, no discard wording; initial focus cancel', async () => {
      const s = await setup()
      await openDlg(s)
      expect(dlg()!.textContent).toContain('Update the notebook?')
      expect(btns().map((b) => b.textContent)).toEqual(['Update SQL block', 'Insert as new block', 'Not now', 'Cancel'])
      expect(dlg()!.textContent).not.toMatch(/discard/i)
      expect(dlg()!.getAttribute('aria-labelledby')).toBeTruthy()
      expect(document.activeElement).toBe(btn('cancel'))
      expect(s.w.emitted('close')).toBeFalsy()
    })

    it('Esc with a dirty draft opens the dialog; zh title', async () => {
      setLocale('zh-CN')
      const s = await setup()
      s.edit('select 5'); await flushPromises()
      await esc()
      expect(dlg()!.textContent).toContain('是否更新笔记本？')
      expect(btns().map((b) => b.textContent)).toEqual(['更新 SQL 块', '插入为新块', '暂不更新', '取消'])
    })

    it('Update SQL block = confirm-write replace (one history entry, auto-run, closes)', async () => {
      const s = await setup()
      const before = s.bytes()
      await openDlg(s, 'select 42')
      btn('update').click(); await flushPromises()
      expect(s.sql('b1')).toBe('select 42')
      expect(s.store.history.undoDepth.value).toBe(1)
      expect(s.queryData).toHaveBeenCalledTimes(1)
      expect(s.w.emitted('close')).toBeTruthy()
      s.store.undo()
      expect(s.bytes()).toBe(before)
      const t = await setup()
      await openDlg(t, 'delete from t')
      btn('update').click(); await flushPromises()
      expect(t.sql('b1')).toBe('delete from t')
      expect(t.queryData).not.toHaveBeenCalled()
    })

    it('Insert as new block = confirm-write insert-new', async () => {
      const s = await setup()
      await openDlg(s, 'select 5')
      btn('insertNew').click(); await flushPromises()
      expect(s.store.nb.value.blocks.length).toBe(3)
      expect(s.store.nb.value.blocks[1].content).toBe('select 5')
      expect(s.sql('b1')).toBe('select 1')
      expect(s.store.history.undoDepth.value).toBe(1)
      expect(s.w.emitted('close')).toBeTruthy()
    })

    it('Not now closes without touching the notebook', async () => {
      const s = await setup()
      const before = s.bytes()
      await openDlg(s)
      btn('skip').click(); await flushPromises()
      expect(s.w.emitted('close')).toBeTruthy()
      expect(s.store.history.undoDepth.value).toBe(0)
      expect(s.bytes()).toBe(before)
    })

    it('Cancel and Esc inside the dialog return to the drawer', async () => {
      const s = await setup()
      await openDlg(s)
      btn('cancel').click(); await flushPromises()
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')).toBeFalsy()
      expect(s.draft()).toBe('select 5')
      expect(s.w.element.contains(document.activeElement)).toBe(true)
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      btn('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flushPromises()
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')).toBeFalsy()
      expect(s.w.find('[data-test=sql-drawer]').exists()).toBe(true)
    })

    it('Update is disabled with the reason when the block changed; Insert/Not now/Cancel work', async () => {
      const s = await setup()
      s.edit('select 5'); await flushPromises()
      s.store.updateContent('b1', 'select 1 -- external'); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      expect(btn('update').disabled).toBe(true)
      const why = document.getElementById(btn('update').getAttribute('aria-describedby')!)!
      expect(why.textContent).toMatch(/changed/i)
      expect(btn('insertNew').disabled).toBe(false)
      btn('insertNew').click(); await flushPromises()
      expect(s.store.nb.value.blocks.length).toBe(3)
    })

    it('block deleted: Update and Insert disabled with the deleted reason; Not now still closes', async () => {
      const s = await setup()
      s.edit('select 5'); await flushPromises()
      s.store.nb.value.blocks.splice(0, 1); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      expect(btn('update').disabled).toBe(true)
      expect(btn('insertNew').disabled).toBe(true)
      expect(document.getElementById(btn('insertNew').getAttribute('aria-describedby')!)!.textContent).toMatch(/deleted/i)
      btn('skip').click(); await flushPromises()
      expect(s.w.emitted('close')).toBeTruthy()
    })

    it('an unconfirmed pending proposal alone does not make the draft dirty', async () => {
      const s = await setup({ replies: [fence('select 55')], hold: false })
      s.edit('select 1'); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')).toBeTruthy()
    })
  })

  describe('close dialog robustness', () => {
    const dlg = () => Array.from(document.querySelectorAll('.cd')).pop() as HTMLElement | undefined
    const btn = (id: string) => dlg()!.querySelector(`[data-test=cd-${id}]`) as HTMLButtonElement
    const why = (id: string) => document.getElementById(btn(id).getAttribute('aria-describedby')!)
    const openD = async (s: any, sqlText = 'select 5') => {
      s.edit(sqlText); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
    }
    const vanish = (s: any) => {
      const orig = s.store.applyAiEdit
      s.store.applyAiEdit = (o: any) => { s.store.nb.value.blocks.splice(0, 1); return orig(o) }
    }

    it('footer insert-new with a block that vanishes before the write: alert, drawer open, writes disabled', async () => {
      const s = await setup()
      s.edit('select 5'); await flushPromises()
      vanish(s)
      await s.w.find('[data-test=sql-insert-new]').trigger('click'); await flushPromises()
      expect(s.w.emitted('close')).toBeFalsy()
      expect(s.w.find('[data-test=sql-apply-error]').attributes('role')).toBe('alert')
      expect(s.w.find('[data-test=sql-apply-error]').text()).toMatch(/deleted/i)
      expect(s.w.find('[data-test=sql-insert-new]').attributes('disabled')).toBeDefined()
      expect(s.w.find('[data-test=drawer-confirm]').attributes('disabled')).toBeDefined()
    })

    it('dialog Insert with a vanishing block: dialog closes, alert shown in the drawer, drawer stays open', async () => {
      const s = await setup()
      await openD(s)
      vanish(s)
      btn('insertNew').click(); await flushPromises()
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')).toBeFalsy()
      expect(s.w.find('[data-test=sql-apply-error]').text()).toMatch(/deleted/i)
    })

    it('while the AI is busy, Update/Insert are disabled with a stated reason; Esc still opens the dialog', async () => {
      const s = await setup({ hold: true })
      s.edit('select 5'); await flushPromises()
      await s.w.find('[data-test=chat-input]').setValue('go')
      await s.w.find('[data-test=chat-send]').trigger('click'); await flushPromises(); await new Promise((r) => setTimeout(r, 20))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flushPromises()
      expect(dlg()).toBeDefined()
      expect(btn('update').disabled).toBe(true)
      expect(btn('insertNew').disabled).toBe(true)
      expect(why('update')!.textContent!.length).toBeGreaterThan(0)
      expect(why('insertNew')!.textContent!.length).toBeGreaterThan(0)
      expect(s.sql('b1')).toBe('select 1')
      s.release('QUESTION: x')
    })

    it('Update disabled with the empty reason (describedby resolves)', async () => {
      const s = await setup()
      await openD(s, '   ')
      expect(btn('update').disabled).toBe(true)
      expect(why('update')!.textContent).toMatch(/empty/i)
    })

    it('Update disabled when the block changed since open (conflict from the dialog)', async () => {
      const s = await setup()
      s.edit('select 5'); await flushPromises()
      s.store.updateContent('b1', 'select 1 -- ext'); await flushPromises()
      await s.w.find('[data-test=drawer-close]').trigger('click'); await flushPromises()
      expect(btn('update').disabled).toBe(true)
      expect(why('update')!.textContent).toMatch(/changed/i)
      expect(s.sql('b1')).toBe('select 1 -- ext')
    })

    it('the dialog closes (drawer stays) when the draft becomes equal to the block underneath', async () => {
      const s = await setup()
      await openD(s)
      s.edit('select 1'); await flushPromises()
      expect(dlg()).toBeUndefined()
      expect(s.w.emitted('close')).toBeFalsy()
      expect(s.w.find('[data-test=sql-drawer]').exists()).toBe(true)
    })

    it('block deleted while the dialog is open: write buttons disabled with the reason', async () => {
      const s = await setup()
      await openD(s)
      s.store.nb.value.blocks.splice(0, 1); await flushPromises()
      expect(btn('update').disabled).toBe(true)
      expect(btn('insertNew').disabled).toBe(true)
      expect(why('insertNew')!.textContent).toMatch(/deleted/i)
    })

    it('double-click on a dialog write button writes once', async () => {
      const s = await setup()
      await openD(s)
      const b = btn('insertNew')
      b.click(); b.click(); await flushPromises()
      expect(s.store.nb.value.blocks.length).toBe(3)
      expect(s.store.history.undoDepth.value).toBe(1)
    })

    it('Esc inside the dialog does not propagate to the document handler', async () => {
      const s = await setup()
      await openD(s)
      const seen = vi.fn()
      document.addEventListener('keydown', seen)
      btn('cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.removeEventListener('keydown', seen)
      await flushPromises()
      expect(seen).not.toHaveBeenCalled()
      expect(dlg()).toBeUndefined()
    })

    it('a notebook load (generation change) closes the drawer through the manager', async () => {
      const s = await setup()
      const mgr = createDrawerManager(s.store)
      mgr.open({ purpose: 'sql', blockId: 'b1' } as any)
      s.store.generation.value++
      await flushPromises()
      expect(mgr.current.value).toBeNull()
    })
  })

  describe('catalog access (table list, structures)', () => {
    const reqs = (s: any, m: string) => s.bridge.calls.filter((c: any) => c.method === m)
    const catQueries = (s: any) => s.queryData.mock.calls.filter((c: any) => /information_schema|sqlite_master/.test(c[0].sql))

    it('first turn carries the table list and the referenced/mentioned table structures', async () => {
      const s = await setup({ tables: ['orders', 'customers', 'items'], blocks: [{ id: 'b1', type: 'sql', content: 'select * from orders', metadata: {} }] })
      await s.send('also join customers please')
      const p = s.prompts()[0]
      expect(catQueries(s)).toHaveLength(1)
      expect(p).toContain('[TABLE LIST]')
      for (const n of ['orders', 'customers', 'items']) expect(p).toContain(n)
      expect(s.getTableMetadata.mock.calls.map((c: any) => c[0].table).sort()).toEqual(['customers', 'orders'])
      expect(p).toContain('COL_OF_orders')
      expect(p).not.toContain('COL_OF_items')
    })
    it('schema toggle off: zero queryData and zero getTableMetadata calls, prompt has none of the names', async () => {
      const on = await setup({ tables: ['orders', 'customers'], blocks: [{ id: 'b1', type: 'sql', content: 'select * from orders', metadata: {} }] })
      await on.send('about customers')
      expect(on.queryData).toHaveBeenCalled()
      expect(on.getTableMetadata).toHaveBeenCalled()
      const s = await setup({ send: { schema: false }, tables: ['orders', 'customers'], blocks: [{ id: 'b1', type: 'sql', content: 'select * from orders', metadata: {} }] })
      await s.send('about customers')
      expect(s.queryData).not.toHaveBeenCalled()
      expect(s.getTableMetadata).not.toHaveBeenCalled()
      expect(s.prompts()[0]).not.toContain('[TABLE LIST]')
      expect(s.prompts()[0]).not.toContain('COL_OF_')
    })
    it('toggle flipped off between two turns: second turn has no list even though cached', async () => {
      const s = await setup({ tables: ['orders', 'zzz_tbl'], replies: ['QUESTION: a', 'QUESTION: b'] })
      await s.send('one')
      expect(s.prompts()[0]).toContain('zzz_tbl')
      s.settings.sendOptions.mockImplementation(async () => ({ schema: false, sql: true, data: true }))
      await s.send('two')
      expect(s.prompts()[1]).not.toContain('zzz_tbl')
      expect(catQueries(s)).toHaveLength(1)
    })
    it('unsupported dialect falls back to notebook tables with the note', async () => {
      const s = await setup({ dbType: 'oracle', blocks: [{ id: 'b1', type: 'sql', content: 'select 1', metadata: {} }, { id: 'b2', type: 'sql', content: 'select * from NB_ONLY_TBL', metadata: {} }] })
      await s.send('go')
      const p = s.prompts()[0]
      expect(catQueries(s)).toHaveLength(0)
      expect(p).toContain('NB_ONLY_TBL')
      expect(p).toContain('table list unavailable for this dialect; only tables seen in the notebook')
    })
    it('local results block: no catalog query', async () => {
      const s = await setup({ tables: ['orders'], blocks: [{ id: 'r1', type: 'sql', content: 'select * from orders', metadata: { source: 'results' } }] })
      const w = await s.mountIt('r1')
      await s.send('hi', w)
      expect(catQueries(s)).toHaveLength(0)
      expect(s.prompts().join('\n')).not.toContain('[TABLE LIST]')
    })
    it('shows an ephemeral one-line notice and does not store it as a message', async () => {
      const s = await setup({ tables: ['orders', 'customers'], blocks: [{ id: 'b1', type: 'sql', content: 'select * from orders', metadata: {} }] })
      await s.send('hi')
      expect(s.w.find('[data-test=chat-notice]').text()).toContain('read table list (2 tables)')
      expect(s.w.findAll('[data-test=chat-msg]').every((m) => !m.text().includes('read table list'))).toBe(true)
    })

  describe('catalog beyond the current schema', () => {
    const DB: Record<string, string[]> = { sales: ['orders', 'items'], hr: ['staff'] }
    const queryImpl = (extra: Record<string, string[]> = {}) => async (req?: any) => {
      const sql: string = req?.sql ?? ''
      const mk = (rows: string[][]) => ({ columns: [{ name: 'name' }], rows, truncated: false, elapsedMs: 1, dbType: 'postgres' })
      if (/information_schema\.schemata/.test(sql)) return mk(Object.keys(DB).map((k) => [k]))
      const m = /table_schema = '([^']*)'/.exec(sql)
      if (m) return mk((extra[m[1]] ?? DB[m[1]] ?? []).map((n) => [n]))
      if (/information_schema\.tables/.test(sql)) return mk(Object.entries(DB).flatMap(([sc, ts]) => ts.map((x) => [`${sc}.${x}`])))
      return { columns: [{ name: 'a' }], rows: [[1]], truncated: false, elapsedMs: 1, dbType: 'postgres' }
    }
    const withSchema = (schema?: string) => [{ id: 'b1', type: 'sql', content: 'select 1', metadata: schema ? { schema } : {} }]
    const tblQ = (s: any) => s.queryData.mock.calls.map((c: any) => c[0].sql).filter((q: string) => /information_schema\.tables/.test(q))
    const schemaQ = (s: any) => s.queryData.mock.calls.map((c: any) => c[0].sql).filter((q: string) => /information_schema\.schemata/.test(q))

    it('block schema "sales": the list holds the sales tables (explicit scope in the statement), notice counts them', async () => {
      const s = await setup({ blocks: withSchema('sales') })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(tblQ(s)).toHaveLength(1)
      expect(tblQ(s)[0]).toContain("table_schema = 'sales'")
      const p = s.prompts()[0]
      expect(p).toContain('[TABLE LIST]')
      expect(p).toContain('orders')
      expect(p).not.toContain('staff')
      expect(s.w.find('[data-test=chat-notice]').text()).toContain('read table list (2 tables)')
    })
    it('block without schema: prefixed names from several schemas', async () => {
      const s = await setup({ blocks: withSchema() })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(tblQ(s)[0]).not.toContain('current_schema')
      const p = s.prompts()[0]
      for (const n of ['sales.orders', 'sales.items', 'hr.staff']) expect(p).toContain(n)
      expect(s.w.find('[data-test=chat-notice]').text()).toContain('read table list (3 tables)')
    })
    it('empty scope: honest notice naming the scope (no "read table list"), exactly one schema-list query, schema names go to the AI', async () => {
      const s = await setup({ blocks: withSchema('public') })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      const text = s.w.find('[data-test=chat-notice]').text()
      expect(text).not.toContain('read table list')
      expect(text).toContain('public')
      expect(text).toMatch(/empty/i)
      expect(schemaQ(s)).toHaveLength(1)
      const p = s.prompts()[0]
      expect(p).toContain('[SCHEMAS AVAILABLE]')
      expect(p).toMatch(/SCHEMAS AVAILABLE[^\n]*\n[^]*sales[^]*hr/)
    })
    it('empty scope caps the schema names at 50 and drops non-whitelisted ones', async () => {
      const s = await setup({ blocks: withSchema('public') })
      const many = [...Array.from({ length: 70 }, (_, i) => `sch${String(i).padStart(2, '0')}`), "bad'name"]
      s.queryData.mockImplementation(async (req?: any): Promise<any> => (/schemata/.test(req?.sql ?? '') ? { columns: [], rows: many.map((n) => [n]), truncated: false } : { columns: [], rows: [], truncated: false }))
      await s.send('go')
      const p = s.prompts()[0]
      expect(p).toContain('sch49')
      expect(p).not.toContain('sch50')
      expect(p).not.toContain("bad'name")
    })
    it('empty scope, then schema OFF on the next turn: schema names are masked everywhere, zero further catalog queries', async () => {
      const s = await setup({ blocks: withSchema('public'), replies: ['hr is the schema to use', 'QUESTION: ok?'] })
      s.queryData.mockImplementation(queryImpl())
      await s.send('one')
      expect(s.prompts()[0]).toContain('hr')
      const before = s.queryData.mock.calls.length
      s.settings.sendOptions.mockImplementation(async () => ({ schema: false, sql: true, data: true }))
      await s.send('two')
      expect(s.queryData.mock.calls.length).toBe(before)
      expect(s.prompts()[1]).not.toContain('SCHEMAS AVAILABLE')
      expect(s.prompts()[1]).not.toMatch(/\bsales\b/)
      expect(s.prompts()[1]).toContain('[earlier reply omitted]')
    })
    it('schema OFF from the start: zero queryData (positive control above)', async () => {
      const s = await setup({ send: { schema: false }, blocks: withSchema('public') })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(s.queryData).not.toHaveBeenCalled()
      expect(s.prompts()[0]).not.toMatch(/SCHEMAS AVAILABLE|sales/)
    })
    it('NEED_LIST: hr lists that schema with prefixed names', async () => {
      const s = await setup({ blocks: withSchema('sales'), replies: ['NEED_LIST: hr', fence('select 1')] })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(tblQ(s).some((q: string) => q.includes("table_schema = 'hr'"))).toBe(true)
      expect(s.prompts()[1]).toContain('hr.staff')
    })
    it('NEED_LIST naming an empty schema: honest notice, schema names offered (one schemata query in total)', async () => {
      const s = await setup({ blocks: withSchema('sales'), replies: ['NEED_LIST: nope', 'QUESTION: ok?'] })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(s.prompts()[1]).toMatch(/SCHEMAS AVAILABLE/)
      expect(s.prompts()[1]).toMatch(/empty[^.]*nope|nope[^.]*empty/i)
      expect(schemaQ(s)).toHaveLength(1)
    })
    it('NEED_LIST with an invalid scope: a note, no catalog query for it', async () => {
      const s = await setup({ blocks: withSchema('sales'), replies: ["NEED_LIST: a'b;--", 'QUESTION: ok?'] })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      expect(tblQ(s).every((q: string) => !q.includes("a'b"))).toBe(true)
      expect(tblQ(s)).toHaveLength(1)
      expect(s.prompts()[1]).toMatch(/Table list unavailable \(invalid-scope\)/)
    })
    it('NEED_TABLES sales.orders: getTableMetadata gets schema "sales" and table "orders" (postgres); database on mysql', async () => {
      const s = await setup({ blocks: withSchema('hr'), replies: ['NEED_TABLES: sales.orders', fence('select 1')] })
      s.queryData.mockImplementation(queryImpl())
      await s.send('go')
      const call = s.getTableMetadata.mock.calls.map((c: any) => c[0]).find((r: any) => r.table === 'orders')
      expect(call).toMatchObject({ schema: 'sales', table: 'orders' })
      const m = await setup({ dbType: 'mysql', blocks: withSchema(), replies: ['NEED_TABLES: shop.orders', fence('select 1')] })
      await m.send('go')
      const mc = m.getTableMetadata.mock.calls.map((c: any) => c[0]).find((r: any) => r.table === 'orders')
      expect(mc.database).toBe('shop')
      expect(mc.schema).toBeUndefined()
    })
    it('dialect without schemas ignores the block schema and scopes by database', async () => {
      const s = await setup({ dbType: 'mysql', blocks: withSchema('ignored') })
      await s.send('go')
      const q = tblQ(s)
      expect(q).toHaveLength(1)
      expect(q[0]).toContain("table_schema = 'db1'")
      expect(q[0]).not.toContain('ignored')
    })
    it('hostile block schema: no catalog query, a stated notice', async () => {
      const s = await setup({ blocks: withSchema('a"b') })
      await s.send('go')
      expect(tblQ(s)).toHaveLength(0)
      expect(s.w.find('[data-test=chat-notice]').text()).toMatch(/not supported/i)
    })
  })

  describe('NEED_ chain', () => {
    const blocks = [{ id: 'b1', type: 'sql', content: 'select 1', metadata: {} }]
    const catQ = (s: any) => s.queryData.mock.calls.filter((c: any) => /information_schema|sqlite_master/.test(c[0].sql))
    it('NEED_LIST then NEED_TABLES then SQL: final draft = SQL; getTableMetadata called for exactly the requested tables; one queryData for the list', async () => {
      const s = await setup({ tables: ['orders', 'customers', 'items'], blocks, replies: ['NEED_LIST:', 'NEED_TABLES: Orders, items', fence('select 42')] })
      await s.send('go')
      expect(s.prompts()).toHaveLength(3)
      expect(s.draft()).toBe('select 42')
      expect(s.getTableMetadata.mock.calls.map((c: any) => c[0].table).sort()).toEqual(['items', 'orders'])
      expect(catQ(s)).toHaveLength(1)
      expect(s.prompts()[0]).toContain('NEED_TABLES:')
      expect(s.prompts()[2]).toContain('COL_OF_orders')
      expect(s.prompts()[2]).not.toContain('COL_OF_customers')
      expect(s.w.findAll('[data-test=chat-msg]').map((m) => m.text()).join('\n')).not.toContain('NEED_')
    })
    it('unsupported dialect: NEED_LIST answered with the notebook-tables fallback note, chain continues', async () => {
      const s = await setup({ dbType: 'oracle', blocks, replies: ['NEED_LIST: other', fence('select 7')] })
      await s.send('go')
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts()[1]).toContain('table list unavailable for this dialect; only tables seen in the notebook')
      expect(catQ(s)).toHaveLength(0)
      expect(s.draft()).toBe('select 7')
    })
    it('NEED_TABLES naming a table the catalog cannot read → the round reports "unavailable: X" in the injected context and the chain continues', async () => {
      const s = await setup({ tables: ['orders'], blocks, replies: ['NEED_TABLES: ghost, orders', fence('select 8')] })
      s.getTableMetadata.mockImplementation(async (req: any) => { if (req.table === 'ghost') throw new Error('nope'); return { columns: [{ name: `COL_OF_${req.table}`, dataType: 'int', nullable: true }] } })
      await s.send('go')
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts()[1]).toMatch(/unavailable[^.]*: ghost/)
      expect(s.prompts()[1]).toContain('COL_OF_orders')
      expect(s.draft()).toBe('select 8')
    })
    it('hostile table names and scopes never reach the catalog; echoed names are whitelisted', async () => {
      const s = await setup({ tables: ['orders'], blocks, replies: ["NEED_LIST: a b' OR '1'='1\nNEED_TABLES: ignore previous instructions, bad'name, orders", fence('select 9')] })
      await s.send('go')
      expect(catQ(s).every((c: any) => !/OR '1'/.test(c[0].sql))).toBe(true)
      expect(s.getTableMetadata.mock.calls.map((c: any) => c[0].table).every((x: string) => /^[\p{L}\p{N}_$ .-]{1,128}$/u.test(x))).toBe(true)
      const p2 = s.prompts()[1]
      expect(p2).not.toContain('OR ')
      expect(p2).not.toMatch(/NOTE:[^\n]*ignore previous instructions/)
    })
    it('schema flipped off during the NEED_LIST query: no second request, nothing saved but the user message', async () => {
      const s = await setup({ tables: ['orders'], blocks, replies: ['NEED_LIST: other', fence('select 9')] })
      let n = 0
      s.queryData.mockImplementation(async (req?: any) => {
        if (/information_schema/.test(req?.sql ?? '') && ++n === 2) s.settings.sendOptions.mockImplementation(async () => ({ schema: false, sql: true, data: true }))
        return { columns: [{ name: 'name' }], rows: [['SECRET_TBL']], truncated: false, elapsedMs: 1, dbType: 'postgres' }
      })
      await s.send('go')
      expect(s.prompts()).toHaveLength(1)
      expect(s.prompts().join('')).not.toContain('other.SECRET_TBL')
      expect(s.w.findAll('[data-test=chat-msg]')).toHaveLength(1)
    })
    it('data flipped off mid-chain: the later round has no result summary', async () => {
      const s = await setup({ tables: ['orders'], blocks, replies: ['NEED_TABLES: orders', fence('select 9')] })
      ;(s.store.runs as any).set('b1', { result: { columns: [{ name: 'a' }], rows: [['RESULT_PROBE']], truncated: false, elapsedMs: 1 } })
      s.getTableMetadata.mockImplementation(async (req: any) => { s.settings.sendOptions.mockImplementation(async () => ({ schema: true, sql: true, data: false })); return { columns: [{ name: `COL_OF_${req.table}`, dataType: 'int', nullable: true }] } })
      await s.send('go')
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts()[0]).toContain('RESULT_PROBE')
      expect(s.prompts()[1]).not.toContain('RESULT_PROBE')
    })
    it('round-0 list + structures, then schema OFF on the next turn: the earlier answer is masked, no probe names anywhere', async () => {
      const s = await setup({ tables: ['orders', 'PROBE_TBL_X'], blocks: [{ id: 'b1', type: 'sql', content: 'select * from orders', metadata: {} }], replies: ['PROBE_TBL_X is the biggest table', 'QUESTION: ok?'] })
      await s.send('which table is big')
      expect(s.prompts()[0]).toContain('PROBE_TBL_X')
      s.settings.sendOptions.mockImplementation(async () => ({ schema: false, sql: true, data: true }))
      await s.send('and now?')
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts()[1]).not.toContain('PROBE_TBL_X')
      expect(s.prompts()[1]).not.toContain('COL_OF_')
      expect(s.prompts()[1]).toContain('[earlier reply omitted]')
    })
    it('catalog denied once: later sends in the same drawer issue zero further catalog queries; a transient failure is retried next turn', async () => {
      const { HostError } = await import('../src/host/bridge')
      const s = await setup({ tables: ['orders'], blocks, replies: ['QUESTION: a', 'QUESTION: b', 'QUESTION: c'] })
      s.queryData.mockImplementation(async () => { throw new HostError('NOT_GRANTED', 'no') })
      await s.send('one'); await s.send('two'); await s.send('three')
      expect(catQ(s)).toHaveLength(1)
      const t = await setup({ tables: ['orders'], blocks, replies: ['QUESTION: a', 'QUESTION: b'] })
      let n = 0
      t.queryData.mockImplementation(async () => { n++; throw new Error('transient') })
      await t.send('one'); await t.send('two')
      expect(n).toBe(2)
    })
    it('a denied catalog is reported unavailable once and the NEED_LIST round does not re-query', async () => {
      const { HostError } = await import('../src/host/bridge')
      const s = await setup({ tables: ['orders'], blocks, replies: ['NEED_LIST:', fence('select 4')] })
      s.queryData.mockImplementation(async () => { throw new HostError('NOT_GRANTED', 'no') })
      await s.send('go')
      expect(catQ(s)).toHaveLength(1)
      expect(s.prompts()).toHaveLength(2)
      expect(s.prompts()[1]).toMatch(/Table list unavailable \(denied\)/)
    })
    it('schema off: the prompt does not invite NEED_ and a NEED reply is not acted on', async () => {
      const s = await setup({ send: { schema: false }, tables: ['orders'], blocks, replies: ['NEED_TABLES: orders'] })
      await s.send('go')
      expect(s.prompts()).toHaveLength(1)
      expect(s.prompts()[0]).not.toContain('NEED_')
      expect(s.getTableMetadata).not.toHaveBeenCalled()
    })
  })
  })

  describe('AI SQL auto-format', () => {
    const upper = async (sql: string) => ({ ok: true, sql: sql.toUpperCase() })
    it('formats the AI SQL into the draft; diff base is still the previous draft', async () => {
      fmt.impl = upper
      const s = await setup({ replies: [fence('select 9')] })
      await s.send('change it')
      expect(s.draft()).toBe('SELECT 9')
      expect(fmt.calls).toEqual(['select 9'])
      await showDiff(s.w)
      expect(s.w.find('[data-test=ai-diff] .ln.del').text()).toContain('select 1')
    })
    it('REAL formatAiSql end to end: AI reply becomes the formatted draft, {{ param }} intact', async () => {
      const real = await vi.importActual<typeof import('../src/ai/formatSql')>('../src/ai/formatSql')
      fmt.impl = (sql, db) => real.formatAiSql(sql, db)
      const s = await setup({ replies: [fence("select a,b from t where d = {{ d }} and x='y' order by a")] })
      await s.send('change it')
      await vi.waitFor(() => expect(s.draft()).toContain('\n'), { timeout: 3000 })
      expect(s.draft()).toContain('SELECT')
      expect(s.draft()).toContain('{{ d }}')
      expect(s.draft()).not.toBe("select a,b from t where d = {{ d }} and x='y' order by a")
    })
    it('never formats user-typed text', async () => {
      fmt.impl = upper
      const s = await setup({ replies: [] })
      s.edit('select 5')
      await flushPromises()
      expect(fmt.calls).toEqual([])
      expect(s.draft()).toBe('select 5')
    })
    it('formatting failure applies the raw SQL', async () => {
      fmt.impl = async (sql) => { throw new Error('x') }
      const s = await setup({ replies: [fence('select 9')] })
      await s.send('change it')
      expect(s.draft()).toBe('select 9')
    })
    it('a user edit while formatting wins: pending proposal, no overwrite', async () => {
      let go: (() => void) | null = null
      fmt.impl = (sql) => new Promise((r) => { go = () => r({ ok: true, sql: sql.toUpperCase() }) })
      const s = await setup({ replies: [fence('select 9')] })
      await s.w.find('[data-test=chat-input]').setValue('x')
      await s.w.find('[data-test=chat-send]').trigger('click')
      await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
      s.edit('select 55')
      go!()
      await flushPromises()
      expect(s.draft()).toBe('select 55')
      expect(s.w.find('[data-test=sql-pending]').exists()).toBe(true)
    })
    it('a stale reply (unmounted while formatting) does not touch the draft', async () => {
      let go: (() => void) | null = null
      fmt.impl = (sql) => new Promise((r) => { go = () => r({ ok: true, sql: 'FORMATTED' }) })
      const s = await setup({ replies: [fence('select 9')] })
      await s.w.find('[data-test=chat-input]').setValue('x')
      await s.w.find('[data-test=chat-send]').trigger('click')
      await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises()
      s.w.unmount()
      go!()
      await flushPromises()
      expect(s.draft()).toBe('select 1')
    })
    it('auto-run gate sees the formatted draft that is applied', async () => {
      fmt.impl = upper
      const s = await setup({ replies: [fence('select 9')] })
      await s.send('change it')
      await s.w.find('[data-test=drawer-confirm]').trigger('click')
      await flushPromises()
      expect(s.sql('b1')).toBe('SELECT 9')
    })
  })
})
