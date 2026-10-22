import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import NotebookView from '../src/shell/NotebookView.vue'
import Toolbar from '../src/shell/Toolbar.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { createConnectionsStore } from "../src/connections/hostConnections"
import { createFakeBridge } from '../src/host/fakeBridge'
import { BridgeKey, CanRunKey, PluginSettingsKey, ConnectionsKey, SelectedKey, StoreKey } from '../src/injection'
import { createPluginSettings } from '../src/state/pluginSettings'
import { setLocale } from '../src/i18n'
import { fakeEditorFactory } from './helpers'

function env(canRun = true) {
  setLocale('en')
  const bridge = createFakeBridge()
  const connections = createConnectionsStore(bridge)
  const pluginSettings = createPluginSettings(bridge)
  const store = useNotebookStore({ maxRows: () => pluginSettings.maxRows.value })
  const selected = ref<string | null>(null)
  const provide = { [PluginSettingsKey as symbol]: pluginSettings, [StoreKey as symbol]: store, [ConnectionsKey as symbol]: connections, [BridgeKey as symbol]: bridge, [SelectedKey as symbol]: selected, [CanRunKey as symbol]: computed(() => canRun) }
  return { bridge, connections, store, selected, provide, pluginSettings }
}
const ids = (s: ReturnType<typeof useNotebookStore>) => s.nb.value.blocks.map((b) => b.id)

describe('NotebookView', () => {
  beforeEach(() => setLocale('en'))
  it('empty notebook shows hint with add buttons', async () => {
    const e = env()
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    expect(w.find('[data-test=empty]').exists()).toBe(true)
    await w.find('[data-test=empty-add-sql]').trigger('click')
    expect(e.store.nb.value.blocks.map((b) => b.type)).toEqual(['sql'])
  })
  it('empty state and inserter offer + Input and render input blocks', async () => {
    const e = env()
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    await w.find('[data-test=empty-add-input]').trigger('click')
    expect(e.store.nb.value.blocks.map((b) => b.type)).toEqual(['input'])
    expect(w.find('[data-test=input-block]').exists()).toBe(true)
    expect(w.find('[data-test=add-input]').text()).toBe('+ Input')
    await w.find('[data-test=add-input]').trigger('click')
    expect(e.store.nb.value.blocks.map((b) => b.type)).toEqual(['input', 'input'])
  })
  it('insert, move, duplicate, delete', async () => {
    const e = env()
    e.store.nb.value.blocks.push({ id: 'a', type: 'markdown', content: 'x' }, { id: 'b', type: 'sql', content: 'q', metadata: {} }, { id: 'c', type: 'mystery' as any, content: '' })
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    expect(w.findAll('[data-test=block]').length).toBe(3)
    expect(w.text()).toContain('Unsupported block type: mystery')
    await w.findAll('[data-test=insert]')[0].find('[data-test=add-sql]').trigger('click')
    expect(e.store.nb.value.blocks[1].type).toBe('sql')
    expect(e.store.nb.value.blocks.length).toBe(4)
    const first = ids(e.store)[0]
    await w.findAll('[data-test=block]')[0].find('[data-test=down]').trigger('click')
    expect(ids(e.store)[1]).toBe(first)
    await w.findAll('[data-test=block]')[0].find('[data-test=dup]').trigger('click')
    expect(e.store.nb.value.blocks.length).toBe(5)
  })
  it('delete asks only when block has content; selection set on click', async () => {
    const e = env()
    e.store.nb.value.blocks.push({ id: 'a', type: 'markdown', content: '' }, { id: 'b', type: 'markdown', content: 'text' })
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    await w.findAll('[data-test=block]')[0].find('[data-test=del]').trigger('click')
    expect(ids(e.store)).toEqual(['b'])
    await w.find('[data-test=block]').trigger('mousedown')
    expect(e.selected.value).toBe('b')
    await w.find('[data-test=del]').trigger('click')
    expect(ids(e.store)).toEqual(['b'])
    expect(w.text()).toContain('Delete this block?')
    const del = w.findAll('.cd-btn').find((x) => x.text() === 'Delete')!
    await del.trigger('click')
    await flushPromises()
    expect(ids(e.store)).toEqual([])
  })
})
describe('NotebookView block controls', () => {
  it('block controls: DOM contract for hover-only display', async () => {
    const e = env()
    e.store.nb.value.blocks.push({ id: 'a', type: 'markdown', content: '' }, { id: 'b', type: 'markdown', content: '' })
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    const blocks = w.findAll('[data-test=block]')
    const controls = blocks[1].find('[data-test=controls]')
    expect(controls.exists()).toBe(true)
    const btns = controls.findAll('button')
    expect(btns.length).toBe(4)
    for (const b of btns) {
      expect(b.attributes('tabindex')).not.toBe('-1')
      expect(b.attributes('hidden')).toBeUndefined()
      expect(b.attributes('style') ?? '').not.toContain('display: none')
    }
    await controls.find('[data-test=up]').trigger('click')
    expect(ids(e.store)).toEqual(['b', 'a'])
    await w.findAll('[data-test=block]')[0].find('[data-test=dup]').trigger('click')
    expect(e.store.nb.value.blocks.length).toBe(3)
    await w.findAll('[data-test=block]')[0].find('[data-test=del]').trigger('click')
    expect(e.store.nb.value.blocks.length).toBe(2)
    await w.findAll('[data-test=block]')[1].trigger('focusin')
    expect(w.findAll('[data-test=block]')[1].classes()).toContain('selected')
  })
})


describe('Toolbar', () => {
  it('run-from disabled without selection, enabled with; stop while running', async () => {
    const e = env()
    e.store.nb.value.blocks.push({ id: 'a', type: 'sql', content: 'q', metadata: {} })
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    expect(w.find('[data-test=run-from]').attributes('disabled')).toBeDefined()
    e.selected.value = 'a'
    await flushPromises()
    expect(w.find('[data-test=run-from]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test=stop]').exists()).toBe(false)
    await w.setProps({ running: true })
    expect(w.find('[data-test=stop]').exists()).toBe(true)
    w.unmount()
  })
  it('disables run buttons when canRun false', () => {
    const e = env(false)
    e.selected.value = 'a'
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    expect(w.find('[data-test=run-all]').attributes('disabled')).toBeDefined()
    w.unmount()
  })
  it('Mod-S emits save with preventDefault; listener removed on unmount', () => {
    const e = env()
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(w.emitted('save')?.length).toBe(1)
    w.unmount()
    const ev2 = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
    window.dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(false)
  })
})

describe('Toolbar results settings', () => {
  const mk = () => {
    const e = env()
    const w = mount(Toolbar, { props: { running: false }, global: { provide: e.provide } })
    return { e, w }
  }
  const okRun = { status: 'ok' as const, result: { columns: [], rows: [], truncated: false, elapsedMs: 1, dbType: 'x' } }
  it('toolbar no longer shows the max-rows control', () => {
    const { w } = mk()
    expect(w.find('[data-test=max-rows]').exists()).toBe(false)
    expect(w.find('[data-test=max-rows-hint]').exists()).toBe(false)
    expect(w.text()).not.toContain('Max rows')
  })
  it('select has three options mapping to modes', async () => {
    const { e, w } = mk()
    const sel = w.find('[data-test=outputs-mode]')
    expect(sel.findAll('option').map((o) => o.attributes('value'))).toEqual(['separate', 'inline', 'none'])
    expect((sel.element as HTMLSelectElement).value).toBe('separate')
    await sel.setValue('inline')
    expect(e.store.nb.value.settings.outputs).toBe('inline')
    await sel.setValue('separate')
    expect(e.store.nb.value.settings.outputs).toBe('separate')
  })
  it('none without saved results applies immediately', async () => {
    const { e, w } = mk()
    await w.find('[data-test=outputs-mode]').setValue('none')
    expect(e.store.nb.value.settings.outputs).toBe('none')
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('none with saved results asks; cancel keeps previous, confirm applies', async () => {
    const { e, w } = mk()
    e.store.runs.set('x', { ...okRun })
    const sel = w.find('[data-test=outputs-mode]')
    await sel.setValue('none')
    expect(e.store.nb.value.settings.outputs).toBe('separate')
    const body = new DOMWrapper(document.body)
    expect(body.text()).toContain("Don't save results")
    expect(body.find('[role=dialog]').element.closest('.tb-sticky')).toBeNull()
    expect(w.find('[role=dialog]').exists()).toBe(false)
    await body.findAll('.cd-btn').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(e.store.nb.value.settings.outputs).toBe('separate')
    expect((sel.element as HTMLSelectElement).value).toBe('separate')
    await sel.setValue('none')
    await body.find('.cd-danger').trigger('click')
    expect(e.store.nb.value.settings.outputs).toBe('none')
    expect((sel.element as HTMLSelectElement).value).toBe('none')
    w.unmount()
  })
  it('+ Local SQL buttons (empty state and inserter) create results blocks', async () => {
    const e = env()
    const w = mount(NotebookView, { props: { editorFactory: fakeEditorFactory() }, global: { provide: e.provide } })
    expect(w.find('[data-test=empty-add-results]').text()).toBe('+ Local SQL')
    await w.find('[data-test=empty-add-results]').trigger('click')
    expect(e.store.nb.value.blocks[0].metadata).toEqual({ source: 'results' })
    await w.find('[data-test=add-results]').trigger('click')
    expect(e.store.nb.value.blocks).toHaveLength(2)
    expect(e.store.nb.value.blocks[1].metadata).toEqual({ source: 'results' })
    setLocale('zh-CN')
    await w.vm.$nextTick()
    expect(w.find('[data-test=add-results]').text()).toBe('+ 本地 SQL')
  })
})

describe('StartPage AI settings', () => {
  const MODELS = [{ configId: 'c1', name: 'Cfg', model: 'm-a', isDefault: false }, { configId: 'c1', name: 'Cfg', model: 'm-b', isDefault: true }]
  async function mountStart(ai: boolean, models: unknown[] = MODELS, saved: unknown = null) {
    const { createAiClient, AI_METHODS } = await import('../src/ai/aiClient')
    const { createAiSettings } = await import('../src/ai/aiSettings')
    const { AiSettingsKey } = await import('../src/injection')
    const StartPage = (await import('../src/shell/StartPage.vue')).default
    const bridge = createFakeBridge({ caps: { aiCompletion: ai }, requestHandlers: { [AI_METHODS.listModels]: () => models }, storageGet: async () => saved as any })
    const ai_ = createAiSettings(bridge, createAiClient(bridge))
    const spy = vi.spyOn(ai_, 'setSend')
    if (ai) { await ai_.load(); await ai_.refreshModels() }
    const w = mount(StartPage, { props: { recent: [], hasSidecar: false }, global: { provide: { [AiSettingsKey as symbol]: ai_, [BridgeKey as symbol]: bridge } } })
    await flushPromises()
    return { w, spy, ai_ }
  }
  it('switches are grouped in a fieldset with legend and help text', async () => {
    setLocale('en')
    const { w } = await mountStart(true)
    const fs = w.find('fieldset[data-test=ai-send-group]')
    expect(fs.exists()).toBe(true)
    expect(fs.find('legend').text()).toMatch(/sent to the AI/i)
    expect(fs.findAll('input[type=checkbox]')).toHaveLength(3)
  })
  it('model select is disabled when there are no models', async () => {
    const { w } = await mountStart(true, [])
    expect((w.find('[data-test=ai-model]').element as HTMLSelectElement).disabled).toBe(true)
    expect(w.find('[data-test=ai-no-models]').exists()).toBe(true)
  })
  it('shows the fallback notice when the saved model is gone', async () => {
    const { w } = await mountStart(true, MODELS, { send: { schema: true, sql: true, data: true }, model: 'zz|gone' })
    expect(w.find('[data-test=ai-model-fallback]').exists()).toBe(true)
    expect((w.find('[data-test=ai-model]').element as HTMLSelectElement).disabled).toBe(false)
  })
  it('renders three checked switches, toggling calls setSend', async () => {
    setLocale('en')
    const { w, spy } = await mountStart(true)
    for (const k of ['schema', 'sql', 'data']) expect((w.find(`[data-test=ai-send-${k}]`).element as HTMLInputElement).checked).toBe(true)
    await w.find('[data-test=ai-send-data]').setValue(false)
    expect(spy).toHaveBeenCalledWith({ data: false })
  })
  it('switches are labelled and described', async () => {
    const { w } = await mountStart(true)
    const el = w.find('[data-test=ai-send-sql]')
    expect(el.element.closest('label')).not.toBeNull()
    const d = el.attributes('aria-describedby')!
    expect(w.find(`#${d}`).text()).toMatch(/confirm/i)
  })
  it('model select lists models and selects effective', async () => {
    const { w } = await mountStart(true)
    const sel = w.find('[data-test=ai-model]')
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['Cfg · m-a', 'Cfg · m-b'])
    expect((sel.element as HTMLSelectElement).value).toBe('c1|m-a')
  })
  it('unsupported shows note and no switches', async () => {
    const { w } = await mountStart(false)
    expect(w.find('[data-test=ai-unsupported]').exists()).toBe(true)
    expect(w.find('[data-test=ai-unsupported]').text()).toContain('0.6.28')
    expect(w.find('[data-test=ai-send-schema]').exists()).toBe(false)
  })
})
