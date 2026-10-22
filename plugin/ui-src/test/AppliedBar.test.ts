import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import AppliedBar from '../src/ai/AppliedBar.vue'
import { useNotebookStore } from '../src/state/notebookStore'
import { StoreKey } from '../src/injection'
import { setLocale } from '../src/i18n'

function setup() {
  setLocale('zh-CN')
  const store = useNotebookStore()
  store.load(serializeNotebook(createEmptyNotebook()), null, null)
  const id = store.addBlock('sql', null)
  store.updateContent(id, 'select 1')
  const w = mount(AppliedBar, { props: { blockId: id }, global: { provide: { [StoreKey as symbol]: store } } })
  return { store, id, w }
}
afterEach(() => { vi.useRealTimers(); setLocale('en') })

describe('AppliedBar outcome', () => {
  const put = (store: any, id: string, outcome: any) => { store.appliedNotice.value = { ...store.appliedNotice.value, blockId: id, outcome } }
  it.each([
    [{ kind: 'ran' }, '已自动运行一次。', 'status'],
    [{ kind: 'failed', message: 'boom' }, '已自动运行一次，但运行失败：boom', 'alert'],
    [{ kind: 'skipped', reason: 'busy' }, '未自动运行：正在运行中。', 'status'],
    [{ kind: 'skipped', reason: 'not-select' }, '未自动运行：不是单条只读 SELECT。', 'status'],
    [{ kind: 'skipped', reason: 'multiple' }, '未自动运行：包含多条语句。', 'status'],
    [{ kind: 'skipped', reason: 'unsupported-syntax' }, '未自动运行：包含无法确认安全的语法。', 'status'],
    [{ kind: 'skipped', reason: 'unresolved-params', detail: 'who' }, '未自动运行：参数未填写（who）。', 'status'],
    [{ kind: 'skipped', reason: 'stale-upstream' }, '未自动运行：上游结果已过期。', 'status'],
    [{ kind: 'skipped', reason: 'no-connection' }, '未自动运行：没有可用的连接。', 'status'],
  ])('renders %j', async (outcome, text, role) => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    put(store, id, outcome)
    await nextTick()
    const o = w.find('[data-test=ai-outcome]')
    expect(o.text()).toBe(text)
    expect(o.attributes('role')).toBe(role === 'alert' ? 'alert' : undefined)
    expect(w.find('[data-test=ai-undo]').exists()).toBe(true)
  })
  it('en wording', async () => {
    const { store, id, w } = setup()
    setLocale('en')
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    put(store, id, { kind: 'skipped', reason: 'unresolved-params', detail: 'who' })
    await nextTick()
    expect(w.find('[data-test=ai-outcome]').text()).toBe('Not run automatically: parameter not filled in (who).')
  })
  it('no outcome line when none; survives touchKeepingNotice-style revision bumps; cleared with the notice', async () => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    await nextTick()
    expect(w.find('[data-test=ai-outcome]').exists()).toBe(false)
    put(store, id, { kind: 'ran' })
    store.noteRunFinished(id)
    await nextTick()
    expect(w.find('[data-test=ai-outcome]').exists()).toBe(true)
    store.appliedNotice.value = null
    await nextTick()
    expect(w.find('[data-test=ai-outcome]').exists()).toBe(false)
  })
})

describe('AppliedBar', () => {
  it('shows after apply, undo restores and hides', async () => {
    const { store, id, w } = setup()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(false)
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    await nextTick()
    const bar = w.find('[data-test=ai-applied-bar]')
    expect(bar.attributes('role')).toBe('status')
    expect(bar.text()).toContain('已应用')
    await bar.find('button').trigger('click')
    expect(store.nb.value.blocks[0].content).toBe('select 1')
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(false)
  })
  it('is only shown under the affected block', async () => {
    const { store, id } = setup()
    const other = mount(AppliedBar, { props: { blockId: 'zzz' }, global: { provide: { [StoreKey as symbol]: store } } })
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    await nextTick()
    expect(other.find('[data-test=ai-applied-bar]').exists()).toBe(false)
  })
  it('auto-dismisses after ~8s', async () => {
    vi.useFakeTimers()
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    await nextTick()
    vi.advanceTimersByTime(7000); await nextTick()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(true)
    vi.advanceTimersByTime(1500); await nextTick()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(false)
  })
  it('hides on next edit', async () => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    await nextTick()
    store.updateContent(id, 'mine')
    await nextTick()
    expect(w.find('[data-test=ai-applied-bar]').exists()).toBe(false)
  })
  it('a second apply replaces the bar', async () => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: '1', run: (tx) => tx.updateContent(id, 'a') })
    store.applyAiEdit({ label: '2', run: (tx) => tx.updateContent(id, 'b') })
    await nextTick()
    expect(w.findAll('[data-test=ai-applied-bar]')).toHaveLength(1)
  })
  it('conflict via undo() (e.g. shortcut) shows role=alert, content unchanged', async () => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    store.nb.value.blocks[0].content = 'mine'
    expect(store.undo().ok).toBe(false)
    await nextTick()
    const bar = w.find('[data-test=ai-applied-bar]')
    expect(bar.attributes('role')).toBe('alert')
    expect(bar.text()).toContain('该块已被修改，无法撤销')
    expect(store.nb.value.blocks[0].content).toBe('mine')
  })
  it('conflict via the button', async () => {
    const { store, id, w } = setup()
    store.applyAiEdit({ label: 'x', run: (tx) => tx.updateContent(id, 'ai') })
    store.nb.value.blocks[0].content = 'mine'
    await nextTick()
    await w.find('[data-test=ai-applied-bar] button').trigger('click')
    expect(w.find('[data-test=ai-applied-bar]').attributes('role')).toBe('alert')
    expect(store.nb.value.blocks[0].content).toBe('mine')
  })
})
