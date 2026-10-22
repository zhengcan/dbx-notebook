import { computed, createApp, h, nextTick, ref } from 'vue'
import LabelsDialog from '../analysis/LabelsDialog.vue'
import LabelsPreview from '../analysis/LabelsPreview.vue'
import { useNotebookStore } from '../state/notebookStore'
import { setLocale } from '../i18n'

const TOKENS = {
  light: '--color-background:#ffffff;--color-foreground:#0a0a0a;--color-muted:#f5f5f5;--color-muted-foreground:#737373;--color-border:#e5e5e5;--color-primary:#2563eb;--color-primary-foreground:#fff;--color-warning:#b45309;--color-destructive:#dc2626',
  dark: '--color-background:#0a0a0a;--color-foreground:#fafafa;--color-muted:#262626;--color-muted-foreground:#a3a3a3;--color-border:#333333;--color-primary:#60a5fa;--color-primary-foreground:#0a0a0a;--color-warning:#f59e0b;--color-destructive:#f87171',
}

if (import.meta.env.MODE === 'smoke') {
  const w = window as any
  w.__sqlnbMountLabelsDialogForSmoke = (o: { theme: 'light' | 'dark'; hostile?: boolean; open?: boolean }) => {
    w.__ldApp?.unmount()
    setLocale('zh-CN')
    const host = document.getElementById('host')!
    host.innerHTML = ''
    const scroller = document.createElement('div')
    scroller.id = 'scroller'
    scroller.setAttribute('style', `${TOKENS[o.theme]};background:var(--color-background);color:var(--color-foreground);font:14px system-ui,sans-serif;position:fixed;inset:0;overflow:auto`)
    const toolbar = document.createElement('div')
    toolbar.id = 'toolbar'
    toolbar.setAttribute('style', 'position:sticky;top:0;z-index:50;height:40px;background:var(--color-muted);border-bottom:1px solid var(--color-border);padding:8px')
    toolbar.innerHTML = '<button type="button" id="tb-btn">toolbar</button>'
    const pad = document.createElement('div')
    pad.setAttribute('style', 'height:300px')
    const block = document.createElement('div')
    block.id = 'blockroot'
    block.tabIndex = -1
    block.setAttribute('style', 'border:1px solid var(--color-border);padding:8px;margin:8px')
    const after = document.createElement('div')
    after.setAttribute('style', 'height:1600px')
    scroller.append(toolbar, pad, block, after)
    host.appendChild(scroller)
    const mount = document.createElement('div')
    block.appendChild(mount)

    const store = useNotebookStore({ now: () => new Date('2026-01-02T00:00:00Z') })
    const long = 'L'.repeat(200)
    const rows = o.hostile ? [{ field: 'region', label: long }, { field: 'متجر', label: 'نص عربي طويل جدا '.repeat(8) }] : [{ field: 'region', label: '大区' }]
    store.nb.value.blocks.push({
      id: 'c1', type: 'chart',
      metadata: {
        data: 'sales', spec: {}, view: 'both',
        chartOptions: { type: 'bar', title: o.hostile ? '<img src=x onerror=alert(1)> 标题 ' + '字'.repeat(100) : '销售额', axisTitles: { x: '区域' } },
        pivot: { rows, columns: [{ field: 'q', nullLabel: '无' }], values: [{ field: 'amount', agg: 'sum', format: { kind: 'thousands', unit: '元' } }, { field: 'n', agg: 'count' }], summaryLabel: '合计' },
      },
    } as any)
    w.__ldCalls = 0
    w.__ldCloses = 0
    const orig = store.setAnalysis.bind(store)
    store.setAnalysis = ((...a: any[]) => { w.__ldCalls++; return (orig as any)(...a) }) as any
    const meta = () => store.nb.value.blocks.find((b) => b.id === 'c1')!.metadata as any
    w.__ldMeta = meta
    const open = ref(!!o.open)
    const cfg = computed(() => ({ pivot: meta().pivot, chart: meta().chartOptions }))
    const extra = Array.from({ length: 117 }, (_, i) => (i % 3 === 0 ? `渠道${i}` : `Key${i}`))
    const cats = { row: [['华东', '华北', 'x'.repeat(120), ...extra], ['a', 'b']], column: [['Q1', 'Q2']] }
    const ctx = { empty: '(空)', summary: '汇总' }
    const opener = ref<HTMLElement | null>(null)
    w.__ldApp = createApp({
      render: () => h('div', [
        h('button', { type: 'button', id: 'opener', ref: opener, onClick: () => { open.value = true } }, '标签'),
        open.value ? h(LabelsDialog, { cfg: cfg.value, categories: cats, ctx, container: block, returnFocus: opener.value, onCommit: (p: any) => store.setAnalysis('c1', p), onClose: () => { w.__ldCloses++; open.value = false } }, { preview: ({ active, numbers }: any) => h(LabelsPreview, { cfg: cfg.value, ctx, active, numbers, categories: { rows: cats.row, columns: cats.column } }) }) : null,
      ]),
    })
    w.__ldApp.mount(mount)
    void nextTick
  }
}
