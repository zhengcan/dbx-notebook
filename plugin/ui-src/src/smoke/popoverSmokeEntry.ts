import { createApp, h } from 'vue'
import AnalysisBlock from '../analysis/AnalysisBlock.vue'
import { useNotebookStore } from '../state/notebookStore'
import { StoreKey } from '../injection'
import { setLocale } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb;--color-primary-foreground:#fff;--color-warning:#b45309;--color-destructive:#dc2626',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#60a5fa;--color-primary-foreground:#0a0a0a;--color-warning:#f59e0b;--color-destructive:#f87171',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountPopoverForSmoke = (o: { theme: 'light' | 'dark'; width: number; badges?: boolean; two?: boolean }) => {
    w.__sqlnbPopApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const root = document.createElement('div')
    root.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0;overflow:auto`)
    const box = document.createElement('div')
    box.setAttribute('style', `position:absolute;top:8px;right:8px;width:${o.width}px;box-sizing:border-box`)
    root.appendChild(box)
    host.appendChild(root)
    const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
    store.nb.value.blocks.push({ id: 's1', type: 'sql', content: 'select 1', metadata: { resultName: 'sales' } } as any)
    store.nb.value.blocks.push({ id: 'c1', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar', title: '销售额' }, pivot: { rows: [{ field: 'region' }], columns: [{ field: 'q' }], values: [{ field: 'amount', agg: 'sum' }] } } } as any)
    store.runs.set('s1', { status: 'ok', executedAt: 'T1', result: { columns: [{ name: 'region', dataType: 'text' }, { name: 'q', dataType: 'text' }, { name: 'amount', dataType: 'integer' }], rows: [['华东', 'Q1', 1]], truncated: false, elapsedMs: 1, dbType: 'sqlite' } } as any)
    const long = { status: 'ok', long: { dims: ['region', 'q'], measures: ['amount'], rows: [['华东', 'Q1', 100], ['华东', 'Q2', 200], ['华北', 'Q1', 50], ['华北', 'Q2', 80]] }, excludedDateRows: 0, partial: false, tooManyPoints: false, ranAt: 'x', sourceExecutedAt: 'T1' } as any
    if (o.badges) Object.assign(long, { sourceExecutedAt: 'T0', partial: true, excludedDateRows: 3, tooManyPoints: true })
    store.setAnalysisRunner(async () => long)
    store.analysis.set('c1', long)
    w.__popCalls = 0
    const orig = store.setAnalysis.bind(store)
    store.setAnalysis = ((...a: any[]) => { w.__popCalls++; return (orig as any)(...a) }) as any
    if (o.two) {
      store.nb.value.blocks.push({ id: 'c2', type: 'chart', metadata: { data: 'sales', spec: {}, view: 'both', chartOptions: { type: 'bar' }, pivot: { rows: [{ field: 'region' }], columns: [], values: [{ field: 'amount', agg: 'sum' }] } } } as any)
      store.analysis.set('c2', long)
    }
    w.__popUndo = () => store.undo()
    w.__popMeta = () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata
    w.__sqlnbPopApp = createApp(o.two ? { render: () => h('div', [h(AnalysisBlock, { blockId: 'c1' }), h(AnalysisBlock, { blockId: 'c2' })]) } : AnalysisBlock, o.two ? {} : { blockId: 'c1' })
    w.__sqlnbPopApp.provide(StoreKey, store)
    w.__sqlnbPopApp.mount(box)
  }
}
