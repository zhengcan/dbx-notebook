import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../src/App.vue'
import { createFakeBridge } from '../src/host/fakeBridge'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'
import { serializeNotebook, createEmptyNotebook, parseNotebook } from '@sqlnb/format'

const hc = (id: string, name: string) => ({ id, name, dialect: 'postgres', connected: true, readOnly: false })
function nbText(def: string, blockConn?: string) {
  const nb = createEmptyNotebook()
  nb.settings.defaultConnection = def
  nb.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: blockConn ? { connection: blockConn } : {} } as any)
  return serializeNotebook(nb)
}
const EMPTY = serializeNotebook(createEmptyNotebook())

function make(o: { text?: string; extra?: Record<string, any>; handlers?: Record<string, any>; locale?: string } = {}) {
  setLocale((o.locale as any) ?? 'en')
  const bridge = createFakeBridge({
    locale: o.locale,
    ...(o.extra ?? {}),
    invokeHandlers: {
      'notebook/recent': () => ({ items: [] }),
      'notebook/read': () => ({ text: o.text ?? EMPTY, mtimeMs: 100 }),
      'notebook/write': () => ({ mtimeMs: 200 }),
      'notebook/touchRecent': () => ({}),
      ...(o.handlers ?? {}),
    },
  } as any)
  const w = mount(App, { props: { bridgeFactory: () => bridge, editorFactory: fakeEditorFactory() }, attachTo: document.body })
  return { w, bridge: bridge as any }
}
const titles = (b: any) => b.calls.filter((c: any) => c.method === 'request' && c.args.method === 'host.setTitle').map((c: any) => c.args.params.title)
const writes = (b: any) => b.calls.filter((c: any) => c.method === 'invoke' && c.args.method === 'notebook/write')
async function openFile(w: any, path = '/tmp/a.sqlnb') {
  await w.find('.sp-path input').setValue(path)
  await w.find('[data-test=open-path]').trigger('click')
  await flushPromises()
}
const settle = async (ms = 500) => { await vi.advanceTimersByTimeAsync(ms); await flushPromises() }
const save = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })); await flushPromises() }

describe('host tab title + connections integration', () => {
  beforeEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

  it('open → name; edit → ● name; save → name; close → null', async () => {
    vi.useFakeTimers()
    const { w, bridge } = make()
    await flushPromises(); await settle()
    await openFile(w); await settle()
    expect(bridge.title).toBe('a')
    await w.find('[data-test=empty-add-md]').trigger('click'); await settle()
    expect(bridge.title).toBe('● a')
    await save(); await settle()
    expect(bridge.title).toBe('a')
    w.unmount(); await settle()
    expect(bridge.title).toBe(null)
    vi.useRealTimers()
  })

  it('save-as changes the title to the new file name', async () => {
    vi.useFakeTimers()
    const { w, bridge } = make({ handlers: { 'notebook/pickSave': () => ({ path: '/tmp/other.sqlnb' }) } })
    await flushPromises(); await settle()
    await openFile(w); await settle()
    await w.find('[data-test=save-as]').trigger('click'); await flushPromises(); await settle()
    expect(bridge.title).toBe('other')
    w.unmount(); vi.useRealTimers()
  })

  it('new unsaved notebook shows the untitled label (en and zh)', async () => {
    for (const [loc, label] of [['en', 'Untitled notebook'], ['zh-CN', '未命名笔记本']] as const) {
      vi.useFakeTimers()
      const { w, bridge } = make({ locale: loc })
      await flushPromises(); await settle()
      await w.find('[data-test=new]').trigger('click'); await flushPromises(); await settle()
      expect(bridge.title).toBe(label)
      w.unmount(); vi.useRealTimers()
    }
  })

  it('title requests are throttled: a burst of edits sends few requests', async () => {
    vi.useFakeTimers()
    const { w, bridge } = make({ text: nbText('') })
    await flushPromises(); await settle()
    await openFile(w); await settle()
    for (let i = 0; i < 10; i++) { await w.find('[data-test=add-md]').trigger('click'); await vi.advanceTimersByTimeAsync(10) }
    await settle(2000)
    expect(titles(bridge).length).toBeLessThanOrEqual(3)
    expect(bridge.title).toBe('● a')
    w.unmount(); vi.useRealTimers()
  })

  it('floating window (workbenchTitle false): zero title requests, no error toast', async () => {
    vi.useFakeTimers()
    const { w, bridge } = make({ extra: { floating: true } })
    await flushPromises(); await settle()
    await openFile(w)
    await w.find('[data-test=empty-add-md]').trigger('click'); await settle()
    await save(); await settle()
    w.unmount(); await settle()
    expect(titles(bridge)).toHaveLength(0)
    expect(bridge.calls.filter((c: any) => c.method === 'request' && c.args.method === 'host.getTitle')).toHaveLength(0)
    expect(document.querySelector('[data-test=toast]')).toBeNull()
    vi.useRealTimers()
  })

  it('connectionsApi false: picker shows unavailable hint, no list call, no missing hints, no toast', async () => {
    const { w, bridge } = make({ text: nbText('main'), extra: { caps: { connectionsApi: false } } })
    await flushPromises()
    await openFile(w)
    expect(w.find('[data-test=picker-unavailable]').exists()).toBe(true)
    expect(bridge.calls.filter((c: any) => c.method === 'request' && c.args.method === 'host.getConnections')).toHaveLength(0)
    expect(w.find('[data-test=notebook-conn-missing]').exists()).toBe(false)
    expect(w.find('[data-test=run]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test=toast]').exists()).toBe(false)
    w.unmount()
  })

  it('permission denied: same degraded behavior, notebook still opens', async () => {
    const { w } = make({ text: nbText('main'), extra: { denyConnections: true } })
    await flushPromises()
    await openFile(w)
    expect(w.find('[data-test=picker-unavailable]').exists()).toBe(true)
    expect(w.find('[data-test=block]').exists()).toBe(true)
    expect(w.find('[data-test=notebook-conn-missing]').exists()).toBe(false)
    expect(w.find('[data-test=run]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test=toast]').exists()).toBe(false)
    w.unmount()
  })

  it('capability matrix: workbenchTitle × connectionsApi are independent', async () => {
    for (const [title, api] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      vi.useFakeTimers()
      const { w, bridge } = make({ extra: { caps: { workbenchTitle: title, connectionsApi: api }, connections: [hc('c1', 'main')] } })
      await flushPromises(); await settle()
      await openFile(w); await settle()
      expect(titles(bridge).length > 0).toBe(title)
      expect(w.find('[data-test=picker-unavailable]').exists()).toBe(!api)
      expect(w.find('[data-test=toast]').exists()).toBe(false)
      w.unmount(); vi.useRealTimers()
    }
  })

  it('missing connection: banner + block hint + run disabled; saved bytes keep the missing name; adding it clears the hints on refresh', async () => {
    const items: any[] = [hc('c1', 'other')]
    const text = nbText('gone', 'gone')
    const { w, bridge } = make({ text, extra: { connections: items } })
    await flushPromises()
    await openFile(w)
    expect(w.find('[data-test=notebook-conn-missing]').exists()).toBe(true)
    expect(w.find('[data-test=block-conn-missing]').exists()).toBe(true)
    expect(w.find('[data-test=run]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test=run]').attributes('title')).toContain('gone')
    expect(w.find('[data-test=dirty]').exists()).toBe(false)
    await w.find('[data-test=add-md]').trigger('click')
    await save()
    const last = writes(bridge).at(-1)
    expect(last).toBeDefined()
    const saved: any = parseNotebook(last.args.params.text)
    expect(saved.settings.defaultConnection).toBe('gone')
    expect(saved.blocks[0].metadata.connection).toBe('gone')
    expect(saved.blocks[0].content).toBe('select 1')
    items.push(hc('c2', 'gone'))
    await w.find('[data-test=picker-refresh]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test=notebook-conn-missing]').exists()).toBe(false)
    expect(w.find('[data-test=block-conn-missing]').exists()).toBe(false)
    expect(w.find('[data-test=run]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('opening a notebook with a missing connection does not mark it dirty or write it', async () => {
    const { w, bridge } = make({ text: nbText('gone'), extra: { connections: [hc('c1', 'other')] } })
    await flushPromises()
    await openFile(w)
    expect(w.find('[data-test=notebook-conn-missing]').exists()).toBe(true)
    expect(w.find('[data-test=dirty]').exists()).toBe(false)
    expect(writes(bridge)).toHaveLength(0)
    w.unmount()
  })

  it('saved .sqlnb never contains connection ids, dialect or provider from the host list', async () => {
    const { w, bridge } = make({ text: nbText('main', 'main'), extra: { connections: [{ id: 'SECRET-ID-777', name: 'main', dialect: 'SENTINELDIALECT', connected: true, readOnly: true, provider: 'SENTINELPROV' }] } })
    await flushPromises()
    await openFile(w)
    await w.find('[data-test=add-md]').trigger('click')
    await save()
    const ws = writes(bridge)
    expect(ws.length).toBeGreaterThan(0)
    for (const c of ws) {
      expect(c.args.params.text).not.toContain('SECRET-ID-777')
      expect(c.args.params.text).not.toContain('SENTINELDIALECT')
      expect(c.args.params.text).not.toContain('SENTINELPROV')
    }
    const stored = JSON.stringify(bridge.calls.filter((c: any) => c.method === 'storageSet'))
    expect(stored).not.toContain('SENTINELDIALECT')
    w.unmount()
  })
})
