import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createEmptyNotebook, parseNotebook, serializeNotebook } from '@sqlnb/format'
import Toolbar from '../src/shell/Toolbar.vue'
import StartPage from '../src/shell/StartPage.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createFileActions } from '../src/shell/fileActions'
import { createFakeBridge } from '../src/host/fakeBridge'
import { buildExportModel } from '../src/export/model'
import { renderExportHtml } from '../src/export/html'
import { runExport } from '../src/export/runExport'
import { buildExportLabels } from '../src/export/labels'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions } from '../src/export/options'
import { BridgeKey, CanRunKey, StoreKey, SelectedKey, ConnectionsKey, PluginSettingsKey } from '../src/injection'
import { createConnectionsStore } from '../src/connections/hostConnections'
import { createPluginSettings } from '../src/state/pluginSettings'
import { setLocale, t } from '../src/i18n'

setLocale('en')

const FILE = (title: unknown) => `sqlnb: "1"\nmetadata:\n  title: ${JSON.stringify(title)}\n  createdAt: "2026-01-01T00:00:00.000Z"\n  modifiedAt: "2026-01-01T00:00:00.000Z"\nblocks:\n  - id: a\n    type: markdown\n    content: hello\n`

function toolbarEnv() {
  const bridge = createFakeBridge()
  const store = useNotebookStore()
  const provide = {
    [StoreKey as symbol]: store, [BridgeKey as symbol]: bridge, [SelectedKey as symbol]: ref(null), [CanRunKey as symbol]: computed(() => true),
    [ConnectionsKey as symbol]: createConnectionsStore(bridge), [PluginSettingsKey as symbol]: createPluginSettings(bridge),
  }
  return { store, provide }
}

function fa(handlers: Record<string, (p: any) => unknown> = {}) {
  const bridge = createFakeBridge({ invokeHandlers: { 'notebook/touchRecent': () => ({}), 'notebook/pickSave': () => ({ path: '/o/new.sqlnb' }), 'notebook/exists': () => ({ exists: false }), 'notebook/write': () => ({ mtimeMs: 9 }), ...handlers } })
  const store = useNotebookStore()
  const actions = createFileActions({ bridge, store, confirm: vi.fn(async () => 'discard' as const), askExternalChange: vi.fn(async () => 'cancel' as const), notify: vi.fn() } as any)
  const callsOf = (m: string) => (bridge.calls as any[]).filter((c) => c.args?.method === m).map((c) => c.args.params)
  return { actions, store, callsOf }
}

describe('notebook has no title; a legacy metadata.title is an ignored unknown key', () => {
  it('Toolbar has no [data-test=title] input', () => {
    const e = toolbarEnv()
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    expect(w.find('[data-test=title]').exists()).toBe(false)
    expect(w.find('input.tb-title').exists()).toBe(false)
    expect(w.find('[data-test=filename]').exists()).toBe(true)
  })

  it('Toolbar never displays a legacy title', () => {
    const e = toolbarEnv()
    e.store.load(FILE('Secret Legacy'), '/dir/report.sqlnb', 1)
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    expect(w.text()).not.toContain('Secret Legacy')
    expect(w.html()).not.toContain('Secret Legacy')
  })

  it('store has no setTitle', () => {
    expect((useNotebookStore() as any).setTitle).toBeUndefined()
  })

  it.each(['旧标题', '', 'no', '<b>x</b> 🎉 "q" \\ : #', '0123', '~', 42, null, ['a'], { k: 1 }])('legacy metadata.title loads without error and, like any unknown metadata key, is carried along on save (%j)', async (title) => {
    const s = fa()
    expect(() => s.store.load(FILE(title), '/a.sqlnb', 1)).not.toThrow()
    expect(s.store.nb.value.blocks[0].content).toBe('hello')
    s.store.updateContent('a', 'edited')
    await s.actions.save()
    const written = s.callsOf('notebook/write')[0].text as string
    expect(parseNotebook(written).metadata.title).toEqual(title)
    await s.actions.saveAs()
    const second = s.callsOf('notebook/write')[1].text as string
    expect(parseNotebook(second).metadata.title).toEqual(title)
  })

  it('a file without a legacy title never gains one on save', async () => {
    const s = fa()
    s.store.load('sqlnb: "1"\nblocks:\n  - id: a\n    type: markdown\n    content: x\n', '/a.sqlnb', 1)
    s.store.updateContent('a', 'y')
    await s.actions.save()
    expect('title' in parseNotebook(s.callsOf('notebook/write')[0].text).metadata).toBe(false)
  })

  it('new notebook JSON has no title key', () => {
    const nb = createEmptyNotebook()
    expect('title' in nb.metadata).toBe(false)
    expect(serializeNotebook(nb)).not.toMatch(/title/)
  })

  it('recent touch sends no title (even when the file has one)', async () => {
    const s = fa()
    s.store.load(FILE('旧标题'), '/a.sqlnb', 1)
    s.store.updateContent('a', 'e')
    await s.actions.save()
    const params = s.callsOf('notebook/touchRecent')[0]
    expect(params).toEqual({ path: '/a.sqlnb' })
  })

  it('Save As suggestion is based on the file name, not title', async () => {
    const s = fa()
    s.store.load(FILE('旧标题'), '/dir/report.sqlnb', 1)
    await s.actions.saveAs()
    expect(s.callsOf('notebook/pickSave')[0].suggestedName).toBe('report.sqlnb')
    const u = fa()
    u.store.load(FILE('旧标题'), null, null)
    await u.actions.saveAs()
    expect(u.callsOf('notebook/pickSave')[0].suggestedName).toBe('notebook.sqlnb')
  })

  it('normalizeExportOptions ignores a stored header.title', () => {
    const o = normalizeExportOptions({ header: { title: true } })
    expect('title' in o.header).toBe(false)
    expect(Object.keys(DEFAULT_EXPORT_OPTIONS.header)).not.toContain('title')
  })

  it('start page recents show file names, not titles', () => {
    const w = mount(StartPage, { props: { recent: [{ path: '/x/plain.sqlnb', title: 'Secret Title', openedAt: 0 }] } as any, global: { provide: {} } })
    expect(w.text()).toContain('plain.sqlnb')
    expect(w.text()).not.toContain('Secret Title')
  })

  const storeWith = (title: string) => ({
    nb: ref({ sqlnb: '1', metadata: { title }, settings: { outputs: 'separate' }, connections: [], blocks: [{ id: 'm', type: 'markdown', content: 'body', metadata: {} }] }),
    runs: new Map(), analysis: new Map(), bigNumbers: new Map(), isStale: () => false, isPartial: () => false, transposed: new Map(),
    dirty: ref(false), refreshAnalysis: vi.fn(async () => ({})), refreshBigNumber: vi.fn(async () => ({})),
  }) as any
  const labels = buildExportLabels((k, p) => t(k as any, p as any))

  it.each(['/o/<b>报告 & co</b>.html', '/o/plain.html'])('export HTML: no <h1> from the title; <title> is the target file name (%s)', async (path) => {
    const saved: string[] = []
    const client: any = { saveHtml: vi.fn(async (_p: string, html: string) => { saved.push(html); return { bytes: 1 } }), pdf: vi.fn(), browserStatus: vi.fn() }
    const r = await runExport({ store: storeWith('<b>Secret</b>'), client, settings: { browserPath: ref('') }, labels, path, dataSourceName: () => undefined }, { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
    expect(r.ok).toBe(true)
    const html = saved[0]
    expect(html).not.toContain('Secret')
    expect(html).not.toContain('<h1>')
    const name = path.split('/').pop()!.replace(/\.html$/, '')
    const esc = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    expect(html).toContain(`<title>${esc}</title>`)
  })

  it('empty file base name (path ends with a separator) falls back to the Untitled label, never an empty <title>', async () => {
    const saved: string[] = []
    const client: any = { saveHtml: vi.fn(async (_p: string, html: string) => { saved.push(html); return { bytes: 1 } }), pdf: vi.fn(), browserStatus: vi.fn() }
    await runExport({ store: storeWith('x'), client, settings: { browserPath: ref('') }, labels, path: '/o/', dataSourceName: () => undefined }, { ...DEFAULT_EXPORT_OPTIONS, format: 'html' }).promise
    expect(saved[0]).toContain(`<title>${t('exp.untitledName')}</title>`)
    expect(saved[0]).not.toContain('<title></title>')
  })

  it('renderExportHtml uses documentTitle only inside <title>, escaped', () => {
    const m = buildExportModel({ store: storeWith('Secret'), options: DEFAULT_EXPORT_OPTIONS, now: new Date(), dataSourceName: () => undefined, documentTitle: 'a<b>' } as any)
    expect((m as any).title).toBeUndefined()
    const h = renderExportHtml(m, DEFAULT_EXPORT_OPTIONS, {}, labels)
    expect(h).toContain('<title>a&lt;b&gt;</title>')
    expect(h).not.toContain('<h1>')
    expect(h).not.toContain('Secret')
  })
})
