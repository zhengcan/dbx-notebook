import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed } from 'vue'
import pickerSrc from '../src/shell/ConnectionPicker.vue?raw'
import ConnectionPicker from '../src/shell/ConnectionPicker.vue'
import SqlBlock from '../src/blocks/SqlBlock.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { BridgeKey, CanRunKey, ConnectionsKey, StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'
import { serializeNotebook } from '@sqlnb/format'
import { makeConnections } from './connectionsEnv'
import { fakeEditorFactory } from './helpers'

const HOST = [
  { id: 'c1', name: 'prod', dialect: 'postgres', connected: true, readOnly: false },
  { id: 'c2', name: 'dev', dialect: 'mysql', connected: false },
  { id: 'c3', name: 'alpha', dialect: 'sqlite', connected: true },
  { id: 'c4', name: 'zed', dialect: 'mysql', connected: false },
]
const ALL_OFF = HOST.map((c) => ({ ...c, connected: false }))

async function env(conns: any[], def?: string, bridgeOpts: any = {}, blockConn?: string) {
  const { bridge, connections } = await makeConnections(conns, bridgeOpts)
  const store = useNotebookStore()
  if (def) store.nb.value.settings.defaultConnection = def
  store.nb.value.blocks.push({ id: 'b1', type: 'sql', content: 'select 1', metadata: blockConn ? { connection: blockConn } : {} })
  store.dirty.value = false
  const provide = { [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [CanRunKey as symbol]: computed(() => true) }
  return {
    store, connections, provide,
    picker: () => mount(ConnectionPicker, { global: { provide } }),
    block: () => mount(SqlBlock, { props: { blockId: 'b1', editorFactory: fakeEditorFactory() }, global: { provide } }),
  }
}
const groups = (w: any, sel: string) => w.findAll(`${sel} optgroup`).map((g: any) => ({ label: g.attributes('label'), opts: g.findAll('option').map((o: any) => o.text()) }))

describe('connection picker groups', () => {
  beforeEach(() => setLocale('en'))

  it('renders optgroups connected → not connected, sorted, en and zh labels', async () => {
    const e = await env(HOST)
    const w = e.picker()
    expect(groups(w, '[data-test=picker]')).toEqual([
      { label: 'Connected', opts: ['alpha (sqlite) · connected', 'prod (postgres) · connected'] },
      { label: 'Not connected', opts: ['dev (mysql) · not connected', 'zed (mysql) · not connected'] },
    ])
    setLocale('zh')
    const z = e.picker()
    expect(groups(z, '[data-test=picker]').map((g: any) => g.label)).toEqual(['已连接', '未连接'])
    expect(z.find('[data-test=picker] optgroup:last-of-type option').text()).toContain('未连接')
  })

  it('disconnected options are disabled with state in text/aria-label/title; connected are not', async () => {
    const w = (await env(HOST)).picker()
    const [on, off] = w.findAll('[data-test=picker] optgroup')
    for (const o of on.findAll('option')) expect(o.attributes('disabled')).toBeUndefined()
    for (const o of off.findAll('option')) {
      expect(o.attributes('disabled')).toBeDefined()
      expect(o.attributes('aria-label')).toContain('not connected')
      expect(o.attributes('title')).toContain('not connected')
    }
  })

  it('a disabled option cannot be picked (nb unchanged, not dirty)', async () => {
    const e = await env(HOST)
    const w = e.picker()
    const sel = w.find('[data-test=picker]')
    ;(sel.element as HTMLSelectElement).value = 'c2'
    await sel.trigger('change')
    expect(e.store.nb.value.settings.defaultConnection).toBeUndefined()
    expect(e.store.dirty.value).toBe(false)
  })

  it('current default that is not connected stays selected; nb unchanged after mount + refresh', async () => {
    const e = await env(HOST, 'dev')
    const before = serializeNotebook(e.store.nb.value)
    const w = e.picker()
    await e.connections.refresh({ force: true })
    await flushPromises()
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).selectedOptions[0].textContent).toBe('dev (mysql) · not connected')
    expect(serializeNotebook(e.store.nb.value)).toBe(before)
    expect(e.store.dirty.value).toBe(false)
  })

  it('missing current → "Not found in DBX" group last with disabled warning option; no rewrite', async () => {
    const e = await env(HOST, 'ghost')
    const w = e.picker()
    const g = groups(w, '[data-test=picker]')
    expect(g.map((x: any) => x.label)).toEqual(['Connected', 'Not connected', 'Not found in DBX'])
    expect(g[2].opts).toEqual(['⚠ ghost'])
    expect(w.find('[data-test=picker-missing-option]').attributes('disabled')).toBeDefined()
    expect(e.store.nb.value.settings.defaultConnection).toBe('ghost')
    expect(e.store.dirty.value).toBe(false)
  })

  it('no empty optgroup is rendered', async () => {
    const w = (await env(HOST.filter((c) => c.connected))).picker()
    expect(groups(w, '[data-test=picker]').map((g: any) => g.label)).toEqual(['Connected'])
    const w2 = (await env(ALL_OFF)).picker()
    expect(groups(w2, '[data-test=picker]').map((g: any) => g.label)).toEqual(['Not connected'])
  })

  it('all disconnected → status hint (en/zh); current stays shown; one connected → hint absent', async () => {
    const e = await env(ALL_OFF, 'dev')
    const w = e.picker()
    const h = w.find('[data-test=picker-none-connected]')
    expect(h.attributes('role')).toBe('status')
    expect(h.text()).toContain('No connection is connected')
    expect((w.find('[data-test=picker]').element as HTMLSelectElement).selectedOptions[0].textContent).toContain('dev')
    setLocale('zh')
    expect((await env(ALL_OFF)).picker().find('[data-test=picker-none-connected]').text()).toContain('没有已连接')
    setLocale('en')
    expect((await env(HOST)).picker().find('[data-test=picker-none-connected]').exists()).toBe(false)
  })

  it('empty host list → picker-empty only, no none-connected hint', async () => {
    const w = (await env([])).picker()
    expect(w.find('[data-test=picker-empty]').exists()).toBe(true)
    expect(w.find('[data-test=picker-none-connected]').exists()).toBe(false)
  })

  it('unavailable state: no groups, no none-connected hint', async () => {
    const e = await env([], 'prod', { caps: { connectionsApi: false } })
    const w = e.picker()
    expect(w.findAll('[data-test=picker] optgroup').length).toBe(0)
    expect(w.find('[data-test=picker-none-connected]').exists()).toBe(false)
    expect(w.find('[data-test=picker-unavailable]').exists()).toBe(true)
  })

  it('duplicate names: mapping select grouped and still maps; name connected if any is', async () => {
    const e = await env([
      { id: 'a1', name: 'same', connected: false }, { id: 'a2', name: 'same', connected: true },
    ], 'same')
    const w = e.picker()
    expect(groups(w, '[data-test=picker-map]').map((g: any) => g.label)).toEqual(['Connected', 'Not connected'])
    await w.find('[data-test=picker-map]').setValue('a2')
    await flushPromises()
    expect(e.connections.resolve('same')).toMatchObject({ status: 'ok' })
  })

  it('option styling uses theme tokens only', () => {
    const style = pickerSrc.slice(pickerSrc.indexOf('<style'))
    expect(style).toContain('option:disabled')
    expect(style).toMatch(/option:disabled[^}]*var\(--color-muted-foreground/)
  })
})

describe('SqlBlock selector groups', () => {
  beforeEach(() => setLocale('en'))

  it('groups names (any-connected counts), default option first, disabled for disconnected', async () => {
    const e = await env([...HOST, { id: 'c5', name: 'dev', dialect: 'mysql', connected: true }], 'prod')
    const w = e.block()
    const sel = w.find('[data-test=conn]')
    expect(sel.find(':scope > option').attributes('value')).toBe('')
    expect(groups(w, '[data-test=conn]')).toEqual([
      { label: 'Connected', opts: ['alpha', 'dev', 'prod'] },
      { label: 'Not connected', opts: ['zed · not connected'] },
    ])
    const off = sel.find('optgroup:last-of-type option')
    expect(off.attributes('disabled')).toBeDefined()
    expect(off.attributes('aria-label')).toContain('not connected')
  })

  it('block referencing a disconnected name keeps it displayed; meta unchanged', async () => {
    const e = await env(HOST, 'prod', {}, 'dev')
    const w = e.block()
    await flushPromises()
    expect((w.find('[data-test=conn]').element as HTMLSelectElement).selectedOptions[0].textContent).toContain('dev')
    expect((e.store.nb.value.blocks[0].metadata as any).connection).toBe('dev')
    expect(e.store.dirty.value).toBe(false)
  })

  it('disabled name cannot be picked', async () => {
    const e = await env(HOST, 'prod')
    const w = e.block()
    const sel = w.find('[data-test=conn]')
    ;(sel.element as HTMLSelectElement).value = 'zed'
    await sel.trigger('change')
    expect((e.store.nb.value.blocks[0].metadata as any).connection).toBeUndefined()
  })

  it('missing name → last group with existing grey option', async () => {
    const e = await env(HOST, 'prod', {}, 'ghost')
    const w = e.block()
    await flushPromises()
    const g = groups(w, '[data-test=conn]')
    expect(g[g.length - 1]).toEqual({ label: 'Not found in DBX', opts: ['⚠ ghost'] })
    expect(w.find('[data-test=conn-missing-option]').attributes('disabled')).toBeDefined()
  })

  it('unavailable: flat names as before, no groups', async () => {
    const e = await env([], 'prod', { caps: { connectionsApi: false } }, 'prod')
    const w = e.block()
    expect(w.findAll('[data-test=conn] optgroup').length).toBe(0)
  })
})
