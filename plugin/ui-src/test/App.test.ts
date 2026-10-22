import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hostAiCalls } from './aiRequests'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { serializeNotebook, createEmptyNotebook } from '@sqlnb/format'

const NB = serializeNotebook(createEmptyNotebook())
const CTX = { id: 'c1', name: 'main', dbType: 'postgres' }

function make(opts: { ctx?: Record<string, unknown>; caps?: any; handlers?: Record<string, any>; requestHandlers?: Record<string, any>; extra?: Record<string, any> } = {}) {
  setLocale('en')
  let ctxFn: ((c: Record<string, unknown>) => void) | null = null
  const bridge = createFakeBridge({
    caps: opts.caps,
    ...opts.extra,
    context: () => opts.ctx ?? {},
    onContext: (fn: any) => { ctxFn = fn; return () => {} },
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: NB, mtimeMs: 100 }),
      'notebook/write': () => ({ mtimeMs: 200 }),
      'notebook/touchRecent': () => ({}),
      ...opts.handlers,
    },
    requestHandlers: opts.requestHandlers,
  } as any)
  const ef = fakeEditorFactory()
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: ef }, attachTo: document.body })
  return { w, bridge, ef, emitCtx: (c: Record<string, unknown>) => ctxFn!(c) }
}
const writes = (b: any) => b.calls.filter((c: any) => c.method === 'invoke' && c.args.method === 'notebook/write')

describe('App', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('swallows stray file drops (no webview navigation) while mounted, but not text drags; removed on unmount', async () => {
    const { w } = make()
    await flushPromises()
    const send = (types: string[]) => { const ev = new Event('drop', { bubbles: true, cancelable: true }) as any; ev.dataTransfer = { types }; document.body.dispatchEvent(ev); return ev as Event }
    expect(send(['Files']).defaultPrevented).toBe(true)
    expect(send(['text/plain']).defaultPrevented).toBe(false)
    w.unmount()
    expect(send(['Files']).defaultPrevented).toBe(false)
  })

  it('registers context connection; new notebook gets it as default', async () => {
    const { w } = make({ ctx: CTX })
    await flushPromises()
    const sel = w.find('[data-test=picker]')
    expect(sel.exists()).toBe(true)
    expect((sel.element as HTMLSelectElement).value).toBe('c1')
    w.unmount()
  })

  it('a hung host.getConnections does not delay ready or auto-new', async () => {
    const { w } = make({ ctx: CTX, extra: { getConnections: () => new Promise(() => {}) } })
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    w.unmount()
  })

  it('use-connection context → auto-new notebook with that name even when connectionsApi is false (seedFromContext)', async () => {
    const { w, bridge } = make({ ctx: CTX, caps: { connectionsApi: false } })
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    expect(writes(bridge)).toHaveLength(0)
    w.unmount()
  })

  it('pre-seeded legacy connections.v1 / connections.json do not appear in the picker', async () => {
    const { w } = make({ ctx: CTX, extra: { storageGet: async (k: string) => (k === 'connections.v1' ? [{ id: 'old', name: 'legacy-conn', dbType: 'x' }] : undefined), connections: [{ id: 'h1', name: 'hostconn', dialect: 'postgres', connected: true, readOnly: false }] }, handlers: { 'connections/list': () => ({ items: [{ id: 'old2', name: 'legacy-sidecar', dbType: 'x' }] }) } })
    await flushPromises()
    const text = w.find('[data-test=picker]').text()
    expect(text).toContain('hostconn')
    expect(text).not.toContain('legacy')
    w.unmount()
  })

  it('refreshes connections on window focus / visible and removes listeners on unmount', async () => {
    let now = 100_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let lists = 0
    const { w } = make({ extra: { getConnections: async () => { lists++; return [] } } })
    await flushPromises()
    const base = lists
    expect(base).toBeGreaterThan(0)
    now += 2000
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(lists).toBe(base + 1)
    now += 2000
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(lists).toBe(base + 2)
    w.unmount()
    now += 2000
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(lists).toBe(base + 2)
    spy.mockRestore()
  })

  it('context refresh while a notebook is open does not replace it', async () => {
    const { w, emitCtx } = make({ ctx: CTX })
    await flushPromises()
    await w.find('[data-test=empty-add-md]').trigger('click')
    emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
    await flushPromises()
    expect(w.findAll('[data-test=block]').length).toBe(1)
    expect(w.findAll('[data-test=picker] option').length).toBe(3)
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    w.unmount()
  })

  it('Ctrl+S on dirty named notebook writes with expectedMtimeMs', async () => {
    const { w, bridge } = make()
    await flushPromises()
    await w.find('[data-test=path-input], .sp-path input').setValue('/tmp/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    await w.find('[data-test=empty-add-md]').trigger('click')
    expect(w.find('[data-test=dirty]').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
    await flushPromises()
    const ws = writes(bridge)
    expect(ws.length).toBe(1)
    expect(ws[0].args.params).toMatchObject({ path: '/tmp/a.sqlnb', expectedMtimeMs: 100 })
    w.unmount()
  })

  it('dataApi false shows banner and disables run', async () => {
    const { w } = make({ caps: { dataApi: false } })
    await flushPromises()
    expect(w.find('[data-test=banner]').text()).toContain('does not support read-only queries')
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=run-all]').attributes('disabled')).toBeDefined()
    await w.find('[data-test=empty-add-sql]').trigger('click')
    expect(w.find('[data-test=run]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('dirty + Open: Cancel keeps, Discard loads other file, Save writes first', async () => {
    const other = createEmptyNotebook()
    const { w, bridge } = make({ handlers: {
      'notebook/pickOpen': () => ({ path: '/tmp/b.sqlnb' }),
      'notebook/pickSave': () => ({ path: '/tmp/new.sqlnb' }),
      'notebook/read': () => ({ text: serializeNotebook(other), mtimeMs: 5 }),
    } })
    await flushPromises()
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    await w.find('[data-test=empty-add-md]').trigger('click')
    const btn = (label: string) => w.findAll('.cd-btn').find((x) => x.text() === label)!
    await w.find('[data-test=open]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('You have unsaved changes. Save, discard or cancel?')
    await btn('Cancel').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test=block]').length).toBe(1)
    await w.find('[data-test=open]').trigger('click')
    await flushPromises()
    await btn('Discard').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=filename]').text()).toContain('b.sqlnb')
    expect(writes(bridge).length).toBe(0)
    // Save path: dirty again, then Open -> Save writes before reading
    await w.find('[data-test=empty-add-md]').trigger('click')
    await flushPromises()
    const readsBefore = bridge.calls.filter((c: any) => c.args?.method === 'notebook/read').length
    await w.find('[data-test=open]').trigger('click')
    await flushPromises()
    await btn('Save').trigger('click')
    await flushPromises()
    const order = bridge.calls.map((c: any) => c.args?.method)
    expect(order.lastIndexOf('notebook/write')).toBeLessThan(order.lastIndexOf('notebook/read'))
    expect(bridge.calls.filter((c: any) => c.args?.method === 'notebook/read').length).toBe(readsBefore + 1)
    w.unmount()
  })

  it('first context arriving while start page shows auto-creates; later ones never change the notebook', async () => {
    const { w, emitCtx } = make()
    await flushPromises()
    emitCtx(CTX)
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    w.unmount()
  })

  it('notebook created before any context stays without default', async () => {
    const { w, emitCtx } = make()
    await flushPromises()
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    emitCtx(CTX)
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('')
    w.unmount()
  })

  it('Home: dirty shows confirm; cancel stays; discard goes to start with refreshed recent', async () => {
    let items: any[] = []
    const { w } = make({ handlers: { 'notebook/recent': () => ({ items }) } })
    await flushPromises()
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    await w.find('[data-test=empty-add-md]').trigger('click')
    await w.find('[data-test=home]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('You have unsaved changes')
    await w.findAll('.cd-btn').find((x) => x.text() === 'Cancel')!.trigger('click')
    await flushPromises()
    expect(w.find('[data-test=toolbar]').exists()).toBe(true)
    items = [{ path: '/x/recent.sqlnb', openedAt: Date.now() }]
    await w.find('[data-test=home]').trigger('click')
    await flushPromises()
    await w.findAll('.cd-btn').find((x) => x.text() === 'Discard')!.trigger('click')
    await flushPromises()
    expect(w.find('[data-test=toolbar]').exists()).toBe(false)
    expect(w.findAll('[data-test=recent-item]').length).toBe(1)
    w.unmount()
  })

  it('Stop aborts between blocks and shows stopping', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const queryData = vi.fn(async () => { await gate; return { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'postgres' } })
    const { w, ef } = make({ ctx: CTX, extra: { queryData } })
    await flushPromises()
    await w.find('[data-test=empty-add-sql]').trigger('click')
    await w.findAll('[data-test=add-sql]')[0].trigger('click')
    ef.mock.calls.forEach((c: any) => c[1].onChange('select 1'))
    await flushPromises()
    await w.find('[data-test=run-all]').trigger('click')
    await flushPromises()
    expect(queryData).toHaveBeenCalledTimes(1)
    await w.find('[data-test=stop]').trigger('click')
    expect(w.find('[data-test=stop]').text()).toContain('Stopping')
    release()
    await flushPromises()
    expect(queryData).toHaveBeenCalledTimes(1)
    expect(w.find('[data-test=stop]').exists()).toBe(false)
    w.unmount()
  })

  it('init failure shows error with Retry', async () => {
    let fail = true
    const { w } = make({ extra: { ready: async () => { if (fail) throw new Error('boom') } } })
    await flushPromises()
    expect(w.find('[data-test=init-error]').text()).toContain('boom')
    fail = false
    await w.find('[data-test=retry]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=init-error]').exists()).toBe(false)
    expect(w.find('[data-test=new]').exists()).toBe(true)
    w.unmount()
  })

  it('unmount while ready() pending does not subscribe', async () => {
    setLocale('en')
    let resolve!: () => void
    const onContext = vi.fn(() => () => {})
    const onEnv = vi.fn(() => () => {})
    const bridge = createFakeBridge({ ready: () => new Promise<void>((r) => { resolve = r }), onContext, onEnv } as any)
    const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() } })
    w.unmount()
    resolve()
    await flushPromises()
    expect(onContext).not.toHaveBeenCalled()
    expect(onEnv).not.toHaveBeenCalled()
  })

  it('external change dialog has distinct title and explanation', async () => {
    const { w } = make({ handlers: { 'notebook/write': () => { throw Object.assign(new Error('[-32011] changed'), { code: -32011 }) } } })
    await flushPromises()
    await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    await w.find('[data-test=empty-add-md]').trigger('click')
    await w.find('[data-test=save]').trigger('click')
    await flushPromises()
    expect(w.find('.cd-title').text()).toBe('File changed on disk')
    expect(w.find('.cd-msg').text()).toContain('Reload: discard my changes')
    w.unmount()
  })

  it('beforeunload is prevented only while dirty, and removed on unmount (I4)', async () => {
    const { w } = make()
    await flushPromises()
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(fire()).toBe(false)
    await w.find('[data-test=empty-add-md]').trigger('click')
    expect(fire()).toBe(true)
    w.unmount()
    expect(fire()).toBe(false)
  })

  it('Save is disabled on a clean named notebook, enabled when dirty (M5)', async () => {
    const { w } = make()
    await flushPromises()
    await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=save]').attributes('disabled')).toBeDefined()
    await w.find('[data-test=empty-add-md]').trigger('click')
    expect(w.find('[data-test=save]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('pending connection applies once to the auto-created notebook without marking it dirty (M2)', async () => {
    const { w } = make({ ctx: CTX })
    await flushPromises()
    expect(w.find('[data-test=dirty]').exists()).toBe(false)
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
    await w.find('[data-test=home]').trigger('click')
    await flushPromises()
    await w.find('[data-test=new]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=dirty]').exists()).toBe(false)
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('')
    w.unmount()
  })

  it('unmount aborts an in-flight run-all (M1)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const nb = createEmptyNotebook()
    nb.settings.defaultConnection = 'main'
    nb.blocks.push({ id: 'b_aaaaaa', type: 'sql', content: 'select 1' }, { id: 'b_bbbbbb', type: 'sql', content: 'select 2' })
    let calls = 0
    const { w } = make({
      ctx: CTX,
      handlers: { 'notebook/read': () => ({ text: serializeNotebook(nb), mtimeMs: 1 }) },
      extra: { queryData: async () => { calls++; await gate; return { columns: [], rows: [], truncated: false } } },
    })
    await flushPromises()
    await w.find('[data-test=home]').trigger('click')
    await flushPromises()
    await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    await w.find('[data-test=run-all]').trigger('click')
    await flushPromises()
    w.unmount()
    release()
    await flushPromises()
    expect(calls).toBe(1)
  })

  describe('opens straight into a new notebook from a connection', () => {
    const PG = { id: 'c1', name: 'pg', dbType: 'postgres', database: 'app' }
    it('initial connection context skips start page; clean, default connection', async () => {
      const { w } = make({ ctx: PG })
      await flushPromises()
      expect(w.find('[data-test=toolbar]').exists()).toBe(true)
      expect(w.find('[data-test=dirty]').exists()).toBe(false)
      expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
      w.unmount()
    })
    it('no connection context keeps the start page', async () => {
      const { w } = make({ ctx: {} })
      await flushPromises()
      expect(w.find('[data-test=toolbar]').exists()).toBe(false)
      expect(w.find('[data-test=new]').exists()).toBe(true)
      w.unmount()
    })
    it('later context refresh never replaces or modifies an edited notebook', async () => {
      const { w, emitCtx } = make({ ctx: PG })
      await flushPromises()
      await w.find('[data-test=empty-add-md]').trigger('click')
      emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
      await flushPromises()
      expect(w.findAll('[data-test=block]').length).toBe(1)
      expect(w.find('[data-test=dirty]').exists()).toBe(true)
      expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
      w.unmount()
    })
    it('after Home, a new context does not auto-create', async () => {
      const { w, emitCtx } = make({ ctx: PG })
      await flushPromises()
      await w.find('[data-test=home]').trigger('click')
      await flushPromises()
      emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
      await flushPromises()
      expect(w.find('[data-test=toolbar]').exists()).toBe(false)
      expect(w.find('[data-test=new]').exists()).toBe(true)
      w.unmount()
    })
    describe('late first context', () => {
      const clean = (w: any) => w.find('[data-test=dirty]').exists() === false
      it('first valid context via onContext auto-creates once; second does not', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        emitCtx(PG)
        emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
        await flushPromises()
        expect(w.find('[data-test=toolbar]').exists()).toBe(true)
        expect(clean(w)).toBe(true)
        expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
        w.unmount()
      })
      it('user created a notebook first: context does not replace it', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        await w.find('[data-test=new]').trigger('click')
        await flushPromises()
        await w.find('[data-test=empty-add-md]').trigger('click')
        emitCtx(PG)
        await flushPromises()
        expect(w.findAll('[data-test=block]').length).toBe(1)
        expect(w.find('[data-test=dirty]').exists()).toBe(true)
        w.unmount()
      })
      it('user New in flight when first context arrives: exactly one notebook, no auto default', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        void w.find('[data-test=new]').trigger('click')
        emitCtx(PG)
        await flushPromises()
        expect(w.find('[data-test=toolbar]').exists()).toBe(true)
        expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('')
        w.unmount()
      })
      it('user Open in flight when first context arrives: the opened file wins, no auto default', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        const other = createEmptyNotebook()
        const { w, emitCtx } = make({ handlers: { 'notebook/read': async () => { await gate; return { text: serializeNotebook(other), mtimeMs: 5 } } } })
        await flushPromises()
        await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
        void w.find('[data-test=open-path]').trigger('click')
        await flushPromises()
        emitCtx(PG)
        await flushPromises()
        release()
        await flushPromises()
        expect(w.find('[data-test=filename]').text()).toContain('a.sqlnb')
        expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('')
        w.unmount()
      })
      it('back-to-back contexts: the first connection wins', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        emitCtx(PG)
        emitCtx({ id: 'c2', name: 'second', dbType: 'mysql' })
        emitCtx({ id: 'c3', name: 'third', dbType: 'mysql' })
        await flushPromises()
        expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
        w.unmount()
      })
      it('invalid first context does not consume the one-shot', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        emitCtx({ dbType: 'x' })
        await flushPromises()
        emitCtx(PG)
        await flushPromises()
        expect(w.find('[data-test=toolbar]').exists()).toBe(true)
        expect((w.find('[data-test=picker]').element as HTMLSelectElement).value).toBe('c1')
        w.unmount()
      })
      it('invalid context does not auto-create or throw', async () => {
        const { w, emitCtx } = make()
        await flushPromises()
        emitCtx({ dbType: 'x' })
        await flushPromises()
        expect(w.find('[data-test=toolbar]').exists()).toBe(false)
        w.unmount()
      })
    })
  })
})

describe('App catalog cache', () => {
  it('provides one shared CatalogKey cache across blocks', async () => {
    document.body.innerHTML = ''
    const queryData = vi.fn(async () => ({ columns: [{ name: 'n' }], rows: [['x']], truncated: false, elapsedMs: 1, dbType: 'postgres' }))
    const { w } = make({ ctx: CTX, extra: { queryData } })
    await flushPromises()
    await w.find('[data-test=empty-add-sql]').trigger('click'); await flushPromises()
    await w.find('[data-test=add-sql]').trigger('click'); await flushPromises()
    const dbs = w.findAll('[data-test=block] [data-test=cat-database]')
    expect(dbs).toHaveLength(2)
    await dbs[0].trigger('focus'); await flushPromises()
    await dbs[1].trigger('focus'); await flushPromises()
    expect(queryData).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})

describe('App analysis blocks on open', () => {
  it('opening a notebook with a big number and chart over an inline result computes them without a manual refresh', async () => {
    document.body.innerHTML = ''
    const nb = createEmptyNotebook()
    nb.settings.outputs = 'inline'
    nb.blocks.push(
      { id: 'b_sales1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' }, outputs: { columns: [{ name: 'amount', type: 'numeric' }], rows: [['12.50'], ['3']], executedAt: 'T1', elapsedMs: 1, truncated: false } } as any,
      { id: 'b_big001', type: 'big-number', metadata: { data: 'sales', value: { field: 'amount', aggregate: 'sum' }, label: 'Total' } } as any,
    )
    const queries: string[] = []
    const { w } = make({
      ctx: CTX,
      handlers: {
        'notebook/read': () => ({ text: serializeNotebook(nb), mtimeMs: 1 }),
        'engine/register': () => ({}),
        'engine/query': (p: any) => { queries.push(p.sql); return { columns: [], rows: [[15.5]], truncated: false, elapsedMs: 1 } },
      },
    })
    await flushPromises()
    await w.find('[data-test=home]').trigger('click')
    await flushPromises()
    await w.find('.sp-path input').setValue('/tmp/a.sqlnb')
    await w.find('[data-test=open-path]').trigger('click')
    await flushPromises()
    await flushPromises()
    expect(w.find('[data-test=bn-value]').text()).toBe('15.5')
    expect(queries.some((q) => /sum\("amount"\)/.test(q))).toBe(true)
    w.unmount()
  })
})

describe('App engine client', () => {
  it('closes the engine session on unmount', async () => {
    document.body.innerHTML = ''
    const { w, bridge } = make({ ctx: CTX, handlers: { 'engine/close': () => ({}) } })
    await flushPromises()
    const closes = () => (bridge as any).calls.filter((c: any) => c.method === 'invoke' && c.args.method === 'engine/close')
    expect(closes()).toHaveLength(0)
    w.unmount()
    await flushPromises()
    expect(closes()).toHaveLength(1)
  })

  describe('global maxRows', () => {
    const toStart = async (a: { w: any }) => { await a.w.find('[data-test=home]').trigger('click'); await flushPromises() }
    const sharedStorage = () => {
      const m = new Map<string, unknown>()
      return { m, extra: { storageGet: async (k: string) => (m.get(k) ?? null), storageSet: async (k: string, v: unknown) => { m.set(k, v) } } }
    }
    it('persists and survives a new App instance; notebook stays clean', async () => {
      const st = sharedStorage()
      const a = make({ ctx: CTX, extra: st.extra })
      await flushPromises()
      expect(a.w.find('[data-test=max-rows]').exists()).toBe(false)
      await toStart(a)
      const inp = a.w.find('[data-test=max-rows]')
      expect(inp.exists()).toBe(true)
      ;(inp.element as HTMLInputElement).value = '250'
      await inp.trigger('change')
      await flushPromises()
      expect(st.m.get('settings.maxRows.v1')).toBe(250)
      expect(a.w.text()).not.toContain('●')
      a.w.unmount()
      const b = make({ ctx: CTX, extra: st.extra })
      await flushPromises()
      await toStart(b)
      expect((b.w.find('[data-test=max-rows]').element as HTMLInputElement).value).toBe('250')
      b.w.unmount()
    })
    it('a second page picks up the value on window focus', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
      const st = sharedStorage()
      const a = make({ ctx: CTX, extra: st.extra })
      const b = make({ ctx: CTX, extra: st.extra })
      await flushPromises()
      await toStart(a); await toStart(b)
      const inp = a.w.find('[data-test=max-rows]')
      ;(inp.element as HTMLInputElement).value = '321'
      await inp.trigger('change')
      await flushPromises()
      vi.setSystemTime(Date.now() + 1100)
      window.dispatchEvent(new Event('focus'))
      await flushPromises()
      expect((b.w.find('[data-test=max-rows]').element as HTMLInputElement).value).toBe('321')
      a.w.unmount(); b.w.unmount()
      } finally { vi.useRealTimers() }
    })
    it('hung storage does not block startup; value applies when it resolves', async () => {
      let release!: (v: unknown) => void
      const gate = new Promise((r) => { release = r })
      const a = make({ ctx: CTX, extra: { storageGet: (k: string) => (k === 'settings.maxRows.v1' ? gate : Promise.resolve(null)), storageSet: async () => {} } })
      await flushPromises()
      await toStart(a)
      expect(a.w.find('[data-test=max-rows]').exists()).toBe(true)
      expect((a.w.find('[data-test=max-rows]').element as HTMLInputElement).value).toBe('5000')
      release(77)
      await flushPromises()
      expect((a.w.find('[data-test=max-rows]').element as HTMLInputElement).value).toBe('77')
      a.w.unmount()
    })
    it('max-rows input is controlled: typed text survives a re-render, invalid entry reverts visibly', async () => {
      const a = make({ ctx: CTX, caps: { storage: false } })
      await flushPromises()
      await toStart(a)
      const el = () => a.w.find('[data-test=max-rows]').element as HTMLInputElement
      el().value = '12'
      await a.w.find('[data-test=max-rows]').trigger('input')
      setLocale('zh-CN')
      await a.w.vm.$nextTick()
      expect(el().value).toBe('12')
      setLocale('en')
      el().value = '0'
      await a.w.find('[data-test=max-rows]').trigger('input')
      await a.w.find('[data-test=max-rows]').trigger('change')
      await flushPromises()
      expect(el().value).toBe('5000')
      expect(a.w.find('[data-test=max-rows-hint]').exists()).toBe(true)
      a.w.unmount()
    })
    it('storage unavailable: default 5000 and in-memory change works', async () => {
      const a = make({ ctx: CTX, caps: { storage: false } })
      await flushPromises()
      await toStart(a)
      const inp = a.w.find('[data-test=max-rows]')
      expect((inp.element as HTMLInputElement).value).toBe('5000')
      ;(inp.element as HTMLInputElement).value = '40'
      await inp.trigger('change')
      await flushPromises()
      expect((a.w.find('[data-test=max-rows]').element as HTMLInputElement).value).toBe('40')
      a.w.unmount()
    })
  })

  it('applies saved AI opt-outs at app start without mounting the start page', async () => {
    const { w, bridge } = make({
      ctx: CTX, caps: { aiCompletion: true },
      extra: { storageGet: async (k: string) => (k === 'ai.settings.v1' ? { send: { schema: true, sql: true, data: false }, model: null } : null) },
      requestHandlers: { 'host.ai.listModels': () => [] },
    })
    await flushPromises()
    expect(w.find('[data-test=ai-settings]').exists()).toBe(false)
    expect((w.vm as any).aiSettings.send.value.data).toBe(false)
    w.unmount()
  })

  it('does not refresh AI models without the aiCompletion capability', async () => {
    const { w, bridge } = make({ ctx: CTX, caps: { aiCompletion: false } })
    await flushPromises()
    expect(hostAiCalls(bridge as any, /listModels/)).toHaveLength(0)
    w.unmount()
  })

  it('positive control: with aiCompletion the same helper sees host.ai.listModels', async () => {
    const { w, bridge } = make({ ctx: CTX, caps: { aiCompletion: true }, requestHandlers: { 'host.ai.listModels': () => [] } })
    await flushPromises()
    expect(hostAiCalls(bridge as any, /listModels/).length).toBeGreaterThan(0)
    w.unmount()
  })
})
