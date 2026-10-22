import { createApp, h, nextTick } from 'vue'
import { createEmptyNotebook, serializeNotebook } from '@sqlnb/format'
import NotebookView from '../shell/NotebookView.vue'
import HistoryLive from '../shell/HistoryLive.vue'
import { createHistoryActions } from '../shell/historyActions'
import { useHistoryShortcuts } from '../shell/useHistoryShortcuts'
import { useNotebookStore } from '../state/notebookStore'
import { createConnectionsStore } from '../connections/hostConnections'
import { createFakeBridge } from '../host/fakeBridge'
import { BridgeKey, ConnectionsKey, HistoryActionsKey, SelectedKey, StoreKey } from '../injection'
import { setLocale } from '../i18n'
import { ref } from 'vue'

const TOKENS = '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb;--color-primary-foreground:#fff;--color-warning:#b45309;--color-destructive:#dc2626'

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountUndoForSmoke = () => {
    setLocale('en')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;padding:8px`)
    host.appendChild(root)
    const bridge = createFakeBridge({})
    const connections = createConnectionsStore(bridge)
    const store = useNotebookStore()
    const nb: any = createEmptyNotebook()
    nb.blocks = [
      { id: 's1', type: 'sql', content: 'select 1', metadata: {} },
      { id: 'm1', type: 'markdown', content: 'hello' },
      { id: 'i1', type: 'input', metadata: { variable: 'v', inputType: 'text', value: 'x' } },
      { id: 'm2', type: 'markdown', content: 'tail' },
    ]
    store.load(serializeNotebook(nb), '/x.sqlnb', 1)
    const actions = createHistoryActions(store, { fallbackFocus: () => document.querySelector<HTMLElement>('[data-test=notebook-view]') })
    const calls = { undo: 0, redo: 0 }
    const counted = { ...actions, undo: () => { calls.undo++; return actions.undo() }, redo: () => { calls.redo++; return actions.redo() } }
    useHistoryShortcuts(store, document, counted)
    const app = createApp({ render: () => h('div', [h(NotebookView), h(HistoryLive, { actions: counted })]) })
    app.provide(StoreKey, store)
    app.provide(ConnectionsKey, connections)
    app.provide(BridgeKey, bridge)
    app.provide(SelectedKey, ref<string | null>(null))
    app.provide(HistoryActionsKey, counted)
    app.mount(root)
    w.__undo = {
      calls,
      ids: () => store.nb.value.blocks.map((b) => b.id),
      content: (id: string) => store.nb.value.blocks.find((b) => b.id === id)?.content,
      meta: (id: string) => store.nb.value.blocks.find((b) => b.id === id)?.metadata,
      depth: () => store.history.undoDepth.value,
      redo: () => store.history.redoDepth.value,
      dirty: () => store.dirty.value,
      live: () => document.querySelector('[data-test=history-live]')?.textContent ?? '',
      active: () => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.getAttribute('data-test') ? '[' + a.getAttribute('data-test') + ']' : ''}${a.closest('.cm-editor') ? '.cm' : ''}` : 'none' },
      tick: () => nextTick(),
      rerender: () => { setLocale('zh-CN'); setLocale('en') },
    }
  }
}
